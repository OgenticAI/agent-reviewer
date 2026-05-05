#!/usr/bin/env node
/**
 * Local CLI runner for the OgenticAI Reviewer.
 *
 * This is the entry point used by:
 *   - The Claude Code plugin's `/review-pr <github-url>` slash command.
 *   - Developers iterating on prompts locally without a CI round-trip.
 *
 * The GitHub Action does NOT use this — it uses `claude-code-action` directly
 * with the system prompt + MCPs. Keeping the two paths separate means CI's
 * trust boundary is GitHub Actions secrets, while the CLI's trust boundary is
 * the developer's `.env`.
 *
 * Usage:
 *   tsx src/cli.ts review-pr https://github.com/OgenticAI/ogentic-shield/pull/1
 *   tsx src/cli.ts review-pr https://github.com/OgenticAI/ogentic-shield/pull/1 --post   # actually upsert the comment
 *   tsx src/cli.ts review-pr https://github.com/OgenticAI/ogentic-shield/pull/1 --dry    # default: print only
 */

import { writeFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import Anthropic from "@anthropic-ai/sdk";

import { parseUatChecklist } from "./parser/uat.js";
import { resolveTickets } from "./linear/resolve.js";
import { ReviewVerdict } from "./schema/verdict.js";
import { renderStickyComment } from "./render/comment.js";
import { upsertStickyComment } from "./github/sticky.js";
import { buildReviewPrompt, SYSTEM_PROMPT } from "./prompt/review.js";
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
  if (command !== "review-pr" || !prUrl) {
    printUsageAndExit();
  }
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
      "Required env vars (loaded from .env or the shell):",
      "  ANTHROPIC_API_KEY     Claude API key",
      "  GITHUB_TOKEN          GitHub token with repo + read:org",
      "  LINEAR_API_TOKEN      Linear personal API key (only when the Linear MCP is unavailable)",
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

  const octokit = new Octokit({ auth: githubToken });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // 1) Pull PR + diff
  const prResp = await octokit.pulls.get({ owner, repo, pull_number: number });
  const pr = prResp.data;
  const diffResp = await octokit.pulls.get({
    owner,
    repo,
    pull_number: number,
    mediaType: { format: "diff" },
  });
  const diff = diffResp.data as unknown as string;

  // 2) Resolve Linear tickets and parse the UAT checklist
  const tickets = resolveTickets({
    headRef: pr.head.ref,
    body: pr.body ?? "",
    title: pr.title,
  });
  const checklist = parseUatChecklist(pr.body ?? "");

  if (tickets.ticketIds.length === 0) {
    console.error(
      "No Linear ticket id found in branch / PR body / title. " +
        "Either the convention isn't followed or this PR isn't reviewable.",
    );
    process.exit(3);
  }
  const primaryTicketId = tickets.ticketIds[0]!;

  // 3) For the local CLI, fetch the Linear ticket via the personal API token.
  //    The GitHub Action path uses the Linear MCP server instead.
  const ticket = await fetchLinearTicketLite(primaryTicketId);

  // 4) Build the prompt and call Claude. The Action does this through
  //    claude-code-action; here we go straight to the SDK.
  const userPrompt = buildReviewPrompt({
    pr: {
      owner,
      repo,
      number,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      createdAt: pr.created_at,
    },
    ticket,
    checklist,
    diff,
  });

  const completion = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = completion.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

  // 5) Parse + validate the verdict JSON
  const verdict = parseVerdict(text, {
    ticketId: primaryTicketId,
    prRef: `${owner}/${repo}#${number}`,
    headSha: pr.head.sha,
  });

  // 6) Render the sticky comment
  const body = renderStickyComment(verdict);
  console.log(body);

  if (args.outputJson) {
    writeFileSync(args.outputJson, JSON.stringify(verdict, null, 2), "utf8");
  }

  // 7) Upsert if --post
  if (args.post) {
    const result = await upsertStickyComment({
      octokit,
      owner,
      repo,
      issueNumber: number,
      body,
    });
    console.error(`[${result.action}] ${result.url}`);
  } else {
    console.error(
      "(dry run — pass --post to upsert the comment on the PR; this is the default for safety.)",
    );
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function parseVerdict(
  modelOutput: string,
  injected: { ticketId: string; prRef: string; headSha: string },
): ReviewVerdict {
  // Sometimes models still wrap JSON in fences despite instructions —
  // strip them defensively.
  const stripped = modelOutput
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```$/, "")
    .trim();
  const parsed = JSON.parse(stripped);

  // Inject fields the model can't know reliably (we don't trust it to echo
  // the SHA correctly, and the schemaVersion / reviewerVersion / generatedAt
  // are agent metadata).
  const candidate = {
    schemaVersion: 1,
    reviewerVersion: REVIEWER_VERSION,
    ticketId: injected.ticketId,
    prRef: injected.prRef,
    headSha: injected.headSha,
    generatedAt: new Date().toISOString(),
    ...parsed,
    schemaVersion_: undefined, // ensure injected wins over any model echo
  };
  return ReviewVerdict.parse(candidate);
}

/**
 * Minimal Linear GraphQL client — only what we need to build a
 * `LinearTicketContext`. The Action uses the Linear MCP for this; the CLI
 * path uses a personal API token directly to keep local iteration friction
 * low.
 */
async function fetchLinearTicketLite(identifier: string): Promise<{
  identifier: string;
  id: string;
  title: string;
  description: string;
  status: string;
  url: string;
}> {
  const token = requireEnv("LINEAR_API_TOKEN");
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
    errors?: unknown;
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
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
