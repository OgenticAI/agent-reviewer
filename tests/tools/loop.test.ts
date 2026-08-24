/**
 * The bounded tool loop (OGE-1552).
 *
 * `turn` is faked throughout, so every branch — caps, tool errors, unknown
 * tools, malformed blocks — is exercised with no network, no API key, and no
 * real waiting. The wall-clock cap uses an injected clock for the same reason.
 *
 * The invariant these tests exist to protect: **the loop always terminates and
 * always returns something usable.** An Action that hangs is worse than one
 * that returns a mediocre verdict, and the reviewer never fails the build.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_ITERATIONS,
  runToolLoop,
  type LoopTurnResponse,
  type TurnFn,
} from "../../src/engine/tools/loop.js";
import { EMPTY_REGISTRY, makeRegistry, type ReviewTool } from "../../src/engine/tools/registry.js";

const FINAL: LoopTurnResponse = {
  content: [{ type: "text", text: '{"items":[]}' }],
  stopReason: "end_turn",
};

function toolUseTurn(name: string, input: unknown = {}, id = "toolu_1"): LoopTurnResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
  };
}

/** A `turn` that replays a scripted sequence of responses. */
function scriptedTurn(responses: LoopTurnResponse[]): { turn: TurnFn; calls: number } {
  let i = 0;
  const state = { calls: 0 } as { calls: number; turn: TurnFn };
  state.turn = async () => {
    state.calls += 1;
    return responses[Math.min(i++, responses.length - 1)]!;
  };
  return state as { turn: TurnFn; calls: number };
}

function echoTool(overrides: Partial<ReviewTool> = {}): ReviewTool {
  return {
    definition: {
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
    execute: async (input) => ({ content: `read: ${JSON.stringify(input)}` }),
    ...overrides,
  };
}

describe("runToolLoop — the empty-registry no-op path", () => {
  it("makes exactly one call and returns the text", async () => {
    const s = scriptedTurn([FINAL]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: EMPTY_REGISTRY,
      userPrompt: "review this",
    });
    expect(s.calls).toBe(1);
    expect(result.iterations).toBe(1);
    expect(result.degraded).toBeUndefined();
    expect(result.transcript).toEqual([]);
    expect(result.content).toEqual(FINAL.content);
  });

  it("seeds the conversation with the user prompt", async () => {
    const seen: unknown[][] = [];
    const turn: TurnFn = async (messages) => {
      seen.push([...messages]);
      return FINAL;
    };
    await runToolLoop({ turn, registry: EMPTY_REGISTRY, userPrompt: "the prompt" });
    expect(seen[0]).toEqual([{ role: "user", content: "the prompt" }]);
  });
});

describe("runToolLoop — tool execution", () => {
  it("executes a requested tool and loops back with the result", async () => {
    const s = scriptedTurn([toolUseTurn("read_file", { path: "a.ts" }), FINAL]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
    });
    expect(s.calls).toBe(2);
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0]!.name).toBe("read_file");
    expect(result.transcript[0]!.isError).toBe(false);
    expect(result.degraded).toBeUndefined();
  });

  it("sends every parallel result back in a single user message", async () => {
    // Splitting tool results across messages trains the model out of parallel
    // tool calls — a slow degradation that's hard to spot later.
    const seen: unknown[][] = [];
    let call = 0;
    const turn: TurnFn = async (messages) => {
      seen.push([...messages]);
      call += 1;
      if (call === 1) {
        return {
          content: [
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
            { type: "tool_use", id: "t2", name: "read_file", input: { path: "b" } },
          ],
          stopReason: "tool_use",
        };
      }
      return FINAL;
    };
    await runToolLoop({ turn, registry: makeRegistry([echoTool()]), userPrompt: "p" });
    const second = seen[1]!;
    const userResults = second.filter(
      (m) => (m as { role: string }).role === "user" && Array.isArray((m as { content: unknown }).content),
    );
    expect(userResults).toHaveLength(1);
    expect((userResults[0] as { content: unknown[] }).content).toHaveLength(2);
  });

  it("gives the model the FULL result while truncating only the transcript", async () => {
    const long = "x".repeat(2000);
    const seen: unknown[][] = [];
    let call = 0;
    const turn: TurnFn = async (messages) => {
      seen.push([...messages]);
      return ++call === 1 ? toolUseTurn("read_file") : FINAL;
    };
    const result = await runToolLoop({
      turn,
      registry: makeRegistry([echoTool({ execute: async () => ({ content: long }) })]),
      userPrompt: "p",
    });
    const resultMsg = seen[1]!.at(-1) as { content: Array<{ content: string }> };
    // Assert on the payload, not the total length: results are wrapped in an
    // untrusted fence (OGE-1579), so the block is longer than the body. What
    // matters is that the model receives all 2000 characters while the
    // transcript keeps only its truncated copy.
    expect(resultMsg.content[0]!.content).toContain("x".repeat(2000));
    expect(result.transcript[0]!.result).toMatch(/… \[truncated\]$/);
  });

  it("reports an unknown tool back to the model instead of crashing", async () => {
    const s = scriptedTurn([toolUseTurn("nonexistent"), FINAL]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
    });
    expect(result.transcript[0]!.isError).toBe(true);
    expect(result.transcript[0]!.result).toMatch(/No such tool: nonexistent/);
  });

  it("converts a throwing tool into an error result, not a failed review", async () => {
    const s = scriptedTurn([toolUseTurn("read_file"), FINAL]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([
        echoTool({
          execute: async () => {
            throw new Error("disk on fire");
          },
        }),
      ]),
      userPrompt: "p",
    });
    expect(result.transcript[0]!.isError).toBe(true);
    expect(result.transcript[0]!.result).toBe("disk on fire");
    expect(result.degraded).toBeUndefined(); // a tool failing is not a degraded run
  });

  it("propagates a tool's own isError flag", async () => {
    const s = scriptedTurn([toolUseTurn("read_file"), FINAL]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([
        echoTool({ execute: async () => ({ content: "not found", isError: true }) }),
      ]),
      userPrompt: "p",
    });
    expect(result.transcript[0]!.isError).toBe(true);
  });

  it("stops when stop_reason is tool_use but no parseable tool_use block exists", async () => {
    // Malformed block: without this guard the loop would spin to the cap.
    const s = scriptedTurn([{ content: [{ type: "tool_use" }], stopReason: "tool_use" }]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
    });
    expect(s.calls).toBe(1);
    expect(result.degraded).toBeUndefined();
  });
});

describe("runToolLoop — caps", () => {
  it("stops at the iteration cap and marks the run degraded", async () => {
    const s = scriptedTurn([toolUseTurn("read_file")]); // never finishes
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
      maxIterations: 4,
    });
    expect(s.calls).toBe(4);
    expect(result.iterations).toBe(4);
    expect(result.degraded).toMatch(/iteration cap of 4/);
  });

  it("still returns usable content when the iteration cap trips", async () => {
    const s = scriptedTurn([
      { content: [{ type: "text", text: "partial" }, ...toolUseTurn("read_file").content], stopReason: "tool_use" },
    ]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
      maxIterations: 2,
    });
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.transcript.length).toBeGreaterThan(0);
  });

  it("stops on the wall-clock cap even when under the iteration cap", async () => {
    let t = 0;
    const now = () => (t += 10_000); // 10s per read
    const s = scriptedTurn([toolUseTurn("read_file")]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
      maxIterations: 100,
      maxWallClockMs: 15_000,
      now,
    });
    expect(result.degraded).toMatch(/wall-clock cap/);
    expect(result.iterations).toBeLessThan(100);
  });

  it("never throws on a cap — degraded is a value, not an exception", async () => {
    const s = scriptedTurn([toolUseTurn("read_file")]);
    await expect(
      runToolLoop({
        turn: s.turn,
        registry: makeRegistry([echoTool()]),
        userPrompt: "p",
        maxIterations: 1,
      }),
    ).resolves.toBeTruthy();
  });

  it("defaults to a documented iteration cap", async () => {
    const s = scriptedTurn([toolUseTurn("read_file")]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
    });
    expect(result.iterations).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("does not mark a run degraded when it finishes on the final allowed iteration", async () => {
    const s = scriptedTurn([toolUseTurn("read_file"), FINAL]);
    const result = await runToolLoop({
      turn: s.turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
      maxIterations: 2,
    });
    expect(result.degraded).toBeUndefined();
  });
});

describe("runToolLoop — server-side pause_turn", () => {
  it("resumes a paused turn without injecting a continue message", async () => {
    const seen: unknown[][] = [];
    let call = 0;
    const turn: TurnFn = async (messages) => {
      seen.push([...messages]);
      return ++call === 1
        ? { content: [{ type: "text", text: "partial" }], stopReason: "pause_turn" }
        : FINAL;
    };
    const result = await runToolLoop({ turn, registry: EMPTY_REGISTRY, userPrompt: "p" });
    expect(call).toBe(2);
    // Second request must be [user, assistant] — no synthetic "continue" user turn.
    expect(seen[1]!.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant"]);
    expect(result.degraded).toBeUndefined();
  });

  it("accumulates content across a resumed turn", async () => {
    let call = 0;
    const turn: TurnFn = async () =>
      ++call === 1
        ? { content: [{ type: "text", text: '{"items":' }], stopReason: "pause_turn" }
        : { content: [{ type: "text", text: "[]}" }], stopReason: "end_turn" };
    const result = await runToolLoop({ turn, registry: EMPTY_REGISTRY, userPrompt: "p" });
    expect(result.content).toHaveLength(2);
  });
});

describe("makeRegistry", () => {
  it("rejects duplicate tool names at construction", () => {
    // A duplicate would let one tool's schema be advertised while another's
    // behaviour runs — worth failing loudly and early.
    expect(() => makeRegistry([echoTool(), echoTool()])).toThrow(/Duplicate tool name/);
  });

  it("builds an empty registry from no tools", () => {
    expect(makeRegistry([]).size).toBe(0);
  });
});

describe("observation collapsing (OGE-1583)", () => {
  function bigToolTurn(id: string): LoopTurnResponse {
    return {
      content: [{ type: "tool_use", id, name: "read_file", input: {} }],
      stopReason: "tool_use",
    };
  }

  it("collapses all but the most recent observations", async () => {
    const seen: unknown[][] = [];
    let call = 0;
    const turn: TurnFn = async (messages) => {
      seen.push(JSON.parse(JSON.stringify(messages)));
      call += 1;
      return call <= 8 ? bigToolTurn(`t${call}`) : FINAL;
    };
    await runToolLoop({
      turn,
      registry: makeRegistry([echoTool({ execute: async () => ({ content: "x".repeat(5000) }) })]),
      userPrompt: "p",
      maxIterations: 10,
    });

    const last = seen.at(-1)!;
    const observations = last.filter(
      (m) =>
        (m as { role: string }).role === "user" &&
        Array.isArray((m as { content: unknown }).content),
    );
    const collapsed = observations.filter((m) =>
      JSON.stringify(m).includes("earlier observation omitted"),
    );
    // 8 observations, 5 kept in full.
    expect(observations.length).toBe(8);
    expect(collapsed.length).toBe(3);
  });

  it("keeps tool_use_id on a collapsed observation", async () => {
    // Dropping it would orphan the model's tool call and invalidate the request.
    const seen: unknown[][] = [];
    let call = 0;
    const turn: TurnFn = async (messages) => {
      seen.push(JSON.parse(JSON.stringify(messages)));
      call += 1;
      return call <= 7 ? bigToolTurn(`t${call}`) : FINAL;
    };
    await runToolLoop({
      turn,
      registry: makeRegistry([echoTool()]),
      userPrompt: "p",
      maxIterations: 10,
    });
    const collapsed = JSON.stringify(seen.at(-1)).match(/"tool_use_id":"t1"/);
    expect(collapsed).not.toBeNull();
  });

  it("leaves the transcript uncollapsed — hashing uses full output", async () => {
    let call = 0;
    const turn: TurnFn = async () => (++call <= 7 ? bigToolTurn(`t${call}`) : FINAL);
    const result = await runToolLoop({
      turn,
      registry: makeRegistry([echoTool({ execute: async () => ({ content: "full result" }) })]),
      userPrompt: "p",
      maxIterations: 10,
    });
    expect(result.transcript).toHaveLength(7);
    for (const rec of result.transcript) expect(rec.result).toContain("full result");
  });
});
