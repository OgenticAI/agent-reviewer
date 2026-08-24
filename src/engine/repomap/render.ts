/**
 * Rendering the ranked repo map to a token budget (OGE-1582).
 *
 * Signature-only lines give ~10–50× compression over source: the model sees
 * "which symbols exist where and how they're called", which is exactly what a
 * repo-wide claim needs, without the bodies. The rendered map is binary-searched
 * to a token budget so it never crowds out the diff.
 *
 * ── Inverse scaling ─────────────────────────────────────────────────────────
 *
 * Aider's `map_mul_no_files` insight: the map is most valuable exactly when the
 * diff is small and the claims are repo-wide ("all state changes emit audit
 * events" on a two-line diff). So the budget scales INVERSELY with diff size —
 * a big diff already carries its own context and gets a small map; a tiny diff
 * gets a big one.
 */

import { estimateTokens } from "../tokens.js";
import type { RankedFile } from "./rank.js";
import type { Tag } from "./tags.js";

export const DEFAULT_MAP_TOKENS = 1024;

/** Diff size (in estimated tokens) at/below which the map gets its full budget. */
const SMALL_DIFF_TOKENS = 1000;
/** Diff size at/above which the map shrinks to its floor. */
const LARGE_DIFF_TOKENS = 12_000;
/** Fraction of the base budget the map keeps on a very large diff. */
const LARGE_DIFF_FLOOR = 0.25;

/**
 * Scale the map budget inversely with diff size.
 *
 * Full budget for a small diff, linearly down to `LARGE_DIFF_FLOOR × base` for
 * a large one. This is the lever that puts a big symbol map in front of the
 * model precisely when the diff is too small to answer a repo-wide claim.
 */
export function scaledMapTokens(baseTokens: number, diffTokens: number): number {
  if (diffTokens <= SMALL_DIFF_TOKENS) return baseTokens;
  if (diffTokens >= LARGE_DIFF_TOKENS) return Math.floor(baseTokens * LARGE_DIFF_FLOOR);
  const t = (diffTokens - SMALL_DIFF_TOKENS) / (LARGE_DIFF_TOKENS - SMALL_DIFF_TOKENS);
  const mul = 1 - t * (1 - LARGE_DIFF_FLOOR);
  return Math.floor(baseTokens * mul);
}

/** Group def signatures by file, in ranked order. */
function defsByFile(tags: Tag[]): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const tag of tags) {
    if (tag.kind !== "def") continue;
    if (!byFile.has(tag.path)) byFile.set(tag.path, []);
    byFile.get(tag.path)!.push(tag.signature);
  }
  return byFile;
}

function renderFor(ranked: RankedFile[], byFile: Map<string, string[]>, topN: number): string {
  const lines: string[] = [];
  for (const { path } of ranked.slice(0, topN)) {
    const defs = byFile.get(path);
    if (!defs || defs.length === 0) continue;
    lines.push(`${path}:`);
    for (const sig of defs) lines.push(`  ${sig}`);
  }
  return lines.join("\n");
}

export interface RenderedMap {
  text: string;
  /** How many files made it into the budget. */
  fileCount: number;
  /** The effective token budget used (after inverse scaling). */
  budget: number;
}

/**
 * Render the map, binary-searching the file count to fit the budget.
 *
 * Binary search over "how many top-ranked files to include" — the largest
 * prefix whose rendered form fits. Deterministic, and within a tight tolerance
 * of the budget by construction.
 */
export function renderRepoMap(args: {
  ranked: RankedFile[];
  tags: Tag[];
  baseTokens?: number;
  diffTokens: number;
}): RenderedMap {
  const budget = scaledMapTokens(args.baseTokens ?? DEFAULT_MAP_TOKENS, args.diffTokens);
  const byFile = defsByFile(args.tags);
  const rankedWithDefs = args.ranked.filter((r) => (byFile.get(r.path)?.length ?? 0) > 0);
  if (rankedWithDefs.length === 0) return { text: "", fileCount: 0, budget };

  let lo = 0;
  let hi = rankedWithDefs.length;
  let best = "";
  let bestN = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = renderFor(rankedWithDefs, byFile, mid);
    if (estimateTokens(text) <= budget) {
      best = text;
      bestN = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Always include at least the single top-ranked file, even if oversized — an
  // empty map is strictly less useful than one over-budget entry.
  if (bestN === 0) {
    best = renderFor(rankedWithDefs, byFile, 1);
    bestN = 1;
  }
  return { text: best, fileCount: bestN, budget };
}
