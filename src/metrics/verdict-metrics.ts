/**
 * The project's success metric, made measurable (OGE-1562).
 *
 * Reviewer v2 exists to move one number: the share of items the reviewer punts
 * to a human. That number was established by hand — mining 364 Linear issues,
 * reading 62 bot comments, and categorising rationales by eye. It came out at
 * 53 of 60 verdicts (88%). Repeating that by hand after every capability lands
 * is not a plan, and eyeballing "feels better" is not a before/after.
 *
 * So each run emits its own counts, in a form something can parse later.
 *
 * ── Why `puntRate` excludes `[human]` items ─────────────────────────────────
 *
 * A `[human]`-marked item is a *correct* punt: the author declared that a
 * person owns the call. Counting those against the reviewer would mean the
 * metric gets worse every time someone writes a more honest checklist, which
 * is precisely the behaviour OGE-1560 is trying to encourage. The denominator
 * is items the reviewer was actually expected to settle.
 *
 * `rawPuntRate` keeps the unadjusted figure, because the historical 88% was
 * measured before `[human]` existed and comparing an adjusted number against
 * it would flatter the result.
 *
 * CODE_VERIFIED (OGE-1580) counts as a non-punt in BOTH rates. That is a real
 * discontinuity in the series, not a quiet improvement: a verdict that would
 * have been UNVERIFIABLE last week is now an affirmative outcome. When
 * comparing against the 88% baseline, read `counts.CODE_VERIFIED` alongside
 * the rate — a drop driven entirely by reclassification is a vocabulary win,
 * which is worth having but is not the same as verifying more.
 */

import type { ReviewVerdict, VerdictStatus } from "../schema/verdict.js";

export interface VerdictMetrics {
  totalItems: number;
  counts: Record<VerdictStatus, number>;
  /** Items the author marked `[human]` — declared, not punted. */
  humanMarked: number;
  /** Items the reviewer was expected to settle (total minus `[human]`). */
  verifiableItems: number;
  /**
   * UNVERIFIABLE among items the reviewer was expected to settle, 0–1.
   * `null` when there were no such items — a rate over an empty denominator
   * is not 0, it is undefined, and reporting 0 would look like success.
   */
  puntRate: number | null;
  /**
   * UNVERIFIABLE over ALL items, comparable with the historical 88% baseline
   * that predates the `[human]` marker.
   */
  rawPuntRate: number | null;
  /** Client-side tool calls made this run. */
  toolCalls: number;
  /** Server-side searches issued this run. */
  researchQueries: number;
  /** True when the verdict was replayed from cache (no model call). */
  cached: boolean;
  /** Set when the tool loop hit a cap. */
  degraded?: string;
}

export function computeVerdictMetrics(args: {
  verdict: ReviewVerdict;
  toolCalls: number;
  researchQueries: number;
  cached: boolean;
  degraded?: string;
}): VerdictMetrics {
  const counts: Record<VerdictStatus, number> = {
    PASS: 0,
    CODE_VERIFIED: 0,
    FAIL: 0,
    PARTIAL: 0,
    UNVERIFIABLE: 0,
  };
  let humanMarked = 0;
  let humanUnverifiable = 0;

  for (const item of args.verdict.items) {
    counts[item.status] += 1;
    if (item.human === true) {
      humanMarked += 1;
      if (item.status === "UNVERIFIABLE") humanUnverifiable += 1;
    }
  }

  const totalItems = args.verdict.items.length;
  const verifiableItems = totalItems - humanMarked;
  const adjustedUnverifiable = counts.UNVERIFIABLE - humanUnverifiable;

  return {
    totalItems,
    counts,
    humanMarked,
    verifiableItems,
    puntRate: verifiableItems > 0 ? adjustedUnverifiable / verifiableItems : null,
    rawPuntRate: totalItems > 0 ? counts.UNVERIFIABLE / totalItems : null,
    toolCalls: args.toolCalls,
    researchQueries: args.researchQueries,
    cached: args.cached,
    ...(args.degraded ? { degraded: args.degraded } : {}),
  };
}

/**
 * Render metrics as a hidden HTML comment carrying JSON.
 *
 * Hidden because it is for machines: Linear renders HTML comments invisibly,
 * so a later analysis pass can parse a stable shape instead of scraping prose
 * — which is exactly what made the original 88% measurement so laborious.
 */
export function renderMetricsBlock(metrics: VerdictMetrics): string {
  return `<!-- ogenticai-reviewer-metrics ${JSON.stringify(metrics)} -->`;
}

/** Recover metrics from a rendered block, or null. Used by analysis tooling. */
export function parseMetricsBlock(body: string): VerdictMetrics | null {
  const match = /<!-- ogenticai-reviewer-metrics (\{.*?\}) -->/s.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as VerdictMetrics;
  } catch {
    return null;
  }
}
