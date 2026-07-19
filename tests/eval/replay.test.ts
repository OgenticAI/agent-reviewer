/**
 * Gold-mode replay over the committed fixture set (OGE-1589).
 *
 * SWE-bench's discipline: before trusting the harness to MEASURE a candidate,
 * prove it reproduces every archived verdict table byte-for-byte on known-good
 * input. If a fixture doesn't reproduce its own expected labels, no regression
 * number the harness later reports means anything.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadFixtures, runEval } from "../../src/eval/run.js";
import { replayFixture } from "../../src/eval/replay.js";
import { compare } from "../../src/eval/replay.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "eval", "fixtures");
const fixtures = loadFixtures(FIXTURE_DIR);

describe("gold-mode replay", () => {
  it("ships at least 10 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))(
    "reproduces the archived verdict table for %s",
    async (_name, fixture) => {
      const result = await replayFixture(fixture);
      expect(result.labelFlips).toEqual([]);
      expect(result.overallFlip).toBe(false);
      expect(result.matches).toBe(true);
    },
  );

  it("covers every verdict class as ground truth", () => {
    const statuses = new Set(fixtures.flatMap((f) => f.expected.items.map((i) => i.status)));
    for (const s of ["PASS", "CODE_VERIFIED", "PARTIAL", "UNVERIFIABLE", "FAIL"]) {
      expect(statuses.has(s as never)).toBe(true);
    }
  });

  it("has at least one injected FAIL per non-clean class", () => {
    const injected = fixtures.filter((f) => f.origin === "injected");
    expect(injected.length).toBeGreaterThanOrEqual(3);
    expect(injected.every((f) => f.expected.items.some((i) => i.status === "FAIL"))).toBe(true);
  });
});

describe("compare", () => {
  it("flags a label flip and an overall flip", () => {
    const result = compare(
      "x",
      { items: [{ id: 1, status: "FAIL" }], overall: "NEEDS_WORK" },
      { items: [{ id: 1, status: "PASS" }], overall: "PASS" },
    );
    expect(result.matches).toBe(false);
    expect(result.labelFlips).toEqual([{ id: 1, expected: "PASS", produced: "FAIL" }]);
    expect(result.overallFlip).toBe(true);
  });
});

describe("runEval gate", () => {
  it("passes on the committed baseline (no regressions)", async () => {
    const report = await runEval({ dir: FIXTURE_DIR, baselinePuntRate: 0.1 });
    expect(report.regressions).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("fails when the punt rate regresses beyond tolerance", async () => {
    // Pretend the baseline was 0 — the fixtures' real 10% punt rate now looks
    // like a regression, which is exactly what the gate must catch.
    const report = await runEval({ dir: FIXTURE_DIR, baselinePuntRate: 0, tolerance: 0.02 });
    expect(report.puntRegressed).toBe(true);
    expect(report.passed).toBe(false);
  });
});
