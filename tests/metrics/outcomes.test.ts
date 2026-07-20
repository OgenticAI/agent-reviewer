/**
 * Verdict outcome telemetry (OGE-1592).
 *
 * The distinction this file exists to protect: **acted-on vs unexplained-flip**.
 * A negative verdict that turns positive looks like success either way. It is
 * only success if a file the reviewer cited actually changed. If those two
 * collapse into one "resolved" number, a run that swaps honest punts for
 * confident guesses scores as an improvement — which is the exact failure the
 * punt-rate metric can't see and this one is meant to catch.
 */

import { describe, expect, it } from "vitest";

import {
  citedPaths,
  computeOutcomes,
  renderOutcomeRows,
  toOutcomeRows,
} from "../../src/metrics/outcomes.js";
import type { ItemVerdict, ReviewVerdict, VerdictStatus } from "../../src/schema/verdict.js";

function item(
  id: number,
  status: VerdictStatus,
  extra: Partial<ItemVerdict> = {},
): ItemVerdict {
  return {
    id,
    itemText: `item ${id}`,
    status,
    rationale: "because",
    evidenceRefs: [],
    ...extra,
  } as ItemVerdict;
}

function verdict(items: ItemVerdict[], headSha = "sha-new"): ReviewVerdict {
  return {
    ticketId: "OGE-308",
    prRef: "OgenticAI/agent-reviewer#1",
    headSha,
    reviewerVersion: "v4",
    generatedAt: "2026-07-19T12:00:00.000Z",
    items,
    summary: "s",
  } as ReviewVerdict;
}

describe("citedPaths", () => {
  it("collects paths from structured evidenceRefs", () => {
    const it0 = item(1, "FAIL", {
      evidenceRefs: [{ kind: "file", path: "src/redact.ts" }] as ItemVerdict["evidenceRefs"],
    });
    expect(citedPaths(it0)).toContain("src/redact.ts");
  });

  it("also recovers paths from the prose evidence trail", () => {
    const it0 = item(1, "FAIL", { evidence: ["read src/tools/loop.ts:40-58"] });
    expect(citedPaths(it0)).toContain("src/tools/loop.ts");
  });

  it("de-duplicates across both sources", () => {
    const it0 = item(1, "FAIL", {
      evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"],
      evidence: ["read src/a.ts"],
    });
    expect(citedPaths(it0).filter((p) => p === "src/a.ts")).toHaveLength(1);
  });
});

describe("computeOutcomes", () => {
  const prev = verdict(
    [
      item(1, "FAIL", {
        evidenceRefs: [{ kind: "file", path: "src/redact.ts" }] as ItemVerdict["evidenceRefs"],
      }),
      item(2, "UNVERIFIABLE", {
        evidenceRefs: [{ kind: "file", path: "README.md" }] as ItemVerdict["evidenceRefs"],
      }),
      item(3, "PASS"),
    ],
    "sha-old",
  );

  it("labels a flip acted-on when a cited file changed", () => {
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "PASS"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: ["src/redact.ts"],
    });
    expect(out.items[0]!.outcome).toBe("acted-on");
    expect(out.items[0]!.changedEvidencePaths).toEqual(["src/redact.ts"]);
  });

  it("labels a flip unexplained when nothing it cited changed", () => {
    // This is the alarm case: last run said FAIL after reading src/redact.ts,
    // this run says PASS and that file never moved. One of the two is wrong.
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "PASS"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: ["docs/unrelated.md"],
    });
    expect(out.items[0]!.outcome).toBe("unexplained-flip");
  });

  it("keeps a still-negative item outstanding", () => {
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "FAIL"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: ["src/redact.ts"],
    });
    expect(out.items[0]!.outcome).toBe("outstanding");
    expect(out.items[1]!.outcome).toBe("outstanding");
  });

  it("treats CODE_VERIFIED as a real positive resolution", () => {
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "CODE_VERIFIED"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: ["src/redact.ts"],
    });
    expect(out.items[0]!.outcome).toBe("acted-on");
  });

  it("does not treat PARTIAL as a resolution — it still names a gap", () => {
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "PARTIAL"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: ["src/redact.ts"],
    });
    expect(out.items[0]!.outcome).toBe("outstanding");
  });

  it("labels an overridden item overridden, whatever the status says", () => {
    // An override means the reviewer was ignored, not agreed with. Counting it
    // as acted-on would make being overruled look like being useful.
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "FAIL"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: ["src/redact.ts"],
      overriddenItemIds: [1],
    });
    expect(out.items[0]!.outcome).toBe("overridden");
  });

  it("labels items with no previous counterpart as new", () => {
    const out = computeOutcomes({
      previous: verdict([item(1, "FAIL")], "sha-old"),
      current: verdict([item(1, "FAIL"), item(2, "PASS")]),
      changedPaths: [],
    });
    expect(out.items[1]!.outcome).toBe("new");
  });

  it("treats every item as new when there is no previous verdict", () => {
    const out = computeOutcomes({ previous: null, current: verdict([item(1, "PASS")]) });
    expect(out.items[0]!.outcome).toBe("new");
    expect(out.actedOnRate).toBeNull();
  });

  it("matches paths loosely across repo-root differences", () => {
    // The model writes repo-relative paths; git may report them prefixed in a
    // monorepo. Exact matching would silently mislabel real fixes.
    const out = computeOutcomes({
      previous: verdict(
        [
          item(1, "FAIL", {
            evidenceRefs: [{ kind: "file", path: "redact.ts" }] as ItemVerdict["evidenceRefs"],
          }),
        ],
        "sha-old",
      ),
      current: verdict([item(1, "PASS")]),
      changedPaths: ["packages/shield/redact.ts"],
    });
    expect(out.items[0]!.outcome).toBe("acted-on");
  });

  it("reports actedOnRate over flips only, and null when nothing flipped", () => {
    const nothingFlipped = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "FAIL"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      changedPaths: [],
    });
    // Undefined, not 0 — nothing regressed here, and 0 would read as failure.
    expect(nothingFlipped.actedOnRate).toBeNull();

    const half = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "PASS"), item(2, "PASS"), item(3, "PASS")]),
      changedPaths: ["src/redact.ts"],
    });
    // item 1 acted-on (src/redact.ts changed), item 2 unexplained (README didn't).
    expect(half.actedOnRate).toBe(0.5);
  });

  it("reports overrideRate over all items", () => {
    const out = computeOutcomes({
      previous: prev,
      current: verdict([item(1, "FAIL"), item(2, "UNVERIFIABLE"), item(3, "PASS")]),
      overriddenItemIds: [1, 2],
    });
    expect(out.overrideRate).toBeCloseTo(2 / 3);
  });
});

describe("outcome rows", () => {
  it("emits one flat labeled row per item", () => {
    const current = verdict([item(1, "PASS", { confidence: 0.9 })]);
    const summary = computeOutcomes({
      previous: verdict(
        [
          item(1, "FAIL", {
            evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"],
          }),
        ],
        "sha-old",
      ),
      current,
      changedPaths: ["src/a.ts"],
    });
    const rows = toOutcomeRows({
      verdict: current,
      summary,
      repo: "OgenticAI/agent-reviewer",
      pr: 62,
      generatedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: "OgenticAI/agent-reviewer",
      pr: 62,
      itemId: 1,
      status: "PASS",
      previousStatus: "FAIL",
      outcome: "acted-on",
      confidence: 0.9,
    });
  });

  it("renders JSONL — one parseable object per line", () => {
    const current = verdict([item(1, "PASS"), item(2, "FAIL")]);
    const summary = computeOutcomes({ previous: null, current });
    const text = renderOutcomeRows(
      toOutcomeRows({
        verdict: current,
        summary,
        repo: "r",
        pr: 1,
        generatedAt: "2026-07-19T12:00:00.000Z",
      }),
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });

  // ── Suggestion applied/ignored telemetry (OGE-1605) ────────────────────────
  //
  // The rate only means something if the denominator is right. Items that were
  // never offered a suggestion must stay out of it entirely — otherwise every
  // PR full of un-suggested findings drags the applied rate toward zero and the
  // number stops tracking suggestion quality at all.

  const withFix = {
    suggestedFix: { path: "src/a.ts", startLine: 3, endLine: 3, replacement: "fixed" },
  };

  it("counts a suggestion as applied when the finding was acted on", () => {
    const previous = verdict([item(1, "FAIL", { ...withFix, evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] })]);
    const current = verdict([item(1, "PASS")]);
    const summary = computeOutcomes({
      previous,
      current,
      changedPaths: ["src/a.ts"],
    });
    expect(summary.items[0]!.outcome).toBe("acted-on");
    expect(summary.items[0]!.suggestionOutcome).toBe("applied");
    expect(summary.suggestionAppliedRate).toBe(1);
  });

  it("counts a suggestion as ignored when the item is still failing", () => {
    const previous = verdict([item(1, "FAIL", { ...withFix, evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] })]);
    const current = verdict([item(1, "FAIL")]);
    const summary = computeOutcomes({ previous, current, changedPaths: [] });
    expect(summary.items[0]!.outcome).toBe("outstanding");
    expect(summary.items[0]!.suggestionOutcome).toBe("ignored");
    expect(summary.suggestionAppliedRate).toBe(0);
  });

  it("counts a clicked-but-ineffective suggestion as ignored — the fix did not clear the criterion", () => {
    // The author applied it, the file changed, and the item STILL fails. The
    // metric measures whether the suggested fix resolved the finding, not
    // whether the button was pressed. Still failing means it did not work.
    const previous = verdict([item(1, "FAIL", { ...withFix, evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] })]);
    const current = verdict([item(1, "FAIL")]);
    const summary = computeOutcomes({
      previous,
      current,
      changedPaths: ["src/a.ts"],
    });
    expect(summary.items[0]!.suggestionOutcome).toBe("ignored");
  });

  it("leaves items that were never offered a suggestion out of the rate entirely", () => {
    const previous = verdict([
      item(1, "FAIL", { ...withFix, evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] }),
      item(2, "FAIL", { evidenceRefs: [{ kind: "file", path: "src/b.ts" }] as ItemVerdict["evidenceRefs"] }),
      item(3, "FAIL", { evidenceRefs: [{ kind: "file", path: "src/c.ts" }] as ItemVerdict["evidenceRefs"] }),
    ]);
    const current = verdict([item(1, "PASS"), item(2, "FAIL"), item(3, "FAIL")]);
    const summary = computeOutcomes({ previous, current, changedPaths: ["src/a.ts"] });

    expect(summary.items[1]!.suggestionOutcome).toBeNull();
    expect(summary.items[2]!.suggestionOutcome).toBeNull();
    // 1 applied, 0 ignored — the two un-suggested failures are not in the ratio.
    expect(summary.suggestionAppliedRate).toBe(1);
  });

  it("keeps an overridden item out of the rate — a force-pass says nothing about the suggestion", () => {
    const previous = verdict([item(1, "FAIL", { ...withFix, evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] })]);
    const current = verdict([item(1, "FAIL")]);
    const summary = computeOutcomes({
      previous,
      current,
      changedPaths: [],
      overriddenItemIds: [1],
    });
    expect(summary.items[0]!.outcome).toBe("overridden");
    expect(summary.items[0]!.suggestionOutcome).toBeNull();
    expect(summary.suggestionAppliedRate).toBeNull();
  });

  it("reports null rather than 0 when no suggestion was ever offered", () => {
    const previous = verdict([item(1, "FAIL", { evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] })]);
    const current = verdict([item(1, "PASS")]);
    const summary = computeOutcomes({ previous, current, changedPaths: ["src/a.ts"] });
    expect(summary.suggestionAppliedRate).toBeNull();
  });

  it("carries suggestionOutcome into the JSONL row, omitted when absent", () => {
    const previous = verdict([
      item(1, "FAIL", { ...withFix, evidenceRefs: [{ kind: "file", path: "src/a.ts" }] as ItemVerdict["evidenceRefs"] }),
      item(2, "FAIL", { evidenceRefs: [{ kind: "file", path: "src/b.ts" }] as ItemVerdict["evidenceRefs"] }),
    ]);
    const current = verdict([item(1, "PASS"), item(2, "PASS")]);
    const summary = computeOutcomes({ previous, current, changedPaths: ["src/a.ts", "src/b.ts"] });
    const rows = toOutcomeRows({
      verdict: current,
      summary,
      repo: "r",
      pr: 1,
      generatedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(rows[0]!.suggestionOutcome).toBe("applied");
    expect("suggestionOutcome" in rows[1]!).toBe(false);
  });
});
