/**
 * Decide whether all CI for a given commit is green enough to auto-promote the
 * linked Linear ticket to "Ready to Merge" (the OGE-339 transition).
 *
 * Why this lives in its own module
 * --------------------------------
 * Originally an inner function of `src/cli.ts`. Extracted for OGE-394 so we can
 * unit-test the (subtle) decision logic without standing up the rest of the
 * CLI. The previous implementation gated on the legacy combined-status API
 * which returns `state: "pending"` (with empty `contexts`) for any commit on a
 * repo that publishes only Checks. That short-circuit fired on the
 * agent-reviewer repo itself — Checks-only — and the Ready-to-Merge transition
 * never ran. See OGE-394 for the live evidence.
 *
 * What "green" means here
 * -----------------------
 * Modern GitHub repos publish their CI signal through one of two APIs:
 *
 *   • **Checks API** — `octokit.checks.listForRef`. Each Check Run has a
 *     `conclusion` field. We treat `success`, `neutral`, `skipped`, and `null`
 *     (in-progress) as non-blocking. The "null is OK" choice matches the
 *     previous behaviour and the OGE-394 AC text — the reviewer itself runs
 *     as a Check, so its own in-progress state shouldn't block the
 *     "Ready to Merge" semantic.
 *
 *   • **Statuses API** — `octokit.repos.getCombinedStatusForRef`. Legacy
 *     integrations (older Travis, classic CircleCI) post here. We require
 *     either no statuses at all (empty `statuses` array), or the combined
 *     `state` to be `"success"`.
 *
 * Both signals must be green. Repos with no CI configured at all (empty under
 * both APIs) return `false` — we shouldn't auto-promote a commit that has no
 * evidence of being tested.
 *
 * Failure mode
 * ------------
 * If either API call throws (rate limit, transient outage, malformed ref), the
 * function returns `false`. Same as the original: this gate must never raise
 * into the writeback path.
 */

import type { Octokit } from "@octokit/rest";

export interface IsCiGreenArgs {
  owner: string;
  repo: string;
  /** Commit SHA or fully-qualified ref. */
  ref: string;
}

/** Conclusion values that are considered non-blocking by the Ready-to-Merge gate. */
const NON_BLOCKING_CHECK_CONCLUSIONS = new Set<string | null>([
  "success",
  "neutral",
  "skipped",
  null, // in-progress; matches the previous behaviour and OGE-394 ACs
]);

/**
 * Returns `true` iff every signal we can read for `ref` is non-blocking.
 *
 * - All Check Runs have a conclusion in {success, neutral, skipped, null}.
 * - All Statuses (if any) are aggregated to combined `state === "success"`.
 * - At least one of the two signal sources is non-empty (we don't promote
 *   commits with literally zero CI evidence).
 *
 * Any thrown error → `false`. Caller decides whether to log.
 */
export async function isCiGreen(
  octokit: Octokit,
  args: IsCiGreenArgs,
): Promise<boolean> {
  try {
    // Spread into a fresh object literal so the param matches Octokit's
    // `RequestParameters` intersection (named interfaces don't get the
    // implicit string index signature that fresh literals do).
    const [checksResp, statusResp] = await Promise.all([
      octokit.checks.listForRef({ ...args }),
      octokit.repos.getCombinedStatusForRef({ ...args }),
    ]);

    const checks = checksResp.data.check_runs;
    const statuses = statusResp.data.statuses;

    // No CI evidence on either surface → not green. Don't promote.
    if (checks.length === 0 && statuses.length === 0) {
      return false;
    }

    // Checks API: every check_run's conclusion must be non-blocking.
    const checksGreen = checks.every((run) =>
      NON_BLOCKING_CHECK_CONCLUSIONS.has(run.conclusion),
    );

    // Statuses API: either there are none (empty), or the combined state
    // must be "success". A non-empty pending/failure combined state blocks.
    const statusesGreen =
      statuses.length === 0 || statusResp.data.state === "success";

    return checksGreen && statusesGreen;
  } catch {
    return false;
  }
}
