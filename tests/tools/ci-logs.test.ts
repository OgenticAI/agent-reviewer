/**
 * Reading CI logs (OGE-1557).
 *
 * The design constraint worth restating: this reads output from a job that
 * already ran in a context *without* reviewer secrets, rather than executing
 * PR-authored code in a process that holds an Anthropic key, a Linear token,
 * and a GitHub App private key. The last test in this file pins that — no tool
 * here may look like an execution primitive.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CI_LOG_TAIL_CHARS,
  makeCiLogTools,
  type CiLogClient,
} from "../../src/tools/ci-logs.js";
import type { ReviewTool } from "../../src/tools/registry.js";

const CTX = { owner: "OgenticAI", repo: "ogentic-shield", headSha: "f629911" };

function client(overrides: Partial<CiLogClient> = {}): CiLogClient {
  return {
    listWorkflowRuns: async () => [{ id: 1, name: "CI" }],
    listJobs: async () => [{ id: 10, name: "test", conclusion: "success" }],
    downloadJobLog: async () => "225 passed in 12.4s",
    ...overrides,
  };
}

function tools(c: CiLogClient): Record<string, ReviewTool> {
  return Object.fromEntries(makeCiLogTools(c, CTX).map((t) => [t.definition.name, t]));
}

describe("list_ci_jobs", () => {
  it("lists jobs with ids and conclusions", async () => {
    const r = await tools(client()).list_ci_jobs!.execute({});
    expect(r.content).toContain("10");
    expect(r.content).toContain("CI / test — success");
  });

  it("reports a still-running job as running, not as a conclusion", async () => {
    const r = await tools(
      client({ listJobs: async () => [{ id: 10, name: "test", conclusion: null }] }),
    ).list_ci_jobs!.execute({});
    expect(r.content).toContain("running");
  });

  it("says so plainly when the commit has no runs", async () => {
    const r = await tools(client({ listWorkflowRuns: async () => [] })).list_ci_jobs!.execute({});
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/No workflow runs/);
  });

  it("turns an API failure into an error result, not a throw", async () => {
    const r = await tools(
      client({
        listWorkflowRuns: async () => {
          throw new Error("rate limited");
        },
      }),
    ).list_ci_jobs!.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/rate limited/);
  });
});

describe("read_ci_log", () => {
  it("returns a short log whole", async () => {
    const r = await tools(client()).read_ci_log!.execute({ job_id: 10 });
    expect(r.content).toBe("225 passed in 12.4s");
  });

  it("returns the TAIL of a long log — that's where results live", async () => {
    const log = "setup noise\n".repeat(5000) + "SUMMARY: 225 passed";
    const r = await tools(client({ downloadJobLog: async () => log })).read_ci_log!.execute({
      job_id: 10,
    });
    expect(r.content).toContain("SUMMARY: 225 passed");
    expect(r.content).toMatch(/head of log omitted/);
    expect(r.content.length).toBeLessThan(CI_LOG_TAIL_CHARS + 200);
  });

  it("requires a numeric job_id and points at the right tool", async () => {
    const r = await tools(client()).read_ci_log!.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/call list_ci_jobs first/);
  });

  it("handles an empty log without pretending it succeeded", async () => {
    const r = await tools(client({ downloadJobLog: async () => "" })).read_ci_log!.execute({
      job_id: 10,
    });
    expect(r.content).toMatch(/no log output/);
  });

  it("turns a download failure into an error result", async () => {
    const r = await tools(
      client({
        downloadJobLog: async () => {
          throw new Error("404 not found");
        },
      }),
    ).read_ci_log!.execute({ job_id: 99 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Could not read job 99/);
  });

  it("passes the PR's own owner/repo/sha, not model-supplied ones", async () => {
    // The model picks a job id, never a repository. Otherwise a PR could name
    // someone else's repo and have the reviewer read its logs.
    const spy = vi.fn(async () => "log");
    await tools(client({ downloadJobLog: spy })).read_ci_log!.execute({
      job_id: 10,
      owner: "attacker",
      repo: "evil",
    });
    expect(spy).toHaveBeenCalledWith({ owner: "OgenticAI", repo: "ogentic-shield", jobId: 10 });
  });
});

describe("tool surface", () => {
  it("exposes only read operations — no execution primitive", async () => {
    // Executing a fork's test suite in this process would hand PR-authored
    // code the reviewer's Anthropic key, Linear token, and GitHub App key.
    const names = Object.keys(tools(client()));
    expect(names.sort()).toEqual(["list_ci_jobs", "read_ci_log"]);
    for (const name of names) {
      expect(name).not.toMatch(/run|exec|bash|shell|test_run/i);
    }
  });
});
