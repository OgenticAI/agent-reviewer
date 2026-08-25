import { describe, it, expect } from "vitest";
import { excerptForRetry } from "../src/review.js";

describe("quoting a rejected response back to the model", () => {
  it("sends a short response whole", () => {
    expect(excerptForRetry('{"items":[]}')).toBe('{"items":[]}');
  });

  // The two failure shapes live at opposite ends: a forbidden preamble at the
  // front, truncation and an unterminated array at the back. Keeping one end
  // would routinely cut away the evidence.
  it("keeps both ends of a long one, and says what it dropped", () => {
    const long = `HEAD${"x".repeat(5000)}TAIL`;
    const out = excerptForRetry(long, 100);

    expect(out).toContain("HEAD");
    expect(out).toContain("TAIL");
    expect(out).toMatch(/\[\d+ characters omitted\]/);
    expect(out.length).toBeLessThan(long.length);
  });

  it("does not truncate at exactly the limit", () => {
    const exact = "y".repeat(100);
    expect(excerptForRetry(exact, 100)).toBe(exact);
  });
});

describe("the excerpt is bounded at both ends", () => {
  // slice(-0) returns the whole string, not the empty one. At headRatio 0 the
  // naive arithmetic silently returned the entire input — the opposite of
  // what a character budget is for.
  it("returns a tail-only excerpt at headRatio 0, not the whole input", () => {
    const long = `HEAD${"x".repeat(500)}TAIL`;
    const out = excerptForRetry(long, 20, 0);

    expect(out).toContain("TAIL");
    expect(out).not.toContain("HEAD");
    expect(out.length).toBeLessThan(long.length);
  });

  it("returns a head-only excerpt at headRatio 1", () => {
    const long = `HEAD${"x".repeat(500)}TAIL`;
    const out = excerptForRetry(long, 20, 1);

    expect(out).toContain("HEAD");
    expect(out).not.toContain("TAIL");
  });

  it("keeps the quoted text within the budget, elision aside", () => {
    const long = "y".repeat(5000);
    for (const limit of [10, 100, 2000]) {
      const quoted = excerptForRetry(long, limit).replace(/\n\n\.\.\. \[\d+ characters omitted\] \.\.\.\n\n/, "");
      expect(quoted.length).toBeLessThanOrEqual(limit);
    }
  });
});
