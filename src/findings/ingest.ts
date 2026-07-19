/**
 * Deterministic findings ingestion (OGE-1588).
 *
 * Reuses OGE-1557's job enumeration and log download, but where that path hands
 * the model a 12KB log tail to read inside the capped tool loop, this one parses
 * the structured output once, up front, and states the result as fact. Nothing
 * here executes anything — it downloads logs CI already wrote and runs them
 * through the format adapters (see the security note in `schema.ts`).
 */

import type { CiLogClient, CiLogContext } from "../tools/ci-logs.js";
import { parseAnyFindings, type Adapter } from "./adapters.js";
import type { JobFindings } from "./schema.js";

/** Only ingest jobs whose name hints at an analyzer/test, to bound downloads. */
const ANALYZER_JOB_HINT = /\b(lint|eslint|tsc|type|typecheck|test|vitest|jest|junit|check)\b/i;

/**
 * Enumerate CI jobs and parse any recognized analyzer/test output.
 *
 * Returns one `JobFindings` per job we could parse (including clean runs, which
 * are a positive fact — see `schema.ts`). Jobs whose logs match no adapter are
 * omitted entirely rather than recorded as `parsed: false`, so the prompt never
 * lists a job we learned nothing from. Every failure degrades to "no findings
 * from this job", never a thrown error — ingestion must not take down a review.
 */
export async function ingestFindings(
  client: CiLogClient,
  ctx: CiLogContext,
  adapters?: Adapter[],
): Promise<JobFindings[]> {
  let runs: Array<{ id: number; name: string }>;
  try {
    runs = await client.listWorkflowRuns(ctx);
  } catch {
    return [];
  }

  const out: JobFindings[] = [];
  for (const run of runs) {
    let jobs: Array<{ id: number; name: string; conclusion: string | null }>;
    try {
      jobs = await client.listJobs({ owner: ctx.owner, repo: ctx.repo, runId: run.id });
    } catch {
      continue;
    }
    for (const job of jobs) {
      if (!ANALYZER_JOB_HINT.test(job.name)) continue;
      let log: string;
      try {
        log = await client.downloadJobLog({ owner: ctx.owner, repo: ctx.repo, jobId: job.id });
      } catch {
        continue;
      }
      const findings = parseAnyFindings(log, adapters);
      if (findings === null) continue; // nothing we recognize — don't claim a fact
      out.push({ job: job.name, parsed: true, findings });
    }
  }
  return out;
}
