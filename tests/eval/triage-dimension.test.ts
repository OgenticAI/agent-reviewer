/**
 * The triage on/off eval dimension (OGE-1606).
 *
 * The dimension exists to answer one question before triage is enabled by
 * default: does the cheap pre-pass make the reviewer punt less? The failure
 * mode this file guards is not a wrong number — it is a CONFIDENT number over
 * an empty or lopsided sample.
 *
 * Two ways that happens, both tested here:
 *   1. No fixture carries a triage arm, so nothing is compared, and a delta of
 *      0 gets read as "triage has no effect".
 *   2. Some fixtures carry an arm and some do not, and the off rate is averaged
 *      over the whole set while the on rate covers a subset — comparing two
 *      different populations and calling the difference a triage effect.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadFixtures, runTriageDimension, formatTriageDimension } from "../../src/eval/run.js";
import { replayFixtureWithTriage } from "../../src/eval/replay.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "eval", "fixtures");

describe("triage dimension", () => {
  it("returns null for a fixture with no triage arm rather than inventing one", async () => {
    const [fixture] = loadFixtures(FIXTURE_DIR);
    expect(fixture).toBeDefined();
    // The committed fixtures predate the arm; none should fabricate a result.
    const produced = await replayFixtureWithTriage({ ...fixture!, triageArm: undefined });
    expect(produced).toBeNull();
  });

  it("reports NO DATA — never a zero delta — when nothing carries an arm", async () => {
    const report = await runTriageDimension({ dir: FIXTURE_DIR });

    // The committed fixture set has no triage arms yet. That must surface as
    // absence of evidence, not as evidence of absence.
    if (report.compared.length === 0) {
      expect(report.delta).toBeNull();
      expect(report.puntRateOff).toBeNull();
      expect(report.puntRateOn).toBeNull();
      expect(report.skipped.length).toBeGreaterThan(0);

      const text = formatTriageDimension(report);
      expect(text).toContain("NO DATA");
      expect(text).toContain("not evidence that triage has no effect");
      // The one thing this must never render is a confident 0.0%.
      expect(text).not.toMatch(/punt rate off: 0\.0%/);
    }
  });

  it("actually replays the triage-on arm end to end when one is recorded", async () => {
    // Built in memory, NOT committed to eval/fixtures — a synthetic fixture in
    // the gold set would be replayed by the CI gate as if it were a real
    // recorded review, which is exactly the kind of fake ground truth the
    // harness exists to avoid. This proves the code path, nothing more.
    const [base] = loadFixtures(FIXTURE_DIR);
    expect(base).toBeDefined();

    const ids = base!.expected.items.map((i) => i.id);
    const withArm = {
      ...base!,
      triageArm: {
        triageResponse: JSON.stringify({
          items: ids.map((id) => ({ id, routing: "trivial", suggestedFiles: [] })),
        }),
        // Same recorded verdict as the off arm: this test asserts the plumbing
        // runs and returns a table, not that triage changed anything.
        modelResponse: base!.modelResponse,
      },
    };

    const produced = await replayFixtureWithTriage(withArm);
    expect(produced).not.toBeNull();
    expect(produced!.items.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(produced!.overall).toBe(base!.expected.overall);
  });

  it("never counts a skipped fixture as compared", async () => {
    const report = await runTriageDimension({ dir: FIXTURE_DIR });
    const all = loadFixtures(FIXTURE_DIR).map((f) => f.name);
    expect([...report.compared, ...report.skipped].sort()).toEqual([...all].sort());
    expect(report.compared.filter((n) => report.skipped.includes(n))).toEqual([]);
  });

  it("names the uncompared fixtures in the summary so coverage is visible", async () => {
    const report = await runTriageDimension({ dir: FIXTURE_DIR });
    const text = formatTriageDimension(report);
    if (report.skipped.length > 0 && report.compared.length > 0) {
      expect(text).toContain("NOT compared (no triageArm)");
      expect(text).toContain("Coverage is");
    }
    // Either way the reader can tell how much of the set the number covers.
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("triage dimension formatting", () => {
  it("states the direction of the effect in words, not just a signed number", () => {
    const reduced = formatTriageDimension({
      compared: ["a", "b"],
      skipped: [],
      puntRateOff: 0.5,
      puntRateOn: 0.25,
      delta: -0.25,
    });
    expect(reduced).toContain("reduced punting by 25.0%");

    const raised = formatTriageDimension({
      compared: ["a"],
      skipped: [],
      puntRateOff: 0.2,
      puntRateOn: 0.4,
      delta: 0.2,
    });
    expect(raised).toContain("raised punting by 20.0%");

    const flat = formatTriageDimension({
      compared: ["a"],
      skipped: [],
      puntRateOff: 0.3,
      puntRateOn: 0.3,
      delta: 0,
    });
    expect(flat).toContain("did not change punting");
  });

  it("flags partial coverage next to the delta, so the number is never read bare", () => {
    const text = formatTriageDimension({
      compared: ["a"],
      skipped: ["b", "c", "d"],
      puntRateOff: 0.5,
      puntRateOn: 0.1,
      delta: -0.4,
    });
    expect(text).toContain("reduced punting by 40.0%");
    expect(text).toContain("NOT compared (no triageArm): b, c, d");
    expect(text).toContain("Coverage is 1/4");
  });
});
