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

import { writeFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import Anthropic from "@anthropic-ai/sdk";

import { runReview, ReviewSkippedError } from "./review.js";
import type { GithubReader, VerdictModel } from "./review.js";
import { LinearGraphqlClient } from "./linear/client.js";
import { runWriteback } from "./linear/writeback.js";
import { upsertStickyComment } from "./github/sticky.js";
import { REVIEWER_VERSION } from "./version.js";
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

type Subcommand = "review-pr" | "override-pr";

interface ReviewArgs {
  command: "review-pr";
  prUrl: string;
  post: boolean;
  outputJson: string | undefined;
  linearWriteback: boolean;
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

type CliArgs = ReviewArgs | OverrideArgs;

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0] as Subcommand | undefined;
  if (command === "review-pr") return parseReviewArgs(args);
  if (command === "override-pr") return parseOverrideArgs(args);
  printUsageAndExit();
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
      "  ogenticai-reviewer review-pr   <pr-url> [--post] [--output-json PATH] [--no-linear-writeback]",
      "  ogenticai-reviewer override-pr <pr-url> --by <github-user> --reason \"<reason>\" [--skip-permission-check]",
      "",
      "Required env vars:",
      "  ANTHROPIC_API_KEY  (review-pr only)",
      "  GITHUB_TOKEN       always",
      "  LINEAR_API_TOKEN   always",
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
  return runOverrideCommand({ args, owner, repo, number });
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
    const result = await runReview({
      pr: { owner: env.owner, repo: env.repo, number: env.number },
      github: makeGithubReader(octokit),
      linear,
      model: makeAnthropicModel(anthropic),
    });

    process.stdout.write(result.body + "\n");
    console.error(
      `Overall: ${result.overall}  ·  ${result.verdict.items.length} item(s)  ·  ` +
        `reviewer=${REVIEWER_VERSION}`,
    );

    if (env.args.outputJson) {
      writeFileSync(env.args.outputJson, JSON.stringify(result.verdict, null, 2), "utf8");
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

function makeAnthropicModel(anthropic: Anthropic): VerdictModel {
  return {
    async produce({ systemPrompt, userPrompt }) {
      const completion = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
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

async function isCiGreen(
  octokit: Octokit,
  args: { owner: string; repo: string; ref: string },
): Promise<boolean> {
  try {
    const status = await octokit.repos.getCombinedStatusForRef(args);
    if (status.data.state !== "success") return false;
    const checks = await octokit.checks.listForRef(args);
    const conclusions = checks.data.check_runs.map((c) => c.conclusion);
    return conclusions.every(
      (c) => c === "success" || c === "neutral" || c === "skipped" || c === null,
    );
  } catch {
    return false;
  }
}

// keep CHECK_NAME importable from cli.ts re-export site if anyone needs it
void CHECK_NAME;
void parseOverrideComment;

void main();
