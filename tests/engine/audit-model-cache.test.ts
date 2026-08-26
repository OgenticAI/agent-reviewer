import { describe, expect, it } from "vitest";

import { makeInvestigateModel, withCachedPrefix } from "../../src/audit-model.js";
import type { ReviewTool } from "../../src/engine/tools/registry.js";
import type { Question } from "../../src/engine/audit/questions.js";

/* ── Prompt caching: the reusable prefix (OGE-2504) ────────────────────────── */

const QUESTION: Question = {
  id: "authn-completeness",
  ask: "Is every route authenticated?",
  seeds: ["auth"],
  absenceClaim: false,
};

const READ_TOOL: ReviewTool = {
  definition: {
    name: "read_file",
    description: "Read a file.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  execute: async () => ({ content: "export const guard = true;\n" }),
};

interface Captured {
  system: unknown;
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * A fake client that replays a scripted conversation and records every request.
 *
 * Scripted rather than canned so the loop actually runs more than once — a
 * single call cannot show whether the cached prefix survives an iteration,
 * which is the only thing worth testing here.
 */
function fakeAnthropic(turns: Array<{ content: unknown[]; stop_reason: string }>) {
  const requests: Captured[] = [];
  let turn = 0;
  const client = {
    messages: {
      create: async (body: Captured) => {
        // Snapshot, so a later in-place mutation by the loop cannot rewrite
        // what we recorded. Testing against a live reference would hide
        // exactly the mutation this feature is vulnerable to.
        requests.push(JSON.parse(JSON.stringify(body)) as Captured);
        return { ...turns[Math.min(turn++, turns.length - 1)], usage: {} };
      },
    },
  };
  return { client, requests };
}

const ANSWER = '{"claims":[]}';

/** Read a file, then answer — the shape almost every real question takes. */
const TWO_TURNS = [
  {
    content: [
      { type: "text", text: "Let me read the middleware." },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/a.ts" } },
    ],
    stop_reason: "tool_use",
  },
  { content: [{ type: "text", text: ANSWER }], stop_reason: "end_turn" },
];

async function investigateWith(turns = TWO_TURNS) {
  const { client, requests } = fakeAnthropic(turns);
  const model = makeInvestigateModel({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    anthropic: client as any,
    readTool: READ_TOOL,
    log: () => {},
  });
  const text = await model.investigate({
    question: QUESTION,
    systemPrompt: "You are an auditor.",
    userPrompt: "QUESTION (authn-completeness)\nREPOSITORY MAP\nsrc/a.ts",
  });
  return { requests, text };
}

function cacheControlOf(message: { content: unknown }): unknown {
  const blocks = message.content as Array<Record<string, unknown>>;
  return Array.isArray(blocks) ? blocks[0]?.["cache_control"] : undefined;
}

describe("the reusable prefix is marked for caching", () => {
  it("marks the end of the first user message", async () => {
    const { requests } = await investigateWith();
    expect(cacheControlOf(requests[0]!.messages[0]!)).toEqual({ type: "ephemeral" });
  });

  it("keeps the prompt text intact when it wraps it in a block", async () => {
    const { requests } = await investigateWith();
    const blocks = requests[0]!.messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!["type"]).toBe("text");
    expect(blocks[0]!["text"]).toContain("REPOSITORY MAP");
  });

  // The point of the whole feature. A breakpoint on a prefix that CHANGES is
  // worse than none: every call misses AND pays the write premium. Presence of
  // the field proves nothing; identity across iterations is the property.
  it("sends a byte-identical prefix on the next iteration", async () => {
    const { requests } = await investigateWith();
    expect(requests.length).toBeGreaterThan(1);
    expect(requests[1]!.messages[0]).toEqual(requests[0]!.messages[0]);
    expect(requests[1]!.system).toEqual(requests[0]!.system);
  });

  // Everything after the first message is rewritten in place as the loop
  // collapses old observations, so nothing there may carry a breakpoint.
  it("marks nothing in the part of the conversation that gets rewritten", async () => {
    const { requests } = await investigateWith();
    const later = requests[requests.length - 1]!.messages.slice(1);
    expect(later.length).toBeGreaterThan(0);
    for (const message of later) {
      expect(cacheControlOf(message)).toBeUndefined();
    }
  });

  it("still returns the answer", async () => {
    const { text } = await investigateWith();
    expect(text.text).toContain(ANSWER);
  });

  // A shape we did not expect goes out unmarked rather than reshaped: an
  // uncached request is merely expensive, a malformed one is a failed audit.
  it("passes an unrecognised first message through untouched", () => {
    const already = [{ type: "text", text: "x" }];
    const out = withCachedPrefix([{ role: "user", content: already }]);
    expect(out[0]!.content).toBe(already);
  });
});
