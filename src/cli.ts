#!/usr/bin/env node
/**
 * Local CLI runner for the OgenticAI Reviewer.
 *
 * Subcommands:
 *   review-pr <pr-url>     [--post] [--output-json PATH] [--no-linear-writeback]
 *   override-pr <pr-url>   --by <github-user> --reason "<reason>"
 *
 * `review-pr` is the per-push verdict pipeline (OGE-338 + OGE-339).
 * `override-pr` applies a `/uat-override <reason>` request after the override
 * Action has parsed the PR comment and verified the commenter's permission
 * (OGE-340). Run by both the Action and locally for testing.
 *
 * Exit codes:
 *   0  success
 *   2  bad CLI args
 *   3  review skipped (no ticket / no checklist) — emit neutral Check upstream
 *   4  required env var missing
 *   5  permission denied (override only)
 *   1  any other failure
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import Anthropic from "@anthropic-ai/sdk";

import { runReview, ReviewSkippedError } from "./review.js";
import type { GithubReader, VerdictModel } from "./review.js";
import { LinearGraphqlClient } from "./linear/client.js";
import { runWriteback } from "./linear/writeback.js";
import { isCiGreen } from "./ci-green.js";
import { fetchCiSummary } from "./ci/summary.js";
import { readStickyComment, upsertStickyComment } from "./github/sticky.js";
import { extractResearchTrace, extractText } from "./research/trace.js";
import { parseVerdictFromStickyBody } from "./cache/verdict-cache.js";
import { runToolLoop, type TurnFn } from "./tools/loop.js";
import type { AdjudicatorModel } from "./adjudicate.js";
import type { RefFileReader } from "./config.js";
import { toOutcomeRows, renderOutcomeRows } from "./metrics/outcomes.js";
import { EMPTY_REGISTRY, makeRegistry, toolDefinitions, type ToolRegistry } from "./tools/registry.js";
import { makeRepoTools, resolveWithinRoot } from "./tools/repo.js";
import { makeHttpTools } from "./tools/http.js";
import { makeCiLogTools, type CiLogClient } from "./tools/ci-logs.js";
import { parseFailLevel } from "./findings/gate.js";
import { reconcileInlineComments, type InlineCommentClient } from "./github/inline-comments.js";
import type { TriageModel } from "./triage/triage.js";
import { parseUatChecklist } from "./parser/uat.js";
import { lintChecklist } from "./lint/checklist.js";
import { renderLintComment } from "./render/lint-comment.js";
import { LINT_COMMENT_MARKER, REVIEWER_VERSION } from "./version.js";
import {
  applyOverride,
  CHECK_NAME,
  isMaintainer,
  parseOverrideComment,
  type CheckPublisher,
  type LinearOverrideWriter,
  type PermissionChecker,
  type PrReplyWriter,
} from "./override.js";
import { resolveTickets } from "./linear/resolve.js";

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

type Subcommand = "review-pr" | "override-pr" | "lint-checklist";

interface ReviewArgs {
  command: "review-pr";
  prUrl: string;
  post: boolean;
  outputJson: string | undefined;
  linearWriteback: boolean;
}

interface LintArgs {
  command: "lint-checklist";
  prUrl: string;
  post: boolean;
}

interface OverrideArgs {
  command: "override-pr";
  prUrl: string;
  by: string;
  reason: string;
  /** Bypass GitHub-side permission check. Used by the override Action which
   *  already verified the commenter via `actor` event metadata. Off by
   *  default — local invocations re-check. */
  skipPermissionCheck: boolean;
}

type CliArgs = ReviewArgs | OverrideArgs | LintArgs;

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] as Subcommand | undefined;
  if (command === "review-pr") return parseReviewArgs(args);
  if (command === "override-pr") return parseOverrideArgs(args);
  if (command === "lint-checklist") return parseLintArgs(args);
  printUsageAndExit();
}

function parseLintArgs(args: string[]): LintArgs {
  const prUrl = args[1];
  if (!prUrl) printUsageAndExit();
  return { command: "lint-checklist", prUrl, post: args.includes("--post") };
}

function parseReviewArgs(args: string[]): ReviewArgs {
  const prUrl = args[1];
  if (!prUrl) printUsageAndExit();
  const post = args.includes("--post");
  const outIdx = args.indexOf("--output-json");
  const outputJson = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const linearWriteback = !args.includes("--no-linear-writeback");
  return { command: "review-pr", prUrl, post, outputJson, linearWriteback };
}

function parseOverrideArgs(args: string[]): OverrideArgs {
  const prUrl = args[1];
  if (!prUrl) printUsageAndExit();
  const byIdx = args.indexOf("--by");
  const reasonIdx = args.indexOf("--reason");
  if (byIdx < 0 || reasonIdx < 0) printUsageAndExit();
  const by = args[byIdx + 1];
  const reason = args[reasonIdx + 1];
  if (!by || !reason) printUsageAndExit();
  const skipPermissionCheck = args.includes("--skip-permission-check");
  return { command: "override-pr", prUrl, by, reason, skipPermissionCheck };
}

function printUsageAndExit(): never {
  console.error(
    [
      "Usage:",
      "  ogenticai-reviewer review-pr      <pr-url> [--post] [--output-json PATH] [--no-linear-writeback]",
      "  ogenticai-reviewer override-pr    <pr-url> --by <github-user> --reason \"<reason>\" [--skip-permission-check]",
      "  ogenticai-reviewer lint-checklist <pr-url> [--post]",
      "",
      "Required env vars:",
      "  ANTHROPIC_API_KEY  (review-pr only)",
      "  GITHUB_TOKEN       always",
      "  LINEAR_API_TOKEN   review-pr / override-pr only",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const match = PR_URL_RE.exec(args.prUrl);
  if (!match) {
    console.error(`Not a recognized PR URL: ${args.prUrl}`);
    process.exit(2);
  }
  const owner = match[1]!;
  const repo = match[2]!;
  const number = Number(match[3]!);

  if (args.command === "review-pr") {
    return runReviewCommand({ args, owner, repo, number });
  }
  if (args.command === "lint-checklist") {
    return runLintCommand({ args, owner, repo, number });
  }
  return runOverrideCommand({ args, owner, repo, number });
}

// ─── lint-checklist (OGE-1559) ────────────────────────────────────────────────

/**
 * Lint the PR's UAT checklist and (with --post) leave an advisory comment.
 *
 * Deliberately cheap: no Anthropic call, no Linear call, no diff fetch. It
 * reads the PR body and nothing else, so it can run on `opened`/`edited` well
 * before the review pass and costs nothing to run often.
 *
 * Exit codes follow the review command's convention — 3 means "nothing to do"
 * (no checklist), which the workflow treats as a clean skip, not a failure.
 */
async function runLintCommand(env: {
  args: LintArgs;
  owner: string;
  repo: string;
  number: number;
}): Promise<void> {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const octokit = new Octokit({ auth: githubToken });

  const pr = await octokit.pulls.get({
    owner: env.owner,
    repo: env.repo,
    pull_number: env.number,
  });

  const checklist = parseUatChecklist(pr.data.body ?? "");
  if (!checklist.found) {
    console.error(`[skip] No "## UAT checklist" block in the PR description.`);
    process.exit(3);
  }

  const result = lintChecklist(checklist);
  const body = renderLintComment(result);

  console.error(
    `Checklist: ${result.totalItems} item(s) · ${result.flaggedItems} flagged · ` +
      `${result.humanMarkedItems} marked [human]` +
      (result.nothingVerifiable ? " · NOTHING VERIFIABLE" : ""),
  );
  for (const f of result.findings) {
    console.error(`  [${f.kind}] item ${f.itemId}: ${f.itemText}`);
  }

  if (!body) {
    console.error("(checklist looks checkable — no comment to post)");
    return;
  }

  process.stdout.write(body + "\n");

  if (env.args.post) {
    const upsert = await upsertStickyComment({
      octokit,
      owner: env.owner,
      repo: env.repo,
      issueNumber: env.number,
      body,
      marker: LINT_COMMENT_MARKER,
    });
    console.error(`[github:${upsert.action}] ${upsert.url}`);
  } else {
    console.error("(dry run — pass --post to upsert the advisory comment)");
  }
}

// ─── review-pr ────────────────────────────────────────────────────────────────

async function runReviewCommand(env: {
  args: ReviewArgs;
  owner: string;
  repo: string;
  number: number;
}): Promise<void> {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
  const linearToken = requireEnv("LINEAR_API_TOKEN");

  const octokit = new Octokit({ auth: githubToken });
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const linear = new LinearGraphqlClient({ token: linearToken });

  try {
    // The previous sticky comment carries the previous verdict as a JSON
    // sidecar — that's the cache. A read failure is not fatal: no cache just
    // means we re-run the review (OGE-1566).
    let cachedVerdict = null;
    try {
      const previous = await readStickyComment({
        octokit,
        owner: env.owner,
        repo: env.repo,
        issueNumber: env.number,
      });
      cachedVerdict = previous ? parseVerdictFromStickyBody(previous) : null;
    } catch (err) {
      console.error(
        `[review] could not read the previous sticky comment (continuing without cache): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Resolve the head SHA up front: the CI-log tools are scoped to this
    // commit, and scoping them from PR data rather than from model input is
    // what stops a PR naming someone else's repository.
    const prMeta = await octokit.pulls.get({
      owner: env.owner,
      repo: env.repo,
      pull_number: env.number,
    });
    const registry = buildToolRegistry(octokit, {
      owner: env.owner,
      repo: env.repo,
      headSha: prMeta.data.head.sha,
    });

    const result = await runReview({
      pr: { owner: env.owner, repo: env.repo, number: env.number },
      github: makeGithubReader(octokit),
      linear,
      configReader: makeRefFileReader(octokit, { owner: env.owner, repo: env.repo }),
      // Deterministic analyzer/test ingestion (OGE-1588), reusing the CI log
      // client. The gate is off unless the repo opts in.
      findingsClient: makeCiLogClient(octokit),
      findingsFailLevel: parseFailLevel(process.env.REVIEWER_FINDINGS_FAIL_LEVEL),
      inlineCommentsEnabled: process.env.REVIEWER_INLINE_COMMENTS === "true",
      ...(process.env.REVIEWER_TRIAGE === "true"
        ? { triageModel: makeTriageModel(anthropic) }
        : {}),
      model: makeAnthropicModel(anthropic, registry),
      researchEnabled: process.env.REVIEWER_RESEARCH === "true",
      cachedVerdict,
      diffPack: {
        ...(process.env.REVIEWER_DIFF_TOKEN_BUDGET
          ? { tokenBudget: Number(process.env.REVIEWER_DIFF_TOKEN_BUDGET) }
          : {}),
        ...(process.env.REVIEWER_EXCLUDE_GLOBS
          ? {
              excludeGlobs: process.env.REVIEWER_EXCLUDE_GLOBS.split(",")
                .map((g) => g.trim())
                .filter(Boolean),
            }
          : {}),
        // Hunk expansion needs the file on disk (OGE-1591). Reuses the same
        // containment as the read tools, so a diff naming a path outside the
        // checkout cannot pull an arbitrary file into the prompt.
        readFile: (path: string) => {
          const root = resolveRepoRoot();
          if (!root) return null;
          try {
            return readFileSync(resolveWithinRoot(root, path), "utf8");
          } catch {
            return null;
          }
        },
      },
      ...(process.env.REVIEWER_ADJUDICATION === "true"
        ? { adjudicator: makeAdjudicatorModel(anthropic) }
        : {}),
    });

    process.stdout.write(result.body + "\n");
    console.error(
      `Overall: ${result.overall}  ·  ${result.verdict.items.length} item(s)  ·  ` +
        `reviewer=${REVIEWER_VERSION}${result.cached ? "  ·  (cached)" : ""}`,
    );
    console.error(`[research] ${result.researchReason}`);
    if (result.degraded) {
      console.error(`[review:degraded] ${result.degraded}`);
    }
    for (const call of result.transcript) {
      console.error(
        `[tool] ${call.name} (${call.durationMs}ms)${call.isError ? " ERROR" : ""}: ${call.result}`,
      );
    }
    // Audit trail. The model composes these and Anthropic dispatches them
    // server-side, so this after-the-fact log is the only record of what
    // actually left the building — see research/policy.ts.
    for (const query of result.researchTrace.queries) {
      console.error(`[research:query] ${query}`);
    }
    for (const code of result.researchTrace.errors) {
      console.error(`[research:error] ${code}`);
    }

    if (env.args.outputJson) {
      // Include the computed `overall` so the Action reads it straight off the
      // sidecar instead of reimplementing overallStatus() in inline node.
      // That duplication silently diverged the moment `[human]` items started
      // being excluded from the roll-up (OGE-1559) — one source of truth now.
      writeFileSync(
        env.args.outputJson,
        JSON.stringify(
          {
            ...result.verdict,
            overall: result.overall,
            // Deterministic findings gate (OGE-1588): the Action reads
            // `findingsGateFailed` to flip the Check to failure independent of
            // the verdict, so an error-level analyzer finding blocks merge on
            // its own.
            ...(result.findingsGate
              ? {
                  findingsGateFailed: result.findingsGate.failed,
                  findingsGateReason: result.findingsGate.reason,
                }
              : {}),
            // Triage routing recorded so the eval harness can measure whether
            // it helps or hurts (OGE-1595).
            ...(result.triage ? { triage: result.triage } : {}),
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    if (result.outcomes && env.args.outputJson) {
      // Labeled outcome rows for the eval harness (OGE-1589), JSONL beside the
      // verdict sidecar. One row per item; append-friendly across runs/repos.
      const rows = toOutcomeRows({
        verdict: result.verdict,
        summary: result.outcomes,
        repo: `${env.owner}/${env.repo}`,
        pr: env.number,
        generatedAt: new Date().toISOString(),
      });
      const rowsPath = env.args.outputJson.replace(/\.json$/, "") + ".outcomes.jsonl";
      writeFileSync(rowsPath, renderOutcomeRows(rows) + "\n", "utf8");
      console.error(`[outcomes] wrote ${rows.length} row(s) to ${rowsPath}`);
    }

    if (env.args.post) {
      const upsert = await upsertStickyComment({
        octokit,
        owner: env.owner,
        repo: env.repo,
        issueNumber: env.number,
        body: result.body,
      });
      console.error(`[github:${upsert.action}] ${upsert.url}`);

      // Anchor findings inline (OGE-1586). Never a formal review — the client
      // surface has no createReview method to call.
      if (result.inlineComments && result.inlineComments.length > 0) {
        const rec = await reconcileInlineComments({
          client: makeInlineCommentClient(octokit),
          owner: env.owner,
          repo: env.repo,
          pullNumber: env.number,
          commitId: result.prContext.headSha,
          desired: result.inlineComments,
        });
        console.error(
          `[github:inline] created=${rec.created} updated=${rec.updated} deleted=${rec.deleted}`,
        );
      }

      if (env.args.linearWriteback) {
        const meta = await linear.getIssueMeta(result.verdict.ticketId);
        const ciGreen = await isCiGreen(octokit, {
          owner: env.owner,
          repo: env.repo,
          ref: result.prContext.headSha,
        });
        const plan = await runWriteback({
          writer: linear,
          verdict: result.verdict,
          ticket: {
            id: meta.id,
            identifier: result.ticket.identifier,
            teamId: meta.teamId,
            url: meta.url,
            currentStatusType: meta.currentStatusType,
          },
          pr: {
            url: `https://github.com/${env.owner}/${env.repo}/pull/${env.number}`,
            ref: `${env.owner}/${env.repo}#${env.number}`,
          },
          ciGreen,
          // The merge event is what turns a still-open punt into a shipped-
          // unanswered question (OGE-1592). The Action sets this on `closed`
          // with `merged == true`.
          merged: process.env.REVIEWER_PR_MERGED === "true",
          metrics: {
            toolCalls: result.transcript.length,
            researchQueries: result.researchTrace.queries.length,
            cached: result.cached,
            puntsBefore: result.puntsBefore,
            puntsAfter: result.puntsAfter,
            ...(result.outcomes
              ? {
                  outcomes: {
                    actedOnRate: result.outcomes.actedOnRate,
                    overrideRate: result.outcomes.overrideRate,
                  },
                }
              : {}),
            ...(result.degraded ? { degraded: result.degraded } : {}),
          },
        });
        console.error(
          `[linear:comment:${plan.comment.action}] [linear:status:${plan.status.action}${
            plan.status.to ? `→${plan.status.to}` : ""
          }] children=${plan.children.length} errors=${plan.errors.length}`,
        );
        for (const err of plan.errors) {
          console.error(`  [linear:error] ${err.step}: ${err.message}`);
        }
      } else {
        console.error("(skipping Linear writeback per --no-linear-writeback)");
      }
    } else {
      console.error("(dry run — pass --post to upsert PR comment + run Linear writeback)");
    }
  } catch (err) {
    if (err instanceof ReviewSkippedError) {
      console.error(`[skip] ${err.message}`);
      process.exit(3);
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
}

// ─── override-pr ──────────────────────────────────────────────────────────────

async function runOverrideCommand(env: {
  args: OverrideArgs;
  owner: string;
  repo: string;
  number: number;
}): Promise<void> {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const linearToken = requireEnv("LINEAR_API_TOKEN");
  const octokit = new Octokit({ auth: githubToken });
  const linear = new LinearGraphqlClient({ token: linearToken });

  // Look up the PR — we need head SHA + html URL, plus the linked ticket id.
  const pr = await octokit.pulls.get({
    owner: env.owner,
    repo: env.repo,
    pull_number: env.number,
  });
  const headSha = pr.data.head.sha;
  const htmlUrl = pr.data.html_url;

  const tickets = resolveTickets({
    headRef: pr.data.head.ref,
    body: pr.data.body ?? "",
    title: pr.data.title,
  });
  if (tickets.ticketIds.length === 0) {
    console.error("No Linear ticket linked from branch / body / title — refusing to override.");
    process.exit(3);
  }
  const ticketId = tickets.ticketIds[0]!;

  // Permission gate (skippable when the Action has already verified).
  if (!env.args.skipPermissionCheck) {
    const checker = makePermissionChecker(octokit, env.owner, env.repo);
    if (!(await isMaintainer(checker, env.args.by))) {
      console.error(
        `[deny] @${env.args.by} does not have write/maintain/admin on ${env.owner}/${env.repo}`,
      );
      process.exit(5);
    }
  }

  const meta = await linear.getIssueMeta(ticketId);
  const result = await applyOverride({
    request: { reason: env.args.reason },
    context: {
      pr: {
        owner: env.owner,
        repo: env.repo,
        number: env.number,
        headSha,
        htmlUrl,
      },
      commenter: env.args.by,
      ticketId,
      ticketUuid: meta.id,
      ticketTeamId: meta.teamId,
    },
    clients: {
      permissions: makePermissionChecker(octokit, env.owner, env.repo),
      check: makeCheckPublisher(octokit),
      linear: makeLinearOverrideWriter(linear),
      pr: makePrReplyWriter(octokit),
    },
  });

  for (const step of result.steps) {
    if (step.status === "ok") console.error(`[ok] ${step.step}`);
    else console.error(`[error] ${step.step}: ${step.message}`);
  }
  const anyError = result.steps.some((s) => s.status === "error");
  process.exit(anyError ? 1 : 0);
}

// ─── Real-world dependency wiring ─────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(4);
  }
  return v;
}

/**
 * Where the repo under review is checked out (OGE-1555).
 *
 * NOT `process.cwd()`. The Action runs the CLI with `working-directory` set to
 * the *reviewer's* own checkout (`github.action_path/../../..`), while the repo
 * being reviewed sits at `GITHUB_WORKSPACE`. Using cwd would point the read
 * tools at agent-reviewer's source and produce confidently wrong verdicts
 * about a completely different codebase.
 *
 * Returns null when there is no usable checkout, in which case the reviewer
 * runs with an empty registry exactly as before.
 */
function resolveRepoRoot(): string | null {
  const candidate = process.env.REVIEWER_REPO_ROOT ?? process.env.GITHUB_WORKSPACE;
  if (!candidate) return null;
  try {
    return statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Octokit-backed CI log reader (OGE-1557).
 *
 * Read-only against the Actions API. Deliberately NOT a `run_tests` tool: the
 * suite already ran in a job that holds no reviewer secrets, so reading its
 * output gets the same evidence without handing PR-authored code this
 * process's Anthropic key, Linear token, and GitHub App private key.
 */
function makeCiLogClient(octokit: Octokit): CiLogClient {
  return {
    async listWorkflowRuns({ owner, repo, headSha }) {
      const resp = await octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        head_sha: headSha,
      });
      return resp.data.workflow_runs.map((r) => ({ id: r.id, name: r.name ?? "workflow" }));
    },
    async listJobs({ owner, repo, runId }) {
      const resp = await octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      return resp.data.jobs.map((j) => ({ id: j.id, name: j.name, conclusion: j.conclusion }));
    },
    async downloadJobLog({ owner, repo, jobId }) {
      const resp = await octokit.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      });
      return typeof resp.data === "string" ? resp.data : String(resp.data ?? "");
    },
  };
}

function buildToolRegistry(
  octokit: Octokit,
  pr: { owner: string; repo: string; headSha: string },
): ToolRegistry {
  // HTTP fetch needs no checkout — it is allowlist-scoped and always safe to
  // offer (OGE-1556).
  const tools = [...makeHttpTools()];

  tools.push(...makeCiLogTools(makeCiLogClient(octokit), pr));

  const root = resolveRepoRoot();
  if (root) {
    tools.push(...makeRepoTools(root));
    console.error(`[tools] repo read access rooted at ${root}`);
  } else {
    console.error("[tools] no repo checkout found — running without repo read access");
  }

  if (tools.length === 0) return EMPTY_REGISTRY;
  console.error(`[tools] registry: ${tools.map((t) => t.definition.name).join(", ")}`);
  return makeRegistry(tools);
}

/**
 * Reads repo files at a ref through the GitHub contents API (OGE-1585).
 *
 * Bound to one repo at construction so a caller cannot accidentally point it
 * at the head fork — the whole security property of per-repo config is that
 * it comes from the upstream default branch.
 */
function makeRefFileReader(
  octokit: Octokit,
  repo: { owner: string; repo: string },
): RefFileReader {
  return {
    async readAtRef(path, ref) {
      try {
        const resp = await octokit.repos.getContent({ ...repo, path, ref });
        const data = resp.data as { content?: string; encoding?: string; type?: string };
        if (data.type !== "file" || typeof data.content !== "string") return null;
        return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString(
          "utf8",
        );
      } catch {
        // 404 is the common case (repo has no config) and is not an error.
        return null;
      }
    },
  };
}

/**
 * Octokit-backed inline comment client (OGE-1586).
 *
 * Exposes only comment create/update/delete/list. It has no `createReview` and
 * no approve path — the reviewer physically cannot submit a formal GitHub
 * review, matching claude-code-action's own security boundary.
 */
function makeInlineCommentClient(octokit: Octokit): InlineCommentClient {
  return {
    async listReviewComments({ owner, repo, pullNumber }) {
      const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return comments.map((c) => ({ id: c.id, body: c.body ?? "" }));
    },
    async createReviewComment({ owner, repo, pullNumber, commitId, path, line, startLine, body }) {
      const resp = await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        path,
        line,
        // Multi-line anchor for a committable suggestion (OGE-1596).
        ...(startLine !== undefined ? { start_line: startLine } : {}),
        body,
      });
      return { id: resp.data.id };
    },
    async updateReviewComment({ owner, repo, commentId, body }) {
      await octokit.pulls.updateReviewComment({ owner, repo, comment_id: commentId, body });
    },
    async deleteReviewComment({ owner, repo, commentId }) {
      await octokit.pulls.deleteReviewComment({ owner, repo, comment_id: commentId });
    },
  };
}

function makeGithubReader(octokit: Octokit): GithubReader {
  return {
    async getPr({ owner, repo, number }) {
      const resp = await octokit.pulls.get({ owner, repo, pull_number: number });
      const pr = resp.data;
      return {
        owner,
        repo,
        number,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "unknown",
        createdAt: pr.created_at,
        // Where per-repo config is read from (OGE-1585). `base.repo` is the
        // upstream repo even on a fork PR, which is the point: a fork must not
        // be able to supply the config that gates its own merge.
        defaultBranch: pr.base.repo.default_branch,
      };
    },
    async getDiff({ owner, repo, number }) {
      const resp = await octokit.pulls.get({
        owner,
        repo,
        pull_number: number,
        mediaType: { format: "diff" },
      });
      return resp.data as unknown as string;
    },
    async getCiSummary({ owner, repo, ref }) {
      return fetchCiSummary(octokit, { owner, repo, ref });
    },
    async getChangedPaths({ owner, repo, base, head }) {
      // Outcome telemetry only (OGE-1592) — a failure here must cost telemetry,
      // never the review, so it returns empty rather than throwing.
      try {
        const resp = await octokit.repos.compareCommits({ owner, repo, base, head });
        return (resp.data.files ?? []).map((f) => f.filename);
      } catch {
        return [];
      }
    },
    async getIssueComment({ owner, repo, commentId }) {
      try {
        const resp = await octokit.issues.getComment({
          owner,
          repo,
          comment_id: commentId,
        });
        const c = resp.data;
        return {
          url: c.html_url,
          author: c.user?.login ?? "unknown",
          createdAt: c.created_at,
          body: c.body ?? "",
        };
      } catch {
        return null;
      }
    },
    async getReviewComment({ owner, repo, commentId }) {
      try {
        const resp = await octokit.pulls.getReviewComment({
          owner,
          repo,
          comment_id: commentId,
        });
        const c = resp.data;
        return {
          url: c.html_url,
          author: c.user?.login ?? "unknown",
          createdAt: c.created_at,
          body: c.body ?? "",
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Output cap. Raised from 4096 with the tool loop (OGE-1552): tool results
 * enter the context and the model now narrates its investigation, so the old
 * ceiling truncated verdicts mid-JSON on anything but a short checklist.
 */
const MAX_OUTPUT_TOKENS = 8192;

function makeAnthropicModel(
  anthropic: Anthropic,
  registry: ToolRegistry = EMPTY_REGISTRY,
): VerdictModel {
  return {
    async produce({ systemPrompt, userPrompt, research }) {
      // Two kinds of tool, deliberately assembled in one array:
      //   - client-side tools from the registry, which WE execute in the loop
      //   - Anthropic's server-side web_search, which runs on their side and
      //     needs no loop iteration at all (OGE-1566)
      const clientTools = toolDefinitions(registry) ?? [];
      const serverTools: Anthropic.Messages.ToolUnion[] = research.enabled
        ? [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: research.maxUses,
              allowed_domains: [...research.allowedDomains],
            },
          ]
        : [];
      const tools = [...clientTools, ...serverTools] as Anthropic.Messages.ToolUnion[];

      const turn: TurnFn = async (messages) => {
        const completion = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          system: systemPrompt,
          messages: messages as Anthropic.MessageParam[],
          // Omit the key entirely when there is nothing to offer. An empty
          // array still advertises a tool-using posture to the model.
          ...(tools.length > 0 ? { tools } : {}),
        });
        return { content: completion.content, stopReason: completion.stop_reason };
      };

      const loop = await runToolLoop({ turn, registry, userPrompt });

      if (loop.degraded) {
        console.error(`[review] tool loop degraded: ${loop.degraded}`);
      }

      return {
        text: extractText(loop.content),
        trace: extractResearchTrace(loop.content),
        transcript: loop.transcript,
        ...(loop.degraded ? { degraded: loop.degraded } : {}),
      };
    },
  };
}

/**
 * The cheap second-pass model that challenges punts (OGE-1587).
 *
 * Deliberately a different, smaller model than the reviewer: per-task routing
 * is Anthropic's own norm (claude-code-action runs a Haiku classify gate over
 * inline comments before posting), and the adjudicator's job is one narrow
 * binary question over evidence that has already been gathered — not a second
 * full review.
 *
 * No tools, low max_tokens: it must not be able to go investigating on its own
 * and reach a conclusion the main pass never had evidence for.
 */
function makeAdjudicatorModel(anthropic: Anthropic): AdjudicatorModel {
  return {
    async adjudicate({ systemPrompt, userPrompt }) {
      const completion = await anthropic.messages.create({
        model: process.env.REVIEWER_ADJUDICATION_MODEL ?? "claude-haiku-4-5",
        max_tokens: 512,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      return completion.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    },
  };
}

function makeTriageModel(anthropic: Anthropic): TriageModel {
  return {
    async triage({ prompt }) {
      const completion = await anthropic.messages.create({
        model: process.env.REVIEWER_TRIAGE_MODEL ?? "claude-haiku-4-5",
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });
      return completion.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    },
  };
}

function makePermissionChecker(
  octokit: Octokit,
  owner: string,
  repo: string,
): PermissionChecker {
  return {
    async getCollaboratorPermission(username) {
      try {
        const resp = await octokit.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username,
        });
        return resp.data.permission;
      } catch {
        return "none";
      }
    },
  };
}

function makeCheckPublisher(octokit: Octokit): CheckPublisher {
  return {
    async publish(args) {
      await octokit.checks.create({
        owner: args.owner,
        repo: args.repo,
        head_sha: args.headSha,
        name: args.name,
        status: "completed",
        conclusion: args.conclusion,
        output: { title: args.title, summary: args.summary },
      });
    },
  };
}

function makeLinearOverrideWriter(linear: LinearGraphqlClient): LinearOverrideWriter {
  return {
    createComment: linear.createComment.bind(linear),
    upsertLabelOnIssue: linear.upsertLabelOnIssue.bind(linear),
  };
}

function makePrReplyWriter(octokit: Octokit): PrReplyWriter {
  return {
    async reply(args) {
      await octokit.issues.createComment({
        owner: args.owner,
        repo: args.repo,
        issue_number: args.issueNumber,
        body: args.body,
      });
    },
  };
}

// keep CHECK_NAME importable from cli.ts re-export site if anyone needs it
void CHECK_NAME;
void parseOverrideComment;

void main();
