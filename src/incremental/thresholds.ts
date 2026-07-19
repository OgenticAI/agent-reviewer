/**
 * Incremental-review thresholds (OGE-1590), mirroring Qodo's `/review -i`.
 *
 * Incremental review is worth its bookkeeping only when there's enough new work
 * to skip. Below a small number of new commits, or within a short window of the
 * last review, a full review is simpler and no more expensive — so these gates
 * decide when to take the incremental path at all. A full-review command always
 * overrides them.
 */

export interface IncrementalThresholds {
  /** Minimum new commits since the last review before going incremental. */
  minCommits: number;
  /** Minimum minutes since the last review before going incremental. */
  minMinutes: number;
}

export const DEFAULT_THRESHOLDS: IncrementalThresholds = { minCommits: 1, minMinutes: 0 };

export interface IncrementalDecision {
  incremental: boolean;
  reason: string;
}

/**
 * Decide whether this push should take the incremental path.
 *
 * A push forced full (`forceFull`) or lacking any prior review always does a
 * full review. Otherwise both thresholds must clear.
 */
export function decideIncremental(args: {
  hasPrevious: boolean;
  newCommits: number;
  minutesSinceLast: number;
  thresholds?: IncrementalThresholds;
  forceFull?: boolean;
}): IncrementalDecision {
  const t = args.thresholds ?? DEFAULT_THRESHOLDS;
  if (args.forceFull) return { incremental: false, reason: "full review requested" };
  if (!args.hasPrevious) return { incremental: false, reason: "no previous review to build on" };
  if (args.newCommits < t.minCommits) {
    return { incremental: false, reason: `fewer than ${t.minCommits} new commit(s)` };
  }
  if (args.minutesSinceLast < t.minMinutes) {
    return { incremental: false, reason: `within ${t.minMinutes} min of the last review` };
  }
  return { incremental: true, reason: `${args.newCommits} new commit(s) since last review` };
}
