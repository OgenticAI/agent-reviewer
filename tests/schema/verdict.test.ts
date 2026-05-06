import { describe, expect, it } from "vitest";

import {
  autoPatchableFails,
  ItemVerdict,
  overallStatus,
  ReviewVerdict,
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
