/**
 * Defect injection + judge-bias protocol (OGE-1589).
 */

import { describe, expect, it } from "vitest";

import { injectDefect } from "../../src/eval/inject.js";
import { judgePair, type PairChoice } from "../../src/eval/judge.js";
import type { EvalFixture } from "../../src/eval/fixture.js";

function baseFixture(): EvalFixture {
  return {
    name: "base",
    description: "d",
    origin: "snapshot",
    pr: {
      owner: "o", repo: "r", number: 1, headSha: "sha", headRef: "oge-1-x",
      title: "t", body: "## UAT checklist\n\n- [ ] a\n- [ ] b", author: "u",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ticket: { identifier: "OGE-1", id: "u", title: "t", description: "d", status: "In Review", url: "https://linear.app/x" },
    diff: "diff --git a/x b/x\n+ y\n",
    modelResponse: JSON.stringify({
      items: [
        { id: 1, itemText: "a", status: "PASS", rationale: "ok", evidenceRefs: [] },
        { id: 2, itemText: "b", status: "PASS", rationale: "ok", evidenceRefs: [] },
      ],
      summary: "s",
    }),
    expected: { items: [{ id: 1, status: "PASS" }, { id: 2, status: "PASS" }], overall: "PASS" },
  };
}

describe("injectDefect", () => {
  it("mints a labeled FAIL against the target item and recomputes the overall", () => {
    const injected = injectDefect({ base: baseFixture(), targetItemId: 2 });
    expect(injected.origin).toBe("injected");
    expect(injected.expected.items.find((i) => i.id === 2)!.status).toBe("FAIL");
    expect(injected.expected.overall).toBe("NEEDS_WORK");
    // The corruption is visible in the diff, so the fixture is self-documenting.
    expect(injected.diff).toContain("defect-injected");
    // The recorded response now marks the target FAIL.
    const resp = JSON.parse(injected.modelResponse);
    expect(resp.items.find((i: { id: number }) => i.id === 2).status).toBe("FAIL");
  });

  it("throws rather than silently mislabel when the target item is absent", () => {
    expect(() => injectDefect({ base: baseFixture(), targetItemId: 99 })).toThrow(/not found/);
  });
});

describe("judgePair — order-swap de-biasing", () => {
  /** A judge that always prefers whichever rationale is presented first. */
  const positionBiased = async (): Promise<PairChoice> => "A";

  it("scores a position-biased judge as a tie (its disagreement is bias, not preference)", async () => {
    const v = await judgePair("candidate-a", "candidate-b", positionBiased);
    expect(v.result).toBe("tie");
    expect(v.disagreed).toBe(true);
  });

  it("awards a win only when both orders agree", async () => {
    // A genuine preference for A: picks A first, and picks the second (A) when
    // A is presented second.
    const prefersA = async (first: string): Promise<PairChoice> =>
      first === "candidate-a" ? "A" : "B";
    const v = await judgePair("candidate-a", "candidate-b", prefersA);
    expect(v.result).toBe("A");
    expect(v.disagreed).toBe(false);
  });

  it("honors an explicit tie without calling it a disagreement", async () => {
    const alwaysTie = async (): Promise<PairChoice> => "tie";
    const v = await judgePair("a", "b", alwaysTie);
    expect(v.result).toBe("tie");
    expect(v.disagreed).toBe(false);
  });
});
