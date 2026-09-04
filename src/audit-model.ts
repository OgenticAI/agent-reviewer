/**
 * The Anthropic-backed models for the audit chain.
 *
 * Kept out of `src/engine/` on purpose. The engine defines `InvestigateModel`
 * and `VerifierModel` as interfaces and is tested against stubs; this file is
 * the one place that knows an SDK exists, exactly as `cli.ts` is for the
 * pull-request path. The boundary test enforces the half of that rule that can
 * be enforced; this comment is the other half.
 *
 * ── Why the two stages get different tools ──────────────────────────────────
 *
 * The investigator gets `read_file` and a repo map, and is asked for claims.
 * The verifier gets `read_file` and one claim, and is asked to destroy it.
 * Neither is given the other's output beyond that: a verifier that could see
 * the investigator's reasoning would be checking the argument rather than the
 * evidence, and would agree with it far too often.
 */

import Anthropic from "@anthropic-ai/sdk";

import { runToolLoop, type LoopMessage, type TurnFn } from "./engine/tools/loop.js";
import { makeRegistry, toolDefinitions, type ReviewTool } from "./engine/tools/registry.js";
import type { InvestigateModel, InvestigateRequest, InvestigateResponse } from "./engine/audit/investigate.js";
import type { VerifierModel, VerifyRequest, VerifierVerdict, Outcome } from "./engine/audit/verify.js";

/**
 * The model for both stages.
 *
 * One model, not a cheap investigator and an expensive verifier. The whole
 * design rests on the verifier being able to overturn the investigator, and a
 * weaker verifier would rubber-stamp rather than refute — the failure would
 * look like high confidence, which is the worst shape for it to take.
 */
export const AUDIT_MODEL = "claude-sonnet-4-5";

const MAX_OUTPUT_TOKENS = 8192;

/**
 * Iterations per question. Higher than the review path's default because an
 * audit question is answered by reading around a codebase, not by reading one
 * diff — the model needs to follow an import chain to reach the answer.
 *
 * ── Why 48 and not 24 ───────────────────────────────────────────────────────
 *
 * 24 was not a budget, it was a wall every question hit. Two runs on 2026-09-03:
 *
 *   · agent-knowledge, 533 files / 92,409 lines — 9 of 9 questions exhausted it
 *   · ogentic-redact,  149 files / 19,917 lines — 4 of 4 questions exhausted it
 *
 * A question that runs out of turns is answered from `askForTheAnswer` with the
 * tools withheld, so its citations are recalled rather than read. `checkAnchors`
 * then rejects them as `quote-absent` or `line-beyond-eof`, or moves them as
 * `line-drift` and caps the claim at inferred — correctly, because a line
 * number written from memory is not a line number read from the file whatever
 * the intent behind it.
 * The first run spent US$39.20 over 1,245 model calls and published nothing at
 * all; the second survived 3 claims out of 35.
 *
 * So the cap was not bounding cost, it was buying it and throwing the result
 * away. 48 keeps the wall-clock cap the real ceiling: the 24-turn questions on
 * the smaller subject took ~95s against a 5-minute limit, so doubling the turns
 * still lands inside it, and a question that genuinely cannot be settled now
 * stops on wall-clock — a bound on work rather than a bound on reading.
 *
 * Tunable without a deploy because the right number is a property of the
 * subject, not of this file, and the next bad run should be answerable by
 * changing an env var on the box rather than shipping a release.
 */
/** Default used when the env var is absent, empty or not a positive integer. */
export const DEFAULT_AUDIT_TOOL_ITERATIONS = 48;

/**
 * Read the cap from `AUDIT_MAX_TOOL_ITERATIONS`.
 *
 * Refuses junk rather than coercing it. `Number("")` is 0 and `Number("12abc")`
 * is NaN — silently accepting either would cap investigation at zero turns and
 * present the resulting empty audit as a finished one, which is the failure this
 * whole comment exists to stop happening twice.
 *
 * Declared above `MAX_TOOL_ITERATIONS`, and the order is load-bearing: that
 * constant calls this at module scope, so a `const` it reads must already be
 * initialised. Declared below, `DEFAULT_AUDIT_TOOL_ITERATIONS` is in its
 * temporal dead zone and importing this file throws.
 */
export function readIterationCap(
  raw: string | undefined = process.env.AUDIT_MAX_TOOL_ITERATIONS,
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUDIT_TOOL_ITERATIONS;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_AUDIT_TOOL_ITERATIONS;
  return parsed;
}

export const MAX_TOOL_ITERATIONS = readIterationCap();

function extractText(content: unknown[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

/** Paths the loop actually opened, in order, deduplicated. */
function openedFrom(transcript: ReadonlyArray<{ name: string; input: unknown }>): string[] {
  const paths = transcript
    .filter((call) => call.name === "read_file")
    .map((call) => (call.input as { path?: unknown })?.path)
    .filter((path): path is string => typeof path === "string");
  return [...new Set(paths)];
}

import type { UsageMeter } from "./engine/audit/usage.js";

export interface AuditModelOptions {
  /**
   * Records what every call cost (OGE-2502).
   *
   * Optional so a caller that does not care about spend is unaffected, but the
   * CLI always supplies one — this is the ONLY place the audit path reaches the
   * API, so a meter here sees every investigate and verify call including each
   * tool-loop iteration.
   */
  meter?: UsageMeter;
  anthropic: Anthropic;
  /** The `read_file` tool, already bound to the tree and the access log. */
  readTool: ReviewTool;
  model?: string;
  log?: (message: string) => void;
}

/**
 * Mark the end of the reusable prefix (OGE-2505).
 *
 * The tool loop makes up to 24 calls per question, and every one of them
 * resends the same opening: the tool schemas, the system prompt, and a first
 * user message carrying the question, the repository map and the analyzer
 * facts. That opening is the bulk of the input and it never changes within a
 * question, so today it is billed at full rate two dozen times over.
 *
 * ── Why the breakpoint goes HERE and nowhere else ───────────────────────────
 *
 * Caching matches on a PREFIX, in render order `tools -> system -> messages`.
 * So one breakpoint at the end of the first user message covers the tools and
 * the system prompt too — there is no need to mark them separately, and marking
 * the system prompt ALONE would cache nothing at all: it measures ~218 tokens
 * against tools' ~84, and the minimum cacheable prefix is about 1024. Short
 * prefixes are not an error; they simply never cache, which is the quiet kind
 * of failure this codebase keeps being bitten by.
 *
 * It also cannot go any LATER. `collapseOldObservations` rewrites earlier tool
 * results in place as the conversation grows, so every message after the first
 * is mutable. A breakpoint past that point would be invalidated on each
 * iteration — every call a miss, and every call paying the write premium.
 *
 * ── What this costs when it does not pay ────────────────────────────────────
 *
 * A cache write is billed ABOVE the input rate (1.25x). A question the model
 * answers in a single call therefore costs ~25% more than it used to and never
 * reads the entry back. That is the deliberate trade: audit questions read
 * files, so single-call questions are the rare case, and the loop's other two
 * dozen calls each drop from full rate to a tenth of it.
 *
 * Returns a NEW array. The loop owns `messages` and mutates it; writing a
 * cache_control block back into it would leave the marker attached to a
 * conversation the loop is still editing.
 */
export function withCachedPrefix(messages: LoopMessage[]): Anthropic.MessageParam[] {
  const [first, ...rest] = messages;
  // Defensive: the loop always opens with a plain string prompt, but a shape we
  // do not recognise is passed through unmarked rather than reshaped. An
  // unmarked request is merely uncached; a malformed one is a failed audit.
  if (!first || typeof first.content !== "string") {
    return messages as Anthropic.MessageParam[];
  }

  return [
    {
      role: first.role,
      content: [
        {
          type: "text",
          text: first.content,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    ...rest,
  ] as Anthropic.MessageParam[];
}

async function runOnce(options: AuditModelOptions, systemPrompt: string, userPrompt: string) {
  const registry = makeRegistry([options.readTool]);
  const tools = toolDefinitions(registry);

  const turn: TurnFn = async (messages, turnOptions) => {
    // Withheld only for the loop's closing turn. Offering tools to a model
    // that has run out of budget is how the closing turn becomes another tool
    // call instead of an answer.
    const offerTools = turnOptions?.tools !== false;
    const completion = await options.anthropic.messages.create({
      model: options.model ?? AUDIT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Zero, so that two runs over an unchanged tree can be compared. The
      // report is diffed against the previous audit; sampling noise would show
      // up there as findings that came and went.
      temperature: 0,
      system: systemPrompt,
      messages: withCachedPrefix(messages),
      ...(tools && offerTools ? { tools: tools as Anthropic.Messages.ToolUnion[] } : {}),
    });
    // Before anything can throw on the response shape: an unmeasured call is
    // recorded as unmeasured, never dropped.
    options.meter?.record(completion);
    return { content: completion.content, stopReason: completion.stop_reason };
  };

  return runToolLoop({ turn, registry, userPrompt, maxIterations: MAX_TOOL_ITERATIONS });
}

/** The investigation stage's model. */
export function makeInvestigateModel(options: AuditModelOptions): InvestigateModel {
  const log = options.log ?? ((message: string) => console.error(message));

  return {
    async investigate(request: InvestigateRequest): Promise<InvestigateResponse> {
      const loop = await runOnce(options, request.systemPrompt, request.userPrompt);

      // A capped loop is reported, never silently accepted. A question the
      // model ran out of turns on has thinner evidence behind it than one it
      // finished, and the operator should know which is which.
      //
      // The turn count rides along because "everything hit the cap" is the
      // single most useful thing to notice about a bad run, and it was
      // previously only derivable by dividing the run's total model calls by
      // the number of questions — which is not a thing anyone does in time.
      if (loop.degraded) {
        log(
          `[audit] ${request.question.id}: ${loop.iterations}/${MAX_TOOL_ITERATIONS} turns — ` +
            `${loop.degraded}`,
        );
      }

      return {
        text: extractText(loop.finalContent as unknown[]),
        openedFiles: openedFrom(loop.transcript),
        // Only when the loop actually stopped short. A question that finished
        // on its own must not be labelled truncated.
        ...(loop.degraded ? { truncated: loop.degraded } : {}),
      };
    },
  };
}

/**
 * Parse a verifier's reply.
 *
 * An unreadable reply becomes `cannot-determine`, never `not-refuted`. The
 * difference matters: `not-refuted` is what earns a claim its place in the
 * report, and awarding it because a response failed to parse would let a
 * malformed answer promote a claim nobody actually checked.
 */
export function parseVerdict(text: string, verifier: number): VerifierVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { verifier, outcome: "cannot-determine", reason: "verifier returned no JSON", vocabulariesTried: [] };
  }

  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const outcome = raw["outcome"];
    const valid: Outcome[] = ["refuted", "not-refuted", "cannot-determine"];

    return {
      verifier,
      outcome: valid.includes(outcome as Outcome) ? (outcome as Outcome) : "cannot-determine",
      reason: typeof raw["reason"] === "string" ? raw["reason"] : "",
      ...(typeof raw["needsAccess"] === "string" ? { needsAccess: raw["needsAccess"] } : {}),
      vocabulariesTried: Array.isArray(raw["vocabulariesTried"])
        ? raw["vocabulariesTried"].filter((v): v is string => typeof v === "string")
        : [],
    };
  } catch {
    return { verifier, outcome: "cannot-determine", reason: "verifier returned unparseable JSON", vocabulariesTried: [] };
  }
}

/** The verification stage's model. */
export function makeVerifierModel(options: AuditModelOptions): VerifierModel {
  return {
    async refute(request: VerifyRequest): Promise<VerifierVerdict> {
      try {
        const loop = await runOnce(options, request.systemPrompt, request.userPrompt);
        return parseVerdict(extractText(loop.finalContent as unknown[]), request.verifier);
      } catch (error) {
        // A verifier that crashed did not clear the claim. Same reasoning as
        // an unparseable reply: failure must never read as agreement.
        const detail = error instanceof Error ? error.message : String(error);
        return {
          verifier: request.verifier,
          outcome: "cannot-determine",
          reason: `verifier failed: ${detail}`,
          vocabulariesTried: [],
        };
      }
    },
  };
}
