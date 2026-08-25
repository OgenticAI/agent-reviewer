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
import { resolveTickets } from "./pr/linear/resolve.js";
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
import type { ToolCallRecord } from "./engine/tools/loop.js";
import { fenceUntrusted, sanitizeUntrusted } from "./engine/tools/sanitize.js";
import { hashPrompt, hashToolOutputs, isCacheHit } from "./cache/verdict-cache.js";
import { adjudicateVerdict, type AdjudicatorModel } from "./adjudicate.js";
import { CI_UNAVAILABLE, type CiSummary } from "./pr/ci/summary.js";
import {
  estimateTokens,
  packDiff,
  splitDiff,
  type PackDiffOptions,
} from "./prompt/diff-pack.js";

/**
 * Packed-diff token ceiling past which the diff is dropped entirely (OGE-1581).
 * Well above the default packing budget: this only catches the pathological
 * case where a single file is itself larger than the window.
 */
const DEFAULT_MAX_DIFF_TOKENS = 60_000;
import { computeOutcomes, type OutcomeSummary } from "./metrics/outcomes.js";
import { ingestFindings } from "./engine/findings/ingest.js";
import type { JobFindings } from "./engine/findings/schema.js";
import { gateFindings, type FindingsFailLevel, type FindingsGateResult } from "./engine/findings/gate.js";
import type { CiLogClient } from "./engine/tools/ci-logs.js";
import {
  buildPositionMap,
  renderFallbackSection,
  renderInlineFindingBody,
  splitFindings,
  type InlineComment,
} from "./render/inline.js";
import { attachSuggestions } from "./render/suggestion.js";
import {
  runTriage,
  priorityFilesFrom,
  type TriageModel,
  type TriageResult,
} from "./triage/triage.js";
import {
  appendReviewedSha,
  highestReviewedSha,
  mergeCarriedForward,
  selectItems,
} from "./incremental/select.js";
import {
  loadRepoConfig,
  matchingLearnedRules,
  matchingPathInstructions,
  triggeredRecipes,
  type RefFileReader,
} from "./config.js";
import { buildRepoMap, type RepoFile } from "./engine/repomap/index.js";
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
  /**
   * Repo-relative paths changed between two commits (OGE-1592). Used to tell a
   * finding that was acted on from one that merely flipped. Optional: without
   * it every flip reads as unexplained, which errs toward flagging.
   */
  getChangedPaths?(args: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<string[]>;
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
  /**
   * Reads files at a git ref, used to load `.agent-reviewer.yml` and the
   * repo's `AGENTS.md` / `CLAUDE.md` from the default branch (OGE-1585).
   * Omitted means no per-repo config — prompts stay byte-identical.
   */
  configReader?: RefFileReader;
  /**
   * Item ids a human force-passed via `/uat-override` (OGE-1592). Labelled
   * `overridden` in the outcome data rather than counted as the reviewer
   * being agreed with — those mean opposite things.
   */
  overriddenItemIds?: number[];
  /**
   * CI log/artifact reader for deterministic findings ingestion (OGE-1588).
   * Reuses OGE-1557's client surface. Omitted means no ingestion — prompts
   * stay byte-identical for repos that don't wire it.
   */
  findingsClient?: CiLogClient;
  /** Severity at/above which analyzer findings fail the Check (OGE-1588). */
  findingsFailLevel?: FindingsFailLevel;
  /**
   * Anchor FAIL/PARTIAL evidence as inline review comments (OGE-1586). Default
   * off — when off, the sticky body stays byte-identical and no inline comments
   * are produced.
   */
  inlineCommentsEnabled?: boolean;
  /**
   * Haiku-class triage model (OGE-1595). When supplied, a cheap pre-pass routes
   * the tool loop onto the hard items and prioritizes the files it flags in the
   * diff pack. Omitted / errors → today's uniform behaviour, unchanged.
   */
  triageModel?: TriageModel;
  /**
   * Carry untouched verdicts forward across pushes (OGE-1590). Requires a
   * previous verdict (`cachedVerdict`) and `github.getChangedPaths`. Off by
   * default; the CLI decides via the `incremental_*` thresholds.
   */
  incrementalEnabled?: boolean;
  /**
   * Checked-out repo files for the ranked repo map (OGE-1582). When supplied,
   * `runReview` builds a signature-only map before the tool loop and injects it
   * read-only. Omitted keeps the prompt byte-identical.
   */
  repoFiles?: RepoFile[];
  /** Base token budget for the repo map; scales inversely with diff size. */
  mapTokens?: number;
  /**
   * Hard ceiling on packed-diff tokens before the overflow fallback trips
   * (OGE-1581). Defaults generously — this is the "would not fit at all" line,
   * not the packing budget.
   */
  maxDiffTokens?: number;
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
  /**
   * Per-item outcomes vs the previous verdict (OGE-1592). Undefined on the
   * first review of a PR, when there is nothing to compare against.
   */
  outcomes?: OutcomeSummary;
  /** Ingested analyzer/test findings, per job (OGE-1588). */
  findings?: JobFindings[];
  /** The deterministic findings-gate result (OGE-1588). */
  findingsGate?: FindingsGateResult;
  /**
   * The effective `fail_on` list after applying config precedence (OGE-1585):
   * a committed `.agent-reviewer.yml` overrides the action input. Undefined
   * when the repo committed no `fail_on`, in which case the action input
   * stands on its own.
   *
   * Surfaced here rather than applied internally because the Check conclusion
   * is decided by the Action, and having two places decide it is exactly the
   * divergence OGE-1559 already caused once.
   */
  effectiveFailOn?: string[];
  /** Inline review comments to post (OGE-1586), when inline mode is on. */
  inlineComments?: InlineComment[];
  /** Item ids that got a committable suggestion block (OGE-1596). */
  suggestedItemIds?: number[];
  /** Per-item routing from the cheap triage pre-pass (OGE-1595), when it ran. */
  triage?: TriageResult;
  /** Carried vs re-verified counts when incremental review ran (OGE-1590). */
  incremental?: { carried: number; reverified: number };
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

  // Ingest structured analyzer/test output as established facts (OGE-1588).
  // Deterministic, up front — the mechanical items ("lint passes", "no new
  // type errors") no longer depend on the model reading a log tail well.
  let findings: JobFindings[] | undefined;
  if (args.findingsClient) {
    try {
      findings = await ingestFindings(args.findingsClient, {
        owner: pr.owner,
        repo: pr.repo,
        headSha: pr.headSha,
      });
    } catch {
      // Ingestion is best-effort context. A failure costs the facts, not the run.
      findings = undefined;
    }
  }

  // Pack before prompting: an unbounded diff either overflows the window or
  // crowds out the checklist and tool results (OGE-1581).
  // Per-repo config, read from the DEFAULT BRANCH only (OGE-1585) — loaded
  // before packing because `exclude_globs` decides what gets packed at all.
  const repoConfig =
    args.configReader && pr.defaultBranch
      ? await loadRepoConfig(args.configReader, pr.defaultBranch)
      : null;
  for (const w of repoConfig?.warnings ?? []) {
    console.error(`[config] ${w}`);
  }

  // Cheap-model triage BEFORE packing (OGE-1595): route the tool loop onto the
  // hard items and let the files it flags survive the token budget. Fail-open —
  // absent a triage model, or on any error, this is a no-op.
  let triage: TriageResult | undefined;
  if (args.triageModel) {
    triage = await runTriage({
      model: args.triageModel,
      checklist: checklist.items.map((it) => ({ id: it.id, text: it.text })),
      changedFiles: splitDiff(diff).map((f) => f.path),
    });
    const counts = triage.items.reduce<Record<string, number>>((acc, it) => {
      acc[it.routing] = (acc[it.routing] ?? 0) + 1;
      return acc;
    }, {});
    console.error(`[triage] ${JSON.stringify(counts)}`);
  }
  const triagePriority = triage ? priorityFilesFrom(triage) : [];

  const packed = packDiff(diff, {
    ...args.diffPack,
    excludeGlobs: [...(args.diffPack?.excludeGlobs ?? []), ...(repoConfig?.config.exclude_globs ?? [])],
    checklistTexts: checklist.items.map((it) => it.text),
    ...(triagePriority.length > 0 ? { priorityPaths: triagePriority } : {}),
  });
  if (packed.truncated) {
    console.error(
      `[diff] packed ${packed.includedFiles.length} file(s); skipped ${packed.skippedFiles.length}` +
        ` (${packed.skippedFiles.map((s) => s.reason).join(", ")})`,
    );
  }

  // Only the guidance this PR actually triggers reaches the prompt — an
  // instruction for files nobody touched is context spent for nothing.
  const changedFiles = packed.includedFiles.concat(packed.skippedFiles.map((s) => s.path));
  const repoGuidance = repoConfig
    ? {
        files: repoConfig.guidance,
        pathInstructions: matchingPathInstructions(repoConfig.config, changedFiles),
        recipes: triggeredRecipes(
          repoConfig.config,
          checklist.items.map((it) => it.text),
        ),
        // Learned rules join the prompt on exactly the same terms as
        // hand-written ones (OGE-1594) — they earned that standing by being
        // accepted through a human merge.
        learnedRules: matchingLearnedRules(
          repoConfig.config,
          checklist.items.map((it) => it.text),
          changedFiles,
        ),
      }
    : undefined;

  // Ranked repo map before the tool loop (OGE-1582): answer repo-wide claims
  // from a standing symbol map instead of paying per tool iteration to explore.
  let repoMap: string | undefined;
  if (args.repoFiles && args.repoFiles.length > 0) {
    const map = buildRepoMap({
      files: args.repoFiles,
      diffTouchedFiles: changedFiles,
      seedTexts: checklist.items.map((it) => it.text),
      diffText: packed.text,
      ...(args.mapTokens !== undefined ? { baseTokens: args.mapTokens } : {}),
    });
    if (map.text) {
      repoMap = map.text;
      console.error(`[repomap] ${map.fileCount} file(s), budget ${map.budget} tokens`);
    }
  }

  // Overflow fallback (OGE-1581): if even the packed diff would blow the
  // window, drop diff text entirely and hand over the changed-file list plus
  // the read tools. A degraded review beats a failed run on a merge gate.
  const packedTokens = estimateTokens(packed.text);
  const overflow = packedTokens > (args.maxDiffTokens ?? DEFAULT_MAX_DIFF_TOKENS);
  const diffOmitted = overflow
    ? {
        changedFiles,
        reason: `it is ~${packedTokens} tokens even after packing, beyond the prompt budget`,
      }
    : undefined;
  if (overflow) {
    console.error(`[diff] OVERFLOW at ~${packedTokens} tokens — falling back to the file list`);
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
    repoGuidance,
    ...(findings ? { findings } : {}),
    ...(repoMap ? { repoMap } : {}),
    ...(diffOmitted ? { diffOmitted } : {}),
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

  // Incremental review: carry untouched items forward from the previous
  // verdict so an unrelated push can't churn a verdict whose code didn't move
  // (OGE-1590). The previous verdict is the same sidecar the cache reads.
  let incrementalInfo: { carried: number; reverified: number } | undefined;
  const previousVerdict = args.cachedVerdict ?? null;
  const reviewedShas = appendReviewedSha(previousVerdict, pr.headSha);
  if (args.incrementalEnabled && previousVerdict && args.github.getChangedPaths) {
    const base = highestReviewedSha(previousVerdict);
    let changedPaths: string[] = [];
    if (base && base !== pr.headSha) {
      try {
        changedPaths = await args.github.getChangedPaths({
          owner: pr.owner,
          repo: pr.repo,
          base,
          head: pr.headSha,
        });
      } catch (err) {
        // Fail-open: no delta means re-verify everything, never carry a stale
        // verdict on a failed diff read.
        console.error(
          `[incremental] delta ${base}..${pr.headSha} failed; full review — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const selection = selectItems({
      previousItems: previousVerdict.items,
      currentItemIds: adjudicated.items.map((it) => it.id),
      changedPaths,
    });
    const mergedItems = mergeCarriedForward({ fresh: adjudicated, previous: previousVerdict, selection });
    adjudicated = { ...adjudicated, items: mergedItems };
    incrementalInfo = { carried: selection.carryForward.size, reverified: selection.reverify.size };
    console.error(
      `[incremental] carried ${incrementalInfo.carried}, re-verified ${incrementalInfo.reverified}`,
    );
  }
  adjudicated = { ...adjudicated, reviewedShas };

  // Outcome telemetry: did the last verdict change anything? (OGE-1592)
  // `puntRate` alone cannot tell better verification from bolder guessing.
  const outcomes = await computeOutcomesForRun({
    previous: args.cachedVerdict ?? null,
    current: adjudicated,
    pr,
    github: args.github,
    overriddenItemIds: args.overriddenItemIds,
  });

  // The findings gate is deterministic and independent of the verdict
  // (OGE-1588): an error-level analyzer finding fails the Check whatever the
  // model concluded, because "tsc reported 3 errors" is not the model's call.
  const findingsGate = findings
    ? gateFindings(findings, args.findingsFailLevel ?? "off")
    : undefined;

  // Anchor FAIL/PARTIAL evidence inline, routing the rest to the sticky
  // fallback (OGE-1586). Off by default keeps the body byte-identical.
  let inlineComments: InlineComment[] | undefined;
  let fallbackSection: string | null | undefined;
  let suggested: number[] | undefined;
  if (args.inlineCommentsEnabled) {
    const positionMap = buildPositionMap(diff);
    const rawSplit = splitFindings(adjudicated.items, positionMap, renderInlineFindingBody);
    // Upgrade small, certain FAIL fixes to committable suggestion blocks
    // (OGE-1596); everything else keeps its prose comment / draft-PR path.
    const { split, suggestedItemIds } = attachSuggestions({
      split: rawSplit,
      items: adjudicated.items,
      positionMap,
    });
    inlineComments = split.inline;
    fallbackSection = renderFallbackSection(split.unanchored);
    if (suggestedItemIds.length > 0) {
      suggested = suggestedItemIds;
      console.error(`[inline] committable suggestions for item(s) ${suggestedItemIds.join(", ")}`);
    }
  }

  const body = renderStickyComment(adjudicated, fallbackSection);
  const retryNote =
    retries > 0 ? `verdict JSON required ${retries} re-prompt(s) before validating` : undefined;
  return {
    verdict: adjudicated,
    body,
    overall: overallStatus(adjudicated),
    puntsBefore,
    puntsAfter,
    ...(outcomes ? { outcomes } : {}),
    ...(findings ? { findings } : {}),
    ...(findingsGate ? { findingsGate } : {}),
    ...(repoConfig?.config.fail_on ? { effectiveFailOn: repoConfig.config.fail_on } : {}),
    ...(inlineComments ? { inlineComments } : {}),
    ...(suggested ? { suggestedItemIds: suggested } : {}),
    ...(triage ? { triage } : {}),
    ...(incrementalInfo ? { incremental: incrementalInfo } : {}),
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
/**
 * How much of a rejected response to quote back on retry.
 *
 * `VerdictModelRequest` carries no message history — each attempt is a fresh
 * single-turn call — so the model cannot see what it returned unless we send
 * it. Quoting the whole thing is the obvious move and the wrong one: a verdict
 * over a long checklist can run to tens of kilobytes, and we would pay for it
 * on every retry.
 *
 * Head and tail, because the two failure shapes live at opposite ends. A
 * preamble the model was told not to write ("Here is the JSON:") is at the
 * front; truncation and an unterminated array are at the back. Sampling one
 * end would routinely cut away the evidence.
 *
 * `headRatio` is what lets the same function serve the thrown error, which
 * wants the tail alone — the failure there is almost always "it stopped
 * mid-JSON", and only the end shows where.
 */
const RETRY_EXCERPT_CHARS = 2000;

/** Enough of the tail to see how a response ended, in an operator's log line. */
const THROW_TAIL_CHARS = 300;

export function excerptForRetry(
  text: string,
  limit = RETRY_EXCERPT_CHARS,
  headRatio = 0.5,
): string {
  if (text.length <= limit) return text;

  const head = Math.round(limit * headRatio);
  const tail = limit - head;
  const elision = `\n\n... [${text.length - limit} characters omitted] ...\n\n`;

  // `slice(-0)` returns the WHOLE string, not the empty one, so a zero-length
  // end has to be spelled out rather than left to the arithmetic. Found by the
  // OGE-2459 session reviewing this function; at head=0 the tail-only excerpt
  // was silently returning the entire input.
  return [
    ...(head > 0 ? [text.slice(0, head)] : []),
    ...(tail > 0 ? [text.slice(text.length - tail)] : []),
  ].join(elision);
}

async function produceVerdictWithRetry(args: {
  model: VerdictModel;
  userPrompt: string;
  research: ResearchPolicy;
  parse: (text: string, output: VerdictModelOutput) => ReviewVerdict;
}): Promise<{ output: VerdictModelOutput; verdict: ReviewVerdict; retries: number }> {
  let lastError = "";
  let lastText = "";

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
            // Fenced, not just quoted. This text is the model's own output
            // produced AFTER reading the PR diff, so it can carry anything the
            // diff carried — including an instruction aimed at us that the
            // model echoed. Re-sending it unfenced would launder attacker
            // content from "something we read" into "something we said". The
            // `<untrusted>` tag is the one the standing rule already in this
            // prompt (UNTRUSTED_CONTENT_RULE, carried in args.userPrompt)
            // refers to, so no new instruction is needed here.
            `This is what you returned:`,
            ``,
            fenceUntrusted(sanitizeUntrusted(excerptForRetry(lastText)), {
              source: "rejected-verdict",
            }),
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
      `Last error: ${lastError}. ` +
      `Last output ended: ...${excerptForRetry(lastText, THROW_TAIL_CHARS, 0)}`,
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

/**
 * Outcome telemetry for one run (OGE-1592).
 *
 * Returns undefined rather than an empty summary when there is nothing to
 * compare against — a first review has no outcomes, and reporting zeroes would
 * read as "nothing was acted on", which is a different and much worse claim.
 *
 * Every failure path degrades to no telemetry. Measurement must never be able
 * to take down the thing it measures.
 */
async function computeOutcomesForRun(args: {
  previous: ReviewVerdict | null;
  current: ReviewVerdict;
  pr: PrContext;
  github: GithubReader;
  overriddenItemIds?: number[];
}): Promise<OutcomeSummary | undefined> {
  const { previous, current } = args;
  if (!previous) return undefined;
  // Same commit means nothing could have been acted on since.
  if (previous.headSha === current.headSha) return undefined;

  let changedPaths: string[] = [];
  if (args.github.getChangedPaths) {
    try {
      changedPaths = await args.github.getChangedPaths({
        owner: args.pr.owner,
        repo: args.pr.repo,
        base: previous.headSha,
        head: current.headSha,
      });
    } catch (err) {
      console.error(
        `[outcomes] could not diff ${previous.headSha}..${current.headSha}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return computeOutcomes({
    previous,
    current,
    changedPaths,
    ...(args.overriddenItemIds ? { overriddenItemIds: args.overriddenItemIds } : {}),
  });
}
