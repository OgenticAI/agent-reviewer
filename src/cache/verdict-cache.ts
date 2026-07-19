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
import { normalizeToolOutput } from "./normalize.js";
import type { ToolCallRecord } from "../tools/loop.js";

/**
 * Fingerprint of what the client-side tools returned, with volatile substrings
 * normalised out (OGE-1553).
 *
 * Sorted, so a model that happened to call two independent tools in a
 * different order still fingerprints the same — call order is a trajectory
 * detail, not evidence.
 *
 * Stored in the sidecar for observability. It is deliberately NOT part of the
 * fast-path cache key — see the note on `isCacheHit` for why that is not
 * achievable with a model-driven loop.
 *
 * Web-search results are absent by construction: those are server-side and
 * live in the research trace, not the client-side transcript. That is the
 * right exclusion — invalidating a verdict because a search result drifted
 * would reintroduce exactly the churn this cache exists to prevent.
 */
export function hashToolOutputs(transcript: ToolCallRecord[]): string {
  const normalized = transcript
    .map((call) => `${call.name}\u0000${normalizeToolOutput(call.result)}`)
    .sort();
  return createHash("sha256").update(normalized.join("\u0001"), "utf8").digest("hex");
}

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
 * ── On "changed tool output invalidates the cache" ─────────────────────────
 *
 * OGE-1553 asked for tool outputs in the cache key. That is not achievable on
 * the fast path, and it is worth being precise about why rather than shipping
 * something that looks like it: tool calls are chosen by the model, so you
 * cannot learn what the tools would have returned without making the model
 * call the cache exists to avoid. Any scheme that "checks tool outputs first"
 * has either already paid for the run or is guessing.
 *
 * What makes this acceptable in practice is that the evidence which actually
 * moves a verdict is already in the prompt, and therefore already in
 * `promptHash`: the diff, the checklist, the ticket, and — since OGE-1554 —
 * CI check-run status. A tool output that changed while all of those stayed
 * byte-identical is a narrow case (a CI *log* differing under an unchanged
 * *conclusion*), and replaying there is a much smaller error than re-reviewing
 * every push forever.
 *
 * `toolOutputHash` is still recorded so a human debugging a suspicious replay
 * can see whether the tool evidence actually matched.
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
