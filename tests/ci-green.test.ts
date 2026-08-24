import { describe, expect, it } from "vitest";
import type { Octokit } from "@octokit/rest";

import { isCiGreen } from "../src/pr/ci-green.js";

/**
 * Build a minimal Octokit stub that returns the canned `checks` and
 * `combinedStatus` responses we want. Anything not provided defaults to the
 * empty / `pending` shapes GitHub returns for commits with no signal.
 *
 * We don't pull in a full Octokit mock library — `isCiGreen` only touches two
 * methods, and the test signal is cleaner when each case spells them out.
 */
function makeOctokit(opts: {
  checks?: Array<{ conclusion: string | null }>;
  combinedState?: "success" | "pending" | "failure";
  statuses?: Array<{ state: string }>;
  throws?: "checks" | "status";
}): Octokit {
  const { checks = [], combinedState = "pending", statuses = [], throws } = opts;
  return {
    checks: {
      listForRef: async () => {
        if (throws === "checks") throw new Error("boom");
        return { data: { check_runs: checks } };
      },
    },
    repos: {
      getCombinedStatusForRef: async () => {
        if (throws === "status") throw new Error("boom");
        return { data: { state: combinedState, statuses } };
      },
    },
  } as unknown as Octokit;
}

const REF_ARGS = { owner: "OgenticAI", repo: "agent-reviewer", ref: "abc123" };

describe("isCiGreen", () => {
  // ─── The OGE-394 bug-fix case ────────────────────────────────────────────

  it("returns true when there are no statuses and every check is green", async () => {
    // The regression case: combined-status API returns pending+empty contexts
    // for a repo that publishes only Checks. Previously this short-circuited
    // to false; now it falls through correctly.
    const octokit = makeOctokit({
      combinedState: "pending",
      statuses: [],
      checks: [
        { conclusion: "success" },
        { conclusion: "success" },
        { conclusion: "neutral" }, // OgenticAI Reviewer's own neutral verdict
      ],
    });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(true);
  });

  it("treats null conclusion (in-progress check) as non-blocking", async () => {
    // Matches the AC: `success` / `neutral` / `skipped` / `null` all pass.
    // The reviewer itself runs as a Check, so its own in-progress state
    // shouldn't block the Ready-to-Merge transition.
    const octokit = makeOctokit({
      combinedState: "pending",
      statuses: [],
      checks: [
        { conclusion: "success" },
        { conclusion: null }, // in-progress
        { conclusion: "skipped" },
      ],
    });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(true);
  });

  // ─── Failing-check cases ─────────────────────────────────────────────────

  it("returns false when any check has a blocking conclusion", async () => {
    for (const blocking of ["failure", "cancelled", "timed_out", "action_required"]) {
      const octokit = makeOctokit({
        combinedState: "pending",
        statuses: [],
        checks: [
          { conclusion: "success" },
          { conclusion: blocking },
          { conclusion: "success" },
        ],
      });
      expect(await isCiGreen(octokit, REF_ARGS)).toBe(false);
    }
  });

  // ─── Statuses-present cases (legacy CI paths) ────────────────────────────

  it("requires combined status === 'success' when statuses are present", async () => {
    const octokit = makeOctokit({
      combinedState: "pending", // still running
      statuses: [{ state: "pending" }],
      checks: [{ conclusion: "success" }],
    });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(false);
  });

  it("returns true when statuses are all green AND checks are all green", async () => {
    const octokit = makeOctokit({
      combinedState: "success",
      statuses: [{ state: "success" }],
      checks: [{ conclusion: "success" }],
    });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(true);
  });

  it("returns false when statuses are green but a check is failing", async () => {
    const octokit = makeOctokit({
      combinedState: "success",
      statuses: [{ state: "success" }],
      checks: [{ conclusion: "failure" }],
    });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(false);
  });

  // ─── No-CI and failure-mode cases ────────────────────────────────────────

  it("returns false when there are neither statuses nor checks (no CI at all)", async () => {
    // A commit with literally zero CI evidence shouldn't auto-promote.
    const octokit = makeOctokit({
      combinedState: "pending",
      statuses: [],
      checks: [],
    });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(false);
  });

  it("returns false when the Checks API throws", async () => {
    // Hardening: the gate must never raise into the writeback path.
    const octokit = makeOctokit({ throws: "checks" });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(false);
  });

  it("returns false when the Statuses API throws", async () => {
    const octokit = makeOctokit({ throws: "status" });
    expect(await isCiGreen(octokit, REF_ARGS)).toBe(false);
  });
});
