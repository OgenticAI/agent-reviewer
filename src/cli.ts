#!/usr/bin/env node
/**
 * Local CLI runner for the OgenticAI Reviewer.
 *
 * Used by:
 *   - The Claude Code plugin's `/review-pr <github-url>` slash command.
 *   - The GitHub Action — same code path as local; the Action just calls
 *     the same CLI under a GitHub App token with --post and --output-json,
 *     then publishes the Check based on the JSON output. One LLM call per
 *     run, deterministic, easy to debug.
 *   - Devs iterating on prompts without a CI round-trip.
 *
 * Usage:
 *   tsx src/cli.ts review-pr <pr-url>                 # dry-run; prints the comment
 *   tsx src/cli.ts review-pr <pr-url> --post           # upsert the sticky comment
 *   tsx src/cli.ts review-pr <pr-url> --output-json verdict.json
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
import type { GithubReader, LinearClient, VerdictModel } from "./review.js";
import { upsertStickyComment } from "./github/sticky.js";
import { renderStickyComment } from "./render/comment.js";
import { overallStatus } from "./schema/verdict.js";
import { REVIEWER_VERSION } from "./version.js";

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

interface CliArgs {
  command: "review-pr";
  prUrl: string;
  post: boolean;
  outputJson: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = args[0];
  const prUrl = args[1];
  if (command !== "review-pr" || !prUrl) printUsageAndExit();
  const post = args.includes("--post");
  const outIdx = args.indexOf("--output-json");
  const outputJson = outIdx >= 0 ? args[outIdx + 1] : undefined;
  return { command: "review-pr", prUrl, post, outputJson };
}

function printUsageAndExit(): never {
  console.error(
    [
      "Usage: ogenticai-reviewer review-pr <pr-url> [--post] [--output-json PATH]",
      "",
      "  <pr-url>              e.g. https://github.com/OgenticAI/ogentic-shield/pull/1",
      "  --post                upsert the sticky comment on the PR (default: print only)",
      "  --output-json PATH    write the raw verdict JSON to PATH",
      "",
      "Required env vars:",
      "  ANTHROPIC_API_KEY     Claude API key",
      "  GITHUB_TOKEN          GitHub token (PAT locally, App token in CI)",
      "  LINEAR_API_TOKEN      Linear personal API key",
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

  try {
    const result = await runReview({
      pr: { owner, repo, number },
      github: makeGithubReader(octokit),
      linear: makeLinearClient(linearToken),
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
      const upsert = await upsertStickyComment({
        octokit,
        owner,
        repo,
        issueNumber: number,
        body: result.body,
      });
      console.error(`[${upsert.action}] ${upsert.url}`);
    } else {
      console.error("(dry run — pass --post to upsert)");
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

function makeLinearClient(token: string): LinearClient {
  return {
    async getIssue(identifier: string) {
      const query = `
        query($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            url
            state { name }
          }
        }
      `;
      const resp = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        body: JSON.stringify({ query, variables: { id: identifier } }),
      });
      if (!resp.ok) {
        throw new Error(`Linear API error: ${resp.status} ${await resp.text()}`);
      }
      const json = (await resp.json()) as {
        data?: {
          issue?: {
            id: string;
            identifier: string;
            title: string;
            description: string | null;
            url: string;
            state: { name: string };
          };
        };
      };
      if (!json.data?.issue) {
        throw new Error(`Linear ticket ${identifier} not found (or token lacks access)`);
      }
      const issue = json.data.issue;
      return {
        identifier: issue.identifier,
        id: issue.id,
        title: issue.title,
        description: issue.description ?? "",
        status: issue.state.name,
        url: issue.url,
      };
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

// Suppress unused-import lint for renderStickyComment — runReview already
// uses it internally. We re-export here for future tooling integration.
void renderStickyComment;

void main();
