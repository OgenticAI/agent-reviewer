#!/usr/bin/env tsx
/**
 * Install (or remove) the OgenticAI Reviewer required Check on one or more
 * repos' default-branch protection.
 *
 * Behaviour
 * ---------
 * MERGES with existing branch protection — never overwrites. Existing required
 * reviewers, code-owner rules, admin enforcement, and other required checks
 * pass through verbatim. Only the `OgenticAI Reviewer / UAT` context is
 * appended (or removed, with `--uninstall`). Idempotent: running with the
 * context already required prints `[ok]` and exits 0.
 *
 * Usage
 * -----
 *   GITHUB_TOKEN=ghp_xxx tsx scripts/install-branch-protection.ts \
 *     --repo OgenticAI/ogentic-shield \
 *     [--branch main]                 \
 *     [--check 'OgenticAI Reviewer / UAT'] \
 *     [--app-id 12345]                \
 *     [--strict true|false]           \
 *     [--dry-run]                     \
 *     [--uninstall]
 *
 * Multiple `--repo` flags are accepted; each repo is processed independently
 * (one failure doesn't abort the others).
 *
 * The token must have `admin:repo` scope (it's used by the
 * `repos.updateBranchProtection` endpoint). For one-off installs use a PAT;
 * for the rollout pipeline, use the OgenticAI Reviewer App's installation
 * token (an App with `Administration: Read & write` permission).
 */

import { Octokit } from "@octokit/rest";

import {
  mergeProtection,
  removeFromProtection,
  type BranchProtectionPut,
} from "../src/protection/merge.js";

interface Args {
  repos: string[];
  branch: string;
  check: string;
  appId: number | undefined;
  strict: boolean | undefined;
  dryRun: boolean;
  uninstall: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const repos: string[] = [];
  let branch = "main";
  let check = "OgenticAI Reviewer / UAT";
  let appId: number | undefined;
  let strict: boolean | undefined;
  let dryRun = false;
  let uninstall = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--repo":
        repos.push(requireValue(args, ++i, "--repo"));
        break;
      case "--branch":
        branch = requireValue(args, ++i, "--branch");
        break;
      case "--check":
        check = requireValue(args, ++i, "--check");
        break;
      case "--app-id":
        appId = Number(requireValue(args, ++i, "--app-id"));
        break;
      case "--strict":
        strict = requireValue(args, ++i, "--strict") === "true";
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--uninstall":
        uninstall = true;
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        process.exit(2);
    }
  }
  if (repos.length === 0) {
    console.error("At least one --repo OWNER/REPO is required");
    process.exit(2);
  }
  return { repos, branch, check, appId, strict, dryRun, uninstall };
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i];
  if (v === undefined) {
    console.error(`Missing value for ${flag}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN env var required (with admin:repo scope)");
    process.exit(2);
  }
  const octokit = new Octokit({ auth: token });

  let anyFailure = false;
  for (const repoSpec of args.repos) {
    const [owner, repo] = repoSpec.split("/");
    if (!owner || !repo) {
      console.error(`[skip] Bad --repo format: ${repoSpec} (expected OWNER/REPO)`);
      anyFailure = true;
      continue;
    }
    try {
      await processRepo(octokit, { owner, repo, ...args });
    } catch (err) {
      anyFailure = true;
      console.error(
        `[error] ${repoSpec}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (anyFailure) process.exit(1);
}

async function processRepo(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string; check: string; appId?: number; strict?: boolean; dryRun: boolean; uninstall: boolean },
): Promise<void> {
  const tag = `${args.owner}/${args.repo}@${args.branch}`;

  const existing = await readExistingProtection(octokit, args);
  const result = args.uninstall
    ? removeFromProtection({ existing, context: args.check })
    : mergeProtection({
        existing,
        context: args.check,
        appId: args.appId,
        strict: args.strict,
      });

  if (!result.changed) {
    console.error(`[ok] ${tag}: already in desired state${formatNotes(result.notes)}`);
    return;
  }

  console.error(`[plan] ${tag}:${formatNotes(result.notes)}`);

  if (args.dryRun) {
    console.error(`[dry-run] ${tag}: skipping PUT`);
    return;
  }

  await putProtection(octokit, args, result.next);
  console.error(`[done] ${tag}: branch protection updated`);
}

async function readExistingProtection(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string },
): Promise<BranchProtectionPut | null> {
  try {
    const resp = await octokit.repos.getBranchProtection({
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
    });
    return normalizeProtectionGet(resp.data);
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function putProtection(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string },
  next: BranchProtectionPut,
): Promise<void> {
  await octokit.repos.updateBranchProtection({
    owner: args.owner,
    repo: args.repo,
    branch: args.branch,
    required_status_checks: next.required_status_checks
      ? {
          strict: next.required_status_checks.strict,
          contexts: next.required_status_checks.contexts,
          checks: next.required_status_checks.checks?.map((c) => ({
            context: c.context,
            app_id: c.app_id ?? undefined,
          })),
        }
      : null,
    enforce_admins: next.enforce_admins,
    required_pull_request_reviews: next.required_pull_request_reviews as
      | Parameters<typeof octokit.repos.updateBranchProtection>[0]["required_pull_request_reviews"]
      | null,
    restrictions: next.restrictions as
      | Parameters<typeof octokit.repos.updateBranchProtection>[0]["restrictions"]
      | null,
    required_linear_history: next.required_linear_history,
    allow_force_pushes: next.allow_force_pushes,
    allow_deletions: next.allow_deletions,
    block_creations: next.block_creations,
    required_conversation_resolution: next.required_conversation_resolution,
    lock_branch: next.lock_branch,
    allow_fork_syncing: next.allow_fork_syncing,
  });
}

function normalizeProtectionGet(
  data: Awaited<ReturnType<Octokit["repos"]["getBranchProtection"]>>["data"],
): BranchProtectionPut {
  return {
    required_status_checks: data.required_status_checks
      ? {
          strict: data.required_status_checks.strict ?? false,
          contexts: data.required_status_checks.contexts ?? [],
          checks: (data.required_status_checks.checks ?? []).map((c) => ({
            context: c.context,
            app_id: c.app_id ?? null,
          })),
        }
      : null,
    enforce_admins: data.enforce_admins?.enabled ?? null,
    required_pull_request_reviews: data.required_pull_request_reviews ?? null,
    restrictions: data.restrictions ?? null,
    required_linear_history: data.required_linear_history?.enabled,
    allow_force_pushes: data.allow_force_pushes?.enabled ?? null,
    allow_deletions: data.allow_deletions?.enabled ?? null,
    block_creations: data.block_creations?.enabled,
    required_conversation_resolution: data.required_conversation_resolution?.enabled,
    lock_branch: data.lock_branch?.enabled,
    allow_fork_syncing: data.allow_fork_syncing?.enabled,
  };
}

function isNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    return (err as { status: number }).status === 404;
  }
  return false;
}

function formatNotes(notes: string[]): string {
  return notes.length === 0 ? "" : "\n" + notes.map((n) => `   · ${n}`).join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
