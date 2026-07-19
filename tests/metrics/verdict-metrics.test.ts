/**
 * Punt-rate instrumentation (OGE-1562).
 *
 * The project exists to move one number, and that number was originally
 * established by hand — mining 364 Linear issues and categorising rationales
 * by eye. These tests pin the arithmetic so the before/after is trustworthy,
 * particularly the two places it would be easy to flatter the result:
 * excluding `[human]` items, and reporting a rate over an empty denominator.
 */

import { describe, expect, it } from "vitest";

import {
  computeVerdictMetrics,
  parseMetricsBlock,
  renderMetricsBlock,
} from "../../src/metrics/verdict-metrics.js";
import { ReviewVerdict, type VerdictStatus } from "../../src/schema/verdict.js";

function verdict(items: Array<{ status: VerdictStatus; human?: boolean }>): ReviewVerdict {
  return ReviewVerdict.parse({
    schemaVersion: 1,
    reviewerVersion: "v3",
    ticketId: "OGE-308",
    prRef: "OgenticAI/x#1",
    headSha: "f6299112233",
    items: items.map((it, i) => ({
      id: i + 1,
      itemText: `item ${i + 1}`,
      status: it.status,
      rationale: "r",
      evidenceRefs: [],
      ...(it.human === undefined ? {} : { human: it.human }),
    })),
    summary: "s",
    generatedAt: "2026-04-27T08:30:00.000Z",
  });
}

function metrics(items: Array<{ status: VerdictStatus; human?: boolean }>) {
  return computeVerdictMetrics({
    verdict: verdict(items),
    toolCalls: 0,
    researchQueries: 0,
    cached: false,
  });
}

describe("computeVerdictMetrics", () => {
  it("counts each status", () => {
    const m = metrics([{ status: "PASS" }, { status: "FAIL" }, { status: "UNVERIFIABLE" }]);
    expect(m.counts).toEqual({ PASS: 1, FAIL: 1, PARTIAL: 0, UNVERIFIABLE: 1 });
    expect(m.totalItems).toBe(3);
  });

  it("excludes [human] items from the punt rate", () => {
    // A [human] item is a correct punt. Counting it against the reviewer would
    // make the metric worse every time someone writes a more honest checklist.
    const m = metrics([
      { status: "PASS" },
      { status: "PASS" },
      { status: "UNVERIFIABLE", human: true },
    ]);
    expect(m.humanMarked).toBe(1);
    expect(m.verifiableItems).toBe(2);
    expect(m.puntRate).toBe(0);
  });

  it("keeps the raw rate comparable with the historical 88% baseline", () => {
    // The baseline predates [human], so an adjusted number compared against it
    // would flatter the result.
    const m = metrics([
      { status: "PASS" },
      { status: "PASS" },
      { status: "UNVERIFIABLE", human: true },
    ]);
    expect(m.rawPuntRate).toBeCloseTo(1 / 3);
  });

  it("counts an unmarked unverifiable item as a punt", () => {
    const m = metrics([{ status: "PASS" }, { status: "UNVERIFIABLE" }]);
    expect(m.puntRate).toBe(0.5);
  });

  it("reports null, not zero, when there is nothing the reviewer could settle", () => {
    // A rate over an empty denominator is undefined; reporting 0 would read
    // as a perfect score on a checklist of nothing but human sign-offs.
    const m = metrics([{ status: "UNVERIFIABLE", human: true }]);
    expect(m.puntRate).toBeNull();
    expect(m.verifiableItems).toBe(0);
  });

  it("reports null rates for an empty checklist", () => {
    const m = metrics([]);
    expect(m.puntRate).toBeNull();
    expect(m.rawPuntRate).toBeNull();
  });

  it("carries run telemetry", () => {
    const m = computeVerdictMetrics({
      verdict: verdict([{ status: "PASS" }]),
      toolCalls: 4,
      researchQueries: 2,
      cached: true,
      degraded: "iteration cap of 12 reached",
    });
    expect(m).toMatchObject({
      toolCalls: 4,
      researchQueries: 2,
      cached: true,
      degraded: "iteration cap of 12 reached",
    });
  });

  it("omits degraded entirely on a clean run", () => {
    expect(metrics([{ status: "PASS" }]).degraded).toBeUndefined();
  });
});

describe("metrics block round-trip", () => {
  it("parses back what it renders", () => {
    const m = metrics([{ status: "PASS" }, { status: "UNVERIFIABLE" }]);
    expect(parseMetricsBlock(renderMetricsBlock(m))).toEqual(m);
  });

  it("survives being embedded in surrounding comment text", () => {
    const m = metrics([{ status: "PASS" }]);
    const body = `# Verdict\n\nsome prose\n\n${renderMetricsBlock(m)}\n`;
    expect(parseMetricsBlock(body)?.totalItems).toBe(1);
  });

  it("returns null when no block is present", () => {
    expect(parseMetricsBlock("no metrics here")).toBeNull();
  });

  it("returns null on a malformed block rather than throwing", () => {
    expect(parseMetricsBlock("<!-- ogenticai-reviewer-metrics {not json} -->")).toBeNull();
  });
});
