/**
 * Verdict reuse across runs (OGE-1566).
 *
 * Why this exists: web results drift. The same diff at the same SHA can
 * produce a different rationale a day later, which churns the sticky comment
 * and breaks the byte-identical promise in `src/review.ts`. That is a sharper
 * problem than model nondeterminism, because the input is changing entirely
 * outside our control.
 *
 * The fix is to not re-ask when nothing we care about changed. Note what this
 * does and does not buy: it stops the churn, it does **not** make a verdict
 * reproducible from scratch. Re-running against a cleared cache can still
 * produce different words.
 *
 * There is no external store, and deliberately so — the reviewer runs in a
 * fresh GitHub Actions container every time, so anything on disk is gone. The
 * sticky comment already embeds the full verdict as a JSON sidecar (see
 * `render/comment.ts`), which makes the PR itself the cache. Read the previous
 * comment, and if it was produced from a byte-identical prompt, reuse it.
 */

import { createHash } from "node:crypto";

import { ReviewVerdict } from "../schema/verdict.js";

/** Stable cache key for a verdict: SHA-256 of the exact user prompt. */
export function hashPrompt(userPrompt: string): string {
  return createHash("sha256").update(userPrompt, "utf8").digest("hex");
}

/**
 * Recover a verdict from a previously-posted sticky comment body.
 *
 * Returns `null` for anything unexpected — no sidecar, malformed JSON, a
 * payload that no longer matches the schema. Every failure path here means
 * "re-run the review", which is correct-but-slower; there is no failure path
 * that yields a wrong-but-fast answer.
 */
export function parseVerdictFromStickyBody(body: string): ReviewVerdict | null {
  const fence = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!fence) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]!);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  // `generatedAt` is deliberately stripped from the rendered sidecar so the
  // comment body stays byte-identical across runs (see render/comment.ts), so
  // re-stamp it here to satisfy the schema. The value is not load-bearing for
  // a cache hit — `promptHash` is — so a placeholder is honest rather than a
  // fabricated timestamp claiming the old run happened now.
  const candidate = { generatedAt: "1970-01-01T00:00:00.000Z", ...(parsed as object) };

  const result = ReviewVerdict.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Whether a previously-posted verdict can stand in for this run.
 *
 * All three must hold:
 *   - same head SHA (the code under review is unchanged)
 *   - same prompt hash (the checklist, ticket, and diff are unchanged)
 *   - same reviewer version (we haven't changed how verdicts are produced)
 *
 * The version check is what makes prompt changes safe to ship: bumping
 * `REVIEWER_VERSION` invalidates every cached verdict at once, so a reworded
 * prompt cannot be silently masked by stale cache hits.
 */
export function isCacheHit(args: {
  cached: ReviewVerdict | null;
  headSha: string;
  promptHash: string;
  reviewerVersion: string;
}): boolean {
  const { cached } = args;
  if (!cached) return false;
  if (!cached.promptHash) return false; // pre-cache verdict — always re-run
  return (
    cached.headSha === args.headSha &&
    cached.promptHash === args.promptHash &&
    cached.reviewerVersion === args.reviewerVersion
  );
}
