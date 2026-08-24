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
