/**
 * Release drift: is `main` running ahead of what consumers actually execute?
 * (OGE-1667)
 *
 * OGE-1653 named this the real defect: *"That silent drift is the actual
 * defect; the stale tag is its symptom."* `main` sat 26 commits and 2.5 months
 * ahead of the `v2` tag every consumer pins. Twenty-six tickets were marked
 * Done while none of that code ran anywhere, and nothing surfaced it — it was
 * found by accident while investigating something else.
 *
 * ── What this measures, and against what ────────────────────────────────────
 *
 * Drift is measured against **the tag consumers actually pin** — the floating
 * major (`v2`) — not the newest semver tag. That distinction is the whole
 * point: `v2.1.0` existed and pointed at `main` the entire time `v2` pointed at
 * May. A check comparing `main` to "the latest tag" would have reported zero
 * drift while every consumer ran three-month-old code.
 *
 * ── Why two thresholds ──────────────────────────────────────────────────────
 *
 * Either alone misses a real case. Forty commits merged in two days is as much
 * unreleased exposure as three commits sitting for three months. Commits catch
 * volume; age catches neglect.
 *
 * Pure by design: all git facts are passed in, so the thresholds and the
 * message are unit-testable without a repository. `scripts/check-drift.ts`
 * supplies the facts.
 */

/** Commits ahead at/above which drift fails the check. */
export const DEFAULT_MAX_COMMITS_AHEAD = 10;

/** Days since the released tag at/above which drift fails the check. */
export const DEFAULT_MAX_AGE_DAYS = 14;

export interface DriftThresholds {
  maxCommitsAhead: number;
  maxAgeDays: number;
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  maxCommitsAhead: DEFAULT_MAX_COMMITS_AHEAD,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
};

export interface DriftFacts {
  /** The floating tag consumers pin, e.g. "v2". */
  tag: string;
  /**
   * Commits on `main` not reachable from the tag.
   *
   * Computed as `git rev-list --count <tag>..main`, which stays correct even
   * when the tag is not an ancestor of `main` — the squash-merge case, where
   * the tagged commit was rewritten out of history and a naive ancestor check
   * reports something misleading.
   */
  commitsAhead: number;
  /** When the tagged commit was authored. Null when the tag doesn't exist. */
  tagDate: Date | null;
  /** Now, injected so the age branch is testable. */
  now: Date;
}

export type DriftStatus = "current" | "drifting" | "stale" | "no-release";

export interface DriftResult {
  status: DriftStatus;
  /** True when CI should fail. */
  failed: boolean;
  commitsAhead: number;
  ageDays: number | null;
  /** Operator-facing explanation, naming the remedy — never just a number. */
  message: string;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Classify drift.
 *
 * - `no-release` — the floating tag doesn't exist. Fails: consumers pinning it
 *   are broken right now, which is worse than drift, not better.
 * - `current` — nothing unreleased. The only genuinely healthy state.
 * - `drifting` — unreleased work, still inside both thresholds. Reported, not
 *   failed; requiring zero would force a release per merge, and that pressure
 *   leads straight to auto-tagging 22 repos on every commit.
 * - `stale` — past a threshold. Fails.
 */
export function assessDrift(facts: DriftFacts, thresholds = DEFAULT_THRESHOLDS): DriftResult {
  const { tag, commitsAhead, tagDate, now } = facts;

  if (tagDate === null) {
    return {
      status: "no-release",
      failed: true,
      commitsAhead,
      ageDays: null,
      message:
        `The floating tag \`${tag}\` does not exist. Every consumer pinning ` +
        `\`@${tag}\` is failing to resolve the action right now. ` +
        `Cut a release: Actions → Release → Run workflow.`,
    };
  }

  const ageDays = daysBetween(tagDate, now);

  if (commitsAhead === 0) {
    return {
      status: "current",
      failed: false,
      commitsAhead,
      ageDays,
      message: `\`${tag}\` is level with \`main\` — consumers run what is on main.`,
    };
  }

  const overCommits = commitsAhead >= thresholds.maxCommitsAhead;
  const overAge = ageDays >= thresholds.maxAgeDays;

  if (overCommits || overAge) {
    const reasons = [
      overCommits ? `${commitsAhead} commits ahead (limit ${thresholds.maxCommitsAhead})` : null,
      overAge ? `last released ${ageDays} days ago (limit ${thresholds.maxAgeDays})` : null,
    ].filter(Boolean);
    return {
      status: "stale",
      failed: true,
      commitsAhead,
      ageDays,
      message:
        `\`main\` has drifted from \`${tag}\`: ${reasons.join(", ")}.\n` +
        `Consumers pin \`@${tag}\`, so none of that work is running anywhere — ` +
        `it is merged, not shipped.\n` +
        `Cut a release: Actions → Release → Run workflow (it gates on typecheck, ` +
        `tests and eval before tagging).`,
    };
  }

  return {
    status: "drifting",
    failed: false,
    commitsAhead,
    ageDays,
    message:
      `${commitsAhead} commit(s) on \`main\` are not in \`${tag}\` ` +
      `(released ${ageDays} day(s) ago). Within thresholds — no action needed yet.`,
  };
}

/** One-line summary for a CI log or job summary. */
export function formatDrift(result: DriftResult): string {
  const icon = result.failed ? "FAIL" : result.status === "current" ? "OK" : "INFO";
  return `[drift:${icon}] ${result.message}`;
}
