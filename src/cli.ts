#!/usr/bin/env node
/**
 * Local CLI runner for the OgenticAI Reviewer.
 *
 * Used by:
 *   - The Claude Code plugin's `/review-pr <github-url>` slash command.
 *   - The GitHub Action — same code path as local; the Action calls the
 *     CLI under a GitHub App token with --post and --output-json, then
 *     publishes the Check based on the JSON output.
 *   - Devs iterating on prompts without a CI round-trip.
 *
 * Usage:
 *   tsx src/cli.ts review-pr <pr-url>                         # dry-run; prints the comment
 *   tsx src/cli.ts review-pr <pr-url> --post                  # upsert PR comment + Linear writeback
 *   tsx src/cli.ts review-pr <pr-url> --output-json verdict.json
 *   tsx src/cli.ts review-pr <pr-url> --no-linear-writeback   # skip Linear side effects
 *
 * Exit codes:
 *   0  success
 *   2  bad CLI args
 *   3  review skipped (no ticket / no checklist) — emit neutral Check upstream
 *   4  required env var missing
 *   1  any other failure (parse error, network, etc.) — emit neutral Check upstream
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

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

interface CliArgs {
  command: "review-pr";
  prUrl: string;
  post: boolean;
  outputJson: string | undefined;
  linearWriteback: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0];
  const prUrl = args[1];
  if (command !== "review-pr" || !prUrl) printUsageAndExit();
  const post = args.includes("--post");
  const outIdx = args.indexOf("--output-json");
  const outputJson = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const linearWriteback = !args.includes("--no-linear-writeback");
  return { command: "review-pr", prUrl, post, outputJson, linearWriteback };
}

function printUsageAndExit(): never {
  console.error(
    [
      "Usage: ogenticai-reviewer review-pr <pr-url> [--post] [--output-json PATH] [--no-linear-writeback]",
      "",
      "  <pr-url>                  e.g. https://github.com/OgenticAI/ogentic-shield/pull/1",
      "  --post                    upsert sticky PR comment + run Linear writeback",
      "  --output-json PATH        write the raw verdict JSON to PATH",
      "  --no-linear-writeback     skip Linear comment / status / child-issue writes",
      "",
      "Required env vars:",
      "  ANTHROPIC_API_KEY         Claude API key",
      "  GITHUB_TOKEN              GitHub token (PAT locally, App token in CI)",
      "  LINEAR_API_TOKEN          Linear personal API key",
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

  const githubToken = requireEnv("GITHUB_TOKEN");
  const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
  const linearToken = requireEnv("LINEAR_API_TOKEN");

  const octokit = new Octokit({ auth: githubToken });
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const linear = new LinearGraphqlClient({ token: linearToken });

  try {
    const result = await runReview({
      pr: { owner, repo, number },
      github: makeGithubReader(octokit),
      linear,
      model: makeAnthropicModel(anthropic),
    });

    process.stdout.write(result.body + "\n");
    console.error(
      `Overall: ${result.overall}  ·  ${result.verdict.items.length} item(s)  ·  ` +
        `reviewer=${REVIEWER_VERSION}`,
    );

    if (args.outputJson) {
      writeFileSync(args.outputJson, JSON.stringify(result.verdict, null, 2), "utf8");
    }

    if (args.post) {
      // 1) Upsert the PR sticky comment via the GitHub App token.
      const upsert = await upsertStickyComment({
        octokit,
        owner,
        repo,
        issueNumber: number,
        body: result.body,
      });
      console.error(`[github:${upsert.action}] ${upsert.url}`);

      // 2) Run Linear writeback unless explicitly skipped.
      if (args.linearWriteback) {
        const meta = await linear.getIssueMeta(result.verdict.ticketId);
        const ciGreen = await isCiGreen(octokit, {
          owner,
          repo,
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
            url: `https://github.com/${owner}/${repo}/pull/${number}`,
            ref: `${owner}/${repo}#${number}`,
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(4);
  }
  return v;
}

// ─── Real-world dependency wiring ─────────────────────────────────────────────

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

/**
 * Best-effort: check whether the head commit's CI status is green.
 *
 * The "Ready to Merge" transition only fires when CI reports green for the
 * head SHA. We use the combined-status API which folds both the legacy
 * "status" API and modern Checks. If anything errors here we return false
 * (safe default — never auto-promote on uncertainty).
 */
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

void main();
