/**
 * The investigation iteration cap.
 *
 * The cap is not a style preference, it decides whether a paid run publishes
 * anything. On 2026-09-03 every question of two separate audits exhausted the
 * old cap of 24, answered from `askForTheAnswer` with tools withheld, and had
 * its recalled line numbers rejected by `checkAnchors` as fabricated. One of
 * those runs cost US$39.20 and published zero findings.
 *
 * These tests pin the two properties that failure depended on: the default is
 * well clear of the wall it hit, and a junk env value can never quietly lower
 * it. The numbers are written out rather than imported from the source, so a
 * change to the default has to be made here on purpose — importing the constant
 * would let it be edited to 1 with the suite still green.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUDIT_TOOL_ITERATIONS,
  MAX_TOOL_ITERATIONS,
  readIterationCap,
} from "../../src/audit-model.js";

const ORIGINAL = process.env.AUDIT_MAX_TOOL_ITERATIONS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AUDIT_MAX_TOOL_ITERATIONS;
  else process.env.AUDIT_MAX_TOOL_ITERATIONS = ORIGINAL;
});

describe("the investigation iteration cap", () => {
  it("defaults well above the 24 that every question exhausted", () => {
    // Not `> 24`: 25 would pass such a test and buy one extra turn on a
    // question that needed the budget doubled.
    expect(DEFAULT_AUDIT_TOOL_ITERATIONS).toBe(48);
  });

  it("uses the default when the variable is unset", () => {
    expect(readIterationCap(undefined)).toBe(48);
  });

  it("uses the default for an empty or blank value", () => {
    // `Number("")` is 0, which would cap investigation at zero turns and report
    // the resulting empty audit as a finished one.
    expect(readIterationCap("")).toBe(48);
    expect(readIterationCap("   ")).toBe(48);
  });

  it("uses the default rather than NaN for junk", () => {
    expect(readIterationCap("12abc")).toBe(48);
    expect(readIterationCap("many")).toBe(48);
  });

  it("refuses zero and negatives instead of coercing them", () => {
    expect(readIterationCap("0")).toBe(48);
    expect(readIterationCap("-5")).toBe(48);
  });

  it("refuses a fraction, which would make the loop condition unreadable", () => {
    expect(readIterationCap("12.5")).toBe(48);
  });

  it("honours a deliberate override, up and down", () => {
    // Down is allowed on purpose: an operator narrowing the budget for a cheap
    // probe is a real thing to want, and it is distinguishable from junk.
    expect(readIterationCap("96")).toBe(96);
    expect(readIterationCap("8")).toBe(8);
    expect(readIterationCap(" 64 ")).toBe(64);
  });

  it("exports a usable cap at module load", () => {
    // The constant is initialised by calling `readIterationCap` at module
    // scope. Declared in the wrong order that call reads a `const` in its
    // temporal dead zone and importing the module throws, so asserting the
    // value here is what catches the reordering.
    expect(Number.isInteger(MAX_TOOL_ITERATIONS)).toBe(true);
    expect(MAX_TOOL_ITERATIONS).toBeGreaterThan(0);
  });
});
