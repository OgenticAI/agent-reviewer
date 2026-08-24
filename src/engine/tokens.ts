/**
 * Token estimation (OGE-2424).
 *
 * Lifted out of `prompt/diff-pack.ts` because `repomap` needed exactly this one
 * function and nothing else from that module — and importing it dragged the
 * whole PR-side prompt graph (ci, parser, research, root) behind a module whose
 * job is to rank files. That single edge was the only thing stopping `repomap`
 * from being mode-neutral.
 *
 * Deliberately crude and deliberately shared: every budget in the engine is
 * computed against the SAME estimate, so a repo map and a diff cannot disagree
 * about what a token costs and quietly overrun a context window between them.
 */

/** Rough token estimate. */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
