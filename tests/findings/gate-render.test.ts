/**
 * The findings gate + established-facts rendering (OGE-1588).
 *
 * The gate is deterministic and independent of any LLM verdict — that
 * independence is the point: "tsc reported 3 errors" is not a matter of
 * opinion the model gets to overrule. The renderer's job is to state findings,
 * AND the verified absence of findings, so the model never reads a clean run
 * as missing evidence.
 */

import { describe, expect, it } from "vitest";

import { gateFindings, parseFailLevel } from "../../src/engine/findings/gate.js";
import { renderFindingsSection } from "../../src/engine/findings/render.js";
import type { JobFindings } from "../../src/engine/findings/schema.js";

const withError: JobFindings = {
  job: "lint",
  parsed: true,
  findings: [
    { path: "src/a.ts", message: "unused", severity: "error", source: "eslint", code: "no-unused-vars" },
    { path: "src/b.ts", message: "prefer ===", severity: "warning", source: "eslint" },
  ],
};
const cleanJob: JobFindings = { job: "typecheck", parsed: true, findings: [] };

describe("gateFindings", () => {
  it("is off by default — findings never gate until a repo opts in", () => {
    const r = gateFindings([withError], "off");
    expect(r.failed).toBe(false);
  });

  it("fails at the configured severity", () => {
    const r = gateFindings([withError], "error");
    expect(r.failed).toBe(true);
    expect(r.offending).toHaveLength(1);
    expect(r.reason).toMatch(/1 finding\(s\) at or above error/);
  });

  it("counts a lower threshold's findings too", () => {
    const r = gateFindings([withError], "warning");
    expect(r.offending).toHaveLength(2);
  });

  it("passes when nothing meets the threshold", () => {
    const r = gateFindings([cleanJob], "error");
    expect(r.failed).toBe(false);
    expect(r.reason).toMatch(/no findings at or above error/);
  });
});

describe("parseFailLevel", () => {
  it("accepts the three severities", () => {
    expect(parseFailLevel("error")).toBe("error");
    expect(parseFailLevel("WARNING")).toBe("warning");
    expect(parseFailLevel("info")).toBe("info");
  });
  it("treats anything else as off", () => {
    expect(parseFailLevel(undefined)).toBe("off");
    expect(parseFailLevel("nonsense")).toBe("off");
    expect(parseFailLevel("")).toBe("off");
  });
});

describe("renderFindingsSection", () => {
  it("states findings AND per-job verified absence", () => {
    const section = renderFindingsSection([withError, cleanJob])!;
    expect(section).toContain("Established facts from analyzers");
    expect(section).toContain("lint — 2 finding(s)");
    expect(section).toContain("ERROR src/a.ts");
    // The clean job is a positive fact, stated as such.
    expect(section).toContain("typecheck — reported no findings");
  });

  it("returns null when nothing was recognized — a byte-identical no-op prompt", () => {
    expect(renderFindingsSection([])).toBeNull();
    expect(renderFindingsSection([{ job: "x", parsed: false, findings: [] }])).toBeNull();
  });

  it("fences the section as untrusted (an analyzer message can echo attacker text)", () => {
    const section = renderFindingsSection([withError])!;
    expect(section).toMatch(/<untrusted[^>]*source="analyzer-findings"/);
  });
});
