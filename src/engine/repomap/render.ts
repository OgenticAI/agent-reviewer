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

/**
 * Ceiling for a map sized by tree, in estimated tokens.
 *
 * 16384 tokens is roughly 64KB of signature lines, which at 8 tokens per
 * file names every file in a tree of about two thousand before the cap
 * bites. It is also the largest prefix this engine wants to pay to cache: the
 * audit marks the first user message as a cache breakpoint, so the map is
 * written once per question and read back at a tenth of the rate on each
 * later turn. Past this size the map starts crowding out the files the model
 * opens, which is the thing it exists to guide.
 */
export const MAX_AUDIT_MAP_TOKENS = 16_384;

/** Tokens the budget grows by for each file in the tree. */
const MAP_TOKENS_PER_FILE = 8;

/**
 * A map budget that grows with the tree (audit path).
 *
 * `DEFAULT_MAP_TOKENS` is the PR reviewer's floor, sized for a run that also
 * carries a diff. The audit has no diff: the map is the only overview the
 * model gets, and `investigateRun` passed no budget at all, so a tree of
 * several hundred files was outlined in 1024 tokens, which is a dozen files.
 * The model then guessed at the rest, and a guessed path that misses is a
 * turn spent on nothing.
 *
 *   budget = 1024 + 8 * files, capped at 16384
 *
 * Eight tokens is about one `path:` header line plus a short signature, so
 * the linear term buys the map roughly one line per file: enough to NAME most
 * of a mid-sized tree, which is what turns a guess into a read. The floor
 * keeps a tiny tree at the PR default rather than below it; the cap is
 * explained on `MAX_AUDIT_MAP_TOKENS`.
 */
export function mapBudgetForTree(fileCount: number): number {
  const files = Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : 0;
  return Math.min(DEFAULT_MAP_TOKENS + MAP_TOKENS_PER_FILE * files, MAX_AUDIT_MAP_TOKENS);
}

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
  /**
   * The files the text names, in rank order. Carried so a prompt can say what
   * the map covers per language without parsing its own output back.
   */
  files: string[];
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
  if (rankedWithDefs.length === 0) return { text: "", fileCount: 0, files: [], budget };

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
  return { text: best, fileCount: bestN, files: rankedWithDefs.slice(0, bestN).map((r) => r.path), budget };
}
