/**
 * Pure orchestration of a single PR review run.
 *
 * The thin `cli.ts` and the GitHub Action both reduce to a call to
 * `runReview()` here. All side effects — fetching from GitHub, calling
 * Anthropic, fetching from Linear, posting comments — are passed in as
 * dependencies so the entire pipeline is end-to-end testable with mocks.
 *
 * Determinism contract:
 *   Given the same `(prBody, headRef, headSha, ticket, diff)`, runReview() at
 *   temperature 0 must produce a byte-identical sticky comment body. That
 *   guarantee is the spine of the "no comment churn on every push" promise.
 *   We test it explicitly in tests/integration/review.test.ts.
 */

import { parseUatChecklist, type UatItem, type UatItemLink } from "./parser/uat.js";
import { resolveTickets } from "./linear/resolve.js";
import { ReviewVerdict } from "./schema/verdict.js";
import { overallStatus, type OverallStatus } from "./schema/verdict.js";
import { renderStickyComment } from "./render/comment.js";
import {
  buildReviewPrompt,
  LINKED_COMMENT_BODY_MAX_CHARS,
  SYSTEM_PROMPT,
  type LinkedComment,
} from "./prompt/review.js";
import { REVIEWER_VERSION } from "./version.js";
import type { LinearTicketContext, PrContext } from "./schema/event.js";

/**
 * Minimal interface the LLM dependency must satisfy. Real impl is the
 * Anthropic SDK; tests pass a stub that returns canned JSON.
 */
export interface VerdictModel {
  produce(args: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string /* raw JSON text from the model */>;
}

/** Linear lookup, swappable between the GraphQL HTTP client and the MCP. */
export interface LinearClient {
  getIssue(identifier: string): Promise<LinearTicketContext>;
}

/**
 * GitHub-side I/O: pull the PR + diff, plus optional comment fetchers used by
 * the OGE-365 ticked-with-verification-comment promotion path. The two
 * comment-fetcher methods are optional so existing test mocks (which only
 * implement `getPr` + `getDiff`) keep compiling — when undefined, the
 * orchestrator silently skips the linked-comment fetch step.
 */
export interface GithubReader {
  getPr(args: { owner: string; repo: string; number: number }): Promise<PrContext>;
  getDiff(args: { owner: string; repo: string; number: number }): Promise<string>;
  getIssueComment?(args: {
    owner: string;
    repo: string;
    commentId: number;
  }): Promise<FetchedComment | null>;
  getReviewComment?(args: {
    owner: string;
    repo: string;
    commentId: number;
  }): Promise<FetchedComment | null>;
}

/**
 * A PR comment body fetched by the orchestrator and fed into the verdict
 * prompt as evidence for the OGE-365 promotion path. Implementations return
 * `null` on any error (404, 403, network) — fail-safe means the affected
 * UAT item stays at whatever the model would have decided without the comment.
 */
export interface FetchedComment {
  /** Canonical permalink to the comment on github.com. */
  url: string;
  /** Login of the comment's author (e.g. "davidoladeji-ogenticai"). */
  author: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Comment body in original markdown. */
  body: string;
}

export interface RunReviewArgs {
  pr: { owner: string; repo: string; number: number };
  github: GithubReader;
  linear: LinearClient;
  model: VerdictModel;
  /** Override the default ISO timestamp source. Tests pin this to a constant. */
  now?: () => string;
}

export interface RunReviewResult {
  verdict: ReviewVerdict;
  /** The fully rendered sticky-comment body, ready to upsert. */
  body: string;
  /** Convenience: the OverallStatus the Check should publish. */
  overall: OverallStatus;
  /** The PrContext that was reviewed (echoed for callers that want it). */
  prContext: PrContext;
  /** The Linear ticket the verdict was scored against (the primary one). */
  ticket: LinearTicketContext;
}

/**
 * Run a single review pass: fetch → parse → prompt → render. No side effects
 * outside the injected dependencies — comment posting, Check publishing, and
 * Linear writeback are the caller's responsibility.
 */
export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const pr = await args.github.getPr(args.pr);
  const diff = await args.github.getDiff(args.pr);

  const tickets = resolveTickets({
    headRef: pr.headRef,
    body: pr.body,
    title: pr.title,
  });
  if (tickets.ticketIds.length === 0) {
    throw new ReviewSkippedError(
      "No Linear ticket id found in branch / PR body / title. " +
        "Skipping review — this PR doesn't follow the OGE-NNN convention.",
    );
  }
  const primaryTicketId = tickets.ticketIds[0]!;
  const ticket = await args.linear.getIssue(primaryTicketId);

  const checklist = parseUatChecklist(pr.body);
  if (!checklist.found) {
    throw new ReviewSkippedError(
      `No "## UAT checklist" block in the PR description. ` +
        `Skipping review — add a checklist or expect human review.`,
    );
  }

  const linkedComments = await fetchLinkedVerificationComments({
    items: checklist.items,
    pr,
    github: args.github,
  });

  const userPrompt = buildReviewPrompt({
    pr,
    ticket,
    checklist,
    diff,
    linkedComments,
  });
  const rawJson = await args.model.produce({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
  });

  const now = args.now ?? (() => new Date().toISOString());
  const verdict = parseVerdict(rawJson, {
    ticketId: primaryTicketId,
    prRef: `${pr.owner}/${pr.repo}#${pr.number}`,
    headSha: pr.headSha,
    generatedAt: now(),
    checklist,
  });

  const body = renderStickyComment(verdict);
  return {
    verdict,
    body,
    overall: overallStatus(verdict),
    prContext: pr,
    ticket,
  };
}

/**
 * Recoverable: the PR isn't reviewable (no ticket, no checklist). The Action
 * surface treats this as a `neutral` Check, not a failure — the reviewer
 * doesn't punish PRs for not opting in.
 */
export class ReviewSkippedError extends Error {
  readonly skipped = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ReviewSkippedError";
  }
}

/**
 * Parse + validate the model's JSON output, injecting the agent-side metadata
 * fields (schema version, reviewer version, ticket id, PR ref, SHA, timestamp)
 * and patching common drift patterns before zod validation.
 *
 * Drift patterns we tolerate (observed live in production):
 *   - Items missing `id`: filled in from 1-based array position.
 *   - Items missing `itemText`: looked up from the parser's checklist by id.
 *   - `evidenceRefs` as bare strings: coerced to `{ kind, path, ... }` objects
 *     using these heuristics:
 *       "src/foo.py:42-58"  →  { kind: "lines", path: "src/foo.py", start: 42, end: 58 }
 *       "src/foo.py:42"     →  { kind: "lines", path: "src/foo.py", start: 42, end: 42 }
 *       "src/foo.py"        →  { kind: "file",  path: "src/foo.py" }
 *       "https://..."       →  { kind: "external", url: "..." }
 *
 * Anything we can't repair fails closed via zod — the caller's failure-safe
 * Check publishing turns that into a `neutral` Check, never `failure`.
 */
function parseVerdict(
  modelOutput: string,
  injected: {
    ticketId: string;
    prRef: string;
    headSha: string;
    generatedAt: string;
    checklist: { items: Array<{ id: number; text: string; human?: boolean }> };
  },
): ReviewVerdict {
  const stripped = modelOutput
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `Model returned non-JSON output (length=${modelOutput.length}). ` +
        `First 200 chars: ${modelOutput.slice(0, 200)}`,
      { cause: err },
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Model output parsed but isn't a JSON object");
  }

  const root = parsed as Record<string, unknown>;
  const rawItems = Array.isArray(root.items) ? (root.items as unknown[]) : [];
  const checklistById = new Map(
    injected.checklist.items.map((it) => [it.id, it]),
  );

  const repairedItems = rawItems.map((raw, idx) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof item.id === "number" ? item.id : idx + 1;
    const source = checklistById.get(id);
    const itemText =
      typeof item.itemText === "string" && item.itemText.length > 0
        ? item.itemText
        : (source?.text ?? `Item ${id}`);
    const evidenceRefs = Array.isArray(item.evidenceRefs)
      ? (item.evidenceRefs as unknown[]).map(coerceEvidenceRef).filter((r) => r !== null)
      : [];
    // `human` comes from the parsed checklist, never from the model — whether
    // a criterion needs a person is the author's declaration, not a verdict
    // the model gets to make. Overwrite anything the model emitted (OGE-1559).
    return { ...item, id, itemText, evidenceRefs, human: source?.human === true };
  });

  const candidate = {
    ...root,
    items: repairedItems,
    schemaVersion: 1,
    reviewerVersion: REVIEWER_VERSION,
    ticketId: injected.ticketId,
    prRef: injected.prRef,
    headSha: injected.headSha,
    generatedAt: injected.generatedAt,
  };
  return ReviewVerdict.parse(candidate);
}

/**
 * Coerce a model-emitted evidence reference into the `EvidenceRef` shape.
 *
 * Pass through objects that are already in the right shape; convert strings
 * via heuristics on file-path / line-range / URL. Returns null for inputs
 * we can't sensibly map (caller filters them out).
 */
function coerceEvidenceRef(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw; // trust zod to validate further

  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // External URL → { kind: "external", url }
  if (/^https?:\/\//i.test(s)) {
    return { kind: "external", url: s };
  }

  // path:start-end  or  path:start
  const lineMatch = s.match(/^([^:]+):(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    const path = lineMatch[1]!;
    const start = Number(lineMatch[2]!);
    const end = lineMatch[3] !== undefined ? Number(lineMatch[3]) : start;
    return { kind: "lines", path, start, end };
  }

  // Bare path → file
  return { kind: "file", path: s };
}

/**
 * Fetch the bodies of any same-PR comments that were linked from ticked
 * UAT items, so the verdict prompt can use them as evidence (OGE-365). The
 * gate is intentionally narrow: an item must be ticked AND link a comment
 * on the *same* PR (matching owner/repo/PR-number) to trigger a fetch. That
 * same-PR check is the security boundary — without it an author could link
 * a comment from a different PR (or a different repo entirely) and have
 * the model treat unrelated text as verification evidence.
 *
 * Errors and edge cases all fail safe to "comment not attached":
 *   - `getIssueComment` / `getReviewComment` undefined (test mocks) → skip silently.
 *   - 404 / 403 / network error → skip silently (logged for observability).
 *   - Cross-PR or non-comment link → ignored at the gate.
 *
 * Body is truncated to `LINKED_COMMENT_BODY_MAX_CHARS` so a multi-megabyte
 * log paste doesn't crowd the diff out of the prompt budget.
 */
async function fetchLinkedVerificationComments(args: {
  items: UatItem[];
  pr: PrContext;
  github: GithubReader;
}): Promise<LinkedComment[]> {
  const { items, pr, github } = args;
  const out: LinkedComment[] = [];
  for (const item of items) {
    if (!item.checked) continue;
    for (const link of item.links) {
      if (!isSamePrCommentLink(link, pr)) continue;
      /* eslint-disable @typescript-eslint/unbound-method --
         The reference is deliberately unbound; it is invoked below via
         `fetcher.call(github, ...)`, which supplies the correct `this`. */
      const fetcher =
        link.kind === "pr-comment-issue"
          ? github.getIssueComment
          : github.getReviewComment;
      /* eslint-enable @typescript-eslint/unbound-method */
      if (!fetcher) continue; // test mock without comment fetchers
      let comment;
      try {
        comment = await fetcher.call(github, {
          owner: link.owner,
          repo: link.repo,
          commentId: link.commentId,
        });
      } catch (err) {
        console.error(
          `[review] failed to fetch ${link.kind} ${link.url}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (!comment) continue;
      const truncated = comment.body.length > LINKED_COMMENT_BODY_MAX_CHARS;
      out.push({
        itemId: item.id,
        sourceUrl: link.url,
        author: comment.author,
        createdAt: comment.createdAt,
        body: truncated
          ? comment.body.slice(0, LINKED_COMMENT_BODY_MAX_CHARS)
          : comment.body,
        truncated,
      });
    }
  }
  return out;
}

/**
 * The same-PR security gate: the link must point at a comment on the PR
 * currently being reviewed, not a sibling PR or another repo. The parser
 * captures `owner/repo/prNumber` from the URL itself; this function compares
 * against the actual PR context.
 */
function isSamePrCommentLink(
  link: UatItemLink,
  pr: PrContext,
): link is Extract<
  UatItemLink,
  { kind: "pr-comment-issue" | "pr-comment-review" }
> {
  if (link.kind !== "pr-comment-issue" && link.kind !== "pr-comment-review") {
    return false;
  }
  return (
    link.owner === pr.owner &&
    link.repo === pr.repo &&
    link.prNumber === pr.number
  );
}
