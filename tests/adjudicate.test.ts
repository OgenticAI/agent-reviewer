/**
 * Second-pass adjudication of punts (OGE-1587).
 *
 * The asymmetry these tests protect: the adjudicator may only ever *reduce*
 * the punt count by finding evidence. Every ambiguous path — API error,
 * unparseable reply, low confidence, missing status — keeps the original punt.
 * A second pass that can manufacture a PASS out of silence would turn a
 * falling punt rate into a lie, which is worse than the punts it removes.
 */

import { describe, expect, it, vi } from "vitest";

import {
  adjudicateVerdict,
  ADJUDICATION_CONFIDENCE_FLOOR,
  buildAdjudicationPrompt,
  type AdjudicatorModel,
} from "../src/adjudicate.js";
import { ReviewVerdict, type VerdictStatus } from "../src/schema/verdict.js";
import type { ToolCallRecord } from "../src/tools/loop.js";

const PR_BODY = [
  "Closes [OGE-308](https://linear.app/ogenticai/issue/OGE-308).",
  "",
  "## UAT checklist",
  "",
  "- [ ] `redact()` round-trips across all profiles", // 1 — ordinary
  "- [ ] Merge the PR once CI is green", // 2 — post-merge, legitimately human
  "- [ ] [human] Clinician confirms the categories", // 3 — declared human
  "",
].join("\n");

function verdictWith(statuses: VerdictStatus[]): ReviewVerdict {
  return ReviewVerdict.parse({
    schemaVersion: 1,
    reviewerVersion: "v4",
    ticketId: "OGE-308",
    prRef: "x/y#1",
    headSha: "abc1234",
    items: statuses.map((status, i) => ({
      id: i + 1,
      itemText: `item ${i + 1}`,
      status,
      rationale: "could not tell",
      evidenceRefs: [],
      ...(i === 2 ? { human: true } : {}),
    })),
    summary: "s",
    generatedAt: "2026-04-27T08:30:00.000Z",
  });
}

const TRANSCRIPT: ToolCallRecord[] = [
  { name: "read_file", input: {}, result: "export function redact() {}", isError: false, durationMs: 3 },
];

function model(reply: string | (() => never)): AdjudicatorModel {
  return {
    adjudicate: vi.fn(async () => {
      if (typeof reply === "function") reply();
      return reply as string;
    }),
  };
}

const OVERTURN = JSON.stringify({
  keepPunt: false,
  revisedStatus: "CODE_VERIFIED",
  confidence: 0.9,
  reason: "the read shows the function exists",
});

describe("adjudicateVerdict — cost control", () => {
  it("spends nothing when there are no punts", async () => {
    const m = model(OVERTURN);
    const r = await adjudicateVerdict({
      verdict: verdictWith(["PASS", "PASS", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: m,
    });
    expect(m.adjudicate).not.toHaveBeenCalled();
    expect(r.outcomes).toEqual([]);
  });

  it("does not challenge a punt the linter says is legitimately human", async () => {
    // "Merge the PR once CI is green" is post-merge — a person owns it, and
    // pressuring the model to un-punt it would be actively wrong.
    const m = model(OVERTURN);
    const r = await adjudicateVerdict({
      verdict: verdictWith(["PASS", "UNVERIFIABLE", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: m,
    });
    expect(m.adjudicate).not.toHaveBeenCalled();
    expect(r.outcomes[0]!.spentCall).toBe(false);
    expect(r.puntsAfter).toBe(1);
  });

  it("does not challenge a [human]-marked punt", async () => {
    const m = model(OVERTURN);
    await adjudicateVerdict({
      verdict: verdictWith(["PASS", "PASS", "UNVERIFIABLE"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: m,
    });
    expect(m.adjudicate).not.toHaveBeenCalled();
  });
});

describe("adjudicateVerdict — overturning", () => {
  it("overturns a hedged punt when the evidence settles it", async () => {
    const r = await adjudicateVerdict({
      verdict: verdictWith(["UNVERIFIABLE", "PASS", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(OVERTURN),
    });
    expect(r.puntsBefore).toBe(1);
    expect(r.puntsAfter).toBe(0);
    expect(r.verdict.items[0]!.status).toBe("CODE_VERIFIED");
    expect(r.verdict.items[0]!.rationale).toMatch(/\[adjudicated:/);
  });

  it("leaves untouched items exactly as they were", async () => {
    const before = verdictWith(["UNVERIFIABLE", "PASS", "PASS"]);
    const r = await adjudicateVerdict({
      verdict: before,
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(OVERTURN),
    });
    expect(r.verdict.items[1]).toEqual(before.items[1]);
  });

  it("does not mutate the input verdict", async () => {
    const before = verdictWith(["UNVERIFIABLE", "PASS", "PASS"]);
    await adjudicateVerdict({
      verdict: before,
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(OVERTURN),
    });
    expect(before.items[0]!.status).toBe("UNVERIFIABLE");
  });
});

describe("adjudicateVerdict — every ambiguous path keeps the punt", () => {
  async function run(reply: string | (() => never)) {
    return adjudicateVerdict({
      verdict: verdictWith(["UNVERIFIABLE", "PASS", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(reply),
    });
  }

  it("keeps the punt when the adjudicator agrees it is undecidable", async () => {
    const r = await run(JSON.stringify({ keepPunt: true, reason: "no evidence either way" }));
    expect(r.puntsAfter).toBe(1);
    expect(r.outcomes[0]!.reason).toMatch(/no evidence/);
  });

  it("fails open on an API error", async () => {
    const r = await run(() => {
      throw new Error("429 rate limited");
    });
    expect(r.puntsAfter).toBe(1);
    expect(r.outcomes[0]!.reason).toMatch(/adjudicator unavailable/);
  });

  it("keeps the punt on an unparseable reply", async () => {
    const r = await run("I think it's probably fine?");
    expect(r.puntsAfter).toBe(1);
    expect(r.outcomes[0]!.reason).toMatch(/unparseable/);
  });

  it("keeps the punt below the confidence floor", async () => {
    const r = await run(
      JSON.stringify({
        keepPunt: false,
        revisedStatus: "PASS",
        confidence: ADJUDICATION_CONFIDENCE_FLOOR - 0.01,
        reason: "maybe",
      }),
    );
    expect(r.puntsAfter).toBe(1);
    expect(r.outcomes[0]!.reason).toMatch(/confidence floor/);
  });

  it("keeps the punt when confidence is omitted entirely", async () => {
    const r = await run(JSON.stringify({ keepPunt: false, revisedStatus: "PASS" }));
    expect(r.puntsAfter).toBe(1);
  });

  it("keeps the punt on an invalid revised status", async () => {
    const r = await run(
      JSON.stringify({ keepPunt: false, revisedStatus: "PROBABLY", confidence: 0.99 }),
    );
    expect(r.puntsAfter).toBe(1);
  });

  it("keeps the punt when the adjudicator 'overturns' it to UNVERIFIABLE", async () => {
    const r = await run(
      JSON.stringify({ keepPunt: false, revisedStatus: "UNVERIFIABLE", confidence: 0.99 }),
    );
    expect(r.puntsAfter).toBe(1);
  });

  it("can never increase the punt count", async () => {
    const r = await run(JSON.stringify({ keepPunt: true }));
    expect(r.puntsAfter).toBeLessThanOrEqual(r.puntsBefore);
  });
});

describe("buildAdjudicationPrompt", () => {
  it("carries the item, the rationale, and the gathered observations", () => {
    // Greptile measured bare self-scoring as "nearly random" — the evidence
    // is what makes this call meaningfully different from re-asking.
    const p = buildAdjudicationPrompt({
      item: verdictWith(["UNVERIFIABLE"]).items[0]!,
      transcript: TRANSCRIPT,
    });
    expect(p).toContain("item 1");
    expect(p).toContain("could not tell");
    expect(p).toContain("export function redact()");
  });

  it("says so explicitly when no observations were gathered", () => {
    const p = buildAdjudicationPrompt({
      item: verdictWith(["UNVERIFIABLE"]).items[0]!,
      transcript: [],
    });
    expect(p).toMatch(/gathered no tool observations/);
  });
});

describe("the adjudicated flag (OGE-1587)", () => {
  const KEEP = JSON.stringify({ keepPunt: true, reason: "genuinely undecidable" });

  it("marks an overturned item", async () => {
    const r = await adjudicateVerdict({
      verdict: verdictWith(["UNVERIFIABLE", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(OVERTURN),
    });
    expect(r.verdict.items[0]!.adjudicated).toBe(true);
  });

  it("marks a punt it looked at and stood by — distinct from never looking", async () => {
    const r = await adjudicateVerdict({
      verdict: verdictWith(["UNVERIFIABLE", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(KEEP),
    });
    expect(r.verdict.items[0]!.status).toBe("UNVERIFIABLE");
    expect(r.verdict.items[0]!.adjudicated).toBe(true);
  });

  it("does NOT mark an item it never challenged (no call spent)", async () => {
    // Index 2 carries the [human] marker, so the hard rules skip it entirely.
    const r = await adjudicateVerdict({
      verdict: verdictWith(["PASS", "PASS", "UNVERIFIABLE"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(OVERTURN),
    });
    expect(r.verdict.items[2]!.human).toBe(true);
    expect(r.verdict.items[2]!.adjudicated).toBeUndefined();
  });

  it("leaves unchallenged non-punt items unmarked", async () => {
    const r = await adjudicateVerdict({
      verdict: verdictWith(["UNVERIFIABLE", "PASS"]),
      transcript: TRANSCRIPT,
      prBody: PR_BODY,
      model: model(OVERTURN),
    });
    expect(r.verdict.items[1]!.adjudicated).toBeUndefined();
  });
});
