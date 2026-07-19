/**
 * Volatile-field normalisation before hashing (OGE-1553).
 *
 * The headline test is the one the ticket asked for: two runs of the same CI
 * job must hash equal. Without that the cache never hits and the whole replay
 * mechanism is dead weight.
 *
 * The counter-tests matter just as much. Over-normalising is the dangerous
 * direction — mask too much and two genuinely different tool outputs collide,
 * so the reviewer replays a stale verdict against changed evidence. Under-
 * normalising only costs a cache miss.
 */

import { describe, expect, it } from "vitest";

import { normalizeToolOutput } from "../../src/cache/normalize.js";
import { hashToolOutputs } from "../../src/cache/verdict-cache.js";
import type { ToolCallRecord } from "../../src/tools/loop.js";

function record(name: string, result: string): ToolCallRecord {
  return { name, input: {}, result, isError: false, durationMs: 1 };
}

describe("normalizeToolOutput — volatile fields", () => {
  it("masks ISO timestamps", () => {
    expect(normalizeToolOutput("started 2026-07-19T10:32:28.123Z")).toBe("started <TS>");
  });

  it("masks clock times", () => {
    expect(normalizeToolOutput("at 10:32:28 done")).toBe("at <TIME> done");
  });

  it("masks durations", () => {
    expect(normalizeToolOutput("took 1.23s")).toBe("took <DUR>");
    expect(normalizeToolOutput("took 45ms")).toBe("took <DUR>");
  });

  it("masks git SHAs", () => {
    expect(normalizeToolOutput("commit f6299112233aabb")).toBe("commit <SHA>");
  });

  it("masks run and job ids", () => {
    expect(normalizeToolOutput("actions/runs/123456")).toContain("<ID>");
    expect(normalizeToolOutput("run_id: 987654")).toContain("<ID>");
  });

  it("strips ANSI colour codes", () => {
    // Explicit escapes: a literal ESC byte in the source is invisible and
    // makes this test impossible to read or edit correctly.
    expect(normalizeToolOutput("\u001b[32mPASS\u001b[0m")).toBe("PASS");
  });

  it("normalises CRLF and trailing whitespace", () => {
    expect(normalizeToolOutput("a   \r\nb")).toBe("a\nb");
  });
});

describe("normalizeToolOutput — what must NOT be masked", () => {
  it("leaves test counts alone", () => {
    // "225 passed" vs "226 passed" is a different fact that can change a
    // verdict. Masking it would let the cache replay against a changed suite.
    expect(normalizeToolOutput("225 passed")).toBe("225 passed");
    expect(normalizeToolOutput("225 passed")).not.toBe(normalizeToolOutput("226 passed"));
  });

  it("leaves file paths and line numbers alone", () => {
    expect(normalizeToolOutput("src/redaction.ts:42: match")).toBe("src/redaction.ts:42: match");
  });

  it("leaves version strings alone", () => {
    expect(normalizeToolOutput("version 0.2.0")).toBe("version 0.2.0");
  });

  it("keeps genuinely different outputs distinct", () => {
    expect(normalizeToolOutput("FAIL: 3 errors")).not.toBe(normalizeToolOutput("FAIL: 4 errors"));
  });
});

describe("hashToolOutputs", () => {
  it("hashes two runs of the same CI job equal", () => {
    // The acceptance criterion from the ticket, stated directly.
    const runA = record(
      "read_ci_log",
      "2026-07-19T10:32:28Z Run actions/runs/111\n225 passed in 12.4s\ncommit abc1234def5678",
    );
    const runB = record(
      "read_ci_log",
      "2026-07-20T04:11:02Z Run actions/runs/222\n225 passed in 9.8s\ncommit abc1234def5678",
    );
    expect(hashToolOutputs([runA])).toBe(hashToolOutputs([runB]));
  });

  it("changes when the substantive result changes", () => {
    const pass = record("read_ci_log", "2026-07-19T10:32:28Z\n225 passed in 12.4s");
    const fail = record("read_ci_log", "2026-07-19T10:32:28Z\n224 passed, 1 failed in 12.4s");
    expect(hashToolOutputs([pass])).not.toBe(hashToolOutputs([fail]));
  });

  it("is order-independent — call order is trajectory, not evidence", () => {
    const a = record("read_file", "contents A");
    const b = record("search_repo", "contents B");
    expect(hashToolOutputs([a, b])).toBe(hashToolOutputs([b, a]));
  });

  it("distinguishes the same output from different tools", () => {
    expect(hashToolOutputs([record("read_file", "x")])).not.toBe(
      hashToolOutputs([record("search_repo", "x")]),
    );
  });

  it("is stable for an empty transcript", () => {
    expect(hashToolOutputs([])).toBe(hashToolOutputs([]));
  });
});
