/**
 * Posting + reconciling inline review comments (OGE-1586).
 *
 * Mirrors `sticky.ts`'s idempotency at the per-finding level: on each run we
 * post a comment for every anchored finding, edit the matching-marker comment
 * from the previous run in place, and delete stale ones whose finding is gone.
 * The marker id (embedded by `render/inline.ts`) is what pairs a comment across
 * runs, exactly as the sticky marker does for the top-level comment.
 *
 * ── The security boundary, made unreachable ─────────────────────────────────
 *
 * The client interface below exposes ONLY create/update/delete/list of review
 * *comments*. It has no `createReview` method and no approve path, so this code
 * physically cannot submit a formal GitHub review or approve a PR — the thing
 * Anthropic forbids claude-code-action from doing. A test asserts the surface.
 */

import { parseInlineMarker, type InlineComment } from "../render/inline.js";

/**
 * The minimal, deliberately narrow GitHub surface for inline comments.
 *
 * No `createReview`. No `submitReview`. No approve. The absence is the point:
 * you cannot call what isn't here.
 */
export interface InlineCommentClient {
  listReviewComments(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<Array<{ id: number; body: string }>>;
  createReviewComment(args: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
    path: string;
    line: number;
    body: string;
  }): Promise<{ id: number }>;
  updateReviewComment(args: {
    owner: string;
    repo: string;
    commentId: number;
    body: string;
  }): Promise<void>;
  deleteReviewComment(args: { owner: string; repo: string; commentId: number }): Promise<void>;
}

export interface ReconcileArgs {
  client: InlineCommentClient;
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  desired: InlineComment[];
}

export interface ReconcileResult {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Reconcile the current run's inline findings against last run's comments.
 *
 * - marker present last run AND this run → update in place (body may have moved on)
 * - marker present this run only → create
 * - marker present last run only → delete (the finding is resolved/gone)
 *
 * Only comments carrying our marker are ever touched — human review comments
 * and other bots' comments are invisible to this pass.
 */
export async function reconcileInlineComments(args: ReconcileArgs): Promise<ReconcileResult> {
  const existing = await args.client.listReviewComments({
    owner: args.owner,
    repo: args.repo,
    pullNumber: args.pullNumber,
  });

  // Ours, keyed by the item id in the marker. Last write per id wins — a prior
  // run should only have left one per id, but be defensive.
  const oursByItem = new Map<number, number>(); // itemId -> commentId
  for (const c of existing) {
    const itemId = parseInlineMarker(c.body);
    if (itemId !== null) oursByItem.set(itemId, c.id);
  }

  const result: ReconcileResult = { created: 0, updated: 0, deleted: 0 };
  const desiredIds = new Set(args.desired.map((d) => d.itemId));

  for (const comment of args.desired) {
    const existingId = oursByItem.get(comment.itemId);
    if (existingId !== undefined) {
      await args.client.updateReviewComment({
        owner: args.owner,
        repo: args.repo,
        commentId: existingId,
        body: comment.body,
      });
      result.updated += 1;
    } else {
      await args.client.createReviewComment({
        owner: args.owner,
        repo: args.repo,
        pullNumber: args.pullNumber,
        commitId: args.commitId,
        path: comment.path,
        line: comment.line,
        body: comment.body,
      });
      result.created += 1;
    }
  }

  // Delete our comments whose finding no longer exists this run.
  for (const [itemId, commentId] of oursByItem) {
    if (!desiredIds.has(itemId)) {
      await args.client.deleteReviewComment({
        owner: args.owner,
        repo: args.repo,
        commentId,
      });
      result.deleted += 1;
    }
  }

  return result;
}
