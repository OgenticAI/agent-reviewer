import { describe, it, expect } from "vitest";

import {
  UsageMeter,
  ZERO_USAGE,
  addUsage,
  buildUsageReport,
  costOf,
  DEFAULT_RATE_CARD,
  rateCardFromEnv,
  renderUsage,
  totalTokens,
  usageCaveat,
  usageFromResponse,
  type RateCard,
} from "../../src/engine/audit/usage.js";

const reply = (u: Record<string, number>) => ({ content: [], usage: u });

/* ── Tokens are a fact ────────────────────────────────────────────────────── */

describe("reading usage off a response", () => {
  it("keeps the four kinds apart, because they are priced apart", () => {
    const u = usageFromResponse(
      reply({
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 5000,
        output_tokens: 50,
      }),
    );
    expect(u).toMatchObject({ uncachedInput: 100, cacheWrite: 20, cacheRead: 5000, output: 50 });
    expect(u.calls).toBe(1);
    expect(u.unmeasured).toBe(0);
  });

  // A response we cannot read is recorded as UNMEASURED, never as zero — a zero
  // sums into the total and silently understates it.
  it.each([null, undefined, {}, { usage: null }, { usage: "nope" }])(
    "counts an unreadable response as unmeasured: %s",
    (raw) => {
      const u = usageFromResponse(raw);
      expect(u.calls).toBe(1);
      expect(u.unmeasured).toBe(1);
      expect(totalTokens(u)).toBe(0);
    },
  );

  it("ignores a negative or non-numeric field rather than trusting it", () => {
    const u = usageFromResponse(reply({ input_tokens: -5, output_tokens: Number.NaN }));
    expect(u.uncachedInput).toBe(0);
    expect(u.output).toBe(0);
    expect(u.unmeasured).toBe(0);
  });
});

/* ── USD is a derivation ──────────────────────────────────────────────────── */

describe("pricing", () => {
  const card = DEFAULT_RATE_CARD;
  const M = 1_000_000;

  it("prices each kind at its own rate", () => {
    const cost = costOf(
      { ...ZERO_USAGE, uncachedInput: M, output: M, cacheRead: M, cacheWrite: M, calls: 1 },
      "claude-sonnet-4-5",
      card,
    );
    // 3 + 15 + 0.30 + 3.75
    expect(cost.known && cost.usd).toBeCloseTo(22.05, 6);
  });

  // The whole reason cache reads are tracked separately: an order of magnitude.
  it("prices a cache read far below an uncached input token", () => {
    const cached = costOf({ ...ZERO_USAGE, cacheRead: M, calls: 1 }, "claude-sonnet-4-5", card);
    const fresh = costOf({ ...ZERO_USAGE, uncachedInput: M, calls: 1 }, "claude-sonnet-4-5", card);
    expect(cached.known && fresh.known && fresh.usd / cached.usd).toBeCloseTo(10, 6);
  });

  // An absent price is absent, not free. A zero would sum into a run total.
  it("reports UNKNOWN, never zero, for a model with no rate", () => {
    const cost = costOf({ ...ZERO_USAGE, output: M, calls: 1 }, "some-other-model", card);
    expect(cost.known).toBe(false);
    expect(cost.known === false && cost.reason).toMatch(/no rate for "some-other-model"/);
  });

  it("a zero-token run is genuinely zero, not unknown", () => {
    const cost = costOf(ZERO_USAGE, "claude-sonnet-4-5", card);
    expect(cost.known && cost.usd).toBe(0);
  });
});

/* ── The card is recorded, so history cannot be rewritten ─────────────────── */

describe("the rate card", () => {
  it("says where its numbers came from and when", () => {
    expect(DEFAULT_RATE_CARD.source).toMatch(/claude\.com/);
    expect(DEFAULT_RATE_CARD.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is carried on the report, so a later price change cannot rewrite it", () => {
    const meter = new UsageMeter();
    meter.record(reply({ input_tokens: 10, output_tokens: 10 }));
    const report = buildUsageReport(meter, "claude-sonnet-4-5", DEFAULT_RATE_CARD);
    expect(report.card).toEqual(DEFAULT_RATE_CARD);
  });

  it("can be overridden, because the rate that matters is the invoiced one", () => {
    const custom: RateCard = {
      source: "our contract",
      retrievedAt: "2026-08-26",
      rates: { "claude-sonnet-4-5": { inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 1, cacheReadPerMTok: 0 } },
    };
    const loaded = rateCardFromEnv({ AUDIT_RATE_CARD: JSON.stringify(custom) } as NodeJS.ProcessEnv);
    expect(loaded.rates["claude-sonnet-4-5"]?.outputPerMTok).toBe(2);
  });

  // Silently falling back to list prices would put an unintended number behind
  // a client quote.
  it("does not fall back to list prices when the override is malformed", () => {
    const loaded = rateCardFromEnv({ AUDIT_RATE_CARD: "{not json" } as NodeJS.ProcessEnv);
    expect(loaded.rates).toEqual({});
    expect(loaded.source).toMatch(/unparseable/);
    expect(costOf({ ...ZERO_USAGE, output: 10, calls: 1 }, "claude-sonnet-4-5", loaded).known).toBe(false);
  });

  it("uses list prices when nothing is set", () => {
    expect(rateCardFromEnv({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_RATE_CARD);
  });
});

/* ── Per stage, because verification is the thing being paid for ──────────── */

describe("the meter", () => {
  it("attributes calls to the stage that made them", () => {
    const meter = new UsageMeter();
    meter.enter("investigate");
    meter.record(reply({ input_tokens: 100, output_tokens: 10 }));
    meter.enter("verify");
    meter.record(reply({ input_tokens: 5, output_tokens: 1 }));
    meter.record(reply({ input_tokens: 5, output_tokens: 1 }));

    expect(meter.forStage("investigate").calls).toBe(1);
    expect(meter.forStage("verify").calls).toBe(2);
    expect(meter.total().uncachedInput).toBe(110);
  });

  it("counts every tool-loop iteration, not one per question", () => {
    const meter = new UsageMeter();
    for (let i = 0; i < 24; i++) meter.record(reply({ input_tokens: 10, output_tokens: 1 }));
    expect(meter.total().calls).toBe(24);
  });

  it("adds cleanly", () => {
    const a = usageFromResponse(reply({ input_tokens: 1, output_tokens: 2 }));
    expect(addUsage(a, a).calls).toBe(2);
    expect(addUsage(a, ZERO_USAGE)).toEqual(a);
  });
});

/* ── A floor is not a total ───────────────────────────────────────────────── */

describe("an incomplete total", () => {
  it("says it is a floor when a call went unmeasured", () => {
    const meter = new UsageMeter();
    meter.record(reply({ input_tokens: 10, output_tokens: 1 }));
    meter.record(null);
    const caveat = usageCaveat(meter.total());
    expect(caveat).toMatch(/1 of 2 model calls reported no usage/);
    expect(caveat).toMatch(/floor rather than a sum/);
  });

  it("says nothing when every call was measured", () => {
    const meter = new UsageMeter();
    meter.record(reply({ input_tokens: 10, output_tokens: 1 }));
    expect(usageCaveat(meter.total())).toBeNull();
  });
});

/* ── What the operator reads ──────────────────────────────────────────────── */

describe("the summary", () => {
  const meter = () => {
    const m = new UsageMeter();
    m.enter("investigate");
    m.record(reply({ input_tokens: 1_000_000, output_tokens: 100_000 }));
    m.enter("verify");
    m.record(reply({ input_tokens: 500_000, output_tokens: 50_000 }));
    return m;
  };

  it("shows each stage separately, so verification is visible as its own cost", () => {
    const out = renderUsage(buildUsageReport(meter(), "claude-sonnet-4-5", DEFAULT_RATE_CARD)).join("\n");
    expect(out).toMatch(/investigate/);
    expect(out).toMatch(/verify/);
  });

  it("names the rates it used", () => {
    const out = renderUsage(buildUsageReport(meter(), "claude-sonnet-4-5", DEFAULT_RATE_CARD)).join("\n");
    expect(out).toMatch(/rates: platform\.claude\.com/);
  });

  it("gives cost per 1,000 lines, which is what makes a quote defensible", () => {
    const out = renderUsage(buildUsageReport(meter(), "claude-sonnet-4-5", DEFAULT_RATE_CARD), 137_735).join("\n");
    expect(out).toMatch(/per 1,000 lines of subject/);
  });

  // The display must never render an unknown cost as $0.00.
  it("prints unknown rather than a dollar figure when there is no rate", () => {
    const out = renderUsage(buildUsageReport(meter(), "mystery-model", DEFAULT_RATE_CARD)).join("\n");
    expect(out).toMatch(/cost\s+unknown/);
    expect(out).not.toMatch(/US\$0\.0000/);
  });
});
