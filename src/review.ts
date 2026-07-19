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
import { resolveResearchPolicy, type ResearchPolicy } from "./research/policy.js";
import { EMPTY_TRACE, type ResearchTrace } from "./research/trace.js";
import type { ToolCallRecord } from "./tools/loop.js";
import { hashPrompt, hashToolOutputs, isCacheHit } from "./cache/verdict-cache.js";
import { adjudicateVerdict, type AdjudicatorModel } from "./adjudicate.js";
import { CI_UNAVAILABLE, type CiSummary } from "./ci/summary.js";
import { packDiff, type PackDiffOptions } from "./prompt/diff-pack.js";
import type { LinearTicketContext, PrContext } from "./schema/event.js";

export interface VerdictModelRequest {
  systemPrompt: string;
  userPrompt: string;
  /**
   * Whether this run may use the server-side web-search tool, and against
   * which sources. When `enabled` is false the implementation must send **no
   * `tools` array at all** — not an empty one — so there is no search path on
   * the vast majority of reviews. See `research/policy.ts`.
   */
  research: ResearchPolicy;
}

/**
 * What the model produced: the raw JSON verdict text, plus what the
 * server-side search actually did (for audit and citation validation).
 */
export interface VerdictModelOutput {
  text: string;
  trace: ResearchTrace;
  /**
   * Every client-side tool call the model made, in order (OGE-1552). Surfaced
   * for operator logs; nothing branches on it yet.
   */
  transcript?: ToolCallRecord[];
  /**
   * Set when the tool loop stopped on a cap rather than because the model was
   * finished. The verdict is still usable — degraded, not failed.
   */
  degraded?: string;
}

/**
 * Minimal interface the LLM dependency must satisfy. Real impl is the
 * Anthropic SDK; tests pass a stub that returns canned JSON.
 *
 * The return type is a union so a stub can keep returning a bare string —
 * that keeps every pre-OGE-1566 test mock compiling and meaningful, since a
 * test that doesn't care about research shouldn't have to fabricate a trace.
 * `normalizeModelOutput` collapses the two shapes.
 */
export interface VerdictModel {
  produce(args: VerdictModelRequest): Promise<string | VerdictModelOutput>;
}

function normalizeModelOutput(out: string | VerdictModelOutput): VerdictModelOutput {
  return typeof out === "string" ? { text: out, trace: EMPTY_TRACE, transcript: [] } : out;
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
  /**
   * Check runs + commit statuses for the head SHA (OGE-1554). Optional so
   * existing test mocks keep compiling; when absent the prompt omits the CI
   * section entirely rather than claiming CI is unknown.
   */
  getCiSummary?(args: { owner: string; repo: string; ref: string }): Promise<CiSummary>;
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
  /**
   * Per-repo opt-in for research (OGE-1566). Default false — see the security
   * note in `research/policy.ts` for why this is not on by default.
   */
  researchEnabled?: boolean;
  /**
   * A verdict recovered from the existing sticky comment, if any. When it was
   * produced from a byte-identical prompt at the same SHA, `runReview` returns
   * it without calling the model at all.
   */
  cachedVerdict?: ReviewVerdict | null;
  /**
   * Cheap second-pass model that challenges each UNVERIFIABLE verdict
   * (OGE-1587). Omitted means no adjudication — the default, so this cannot
   * change behaviour for callers that have not opted in.
   */
  adjudicator?: AdjudicatorModel;
  /**
   * Diff packing controls (OGE-1581 / OGE-1591). Omitted uses the defaults;
   * `readFile` enables function-boundary hunk expansion.
   */
  diffPack?: PackDiffOptions;
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
  /** True when the verdict was reused from the sticky comment (no model call). */
  cached: boolean;
  /**
   * What the server-side search did. Callers log `queries` — because the model
   * composes them and Anthropic dispatches them, this after-the-fact record is
   * the only visibility we get into what left the building.
   */
  researchTrace: ResearchTrace;
  /** Why research was on or off, for operator-facing logs. */
  researchReason: string;
  /** Punt count before adjudication ran; equals the after count when it didn't. */
  puntsBefore: number;
  /** Punt count after adjudication. */
  puntsAfter: number;
  /** Client-side tool calls made during the run, in order (OGE-1552). */
  transcript: ToolCallRecord[];
  /**
   * Set when the tool loop hit an iteration or wall-clock cap. The verdict is
   * usable but was cut short — callers surface this rather than pretending the
   * run completed normally.
   */
  degraded?: string;
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

  // Resolve the research policy *before* building the prompt: whether research
  // is on changes the prompt text, and therefore the cache key.
  const research = resolveResearchPolicy({
    items: checklist.items,
    enabledByConfig: args.researchEnabled === true,
  });

  // CI is real evidence about this exact commit and was already being fetched
  // for the writeback gate — it just never reached the prompt (OGE-1554).
  let ci: CiSummary | undefined;
  if (args.github.getCiSummary) {
    try {
      ci = await args.github.getCiSummary({
        owner: pr.owner,
        repo: pr.repo,
        ref: pr.headSha,
      });
    } catch {
      // A CI-read failure must never take down the review. Say "unknown"
      // rather than silently omitting, so the model can't read absence as green.
      ci = CI_UNAVAILABLE;
    }
  }

  // Pack before prompting: an unbounded diff either overflows the window or
  // crowds out the checklist and tool results (OGE-1581).
  const packed = packDiff(diff, {
    ...args.diffPack,
    checklistTexts: checklist.items.map((it) => it.text),
  });
  if (packed.truncated) {
    console.error(
      `[diff] packed ${packed.includedFiles.length} file(s); skipped ${packed.skippedFiles.length}` +
        ` (${packed.skippedFiles.map((s) => s.reason).join(", ")})`,
    );
  }

  const userPrompt = buildReviewPrompt({
    pr,
    ticket,
    checklist,
    diff: packed.text,
    linkedComments,
    research,
    ci,
    skippedFiles: packed.skippedFiles,
  });
  const promptHash = hashPrompt(userPrompt);

  // Reuse the previous verdict when nothing in the determinism vector moved.
  // This is what stops web-result drift from churning the sticky comment on
  // every push — see cache/verdict-cache.ts.
  if (
    isCacheHit({
      cached: args.cachedVerdict ?? null,
      headSha: pr.headSha,
      promptHash,
      reviewerVersion: REVIEWER_VERSION,
    })
  ) {
    const cachedVerdict = args.cachedVerdict!;
    return {
      verdict: cachedVerdict,
      body: renderStickyComment(cachedVerdict),
      overall: overallStatus(cachedVerdict),
      prContext: pr,
      ticket,
      cached: true,
      researchTrace: EMPTY_TRACE,
      researchReason: "cache hit — prompt unchanged since the last run",
      transcript: [],
      puntsBefore: cachedVerdict.items.filter((it) => it.status === "UNVERIFIABLE").length,
      puntsAfter: cachedVerdict.items.filter((it) => it.status === "UNVERIFIABLE").length,
    };
  }

  const now = args.now ?? (() => new Date().toISOString());
  const { output, verdict: finalVerdict, retries } = await produceVerdictWithRetry({
    model: args.model,
    userPrompt,
    research,
    parse: (text, attemptOutput) =>
      parseVerdict(text, {
        ticketId: primaryTicketId,
        prRef: `${pr.owner}/${pr.repo}#${pr.number}`,
        headSha: pr.headSha,
        generatedAt: now(),
        promptHash,
        // Hash and citation-filter against the attempt that actually produced
        // this text — a retry has its own transcript and trace.
        toolOutputHash: hashToolOutputs(attemptOutput.transcript ?? []),
        checklist,
        trace: attemptOutput.trace,
        researchEnabled: research.enabled,
        linkedCommentUrls: linkedComments.map((lc) => lc.sourceUrl),
      }),
  });

  // Challenge the punts before anything is rendered — the sticky comment, the
  // Check, and the Linear mirror should all reflect the adjudicated table.
  let adjudicated = finalVerdict;
  let puntsBefore = finalVerdict.items.filter((it) => it.status === "UNVERIFIABLE").length;
  let puntsAfter = puntsBefore;
  if (args.adjudicator && puntsBefore > 0) {
    const result = await adjudicateVerdict({
      verdict: finalVerdict,
      transcript: output.transcript ?? [],
      prBody: pr.body,
      model: args.adjudicator,
    });
    adjudicated = result.verdict;
    puntsBefore = result.puntsBefore;
    puntsAfter = result.puntsAfter;
    for (const o of result.outcomes) {
      console.error(
        `[adjudicate] item ${o.itemId}: ${o.keptPunt ? "kept" : "overturned"}` +
          `${o.spentCall ? "" : " (no call)"} — ${o.reason}`,
      );
    }
  }

  const body = renderStickyComment(adjudicated);
  const retryNote =
    retries > 0 ? `verdict JSON required ${retries} re-prompt(s) before validating` : undefined;
  return {
    verdict: adjudicated,
    body,
    overall: overallStatus(adjudicated),
    puntsBefore,
    puntsAfter,
    prContext: pr,
    ticket,
    cached: false,
    researchTrace: output.trace,
    researchReason: research.reason,
    transcript: output.transcript ?? [],
    ...(output.degraded || retryNote
      ? { degraded: [output.degraded, retryNote].filter(Boolean).join("; ") }
      : {}),
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
 * The model's output could not be turned into a trustworthy verdict table.
 *
 * Distinct from a generic parse failure because the caller acts on it: it
 * re-prompts with this exact message, which is far more effective than
 * silently repairing (SWE-agent measured recovery dropping from 90.5% to 57.2%
 * once a bad action is absorbed rather than corrected at the boundary).
 */
export class VerdictShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictShapeError";
  }
}

/** Validation retries. Cheap relative to a wrong merge-gating verdict. */
const MAX_VERDICT_RETRIES = 2;

/**
 * Ask the model for a verdict, re-prompting with the exact validation error
 * before falling back to repair heuristics (OGE-1593).
 *
 * The heuristics are kept — `claude-code-security-review` retains a fallback
 * tier at production scale for good reason — but they are now the *last*
 * resort rather than the first, and a run that needs them is marked degraded
 * instead of passing silently.
 *
 * Retries do not consume tool-loop iterations: the loop's caps govern
 * investigation, this governs output shape.
 */
async function produceVerdictWithRetry(args: {
  model: VerdictModel;
  userPrompt: string;
  research: ResearchPolicy;
  parse: (text: string, output: VerdictModelOutput) => ReviewVerdict;
}): Promise<{ output: VerdictModelOutput; verdict: ReviewVerdict; retries: number }> {
  let lastText = "";
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_VERDICT_RETRIES; attempt++) {
    const prompt =
      attempt === 0
        ? args.userPrompt
        : [
            args.userPrompt,
            ``,
            `## Your previous response was rejected`,
            ``,
            `It did not validate against the ReviewVerdict schema:`,
            ``,
            "```",
            lastError,
            "```",
            ``,
            `Return the corrected JSON only — same checklist, one object per item,`,
            `each with its 1-based "id". Do not explain the correction.`,
          ].join("\n");

    const output = normalizeModelOutput(
      await args.model.produce({ systemPrompt: SYSTEM_PROMPT, userPrompt: prompt, research: args.research }),
    );
    lastText = output.text;

    try {
      return { output, verdict: args.parse(output.text, output), retries: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `[review] verdict validation failed (attempt ${attempt + 1}/${MAX_VERDICT_RETRIES + 1}): ${lastError}`,
      );
    }
  }

  // Retries exhausted. Deliberately NOT falling back to a permissive parse:
  // the repairs that are safe (backfilling itemText from the checklist,
  // coercing bare-string evidenceRefs) already ran inside `parse` on every
  // attempt. The only thing a laxer pass could add is positional renumbering,
  // which is the mis-mapping hazard this ticket exists to remove.
  //
  // Throwing here routes to the caller's failure-safe path — a `neutral`
  // Check, never a `failure` — so an unparseable response blocks nothing and
  // is visible, rather than silently gating a merge on a shifted table.
  throw new VerdictShapeError(
    `Model output failed schema validation after ${MAX_VERDICT_RETRIES + 1} attempts. ` +
      `Last error: ${lastError}`,
  );
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
    promptHash: string;
    toolOutputHash: string;
    checklist: { items: Array<{ id: number; text: string; human?: boolean }> };
    trace: ResearchTrace;
    researchEnabled: boolean;
    linkedCommentUrls: string[];
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

  // Positional id backfill is only safe when the model returned exactly the
  // checklist it was given (OGE-1593). If it dropped a mid-list item and we
  // renumber by position, every later verdict silently lands on the WRONG
  // checklist item — and that mis-mapped table goes straight into a
  // merge-gating comment with no error anywhere. Refuse instead; the caller
  // re-prompts with this message.
  const missingIds = rawItems.some(
    (raw) => !(raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "number"),
  );
  if (missingIds && rawItems.length !== injected.checklist.items.length) {
    throw new VerdictShapeError(
      `Model returned ${rawItems.length} item(s) for a ${injected.checklist.items.length}-item ` +
        `checklist and at least one has no "id". Refusing to renumber by position — return one ` +
        `object per checklist item, each with its 1-based "id".`,
    );
  }

  const repairedItems = rawItems.map((raw, idx) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof item.id === "number" ? item.id : idx + 1;
    const source = checklistById.get(id);
    const itemText =
      typeof item.itemText === "string" && item.itemText.length > 0
        ? item.itemText
        : (source?.text ?? `Item ${id}`);
    const coerced = Array.isArray(item.evidenceRefs)
      ? (item.evidenceRefs as unknown[]).map(coerceEvidenceRef).filter((r) => r !== null)
      : [];
    // `human` comes from the parsed checklist, never from the model — whether
    // a criterion needs a person is the author's declaration, not a verdict
    // the model gets to make. Overwrite anything the model emitted (OGE-1559).
    const human = source?.human === true;
    const evidenceRefs = dropUnsourcedCitations(coerced, {
      itemId: id,
      human,
      trace: injected.trace,
      researchEnabled: injected.researchEnabled,
      linkedCommentUrls: injected.linkedCommentUrls,
    });
    return { ...item, id, itemText, evidenceRefs, human };
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
    promptHash: injected.promptHash,
    toolOutputHash: injected.toolOutputHash,
  };
  return ReviewVerdict.parse(candidate);
}

/**
 * Strip external citations on `[human]` items that no search actually
 * returned (OGE-1566).
 *
 * This is the structural half of "no uncited domain claims". The prompt asks
 * the model not to assert standards it can't cite; this makes the ask
 * enforceable, because a model that invents `https://hhs.gov/...` to dress up
 * a half-remembered fact produces a citation that looks authoritative and
 * isn't. A wrong DSM-5 claim carrying a real-looking government URL is worse
 * than no briefing at all — it anchors the expert who reads it, and the entire
 * value of a briefing is that they trust it enough to move faster.
 *
 * Scope is deliberately narrow — only `[human]` items, and only when research
 * actually ran:
 *   - Non-`[human]` items legitimately cite URLs from the diff, the ticket
 *     description, or a linked verification comment. Filtering those would
 *     break the OGE-365 promotion path.
 *   - With research off there is no result set to check against, so every
 *     external ref would be dropped — silently gutting evidence on repos that
 *     never opted in.
 *
 * Same-PR verification-comment URLs stay permitted: they were fetched by the
 * orchestrator and are evidence of a different kind.
 */
function dropUnsourcedCitations(
  refs: unknown[],
  ctx: {
    itemId: number;
    human: boolean;
    trace: ResearchTrace;
    researchEnabled: boolean;
    linkedCommentUrls: string[];
  },
): unknown[] {
  if (!ctx.human || !ctx.researchEnabled) return refs;

  const permitted = new Set([...ctx.trace.citedUrls, ...ctx.linkedCommentUrls]);

  return refs.filter((ref) => {
    if (typeof ref !== "object" || ref === null) return true;
    const r = ref as Record<string, unknown>;
    if (r.kind !== "external" || typeof r.url !== "string") return true;
    if (permitted.has(r.url)) return true;
    console.error(
      `[review] dropped uncited external evidence on item ${ctx.itemId}: ${r.url} ` +
        `(not returned by any search this run)`,
    );
    return false;
  });
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
      const fetcher =
        link.kind === "pr-comment-issue"
          ? github.getIssueComment
          : github.getReviewComment;
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
