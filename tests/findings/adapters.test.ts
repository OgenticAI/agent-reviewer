/**
 * Analyzer-output adapters (OGE-1588).
 *
 * The property under test throughout: **parse, never execute.** Every input
 * here is text CI already produced; no adapter runs a tool or reads a config.
 * The adapters are also total — malformed input returns null, so one bad
 * artifact can't take down ingestion of the others.
 */

import { describe, expect, it } from "vitest";

import {
  eslintAdapter,
  junitAdapter,
  parseAnyFindings,
  tscAdapter,
} from "../../src/findings/adapters.js";

describe("eslintAdapter", () => {
  const raw = JSON.stringify([
    {
      filePath: "/home/runner/work/repo/repo/src/redact.ts",
      messages: [
        { ruleId: "no-unused-vars", severity: 2, message: "'x' is defined but never used.", line: 5, column: 7 },
        { ruleId: "eqeqeq", severity: 1, message: "Expected '==='.", line: 9, column: 1 },
      ],
    },
    { filePath: "/home/runner/work/repo/repo/src/clean.ts", messages: [] },
  ]);

  it("normalizes eslint JSON to findings with severity and code", () => {
    const findings = eslintAdapter.parse(raw)!;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      path: "src/redact.ts",
      severity: "error",
      source: "eslint",
      code: "no-unused-vars",
      position: { line: 5, column: 7 },
    });
    expect(findings[1]!.severity).toBe("warning");
  });

  it("relativizes the doubled-repo CI checkout path", () => {
    expect(eslintAdapter.parse(raw)![0]!.path).toBe("src/redact.ts");
  });

  it("returns null for JSON that isn't eslint's shape", () => {
    expect(eslintAdapter.parse(JSON.stringify([{ foo: 1 }]))).toBeNull();
    expect(eslintAdapter.parse("not json")).toBeNull();
  });
});

describe("tscAdapter", () => {
  const raw = [
    "src/config.ts(12,3): error TS2345: Argument of type 'x' is not assignable.",
    "some unrelated build log line",
    "src/review.ts(88,10): error TS2339: Property 'foo' does not exist.",
  ].join("\n");

  it("parses tsc console diagnostics with code and position", () => {
    const findings = tscAdapter.parse(raw)!;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      path: "src/config.ts",
      position: { line: 12, column: 3 },
      code: "TS2345",
      severity: "error",
      source: "tsc",
    });
  });

  it("returns null (not empty) when no tsc line is present — that isn't its output", () => {
    // Distinguishing "not mine" from "clean" is the point: a false all-clear
    // would let the model read absence as green.
    expect(tscAdapter.parse("just some logs\nnothing here")).toBeNull();
  });
});

describe("junitAdapter", () => {
  const raw = `<?xml version="1.0"?>
<testsuite name="redaction" tests="3" failures="1">
  <testcase classname="RedactionTest" name="round_trips" file="tests/redact_test.py" time="0.01"/>
  <testcase classname="RedactionTest" name="masks_ssn" file="tests/redact_test.py" time="0.02">
    <failure message="AssertionError: SSN leaked">Traceback...\n  assert masked</failure>
  </testcase>
</testsuite>`;

  it("emits a finding only for failing test cases", () => {
    const findings = junitAdapter.parse(raw)!;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "tests/redact_test.py",
      severity: "error",
      source: "junit",
      message: "AssertionError: SSN leaked",
    });
    expect(findings[0]!.code).toContain("masks_ssn");
  });

  it("returns null when there is no testcase element", () => {
    expect(junitAdapter.parse("<other>xml</other>")).toBeNull();
  });

  it("decodes XML entities in the failure message", () => {
    const xml = `<testsuite><testcase name="t"><failure message="expected &lt;a&gt; &amp; &quot;b&quot;">x</failure></testcase></testsuite>`;
    expect(junitAdapter.parse(xml)![0]!.message).toBe('expected <a> & "b"');
  });
});

describe("parseAnyFindings", () => {
  it("routes text to the first adapter that recognizes it", () => {
    const eslint = parseAnyFindings(
      JSON.stringify([{ filePath: "/x/src/a.ts", messages: [{ ruleId: null, severity: 2, message: "m", line: 1 }] }]),
    );
    expect(eslint?.[0]!.source).toBe("eslint");
  });

  it("returns null when no adapter recognizes the text", () => {
    expect(parseAnyFindings("a plain build log with nothing structured")).toBeNull();
  });
});
