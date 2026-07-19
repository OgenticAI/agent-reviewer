/**
 * The single sandboxed exec tool (OGE-1584).
 *
 * Two properties matter above the rest, and both are security properties:
 *   1. The tool FAILS CLOSED — if a reviewer secret is present in the env, it
 *      refuses to run rather than executing a PR command beside a credential
 *      (the Kudelski / CodeRabbit failure mode).
 *   2. The observation is a structured `{stdoutTail, exitCode}` that flows
 *      through the OGE-1579 scrub/fence pipeline like any other tool output —
 *      exec output is the most injection-prone class there is.
 */

import { describe, expect, it } from "vitest";

import {
  assertSecretlessEnv,
  FORBIDDEN_SECRET_ENV,
  makeExecTool,
  renderObservation,
  type ExecObservation,
} from "../../src/tools/exec.js";
import { scrubObservation } from "../../src/tools/sanitize.js";
import { makeRegistry } from "../../src/tools/registry.js";

/** A fake runner so tests never spawn a shell. */
function fakeRun(obs: ExecObservation) {
  return async () => obs;
}
const CLEAN_ENV = () => ({ ok: true, leaked: [] });

describe("assertSecretlessEnv", () => {
  it("passes when no reviewer secret is present", () => {
    expect(assertSecretlessEnv({ GITHUB_TOKEN: "ghs_repo_scoped", PATH: "/usr/bin" }).ok).toBe(true);
  });

  it("fails and names the leaked secret", () => {
    const r = assertSecretlessEnv({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
    expect(r.ok).toBe(false);
    expect(r.leaked).toContain("ANTHROPIC_API_KEY");
  });

  it("treats every forbidden name as a leak", () => {
    for (const name of FORBIDDEN_SECRET_ENV) {
      expect(assertSecretlessEnv({ [name]: "value" }).ok).toBe(false);
    }
  });

  it("ignores an empty-string secret (unset in practice)", () => {
    expect(assertSecretlessEnv({ ANTHROPIC_API_KEY: "" }).ok).toBe(true);
  });
});

describe("run_command tool", () => {
  it("returns the structured {stdoutTail, exitCode} observation shape", async () => {
    const tool = makeExecTool({
      run: fakeRun({ stdoutTail: "3 passed, 0 failed", exitCode: 0 }),
      envCheck: CLEAN_ENV,
    });
    const result = await tool.execute({ cmd: "npm test" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("$ npm test");
    expect(result.content).toContain("exit: 0");
    expect(result.content).toContain("3 passed, 0 failed");
  });

  it("marks a non-zero exit as an error observation", async () => {
    const tool = makeExecTool({ run: fakeRun({ stdoutTail: "1 failed", exitCode: 1 }), envCheck: CLEAN_ENV });
    expect((await tool.execute({ cmd: "npm test" })).isError).toBe(true);
  });

  it("FAILS CLOSED when the env holds a secret — refuses, does not run", async () => {
    let ran = false;
    const tool = makeExecTool({
      run: async () => {
        ran = true;
        return { stdoutTail: "", exitCode: 0 };
      },
      envCheck: () => ({ ok: false, leaked: ["ANTHROPIC_API_KEY"] }),
    });
    const result = await tool.execute({ cmd: "cat ~/.aws/credentials" });
    expect(ran).toBe(false); // the command NEVER executed
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not secretless/);
    expect(result.content).toMatch(/do not retry/);
  });

  it("rejects an empty command", async () => {
    const tool = makeExecTool({ run: fakeRun({ stdoutTail: "", exitCode: 0 }), envCheck: CLEAN_ENV });
    expect((await tool.execute({ cmd: "  " })).isError).toBe(true);
  });

  it("exposes exactly one tool named run_command", () => {
    expect(makeExecTool().definition.name).toBe("run_command");
  });
});

describe("exec observation through the sanitize pipeline (OGE-1579)", () => {
  it("masks a secret value that a command echoed before it reaches the transcript", () => {
    const secret = "sk-ant-supersecretvalue123";
    // Simulate a PR command that printed a leaked secret into stdout.
    const obs: ExecObservation = { stdoutTail: `TOKEN=${secret}`, exitCode: 0 };
    const rendered = renderObservation("printenv", obs);
    // This is the exact call the loop makes on every observation.
    const scrubbed = scrubObservation(rendered, [secret]);
    expect(scrubbed).not.toContain(secret);
  });
});

describe("run_command real execution (integration)", () => {
  it("actually runs a fixture command and reports stdout + exit 0", async () => {
    // No fake runner: this spawns a real shell. `echo` is harmless and present
    // everywhere the tests run.
    const tool = makeExecTool({ envCheck: CLEAN_ENV });
    const result = await tool.execute({ cmd: "echo hello-sandbox" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello-sandbox");
    expect(result.content).toContain("exit: 0");
  });

  it("reports a non-zero exit from a real failing command", async () => {
    const tool = makeExecTool({ envCheck: CLEAN_ENV });
    const result = await tool.execute({ cmd: "exit 3" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit: 3");
  });
});

describe("registry gating — run_command only when explicitly added (OGE-1584)", () => {
  it("is absent from a registry built without the exec tool", () => {
    // Mirrors the CLI's default: sandbox_enabled=false never pushes makeExecTool.
    const registry = makeRegistry([
      { definition: { name: "http_get", description: "d", input_schema: {} }, execute: async () => ({ content: "" }) },
    ]);
    expect(registry.has("run_command")).toBe(false);
  });

  it("is present exactly when the exec tool is added", () => {
    const registry = makeRegistry([makeExecTool({ envCheck: CLEAN_ENV })]);
    expect(registry.has("run_command")).toBe(true);
  });
});
