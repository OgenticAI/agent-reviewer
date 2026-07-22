/**
 * Release drift detection (OGE-1667).
 *
 * The case this exists to catch is a real one: `main` sat 26 commits and 2.5
 * months ahead of the `v2` tag every consumer pinned, 26 tickets read Done, and
 * none of that code ran anywhere. It's pinned below as a regression test — if
 * the thresholds are ever loosened past it, that failure returns.
 */

import { describe, expect, it } from "vitest";

import {
  assessDrift,
  DEFAULT_THRESHOLDS,
  formatDrift,
  type DriftFacts,
} from "../../src/release/drift.js";

const NOW = new Date("2026-07-20T00:00:00Z");

function facts(over: Partial<DriftFacts> = {}): DriftFacts {
  return {
    tag: "v2",
    commitsAhead: 0,
    tagDate: new Date("2026-07-19T00:00:00Z"),
    now: NOW,
    ...over,
  };
}

describe("assessDrift", () => {
  it("is current when the tag is level with main", () => {
    const r = assessDrift(facts({ commitsAhead: 0 }));
    expect(r.status).toBe("current");
    expect(r.failed).toBe(false);
  });

  it("reports but does not fail on small, recent drift", () => {
    // Requiring zero drift would force a release per merge, and that pressure
    // leads straight to auto-tagging 22 repos on every commit.
    const r = assessDrift(facts({ commitsAhead: 3, tagDate: new Date("2026-07-18T00:00:00Z") }));
    expect(r.status).toBe("drifting");
    expect(r.failed).toBe(false);
  });

  it("fails on commit volume even when the release is recent", () => {
    // 40 commits in two days is as much unreleased exposure as a stale tag.
    const r = assessDrift(facts({ commitsAhead: 40, tagDate: new Date("2026-07-19T00:00:00Z") }));
    expect(r.status).toBe("stale");
    expect(r.failed).toBe(true);
    expect(r.message).toContain("40 commits ahead");
  });

  it("fails on age even when only a few commits landed", () => {
    const r = assessDrift(facts({ commitsAhead: 2, tagDate: new Date("2026-05-01T00:00:00Z") }));
    expect(r.status).toBe("stale");
    expect(r.failed).toBe(true);
    expect(r.message).toContain("days ago");
  });

  it("REGRESSION: catches the actual incident — 26 commits, 2.5 months", () => {
    // v2 -> 67fb38b (2026-05-07); main -> 594084d (2026-07-19).
    const r = assessDrift(
      facts({ commitsAhead: 26, tagDate: new Date("2026-05-07T00:00:00Z"), now: new Date("2026-07-19T00:00:00Z") }),
    );
    expect(r.failed).toBe(true);
    expect(r.status).toBe("stale");
    // Both thresholds were breached; the message should say so, not pick one.
    expect(r.message).toContain("26 commits ahead");
    expect(r.message).toContain("73 days ago");
  });

  it("fails when the floating tag does not exist at all", () => {
    // Worse than drift: consumers pinning @v2 can't resolve the action.
    const r = assessDrift(facts({ tagDate: null, commitsAhead: 5 }));
    expect(r.status).toBe("no-release");
    expect(r.failed).toBe(true);
    expect(r.message).toContain("does not exist");
  });

  it("names the remedy, not just the number", () => {
    // A check that reports a number and no action gets ignored.
    const r = assessDrift(facts({ commitsAhead: 26, tagDate: new Date("2026-05-07T00:00:00Z") }));
    expect(r.message).toMatch(/Actions → Release → Run workflow/);
    expect(r.message).toContain("merged, not shipped");
  });

  it("honours custom thresholds", () => {
    const strict = { maxCommitsAhead: 1, maxAgeDays: 1 };
    expect(assessDrift(facts({ commitsAhead: 2 }), strict).failed).toBe(true);
    const loose = { maxCommitsAhead: 100, maxAgeDays: 365 };
    expect(assessDrift(facts({ commitsAhead: 26, tagDate: new Date("2026-05-07T00:00:00Z") }), loose).failed).toBe(false);
  });

  it("uses thresholds that would have caught the incident by default", () => {
    // Guards the defaults themselves, not just the logic.
    expect(DEFAULT_THRESHOLDS.maxCommitsAhead).toBeLessThanOrEqual(26);
    expect(DEFAULT_THRESHOLDS.maxAgeDays).toBeLessThanOrEqual(73);
  });
});

describe("formatDrift", () => {
  it("marks a failure distinctly from a clean result", () => {
    const bad = formatDrift(assessDrift(facts({ commitsAhead: 26, tagDate: new Date("2026-05-07T00:00:00Z") })));
    const good = formatDrift(assessDrift(facts({ commitsAhead: 0 })));
    expect(bad).toContain("[drift:FAIL]");
    expect(good).toContain("[drift:OK]");
  });
});
