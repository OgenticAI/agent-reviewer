/**
 * Find-or-upsert the sticky reviewer comment on a PR.
 *
 * The "sticky" pattern: every comment we post starts with a fixed HTML marker
 * (`COMMENT_MARKER` in src/version.ts). On subsequent runs we list the PR's
 * issue comments, find the one whose body starts with that marker, and PATCH
 * its body in place. If we don't find one, we POST a new comment.
 *
 * This is the same pattern @octokit/rest exposes via the issues.* endpoints
 * (PRs are issues for commenting purposes). We use issue-comments rather
 * than review-comments because review-comments are pinned to file/line and
 * we want a top-level whole-PR comment.
 */

import type { Octokit } from "@octokit/rest";

import { COMMENT_MARKER } from "../version.js";

export interface UpsertStickyArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** PR number (== issue number for commenting). */
  issueNumber: number;
  /** The pre-rendered comment body (must start with COMMENT_MARKER). */
  body: string;
}

export interface UpsertStickyResult {
  action: "created" | "updated" | "noop";
  commentId: number;
  url: string;
}

/**
 * If a sticky comment exists with byte-identical body, do nothing — that's the
 * "no comment churn on each push" guarantee. Otherwise create or patch.
 */
export async function upsertStickyComment(args: UpsertStickyArgs): Promise<UpsertStickyResult> {
  if (!args.body.startsWith(COMMENT_MARKER)) {
    throw new Error(
      `Sticky body must start with COMMENT_MARKER (got: ${args.body.slice(0, 60)}…). ` +
        `Use renderStickyComment() to build the body.`,
    );
  }

  const existing = await findStickyComment(args);

  if (existing && existing.body === args.body) {
    return { action: "noop", commentId: existing.id, url: existing.url };
  }

  if (existing) {
    const updated = await args.octokit.issues.updateComment({
      owner: args.owner,
      repo: args.repo,
      comment_id: existing.id,
      body: args.body,
    });
    return { action: "updated", commentId: updated.data.id, url: updated.data.html_url };
  }

  const created = await args.octokit.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.issueNumber,
    body: args.body,
  });
  return { action: "created", commentId: created.data.id, url: created.data.html_url };
}

interface StickyCommentMatch {
  id: number;
  body: string;
  url: string;
}

async function findStickyComment(args: UpsertStickyArgs): Promise<StickyCommentMatch | null> {
  // Paginate. Most PRs have <30 comments, but the API caps at 100/page so
  // walking is cheap and correct.
  const iterator = args.octokit.paginate.iterator(args.octokit.issues.listComments, {
    owner: args.owner,
    repo: args.repo,
    issue_number: args.issueNumber,
    per_page: 100,
  });

  for await (const { data } of iterator) {
    for (const comment of data) {
      if ((comment.body ?? "").startsWith(COMMENT_MARKER)) {
        return { id: comment.id, body: comment.body ?? "", url: comment.html_url };
      }
    }
  }
  return null;
}
