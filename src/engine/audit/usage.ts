/**
 * What a review cost (OGE-2502).
 *
 * The engine makes many model calls per run — the tool loop runs up to 24
 * iterations per question, ten questions, then at least two verifiers per
 * surviving claim. None of it was recorded, so the unit economics of the
 * product were invisible.
 *
 * ── Two kinds of number, kept apart ─────────────────────────────────────────
 *
 * TOKENS ARE A FACT. Every Messages response carries `usage`, and summing it
 * needs no interpretation.
 *
 * USD IS A DERIVATION. It needs a rate per model, and rates are neither ours
 * nor stable. Blurring the two is how a dashboard ends up showing a confident
 * number that is wrong — so a model with no rate reports its tokens and says
 * the cost is UNKNOWN. Never zero: a zero would sum into a total and quietly
 * understate it, which is the same well-formed-lie shape the rest of this
 * engine is built against.
 */

/** One response's usage, in the four kinds that are priced differently. */
export interface TokenUsage {
  /** Input tokens billed at full rate. */
  uncachedInput: number;
  /** Input written to the cache, billed ABOVE the input rate. */
  cacheWrite: number;
  /** Input served from the cache, billed far below it. */
  cacheRead: number;
  output: number;
  /** Responses counted. */
  calls: number;
  /**
   * Responses that carried no usage at all.
   *
   * Counted rather than ignored, because a total computed over an unknown
   * number of unmeasured calls is a floor, not a sum — and it has to say so.
   */
  unmeasured: number;
}

export const ZERO_USAGE: TokenUsage = {
  uncachedInput: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  calls: 0,
  unmeasured: 0,
};

/** Total input of every kind. Useful for display; never for pricing. */
export function totalInput(usage: TokenUsage): number {
  return usage.uncachedInput + usage.cacheWrite + usage.cacheRead;
}

export function totalTokens(usage: TokenUsage): number {
  return totalInput(usage) + usage.output;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    calls: a.calls + b.calls,
    unmeasured: a.unmeasured + b.unmeasured,
  };
}

/**
 * Read one API response's usage.
 *
 * Total, and deliberately tolerant: a response shape we do not recognise is
 * recorded as UNMEASURED rather than as zero, so it shows up in the total's
 * caveat instead of disappearing into it.
 */
export function usageFromResponse(raw: unknown): TokenUsage {
  const usage = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (typeof usage !== "object" || usage === null) {
    return { ...ZERO_USAGE, calls: 1, unmeasured: 1 };
  }
  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

  return {
    uncachedInput: num(usage["input_tokens"]),
    cacheWrite: num(usage["cache_creation_input_tokens"]),
    cacheRead: num(usage["cache_read_input_tokens"]),
    output: num(usage["output_tokens"]),
    calls: 1,
    unmeasured: 0,
  };
}

/* ── Rates ────────────────────────────────────────────────────────────────── */

/** Dollars per million tokens, by kind. */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

/**
 * The rates a run was priced with, recorded WITH the run.
 *
 * This is the part that keeps history honest. Rates change; if cost were
 * recomputed from a live table, the first repricing would silently rewrite what
 * every past review cost, and nobody would notice because every number would
 * still look well-formed. A run stores the card it used, so its cost is a fact
 * about that run rather than a statement about today's price list.
 *
 * `source` and `retrievedAt` are required for the same reason: a number
 * standing behind a client quote should say where it came from.
 */
export interface RateCard {
  source: string;
  retrievedAt: string;
  rates: Record<string, ModelRate>;
}

/**
 * List prices, retrieved rather than remembered.
 *
 * Deliberately overridable: the rate that matters for a quote is the one on the
 * invoice, which volume terms and prepaid credits can move away from list.
 *
 * Note on cache writes — Anthropic prices a 5-minute write and a 1-hour write
 * differently ($3.75 and $6.00 for this model). The API's
 * `cache_creation_input_tokens` does not say which TTL applied, so this uses
 * the 5-minute rate. That is correct rather than merely a default: the engine
 * marks exactly one breakpoint, in `withCachedPrefix`, and it asks for
 * `ephemeral` — the 5-minute TTL. If a 1-hour breakpoint is ever added, this
 * card starts UNDER-counting silently, because the response cannot tell the
 * two apart. Change the rate in the same commit that changes the TTL.
 */
export const DEFAULT_RATE_CARD: RateCard = {
  source: "platform.claude.com/docs/en/models/sonnet-4-5/overview",
  retrievedAt: "2026-08-26",
  rates: {
    "claude-sonnet-4-5": {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
    },
  },
};

/**
 * Load a rate card from the environment, falling back to list prices.
 *
 * `AUDIT_RATE_CARD` takes a whole card as JSON so an operator can price a run
 * at the rate they are actually billed without editing code.
 */
export function rateCardFromEnv(env: NodeJS.ProcessEnv = process.env): RateCard {
  const raw = env["AUDIT_RATE_CARD"];
  if (!raw) return DEFAULT_RATE_CARD;
  try {
    const parsed = JSON.parse(raw) as RateCard;
    if (typeof parsed?.rates !== "object" || parsed.rates === null) return DEFAULT_RATE_CARD;
    return {
      source: typeof parsed.source === "string" ? parsed.source : "AUDIT_RATE_CARD",
      retrievedAt: typeof parsed.retrievedAt === "string" ? parsed.retrievedAt : "unknown",
      rates: parsed.rates,
    };
  } catch {
    // A malformed card must not silently become list prices for a client quote.
    return { source: "AUDIT_RATE_CARD (unparseable)", retrievedAt: "unknown", rates: {} };
  }
}

export type Cost =
  | { known: true; usd: number }
  | { known: false; reason: string };

/**
 * Price one usage total.
 *
 * Returns UNKNOWN rather than zero when the model has no rate. A zero would
 * sum into a run total and understate it, and an understated cost is worse than
 * an absent one because it looks like an answer.
 */
export function costOf(usage: TokenUsage, model: string, card: RateCard): Cost {
  const rate = card.rates[model];
  if (!rate) {
    return {
      known: false,
      reason: `no rate for "${model}" in the card from ${card.source}`,
    };
  }
  const usd =
    (usage.uncachedInput * rate.inputPerMTok +
      usage.cacheWrite * rate.cacheWritePerMTok +
      usage.cacheRead * rate.cacheReadPerMTok +
      usage.output * rate.outputPerMTok) /
    1_000_000;
  return { known: true, usd };
}

/**
 * What to say about a total that may be incomplete.
 *
 * A run with unmeasured calls has a FLOOR, not a total, and the difference
 * matters when the number is going into a quote.
 */
export function usageCaveat(usage: TokenUsage): string | null {
  if (usage.unmeasured === 0) return null;
  const one = usage.unmeasured === 1;
  return (
    `${usage.unmeasured} of ${usage.calls} model call${usage.calls === 1 ? "" : "s"} ` +
    `reported no usage, so ${one ? "this total is" : "these totals are"} a floor rather than a sum.`
  );
}

/* ── The meter ────────────────────────────────────────────────────────────── */

/**
 * Accumulates usage per stage.
 *
 * Per stage rather than only per run because `investigate` and `verify` are
 * separately tunable, and verification is a deliberate cost the product's
 * confidence claim rests on. Folded into one total it looks like overhead;
 * shown as its own line it is the thing being paid for.
 */
export class UsageMeter {
  private readonly stages = new Map<string, TokenUsage>();
  private stage = "investigate";

  /** Attribute everything recorded from now on to this stage. */
  enter(stage: string): void {
    this.stage = stage;
  }

  record(response: unknown): void {
    const usage = usageFromResponse(response);
    this.stages.set(this.stage, addUsage(this.stages.get(this.stage) ?? ZERO_USAGE, usage));
  }

  forStage(stage: string): TokenUsage {
    return this.stages.get(stage) ?? ZERO_USAGE;
  }

  byStage(): Record<string, TokenUsage> {
    return Object.fromEntries(this.stages);
  }

  total(): TokenUsage {
    return [...this.stages.values()].reduce(addUsage, ZERO_USAGE);
  }
}

/** The shape written to disk and sent to the operator surface. */
export interface UsageReport {
  model: string;
  card: RateCard;
  byStage: Record<string, TokenUsage>;
  total: TokenUsage;
  /** Null when the model has no rate — never zero. */
  totalUsd: number | null;
  costUnknownReason: string | null;
  caveat: string | null;
}

export function buildUsageReport(meter: UsageMeter, model: string, card: RateCard): UsageReport {
  const total = meter.total();
  const cost = costOf(total, model, card);
  return {
    model,
    card,
    byStage: meter.byStage(),
    total,
    totalUsd: cost.known ? cost.usd : null,
    costUnknownReason: cost.known ? null : cost.reason,
    caveat: usageCaveat(total),
  };
}

/**
 * The operator-facing summary.
 *
 * The three kinds of input are shown apart rather than folded into one figure,
 * because they are priced an order of magnitude apart — two runs doing
 * identical work can differ several-fold on cost depending only on cache hits,
 * and a single "input" number hides the one lever worth pulling.
 *
 * Writes are shown next to reads on purpose. A write is billed ABOVE the input
 * rate, so caching only pays once reads outnumber it; a stage showing writes
 * and no reads is a breakpoint on a prefix that keeps changing, which costs
 * more than not caching at all. Folded together the two are indistinguishable.
 */
export function renderUsage(report: UsageReport, loc?: number): string[] {
  const n = (value: number): string => value.toLocaleString();
  const lines = [`  cost of this run (model ${report.model})`];

  for (const [stage, usage] of Object.entries(report.byStage)) {
    lines.push(
      `    ${stage.padEnd(12)} ${n(usage.calls).padStart(4)} call(s)  ` +
        `in ${n(usage.uncachedInput)} · cache w${n(usage.cacheWrite)}/r${n(usage.cacheRead)} · ` +
        `out ${n(usage.output)}`,
    );
  }

  const t = report.total;
  lines.push(
    `    ${"total".padEnd(12)} ${n(t.calls).padStart(4)} call(s)  ` +
      `${n(totalTokens(t))} tokens`,
  );

  if (report.totalUsd === null) {
    // Never a zero. An absent price is absent, not free.
    lines.push(`    cost         unknown — ${report.costUnknownReason}`);
  } else {
    lines.push(`    cost         US$${report.totalUsd.toFixed(4)}  (rates: ${report.card.source}, ${report.card.retrievedAt})`);
    if (loc && loc > 0) {
      lines.push(`                 US$${((report.totalUsd / loc) * 1000).toFixed(4)} per 1,000 lines of subject`);
    }
  }

  if (report.caveat) lines.push(`    ! ${report.caveat}`);
  return lines;
}
