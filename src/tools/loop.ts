/**
 * The bounded agentic loop (OGE-1552).
 *
 * Today the review is one blind call: the model sees a diff and nothing else,
 * so `UNVERIFIABLE` is the only correct answer for any claim not literally in
 * a hunk. That is why 53 of 60 verdicts punt. This is the plumbing that lets
 * the model look things up before deciding — though note the actual
 * behavioural lever is the `SYSTEM_PROMPT` wording change that ships with it,
 * not the loop.
 *
 * Deliberately abstracted from the Anthropic SDK: `runToolLoop` takes a `turn`
 * function and structural message/content types. That means every branch here
 * — iteration cap, wall-clock cap, tool errors, malformed blocks — is unit
 * testable with a fake `turn`, no network and no API key.
 *
 * Termination is bounded three ways, because an Action that hangs is worse
 * than an Action that returns a mediocre verdict:
 *   1. the model stops asking for tools (the normal exit),
 *   2. an iteration cap,
 *   3. a wall-clock cap.
 * Hitting (2) or (3) is *degraded*, not fatal — the caller still gets whatever
 * the model produced, plus a reason string to surface. The reviewer never
 * fails the Action.
 */

import type { ToolRegistry } from "./registry.js";
import { collectKnownSecrets, fenceUntrusted, scrubObservation } from "./sanitize.js";

/** Structural stand-in for an Anthropic message param. */
export interface LoopMessage {
  role: "user" | "assistant";
  content: unknown;
}

export interface LoopTurnResponse {
  content: unknown[];
  /** `tool_use`, `pause_turn`, `end_turn`, `max_tokens`, … */
  stopReason: string | null;
}

/** One request/response against the model. Injected so tests can fake it. */
export type TurnFn = (messages: LoopMessage[]) => Promise<LoopTurnResponse>;

/** One executed tool call, for the transcript. */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  /** Result content, truncated for the transcript. */
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface ToolLoopResult {
  /** Every content block across every turn, in order. */
  content: unknown[];
  transcript: ToolCallRecord[];
  /** Why the loop stopped early, or undefined if it finished normally. */
  degraded?: string;
  iterations: number;
}

/** Iteration cap. Generous enough for real investigation, small enough to bound cost. */
export const DEFAULT_MAX_ITERATIONS = 12;

/** Wall-clock cap. The Action's own timeout is 15 minutes; stay well inside it. */
export const DEFAULT_MAX_WALL_CLOCK_MS = 5 * 60_000;

/** Transcript entries are for humans debugging a run, not for replay. */
const TRANSCRIPT_RESULT_MAX_CHARS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

function extractToolUses(content: unknown[]): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string") continue;
    out.push({ id: block.id, name: block.name, input: block.input });
  }
  return out;
}

/**
 * Run the model until it stops asking for tools, or a cap trips.
 *
 * With an empty registry this makes exactly one `turn` call and returns — the
 * no-op path that lets the loop ship before any tool exists.
 */
export async function runToolLoop(args: {
  turn: TurnFn;
  registry: ToolRegistry;
  userPrompt: string;
  maxIterations?: number;
  maxWallClockMs?: number;
  /** Injectable clock so the wall-clock cap is testable without waiting. */
  now?: () => number;
}): Promise<ToolLoopResult> {
  const maxIterations = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxWallClockMs = args.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS;
  const now = args.now ?? (() => Date.now());

  const startedAt = now();
  // Resolved once: reading process.env per observation would be wasteful and
  // would let a mid-run env change produce inconsistent masking.
  const knownSecrets = collectKnownSecrets();
  const messages: LoopMessage[] = [{ role: "user", content: args.userPrompt }];
  const collected: unknown[] = [];
  const transcript: ToolCallRecord[] = [];

  let iterations = 0;
  let degraded: string | undefined;
  /**
   * Whether the model stopped asking for tools of its own accord.
   *
   * Tracked explicitly rather than inferred from `iterations >= maxIterations`:
   * a run that legitimately finishes *on* its last allowed iteration has the
   * same counter value as one the cap cut short, and marking that first case
   * degraded would put a false warning on a perfectly good verdict.
   */
  let completedNormally = false;

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await args.turn(messages);
    collected.push(...response.content);

    // Server-side tool loop paused (web search etc). Re-send as-is to resume;
    // do NOT inject a "continue" message — the API resumes off the trailing
    // server-tool block on its own.
    if (response.stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      if (now() - startedAt > maxWallClockMs) {
        degraded = `wall-clock cap of ${maxWallClockMs}ms reached while resuming a paused turn`;
        break;
      }
      continue;
    }

    const toolUses = response.stopReason === "tool_use" ? extractToolUses(response.content) : [];
    if (toolUses.length === 0) {
      completedNormally = true;
      break; // the model answered
    }

    messages.push({ role: "assistant", content: response.content });

    // Execute in parallel and return every result in ONE user message.
    // Splitting results across messages trains the model out of parallel tool
    // calls, which is a slow, hard-to-spot degradation.
    const results = await Promise.all(
      toolUses.map(async (use) => {
        const { record, content } = await executeTool(args.registry, use, now, knownSecrets);
        transcript.push(record);
        return {
          type: "tool_result",
          tool_use_id: use.id,
          // The model gets the FULL result; only the transcript is truncated.
          // Feeding back the shortened copy would quietly degrade every tool
          // whose output runs long, in a way that looks like a model problem.
          //
          // Fenced because every tool output is attacker-influenced: a CI log
          // line or fetched page can address the model directly (OGE-1579).
          // The fence is inert without the standing rule in the prompt.
          content: fenceUntrusted(content, { source: use.name }),
          ...(record.isError ? { is_error: true } : {}),
        };
      }),
    );
    messages.push({ role: "user", content: results });

    if (now() - startedAt > maxWallClockMs) {
      degraded = `wall-clock cap of ${maxWallClockMs}ms reached after ${iterations} iteration(s)`;
      break;
    }
  }

  if (!degraded && !completedNormally) {
    degraded = `iteration cap of ${maxIterations} reached`;
  }

  return { content: collected, transcript, degraded, iterations };
}

/**
 * Run one tool call, returning the full content for the model plus a
 * truncated record for the transcript.
 */
async function executeTool(
  registry: ToolRegistry,
  use: ToolUseBlock,
  now: () => number,
  knownSecrets: string[],
): Promise<{ record: ToolCallRecord; content: string }> {
  const startedAt = now();
  const tool = registry.get(use.name);

  // Scrub BEFORE anything downstream sees it: the model, the transcript, the
  // operator log, and — critically — the cache hash computed from the
  // transcript, which must never embed a secret value (OGE-1579).
  const finish = (raw: string, isError: boolean) => {
    const content = scrubObservation(raw, knownSecrets);
    return {
      record: {
        name: use.name,
        input: use.input,
        result: truncate(content),
        isError,
        durationMs: now() - startedAt,
      },
      content,
    };
  };

  if (!tool) {
    // The model asked for something we never advertised. Tell it plainly so it
    // can pick a different approach rather than retrying the same call.
    return finish(`No such tool: ${use.name}`, true);
  }

  try {
    const result = await tool.execute(use.input);
    return finish(result.content, result.isError === true);
  } catch (err) {
    // A throwing tool must not take the review down with it — the reviewer
    // never fails the Action.
    return finish(err instanceof Error ? err.message : String(err), true);
  }
}

function truncate(s: string): string {
  return s.length > TRANSCRIPT_RESULT_MAX_CHARS
    ? `${s.slice(0, TRANSCRIPT_RESULT_MAX_CHARS)}… [truncated]`
    : s;
}
