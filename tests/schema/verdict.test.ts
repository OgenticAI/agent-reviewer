import { describe, expect, it } from "vitest";

import {
  autoPatchableFails,
  ItemVerdict,
  overallStatus,
  ReviewVerdict,
  type VerdictStatus,
} from "../../src/schema/verdict.js";

describe("ItemVerdict schema", () => {
  it("accepts an item without autoPatchable (omitted = not auto-patchable)", () => {
    const parsed = ItemVerdict.parse({
      id: 1,
      itemText: "x",
      status: "PASS",
      rationale: "ok",
    });
    expect(parsed.autoPatchable).toBeUndefined();
    expect(parsed.evidenceRefs).toEqual([]);
  });

  it("accepts autoPatchable=true", () => {
    const parsed = ItemVerdict.parse({
      id: 1,
      itemText: "x",
      status: "FAIL",
      rationale: "missing test",
      autoPatchable: true,
    });
    expect(parsed.autoPatchable).toBe(true);
  });

  it("rejects non-boolean autoPatchable", () => {
    expect(() =>
      ItemVerdict.parse({
        id: 1,
        itemText: "x",
        status: "PASS",
        rationale: "y",
        autoPatchable: "yes",
      }),
    ).toThrow();
  });
});

describe("autoPatchableFails", () => {
  function makeVerdict(
    items: Array<Partial<ReviewVerdict["items"][number]>>,
  ): ReviewVerdict {
    return ReviewVerdict.parse({
      schemaVersion: 1,
      reviewerVersion: "v1",
      ticketId: "OGE-1",
      prRef: "x/y#1",
      headSha: "abc1234",
      items: items.map((it, i) => ({
        id: i + 1,
        itemText: it.itemText ?? `item ${i}`,
        status: it.status ?? "PASS",
        rationale: it.rationale ?? "x",
        evidenceRefs: it.evidenceRefs ?? [],
        autoPatchable: it.autoPatchable ?? false,
      })),
      summary: "x",
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
  }

  it("returns only FAIL items with autoPatchable=true", () => {
    const v = makeVerdict([
      { status: "PASS", autoPatchable: true }, // not FAIL
      { status: "FAIL", autoPatchable: false }, // not autoPatchable
      { status: "FAIL", autoPatchable: true }, // ✔
      { status: "PARTIAL", autoPatchable: true }, // not FAIL
      { status: "FAIL", autoPatchable: true }, // ✔
    ]);
    const fails = autoPatchableFails(v);
    expect(fails).toHaveLength(2);
    expect(fails.every((it) => it.status === "FAIL" && it.autoPatchable)).toBe(true);
  });

  it("returns [] when no items qualify", () => {
    const v = makeVerdict([
      { status: "PASS" },
      { status: "PARTIAL" },
      { status: "UNVERIFIABLE" },
    ]);
    expect(autoPatchableFails(v)).toEqual([]);
  });
});

describe("overallStatus (sanity recheck after schema bump)", () => {
  it("autoPatchable doesn't influence overall — only status does", () => {
    const v = ReviewVerdict.parse({
      schemaVersion: 1,
      reviewerVersion: "v1",
      ticketId: "OGE-1",
      prRef: "x/y#1",
      headSha: "abc1234",
      items: [
        {
          id: 1,
          itemText: "x",
          status: "PASS",
          rationale: "ok",
          evidenceRefs: [],
          autoPatchable: true,
        },
      ],
      summary: "x",
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
    expect(overallStatus(v)).toBe("PASS");
  });
});

/**
 * OGE-1559. Before this, a checklist that honestly declared two `[human]`
 * criteria reported HUMAN_REVIEW — indistinguishable from a blind punt. That
 * made the reviewer's headline metric unmovable and quietly penalised the
 * authoring behaviour we want.
 */
describe("overallStatus — [human]-marked items", () => {
  function verdict(
    items: Array<{ status: VerdictStatus; human?: boolean }>,
  ): ReviewVerdict {
    return ReviewVerdict.parse({
      schemaVersion: 1,
      reviewerVersion: "v2",
      ticketId: "OGE-1",
      prRef: "x/y#1",
      headSha: "abc1234",
      items: items.map((it, i) => ({
        id: i + 1,
        itemText: `item ${i + 1}`,
        status: it.status,
        rationale: "x",
        evidenceRefs: [],
        ...(it.human === undefined ? {} : { human: it.human }),
      })),
      summary: "x",
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
  }

  it("ignores UNVERIFIABLE on a [human] item when everything else passes", () => {
    const v = verdict([
      { status: "PASS" },
      { status: "UNVERIFIABLE", human: true },
    ]);
    expect(overallStatus(v)).toBe("PASS");
  });

  it("still reports HUMAN_REVIEW for an UNMARKED unverifiable item", () => {
    const v = verdict([
      { status: "PASS" },
      { status: "UNVERIFIABLE", human: true },
      { status: "UNVERIFIABLE" },
    ]);
    expect(overallStatus(v)).toBe("HUMAN_REVIEW");
  });

  it("keeps FAIL authoritative even on a [human] item", () => {
    // The marker says "a person decides whether this passes", not "ignore
    // this" — positive evidence of breakage is still a real signal.
    const v = verdict([{ status: "PASS" }, { status: "FAIL", human: true }]);
    expect(overallStatus(v)).toBe("NEEDS_WORK");
  });

  it("reports HUMAN_REVIEW, not PASS, when every item is [human]-marked", () => {
    // Vacuous PASS here would read as a green light on a checklist nobody
    // has actually verified.
    const v = verdict([
      { status: "UNVERIFIABLE", human: true },
      { status: "UNVERIFIABLE", human: true },
    ]);
    expect(overallStatus(v)).toBe("HUMAN_REVIEW");
  });

  it("does not let a [human] PARTIAL downgrade an otherwise clean pass", () => {
    const v = verdict([{ status: "PASS" }, { status: "PARTIAL", human: true }]);
    expect(overallStatus(v)).toBe("PASS");
  });

  it("still reports PASS_WITH_PARTIALS for an unmarked partial", () => {
    const v = verdict([{ status: "PASS" }, { status: "PARTIAL" }]);
    expect(overallStatus(v)).toBe("PASS_WITH_PARTIALS");
  });

  it("is unchanged for verdicts with no human field at all (back-compat)", () => {
    // Sidecars written before this change carry no `human` key. They must
    // score exactly as they did before.
    expect(overallStatus(verdict([{ status: "PASS" }]))).toBe("PASS");
    expect(overallStatus(verdict([{ status: "UNVERIFIABLE" }]))).toBe("HUMAN_REVIEW");
    expect(overallStatus(verdict([{ status: "PARTIAL" }]))).toBe("PASS_WITH_PARTIALS");
    expect(overallStatus(verdict([{ status: "FAIL" }]))).toBe("NEEDS_WORK");
  });
});
