#!/usr/bin/env tsx
/**
 * Roll the OgenticAI Reviewer out to a list of target repos.
 *
 * Behaviour
 * ---------
 * For each `--repo OWNER/NAME`:
 *   1. Read both workflow templates from `templates/workflows/`.
 *   2. Compute what would change on the target — this is `planRollout` pure
 *      logic, tested in isolation.
 *   3. If anything would change, create or update a stable rollout branch
 *      `ogenticai-reviewer/install-v1` with the desired files, and open
 *      (or update) a PR titled
 *      `chore: install OgenticAI Reviewer (UAT-checklist gate)`.
 *   4. If nothing would change, print `[ok] already installed`.
 *
 * The script NEVER pushes directly to the default branch. The maintainer
 * reviews + merges the PR. Multi-repo rollout is a per-repo PR each.
 *
 * Idempotent: running twice is safe. Per-repo failures don't abort the
 * others.
 *
 * Usage
 * -----
 *   GITHUB_TOKEN=ghp_xxx tsx scripts/rollout-reviewer.ts \
 *     --repo OgenticAI/ogentic-shield \
 *     --repo OgenticAI/agent-dealsizer \
 *     --repo OgenticAI/agentcovenant \
 *     --repo OgenticAI/agent-knowledge \
 *     [--dry-run] \
 *     [--app-install-url https://github.com/apps/ogenticai-reviewer/installations/new]
 *
 * The token must have `repo` scope (the script creates branches + PRs).
 * Use the OgenticAI Reviewer App's installation token in CI for proper
 * attribution; a maintainer's PAT works for one-off rollouts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Octokit } from "@octokit/rest";

import {
  planRollout,
  rolloutPrBody,
  ROLLOUT_BRANCH,
  ROLLOUT_PR_TITLE,
  type RolloutFile,
} from "../src/rollout/plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface Args {
  repos: string[];
  dryRun: boolean;
  appInstallUrl: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const repos: string[] = [];
  let dryRun = false;
  let appInstallUrl = "https://github.com/apps/ogenticai-reviewer/installations/new";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--repo":
        repos.push(req(args, ++i, "--repo"));
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--app-install-url":
        appInstallUrl = req(args, ++i, "--app-install-url");
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        process.exit(2);
    }
  }
  if (repos.length === 0) {
    console.error("At least one --repo OWNER/NAME is required");
    process.exit(2);
  }
  return { repos, dryRun, appInstallUrl };
}

function req(args: string[], i: number, flag: string): string {
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
    console.error("GITHUB_TOKEN env var required");
    process.exit(4);
  }
  const octokit = new Octokit({ auth: token });

  const desired = readDesiredFiles();

  let anyError = false;
  for (const slug of args.repos) {
    const [owner, repo] = slug.split("/");
    if (!owner || !repo) {
      console.error(`[skip] Bad --repo format: ${slug} (expected OWNER/NAME)`);
      anyError = true;
      continue;
    }
    try {
      await rolloutOne(octokit, { owner, repo, desired, ...args });
    } catch (err) {
      anyError = true;
      console.error(
        `[error] ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (anyError) process.exit(1);
}

function readDesiredFiles(): RolloutFile[] {
  return [
    {
      path: ".github/workflows/ogenticai-reviewer.yml",
      content: readFileSync(
        join(REPO_ROOT, "templates/workflows/ogenticai-reviewer.yml"),
        "utf8",
      ),
    },
    {
      path: ".github/workflows/uat-override.yml",
      content: readFileSync(
        join(REPO_ROOT, "templates/workflows/uat-override.yml"),
        "utf8",
      ),
    },
  ];
}

async function rolloutOne(
  octokit: Octokit,
  args: { owner: string; repo: string; desired: RolloutFile[]; dryRun: boolean; appInstallUrl: string },
): Promise<void> {
  const slug = `${args.owner}/${args.repo}`;

  // 1) Resolve default branch + read current contents.
  const repoData = (await octokit.repos.get({ owner: args.owner, repo: args.repo })).data;
  const baseBranch = repoData.default_branch;

  const currentContents: Record<string, string | null> = {};
  for (const file of args.desired) {
    currentContents[file.path] = await readFileFromBranch(octokit, {
      owner: args.owner,
      repo: args.repo,
      branch: baseBranch,
      path: file.path,
    });
  }

  const plan = planRollout({ desired: args.desired, currentContents });
  if (!plan.changed) {
    console.error(`[ok] ${slug}: already installed (${plan.alreadyInstalled.length} file(s))`);
    return;
  }

  console.error(
    `[plan] ${slug}: ${plan.files.length} file(s) to write, ${plan.alreadyInstalled.length} already in place`,
  );
  if (args.dryRun) {
    console.error(`[dry-run] ${slug}: skipping branch + PR`);
    return;
  }

  // 2) Ensure rollout branch exists, pointing at base.
  const baseSha = (
    await octokit.git.getRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${baseBranch}`,
    })
  ).data.object.sha;
  await ensureBranch(octokit, {
    owner: args.owner,
    repo: args.repo,
    branch: ROLLOUT_BRANCH,
    fromSha: baseSha,
  });

  // 3) Write each file via the contents API. Octokit handles SHA fetch +
  //    PUT. If the file already exists on the rollout branch with the same
  //    content, the API returns 422 and we fall through.
  for (const file of plan.files) {
    await upsertFileOnBranch(octokit, {
      owner: args.owner,
      repo: args.repo,
      branch: ROLLOUT_BRANCH,
      path: file.path,
      content: file.content,
      message: `chore: install ${file.path} (OGE-341)`,
    });
  }

  // 4) Open or update the PR.
  await ensurePr(octokit, {
    owner: args.owner,
    repo: args.repo,
    head: ROLLOUT_BRANCH,
    base: baseBranch,
    title: ROLLOUT_PR_TITLE,
    body: rolloutPrBody({ repoSlug: slug, appInstallUrl: args.appInstallUrl }),
  });

  console.error(`[done] ${slug}: rollout PR open or updated on branch ${ROLLOUT_BRANCH}`);
}

async function readFileFromBranch(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string; path: string },
): Promise<string | null> {
  try {
    const resp = await octokit.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: args.path,
      ref: args.branch,
    });
    if (Array.isArray(resp.data)) return null;
    if (resp.data.type !== "file") return null;
    if (!("content" in resp.data) || !resp.data.content) return null;
    return Buffer.from(resp.data.content, "base64").toString("utf8");
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "status" in err) {
      if ((err as { status: number }).status === 404) return null;
    }
    throw err;
  }
}

async function ensureBranch(
  octokit: Octokit,
  args: { owner: string; repo: string; branch: string; fromSha: string },
): Promise<void> {
  try {
    await octokit.git.getRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${args.branch}`,
    });
    return; // exists already
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      (err as { status: number }).status === 404
    ) {
      await octokit.git.createRef({
        owner: args.owner,
        repo: args.repo,
        ref: `refs/heads/${args.branch}`,
        sha: args.fromSha,
      });
      return;
    }
    throw err;
  }
}

async function upsertFileOnBranch(
  octokit: Octokit,
  args: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
    message: string;
  },
): Promise<void> {
  // Look up existing SHA on this branch (if any) so we can overwrite.
  let sha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: args.path,
      ref: args.branch,
    });
    if (!Array.isArray(existing.data) && existing.data.type === "file") {
      sha = existing.data.sha;
    }
  } catch (err: unknown) {
    if (
      !(typeof err === "object" &&
        err !== null &&
        "status" in err &&
        (err as { status: number }).status === 404)
    ) {
      throw err;
    }
  }
  await octokit.repos.createOrUpdateFileContents({
    owner: args.owner,
    repo: args.repo,
    branch: args.branch,
    path: args.path,
    message: args.message,
    content: Buffer.from(args.content, "utf8").toString("base64"),
    sha,
  });
}

async function ensurePr(
  octokit: Octokit,
  args: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  },
): Promise<void> {
  const existing = await octokit.pulls.list({
    owner: args.owner,
    repo: args.repo,
    head: `${args.owner}:${args.head}`,
    base: args.base,
    state: "open",
  });
  if (existing.data.length > 0) {
    const pr = existing.data[0]!;
    if (pr.title !== args.title || pr.body !== args.body) {
      await octokit.pulls.update({
        owner: args.owner,
        repo: args.repo,
        pull_number: pr.number,
        title: args.title,
        body: args.body,
      });
    }
    return;
  }
  await octokit.pulls.create({
    owner: args.owner,
    repo: args.repo,
    head: args.head,
    base: args.base,
    title: args.title,
    body: args.body,
    draft: false,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
