/**
 * Read test / lint / benchmark output from CI logs (OGE-1557).
 *
 * 11 mentions — the third-largest tool-fixable category. UAT items constantly
 * assert what the test suite already proved, in a job that already ran:
 *
 *   OGE-313: "Items 1, 2, 3, 9, and 10 are UNVERIFIABLE because they require
 *             execution output (test runs, linter output, benchmark results)."
 *   OGE-582: "Item 13 (test count and pass status) … requires running pytest."
 *
 * OGE-1554 put CI *status* in the prompt, which settles "the suite passes".
 * It cannot settle "225 tests pass" or "the benchmark is under 200ms" — those
 * need the actual output. This reads it.
 *
 * ── Why this reads logs instead of running tests ────────────────────────────
 *
 * The obvious implementation is a `run_tests` tool. It would be a serious
 * vulnerability. This process holds ANTHROPIC_API_KEY, LINEAR_API_TOKEN, and a
 * GitHub App private key; executing a fork's test suite here hands arbitrary
 * PR-authored code those credentials. A malicious `conftest.py` exfiltrates
 * everything on the first run, and the PR looks entirely ordinary.
 *
 * The tests already ran — in a CI job that does *not* hold reviewer secrets.
 * Reading that job's output gets the same evidence with none of the exposure.
 * That asymmetry is the whole design, and it is why this tool is read-only
 * against the Actions API rather than a shell.
 *
 * If real execution is ever needed, it belongs in a separate, secretless,
 * network-restricted job — never in this process.
 */

import type { ReviewTool, ToolResult } from "./registry.js";

/**
 * Logs are long and the tail is where results live — a pytest summary line, a
 * failing assertion, a benchmark table. Reading from the end keeps the useful
 * part and drops the setup noise.
 */
export const CI_LOG_TAIL_CHARS = 12 * 1024;

/** Minimal Octokit surface this tool needs. Keeps tests free of the real SDK. */
export interface CiLogClient {
  listWorkflowRuns(args: {
    owner: string;
    repo: string;
    headSha: string;
  }): Promise<Array<{ id: number; name: string }>>;
  listJobs(args: {
    owner: string;
    repo: string;
    runId: number;
  }): Promise<Array<{ id: number; name: string; conclusion: string | null }>>;
  downloadJobLog(args: { owner: string; repo: string; jobId: number }): Promise<string>;
}

export interface CiLogContext {
  owner: string;
  repo: string;
  headSha: string;
}

export function makeCiLogTools(client: CiLogClient, ctx: CiLogContext): ReviewTool[] {
  return [listCiJobsTool(client, ctx), readCiLogTool(client, ctx)];
}

function listCiJobsTool(client: CiLogClient, ctx: CiLogContext): ReviewTool {
  return {
    definition: {
      name: "list_ci_jobs",
      description:
        "List the CI jobs that ran for this PR's head commit, with their conclusions. Call this " +
        "first to find the job whose output you need, then use read_ci_log.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute(): Promise<ToolResult> {
      try {
        const runs = await client.listWorkflowRuns(ctx);
        if (runs.length === 0) return { content: "No workflow runs for this commit." };

        const lines: string[] = [];
        for (const run of runs) {
          const jobs = await client.listJobs({ owner: ctx.owner, repo: ctx.repo, runId: run.id });
          for (const job of jobs) {
            lines.push(`${job.id}\t${run.name} / ${job.name} — ${job.conclusion ?? "running"}`);
          }
        }
        return {
          content: lines.length > 0 ? lines.join("\n") : "No jobs found for this commit.",
        };
      } catch (e) {
        return {
          content: `Could not list CI jobs: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  };
}

function readCiLogTool(client: CiLogClient, ctx: CiLogContext): ReviewTool {
  return {
    definition: {
      name: "read_ci_log",
      description:
        "Read the output of a CI job that ran for this commit, by job id from list_ci_jobs. " +
        "Returns the tail of the log, where test summaries, failures, and benchmark results " +
        "live. Use this to settle items naming a test count, a specific test, or a measured " +
        "number — a green check alone does not.",
      input_schema: {
        type: "object",
        properties: {
          job_id: { type: "integer", description: "Job id from list_ci_jobs" },
        },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolResult> {
      const jobId =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).job_id
          : undefined;
      if (typeof jobId !== "number" || !Number.isFinite(jobId)) {
        return {
          content: "read_ci_log requires a numeric `job_id` — call list_ci_jobs first.",
          isError: true,
        };
      }

      try {
        const log = await client.downloadJobLog({
          owner: ctx.owner,
          repo: ctx.repo,
          jobId,
        });
        if (log.length === 0) return { content: `Job ${jobId} produced no log output.` };

        if (log.length <= CI_LOG_TAIL_CHARS) return { content: log };
        return {
          content:
            `… [head of log omitted; showing last ${CI_LOG_TAIL_CHARS} chars]\n` +
            log.slice(-CI_LOG_TAIL_CHARS),
        };
      } catch (e) {
        return {
          content: `Could not read job ${jobId}: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    },
  };
}
