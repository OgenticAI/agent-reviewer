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

import { parseUatChecklist } from "./parser/uat.js";
import { resolveTickets } from "./linear/resolve.js";
import { ReviewVerdict } from "./schema/verdict.js";
import { overallStatus, type OverallStatus } from "./schema/verdict.js";
import { renderStickyComment } from "./render/comment.js";
import { buildReviewPrompt, SYSTEM_PROMPT } from "./prompt/review.js";
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

/** GitHub-side I/O: pull the PR + diff. */
export interface GithubReader {
  getPr(args: { owner: string; repo: string; number: number }): Promise<PrContext>;
  getDiff(args: { owner: string; repo: string; number: number }): Promise<string>;
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

  const userPrompt = buildReviewPrompt({ pr, ticket, checklist, diff });
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
 * fields (schema version, reviewer version, ticket id, PR ref, SHA, timestamp).
 *
 * The model can return JSON wrapped in code fences despite instructions —
 * strip them defensively. zod parsing then fails closed if the model output
 * is structurally wrong.
 */
function parseVerdict(
  modelOutput: string,
  injected: {
    ticketId: string;
    prRef: string;
    headSha: string;
    generatedAt: string;
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
  const candidate = {
    ...(parsed as Record<string, unknown>),
    schemaVersion: 1,
    reviewerVersion: REVIEWER_VERSION,
    ticketId: injected.ticketId,
    prRef: injected.prRef,
    headSha: injected.headSha,
    generatedAt: injected.generatedAt,
  };
  return ReviewVerdict.parse(candidate);
}
