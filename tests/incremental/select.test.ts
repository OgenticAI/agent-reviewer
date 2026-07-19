/**
 * Incremental review selection + carry-forward (OGE-1590).
 *
 * The trust property: an item whose evidence files didn't change on this push
 * carries forward with the SAME verdict it had, not whatever the model happens
 * to say this run. FAIL always re-verifies; a touched item re-verifies; the
 * rest carry forward annotated with the SHA they were verified at.
 */

import { describe, expect, it } from "vitest";

import {
  appendReviewedSha,
  evidenceFilesOf,
  highestReviewedSha,
  mergeCarriedForward,
  selectItems,
} from "../../src/incremental/select.js";
import { decideIncremental } from "../../src/incremental/thresholds.js";
import type { ItemVerdict, ReviewVerdict } from "../../src/schema/verdict.js";

function item(id: number, status: ItemVerdict["status"], over: Partial<ItemVerdict> = {}): ItemVerdict {
  return { id, itemText: `item ${id}`, status, rationale: "r", evidenceRefs: [], ...over } as ItemVerdict;
}

function verdict(items: ItemVerdict[], over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    schemaVersion: 1,
    reviewerVersion: "v4",
    ticketId: "OGE-1",
    prRef: "o/r#1",
    headSha: "sha_old_1",
    items,
    summary: "s",
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as ReviewVerdict;
}

describe("evidenceFilesOf", () => {
  it("prefers explicit evidenceFiles", () => {
    expect(evidenceFilesOf(item(1, "PASS", { evidenceFiles: ["a.ts"] }))).toEqual(["a.ts"]);
  });
  it("falls back to paths in evidenceRefs", () => {
    const it = item(1, "PASS", {
      evidenceRefs: [{ kind: "file", path: "src/x.ts" }] as ItemVerdict["evidenceRefs"],
    });
    expect(evidenceFilesOf(it)).toEqual(["src/x.ts"]);
  });
});

describe("selectItems", () => {
  const prev = [
    item(1, "PASS", { evidenceFiles: ["src/a.ts"] }),
    item(2, "PASS", { evidenceFiles: ["src/b.ts"] }),
    item(3, "FAIL", { evidenceFiles: ["src/c.ts"] }),
    item(4, "PASS", {}), // no evidence files
  ];

  it("carries forward an item whose evidence didn't change", () => {
    const s = selectItems({ previousItems: prev, currentItemIds: [1, 2, 3, 4], changedPaths: ["src/b.ts"] });
    expect(s.carryForward.has(1)).toBe(true); // a.ts untouched
  });

  it("re-verifies an item whose evidence file changed", () => {
    const s = selectItems({ previousItems: prev, currentItemIds: [1, 2, 3, 4], changedPaths: ["src/b.ts"] });
    expect(s.reverify.has(2)).toBe(true); // b.ts changed
  });

  it("always re-verifies a FAIL, even with untouched evidence", () => {
    const s = selectItems({ previousItems: prev, currentItemIds: [1, 2, 3, 4], changedPaths: [] });
    expect(s.reverify.has(3)).toBe(true);
  });

  it("re-verifies an item with no evidence files — can't prove it's untouched", () => {
    const s = selectItems({ previousItems: prev, currentItemIds: [1, 2, 3, 4], changedPaths: [] });
    expect(s.reverify.has(4)).toBe(true);
  });

  it("re-verifies an item with no prior verdict", () => {
    const s = selectItems({ previousItems: prev, currentItemIds: [1, 2, 3, 4, 5], changedPaths: [] });
    expect(s.reverify.has(5)).toBe(true);
  });

  it("matches paths loosely across repo-root differences", () => {
    const s = selectItems({
      previousItems: [item(1, "PASS", { evidenceFiles: ["a.ts"] })],
      currentItemIds: [1],
      changedPaths: ["packages/x/a.ts"],
    });
    expect(s.reverify.has(1)).toBe(true);
  });
});

describe("mergeCarriedForward", () => {
  it("replaces a carried item with the previous verdict, annotated with the SHA", () => {
    const previous = verdict(
      [item(1, "PASS", { rationale: "was good", evidenceFiles: ["src/a.ts"] })],
      { headSha: "sha_old_1", reviewedShas: ["sha_old_1"] },
    );
    // The fresh run flipped item 1 to FAIL — but its code didn't change, so the
    // carry-forward must win to prevent churn.
    const fresh = verdict([item(1, "FAIL", { rationale: "model flip-flopped" })], { headSha: "sha_new" });
    const merged = mergeCarriedForward({
      fresh,
      previous,
      selection: { carryForward: new Set([1]), reverify: new Set() },
    });
    expect(merged[0]!.status).toBe("PASS");
    expect(merged[0]!.rationale).toBe("was good");
    expect(merged[0]!.verifiedAtSha).toBe("sha_old_1");
  });

  it("leaves a re-verified item as the fresh model produced it", () => {
    const previous = verdict([item(1, "PASS")]);
    const fresh = verdict([item(1, "FAIL", { rationale: "genuinely broke" })], { headSha: "sha_new" });
    const merged = mergeCarriedForward({
      fresh,
      previous,
      selection: { carryForward: new Set(), reverify: new Set([1]) },
    });
    expect(merged[0]!.status).toBe("FAIL");
    expect(merged[0]!.verifiedAtSha).toBeUndefined();
  });
});

describe("reviewed-SHA history", () => {
  it("appends the head SHA, de-duplicated", () => {
    const prev = verdict([item(1, "PASS")], { reviewedShas: ["sha1"] });
    expect(appendReviewedSha(prev, "sha2")).toEqual(["sha1", "sha2"]);
    expect(appendReviewedSha(prev, "sha1")).toEqual(["sha1"]);
  });

  it("starts a fresh history from null", () => {
    expect(appendReviewedSha(null, "sha1")).toEqual(["sha1"]);
  });

  it("reads the highest reviewed SHA", () => {
    expect(highestReviewedSha(verdict([item(1, "PASS")], { reviewedShas: ["a", "b", "c"] }))).toBe("c");
    // Falls back to headSha when no history recorded.
    expect(highestReviewedSha(verdict([item(1, "PASS")], { headSha: "sha_old_1" }))).toBe("sha_old_1");
  });
});

describe("decideIncremental thresholds", () => {
  it("forces full review on request", () => {
    expect(decideIncremental({ hasPrevious: true, newCommits: 5, minutesSinceLast: 60, forceFull: true }).incremental).toBe(false);
  });
  it("requires a previous review", () => {
    expect(decideIncremental({ hasPrevious: false, newCommits: 5, minutesSinceLast: 60 }).incremental).toBe(false);
  });
  it("requires the minimum new commits", () => {
    const d = decideIncremental({ hasPrevious: true, newCommits: 0, minutesSinceLast: 60, thresholds: { minCommits: 1, minMinutes: 0 } });
    expect(d.incremental).toBe(false);
  });
  it("takes the incremental path once thresholds clear", () => {
    expect(decideIncremental({ hasPrevious: true, newCommits: 2, minutesSinceLast: 30 }).incremental).toBe(true);
  });
});
