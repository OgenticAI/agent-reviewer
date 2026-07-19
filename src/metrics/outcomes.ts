/**
 * Verdict outcomes — did anything happen because of what the reviewer said?
 * (OGE-1592)
 *
 * `puntRate` measures how often the reviewer declines to answer. It cannot
 * distinguish better verification from bolder guessing: a run that swaps
 * honest punts for confident wrong PASSes scores *better*. Nothing else in
 * this repo would notice.
 *
 * The fix is BitsAI-CR's **Outdated Rate**, and its appeal is that it needs no
 * human annotation at all: a finding counts as acted-on when the code it
 * pointed at changes in a later commit. We compute the same signal by diffing
 * the previous sticky sidecar against the current push.
 *
 * ── The three outcomes that matter ──────────────────────────────────────────
 *
 * - **acted-on** — a negative verdict flipped positive AND a file it cited
 *   changed. The reviewer said something and someone did something about it.
 * - **unexplained-flip** — flipped positive with no cited file touched. This
 *   is the interesting one. Either the original finding was noise, or this
 *   run is guessing where the last one investigated. Either way it is the
 *   class to review, and it is invisible without this computation.
 * - **overridden** — a human force-passed it. A real outcome, and distinct
 *   from both of the above: it means the reviewer was ignored, not agreed with.
 *
 * A high acted-on rate is the goal. A high unexplained-flip rate is the alarm.
 * Reporting them separately is the entire point — collapsing them into one
 * "resolved" number would hide exactly the failure this ticket exists to catch.
 */

import type { ItemVerdict, ReviewVerdict, VerdictStatus } from "../schema/verdict.js";
import { NON_PUNT_STATUSES } from "../schema/verdict.js";

/**
 * Statuses that represent an unmet criterion. PARTIAL counts: it names a gap,
 * and closing that gap is an outcome worth measuring.
 */
const NEGATIVE_STATUSES: ReadonlySet<VerdictStatus> = new Set([
  "FAIL",
  "PARTIAL",
  "UNVERIFIABLE",
]);

/** A settled, affirmative answer. */
function isPositive(status: VerdictStatus): boolean {
  return NON_PUNT_STATUSES.has(status) && status !== "PARTIAL";
}

export type OutcomeKind =
  | "acted-on"
  | "unexplained-flip"
  | "overridden"
  | "outstanding"
  | "unchanged"
  | "new";

export interface ItemOutcome {
  id: number;
  itemText: string;
  previousStatus: VerdictStatus | null;
  status: VerdictStatus;
  outcome: OutcomeKind;
  /** Cited files that changed since the previous verdict — the evidence. */
  changedEvidencePaths: string[];
}

export interface OutcomeSummary {
  items: ItemOutcome[];
  /**
   * acted-on / (acted-on + unexplained-flip), 0–1. `null` when nothing
   * flipped — a rate over an empty denominator is undefined, not 0, and
   * reporting 0 would read as total failure on a PR where nothing regressed.
   */
  actedOnRate: number | null;
  /** overridden / total items, 0–1. `null` when there are no items. */
  overrideRate: number | null;
}

/** Paths a verdict item pointed at, from both the structured and prose trails. */
export function citedPaths(item: ItemVerdict): string[] {
  const fromRefs = (item.evidenceRefs ?? [])
    .map((r) => (r as { path?: string }).path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  // `evidence` is prose ("read src/foo.ts:40-58"), so paths are extracted by
  // shape rather than parsed — a missed path degrades an acted-on into an
  // unexplained-flip, which errs toward flagging rather than toward silence.
  const fromProse = (item.evidence ?? []).flatMap((e) =>
    Array.from(e.matchAll(/[\w./-]+\.[A-Za-z]{1,6}/g), (m) => m[0]),
  );
  return Array.from(new Set([...fromRefs, ...fromProse]));
}

/**
 * A cited path matches a changed path when either ends with the other.
 *
 * Deliberately loose: the model writes repo-relative paths, `git` may report
 * them differently across renames and monorepo roots, and an exact-match rule
 * would silently classify real fixes as unexplained flips. Qodo's own docs
 * warn that fulfillment is usually indirect — match at file level, not diff
 * level.
 */
function pathsMatch(cited: string, changed: string): boolean {
  if (cited === changed) return true;
  return changed.endsWith(`/${cited}`) || cited.endsWith(`/${changed}`);
}

export function computeOutcomes(args: {
  previous: ReviewVerdict | null;
  current: ReviewVerdict;
  /** Repo-relative paths changed between the two verdicts' head SHAs. */
  changedPaths?: string[];
  /** Item ids a human force-passed via `/uat-override`. */
  overriddenItemIds?: number[];
}): OutcomeSummary {
  const changedPaths = args.changedPaths ?? [];
  const overridden = new Set(args.overriddenItemIds ?? []);
  const prevById = new Map<number, ItemVerdict>(
    (args.previous?.items ?? []).map((it) => [it.id, it]),
  );

  const items: ItemOutcome[] = args.current.items.map((item) => {
    const prev = prevById.get(item.id);
    // Match on the previous verdict's citations: those are what the fix would
    // have been aimed at. The current run's citations are what the author
    // ended up touching, which is the same thing only when nothing moved.
    const changedEvidencePaths = prev
      ? citedPaths(prev).filter((c) => changedPaths.some((ch) => pathsMatch(c, ch)))
      : [];

    const outcome = classify({
      prev: prev ?? null,
      item,
      overridden: overridden.has(item.id),
      changedEvidencePaths,
    });

    return {
      id: item.id,
      itemText: item.itemText,
      previousStatus: prev?.status ?? null,
      status: item.status,
      outcome,
      changedEvidencePaths,
    };
  });

  const actedOn = items.filter((i) => i.outcome === "acted-on").length;
  const flips = items.filter((i) => i.outcome === "unexplained-flip").length;
  const overrides = items.filter((i) => i.outcome === "overridden").length;

  return {
    items,
    actedOnRate: actedOn + flips > 0 ? actedOn / (actedOn + flips) : null,
    overrideRate: items.length > 0 ? overrides / items.length : null,
  };
}

function classify(args: {
  prev: ItemVerdict | null;
  item: ItemVerdict;
  overridden: boolean;
  changedEvidencePaths: string[];
}): OutcomeKind {
  // An override is the strongest signal available — a human looked at this
  // exact item and ruled. It outranks whatever the status transition says.
  if (args.overridden) return "overridden";
  if (!args.prev) return "new";
  if (!NEGATIVE_STATUSES.has(args.prev.status)) return "unchanged";
  if (!isPositive(args.item.status)) return "outstanding";
  return args.changedEvidencePaths.length > 0 ? "acted-on" : "unexplained-flip";
}

/**
 * One labeled row per item, for the eval harness (OGE-1589).
 *
 * JSONL rather than a nested object: rows accumulate across runs and repos,
 * and appending a line is the only operation that stays cheap at that scale.
 * The schema is deliberately flat and stable — anything reading these will
 * outlive this module.
 */
export interface OutcomeRow {
  repo: string;
  pr: number;
  headSha: string;
  ticketId: string;
  itemId: number;
  itemText: string;
  status: VerdictStatus;
  previousStatus: VerdictStatus | null;
  outcome: OutcomeKind;
  confidence?: number;
  changedEvidencePaths: string[];
  generatedAt: string;
}

export function toOutcomeRows(args: {
  verdict: ReviewVerdict;
  summary: OutcomeSummary;
  repo: string;
  pr: number;
  generatedAt: string;
}): OutcomeRow[] {
  const confById = new Map(args.verdict.items.map((it) => [it.id, it.confidence]));
  return args.summary.items.map((o) => ({
    repo: args.repo,
    pr: args.pr,
    headSha: args.verdict.headSha,
    ticketId: args.verdict.ticketId,
    itemId: o.id,
    itemText: o.itemText,
    status: o.status,
    previousStatus: o.previousStatus,
    outcome: o.outcome,
    ...(confById.get(o.id) !== undefined ? { confidence: confById.get(o.id) } : {}),
    changedEvidencePaths: o.changedEvidencePaths,
    generatedAt: args.generatedAt,
  }));
}

export function renderOutcomeRows(rows: OutcomeRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}
