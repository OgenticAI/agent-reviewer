/**
 * Findings ingestion (OGE-1588) — the CI-enumeration wiring.
 *
 * Covers the graceful no-op when a repo's CI produces nothing recognized, and
 * the fail-safe posture: any download/enumeration error costs the facts, never
 * the review.
 */

import { describe, expect, it } from "vitest";

import { ingestFindings } from "../../src/engine/findings/ingest.js";
import type { CiLogClient } from "../../src/engine/tools/ci-logs.js";

const CTX = { owner: "OgenticAI", repo: "agent-reviewer", headSha: "sha" };

function client(over: Partial<CiLogClient> = {}): CiLogClient {
  return {
    async listWorkflowRuns() {
      return [{ id: 1, name: "CI" }];
    },
    async listJobs() {
      return [
        { id: 10, name: "lint", conclusion: "failure" },
        { id: 11, name: "deploy", conclusion: "success" }, // not an analyzer hint
      ];
    },
    async downloadJobLog() {
      return JSON.stringify([
        { filePath: "/w/r/r/src/a.ts", messages: [{ ruleId: "x", severity: 2, message: "m", line: 1 }] },
      ]);
    },
    ...over,
  };
}

describe("ingestFindings", () => {
  it("parses analyzer-hinted jobs and skips the rest", async () => {
    const jobs = await ingestFindings(client(), CTX);
    // Only 'lint' matched the analyzer hint; 'deploy' was skipped.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job).toBe("lint");
    expect(jobs[0]!.findings).toHaveLength(1);
  });

  it("no-ops when the job output matches no adapter", async () => {
    const jobs = await ingestFindings(
      client({ async downloadJobLog() { return "plain build log, nothing structured"; } }),
      CTX,
    );
    // Unrecognized output is omitted, never recorded as a false all-clear.
    expect(jobs).toEqual([]);
  });

  it("records a clean analyzer run as a parsed job with no findings", async () => {
    const jobs = await ingestFindings(
      client({ async downloadJobLog() { return "src/a.ts(1,1): error TS0: x"; },
               async listJobs() { return [{ id: 1, name: "typecheck", conclusion: "success" }]; } }),
      CTX,
    );
    expect(jobs[0]!.parsed).toBe(true);
  });

  it("degrades to empty when enumeration throws — never takes down the review", async () => {
    const jobs = await ingestFindings(
      client({ async listWorkflowRuns() { throw new Error("403"); } }),
      CTX,
    );
    expect(jobs).toEqual([]);
  });

  it("skips a single job whose log download fails, keeping the others", async () => {
    let n = 0;
    const jobs = await ingestFindings(
      client({
        async listJobs() {
          return [
            { id: 1, name: "lint", conclusion: "failure" },
            { id: 2, name: "test", conclusion: "failure" },
          ];
        },
        async downloadJobLog() {
          n += 1;
          if (n === 1) throw new Error("artifact expired");
          return JSON.stringify([
            { filePath: "/w/r/r/src/b.ts", messages: [{ ruleId: "y", severity: 1, message: "m", line: 2 }] },
          ]);
        },
      }),
      CTX,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job).toBe("test");
  });
});
