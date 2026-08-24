/**
 * CI status in the verdict prompt (OGE-1554).
 *
 * The distinction these tests protect is the one the whole ticket turns on:
 * a green check proves a *job* passed, not what the job contains. If the model
 * treats "CI is green" as settling "all 225 tests pass", the reviewer trades
 * an honest punt for a confident wrong PASS — strictly worse.
 */

import { describe, expect, it } from "vitest";

import { CI_UNAVAILABLE, renderCiSection, type CiSummary } from "../../src/pr/ci/summary.js";

const SHA = "f6299112233aabbccdd";

function summary(overrides: Partial<CiSummary> = {}): CiSummary {
  return { available: true, checks: [], statuses: [], ...overrides };
}

describe("renderCiSection", () => {
  it("returns null when CI is readable but the commit has none", () => {
    // An empty section would perturb the prompt (and the cache key) on every
    // CI-less repo for no benefit.
    expect(renderCiSection(summary(), SHA)).toBeNull();
  });

  it("distinguishes an unreadable API from a commit with no CI", () => {
    // Conflating these would let a rate-limited fetch read as a green build.
    const body = renderCiSection(CI_UNAVAILABLE, SHA)!;
    expect(body).toContain("Could not be read this run");
    expect(body).toContain("do not");
    expect(body).toMatch(/assume either pass or fail/);
  });

  it("lists each completed check with its conclusion", () => {
    const body = renderCiSection(
      summary({
        checks: [
          { name: "CI", status: "completed", conclusion: "success" },
          { name: "OgenticAI Reviewer / UAT", status: "completed", conclusion: "failure" },
        ],
      }),
      SHA,
    )!;
    expect(body).toContain("**CI** — success");
    expect(body).toContain("**OgenticAI Reviewer / UAT** — failure");
  });

  it("shows an in-progress check as running, not as a conclusion", () => {
    const body = renderCiSection(
      summary({ checks: [{ name: "CI", status: "in_progress", conclusion: null }] }),
      SHA,
    )!;
    expect(body).toContain("in_progress (no conclusion yet)");
  });

  it("includes legacy commit statuses", () => {
    const body = renderCiSection(
      summary({ statuses: [{ context: "continuous-integration/travis", state: "success" }] }),
      SHA,
    )!;
    expect(body).toContain("continuous-integration/travis");
    expect(body).toContain("legacy status");
  });

  it("tells the model a green job is grounds to PASS a job-level claim", () => {
    const body = renderCiSection(
      summary({ checks: [{ name: "CI", status: "completed", conclusion: "success" }] }),
      SHA,
    )!;
    expect(body).toMatch(/grounds to PASS/);
    expect(body).toMatch(/grounds to FAIL/);
  });

  it("warns that a green check does NOT settle a test-count or benchmark claim", () => {
    const body = renderCiSection(
      summary({ checks: [{ name: "CI", status: "completed", conclusion: "success" }] }),
      SHA,
    )!;
    expect(body).toMatch(/not what it contains/);
    expect(body).toMatch(/pass count/);
    expect(body).toMatch(/log output/);
  });

  it("scopes the section to the head SHA it was read for", () => {
    const body = renderCiSection(
      summary({ checks: [{ name: "CI", status: "completed", conclusion: "success" }] }),
      SHA,
    )!;
    expect(body).toContain(SHA.slice(0, 7));
  });

  it("is deterministic for identical input", () => {
    const s = summary({ checks: [{ name: "CI", status: "completed", conclusion: "success" }] });
    expect(renderCiSection(s, SHA)).toBe(renderCiSection(s, SHA));
  });
});
