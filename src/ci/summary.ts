/**
 * Per-check CI detail for the verdict prompt (OGE-1554).
 *
 * The single largest tool-fixable category of punts — 13 mentions — is items
 * asserting things CI already proved, in a job that already ran:
 *
 *   OGE-1028: "CI execution and auto-merge status require external verification."
 *   OGE-1278: "UAT items 1 and 3 require observing actual CI runs."
 *
 * The galling part is that the reviewer was **already fetching this**.
 * `isCiGreen()` reads every check run for the head SHA — and its boolean
 * result went only to the Linear writeback gate, never into the prompt. The
 * model was told nothing about it and dutifully reported that CI status
 * "requires external verification".
 *
 * This module produces the richer shape the prompt needs. `isCiGreen` keeps
 * its own narrow boolean contract for the Ready-to-Merge transition, which is
 * a different question with different semantics (in-progress counts as
 * non-blocking there; here we want the model to see "still running" as
 * exactly that).
 *
 * What CI status does and does not prove — the distinction the prompt leans on:
 *   - It *does* show that a named job passed or failed on this exact commit.
 *   - It does *not* show what the suite contains. "All 225 tests pass" needs
 *     the run's log output, not its conclusion. That is OGE-1557.
 */

import type { Octokit } from "@octokit/rest";

export interface CiCheckRun {
  name: string;
  /** `queued` | `in_progress` | `completed`. */
  status: string;
  /** `success` | `failure` | `neutral` | `cancelled` | `skipped` | … | null while running. */
  conclusion: string | null;
}

export interface CiCommitStatus {
  context: string;
  /** `success` | `failure` | `pending` | `error`. */
  state: string;
}

export interface CiSummary {
  /**
   * False when the API calls failed. The prompt then says the status is
   * unavailable rather than implying an empty result means "no CI" — those
   * are very different facts and conflating them would let a rate-limited
   * fetch read as a green build.
   */
  available: boolean;
  checks: CiCheckRun[];
  statuses: CiCommitStatus[];
}

export const CI_UNAVAILABLE: CiSummary = { available: false, checks: [], statuses: [] };

/**
 * Read every check run and commit status for a ref.
 *
 * Never throws: a CI-fetch failure must not take down the review. It degrades
 * to `CI_UNAVAILABLE`, which the prompt reports honestly.
 */
export async function fetchCiSummary(
  octokit: Octokit,
  args: { owner: string; repo: string; ref: string },
): Promise<CiSummary> {
  try {
    const [checksResp, statusResp] = await Promise.all([
      octokit.checks.listForRef({ ...args }),
      octokit.repos.getCombinedStatusForRef({ ...args }),
    ]);
    return {
      available: true,
      checks: checksResp.data.check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
      })),
      statuses: statusResp.data.statuses.map((s) => ({ context: s.context, state: s.state })),
    };
  } catch {
    return CI_UNAVAILABLE;
  }
}

/**
 * Render the CI section of the prompt, or null when there is nothing useful
 * to say.
 *
 * Returning null on "available but empty" is deliberate: a repo with no CI
 * configured gains nothing from a section saying so, and an empty section
 * would perturb the prompt (and therefore the cache key) on every such repo
 * for no benefit.
 */
export function renderCiSection(summary: CiSummary, headSha: string): string | null {
  if (!summary.available) {
    return [
      `## CI status for \`${headSha.slice(0, 7)}\``,
      ``,
      `_Could not be read this run (API error). Treat CI as unknown — do not`,
      `assume either pass or fail from its absence._`,
    ].join("\n");
  }

  if (summary.checks.length === 0 && summary.statuses.length === 0) return null;

  const lines = [`## CI status for \`${headSha.slice(0, 7)}\``, ``];

  for (const check of summary.checks) {
    const verdict =
      check.status !== "completed" ? `${check.status} (no conclusion yet)` : (check.conclusion ?? "unknown");
    lines.push(`- **${check.name}** — ${verdict}`);
  }
  for (const status of summary.statuses) {
    lines.push(`- **${status.context}** (legacy status) — ${status.state}`);
  }

  lines.push(``);
  lines.push(
    `This is real evidence about **this commit** — use it. A named job reported`,
  );
  lines.push(
    `as \`success\` is grounds to PASS an item asserting that job passes; a`,
  );
  lines.push(`\`failure\` is grounds to FAIL one.`);
  lines.push(``);
  lines.push(
    `But it shows only whether a job passed — not what it contains. An item`,
  );
  lines.push(
    `naming a specific test, a pass count, or a benchmark number is NOT settled`,
  );
  lines.push(
    `by a green check; you would need the run's log output, which you do not`,
  );
  lines.push(`have. A job still running settles nothing either way.`);

  return lines.join("\n");
}
