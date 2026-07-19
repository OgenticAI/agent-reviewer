/**
 * The single sandboxed exec tool (OGE-1584).
 *
 * Any checklist item of the form "run X and verify Y" — retries fire, the
 * endpoint 404s, the suite covers the flag — punts UNVERIFIABLE by
 * construction, because the model can read but never execute. That is the
 * largest structural contributor to the 88% punt baseline that no prompting
 * change can touch. This is the safe side of that boundary.
 *
 * ── The security framing is load-bearing ────────────────────────────────────
 *
 * The Kudelski RCE on CodeRabbit worked precisely because analyzer execution
 * ran in an environment holding API keys and the GitHub App private key. The
 * remediation was exactly this design: execution moves to a jailed, SECRETLESS
 * environment. Two guarantees enforce it here:
 *
 *   1. This tool runs PR-authored commands, so it must NEVER be constructed in
 *      the reviewer's main process (which holds ANTHROPIC_API_KEY,
 *      LINEAR_API_TOKEN, the GitHub App key). It is registered only behind
 *      `sandbox_enabled`, which the Action wires to a separate secretless job.
 *   2. `assertSecretlessEnv()` fails closed: if any known secret name is present
 *      in the process env, the tool refuses to run rather than executing a
 *      PR command next to a credential.
 *
 * ── Minimal surface ─────────────────────────────────────────────────────────
 *
 * mini-SWE-agent is the existence proof: one stateless `run_command` scores
 * >74% on SWE-bench Verified. One auditable tool beats N bespoke ones — every
 * observation has the same `{stdoutTail, exitCode}` shape, and the substrate
 * (a container step now, a microVM later) is swappable without the model
 * noticing.
 */

import { spawn } from "node:child_process";

import type { ReviewTool, ToolResult } from "./registry.js";

/** Tail of stdout+stderr kept per command — enough to verify, bounded for context. */
export const EXEC_OUTPUT_TAIL_CHARS = 8 * 1024;

/** Per-command wall-clock cap. The loop's overall caps (OGE-1552) still apply. */
export const EXEC_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Secret env names that must NOT be present when exec runs.
 *
 * The reviewer's credentials. If any is set, we are not in the secretless
 * sandbox and running a PR command here would be the exact CodeRabbit failure —
 * so the tool refuses. This is an allowlist-by-absence: the sandbox job is
 * expected to carry only a repo-scoped `GITHUB_TOKEN` and nothing below.
 */
export const FORBIDDEN_SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "LINEAR_API_TOKEN",
  "LINEAR_FACTORY_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "REVIEWER_APP_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "NPM_TOKEN",
] as const;

export interface EnvHygieneResult {
  ok: boolean;
  /** Secret env names found present — empty when clean. */
  leaked: string[];
}

/**
 * Verify the process env carries no reviewer secrets.
 *
 * Fail-closed: the exec tool calls this before every command and refuses if it
 * returns `ok: false`. Exported so the env-hygiene test can assert the sandbox
 * job's environment directly.
 */
export function assertSecretlessEnv(env: NodeJS.ProcessEnv = process.env): EnvHygieneResult {
  const leaked = FORBIDDEN_SECRET_ENV.filter((name) => {
    const v = env[name];
    return typeof v === "string" && v.length > 0;
  });
  return { ok: leaked.length === 0, leaked };
}

/** Structured observation crossing the sandbox boundary (OpenHands' shape). */
export interface ExecObservation {
  stdoutTail: string;
  exitCode: number | null;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Injectable runner so the tool is testable without spawning a shell. */
  run?: (cmd: string, opts: { cwd?: string; timeoutMs: number }) => Promise<ExecObservation>;
  /** Injectable env check, for tests. */
  envCheck?: () => EnvHygieneResult;
}

function defaultRun(
  cmd: string,
  opts: { cwd?: string; timeoutMs: number },
): Promise<ExecObservation> {
  return new Promise((resolve) => {
    // Run under `sh -c` so the model can use pipes/redirection like a shell.
    // This is safe ONLY because the surrounding job is secretless — see the
    // module header. The env is passed through as-is; the sandbox job is
    // responsible for it carrying no secrets, and `assertSecretlessEnv` is the
    // belt-and-braces check on top.
    const child = spawn("sh", ["-c", cmd], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
    });
    let out = "";
    const append = (chunk: Buffer) => {
      out += chunk.toString();
      // Keep only the tail as we go, so a runaway command can't exhaust memory.
      if (out.length > EXEC_OUTPUT_TAIL_CHARS * 2) out = out.slice(-EXEC_OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("close", (code) => resolve({ stdoutTail: tail(out), exitCode: code }));
    child.on("error", (err) => resolve({ stdoutTail: `spawn error: ${err.message}`, exitCode: null }));
  });
}

function tail(s: string): string {
  return s.length > EXEC_OUTPUT_TAIL_CHARS
    ? `… [output truncated to last ${EXEC_OUTPUT_TAIL_CHARS} chars]\n${s.slice(-EXEC_OUTPUT_TAIL_CHARS)}`
    : s;
}

/**
 * The one exec tool. Only ever added to the registry behind `sandbox_enabled`.
 *
 * Every result is a structured `{stdoutTail, exitCode}` rendered for the model;
 * the loop then routes it through the OGE-1579 scrub/fence pipeline like any
 * other observation — exec output is the most injection-prone class there is.
 */
export function makeExecTool(options: RunCommandOptions = {}): ReviewTool {
  const run = options.run ?? defaultRun;
  const envCheck = options.envCheck ?? (() => assertSecretlessEnv());

  return {
    definition: {
      name: "run_command",
      description:
        "Run a shell command in a secretless sandbox on the PR's checked-out head, and get " +
        "its combined stdout/stderr tail plus exit code. Prefer deterministic checks — run the " +
        "test suite, grep for a symbol, build the project — and cite the exact command and its " +
        "output as evidence. There are no credentials in this environment; network egress is " +
        "restricted.",
      input_schema: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "The shell command to run." },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
    async execute(input: unknown): Promise<ToolResult> {
      const cmd = (input as { cmd?: unknown })?.cmd;
      if (typeof cmd !== "string" || cmd.trim() === "") {
        return { content: "run_command requires a non-empty `cmd` string.", isError: true };
      }

      // Fail closed: never run a PR command in an env that holds a secret.
      const hygiene = envCheck();
      if (!hygiene.ok) {
        return {
          content:
            `run_command refused: the environment is not secretless ` +
            `(${hygiene.leaked.join(", ")} present). Execution is only allowed in the ` +
            `sandbox job. This is a safety gate, not a transient error — do not retry.`,
          isError: true,
        };
      }

      const obs = await run(cmd, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        timeoutMs: options.timeoutMs ?? EXEC_COMMAND_TIMEOUT_MS,
      });
      return {
        content: renderObservation(cmd, obs),
        isError: obs.exitCode !== 0,
      };
    },
  };
}

/** Render the structured observation as the text the model reads. */
export function renderObservation(cmd: string, obs: ExecObservation): string {
  return [
    `$ ${cmd}`,
    `exit: ${obs.exitCode ?? "null (killed/timeout)"}`,
    `---`,
    obs.stdoutTail || "(no output)",
  ].join("\n");
}
