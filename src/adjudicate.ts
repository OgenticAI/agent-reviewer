/**
 * Second-pass adjudication of UNVERIFIABLE verdicts (OGE-1587).
 *
 * Punts currently post unchallenged. A share of them are "probably fine but I
 * hedged", or items decidable from evidence the tool loop already gathered —
 * and the same single call both generates and judges its own verdicts, which
 * Qodo's self-reflection docs state models do badly in one pass.
 *
 * ── Why this is not just "ask the model again" ──────────────────────────────
 *
 * Greptile measured bare LLM self-scoring of review comments as **"nearly
 * random"**. That negative result shapes the whole design: the adjudicator is
 * never asked to re-score in the void. It receives the item, the original
 * rationale, the observations the loop actually collected, and is asked one
 * narrow binary question — was this decidable from that evidence? The positive
 * precedent is first-party: `claude-code-security-review` ships exactly this
 * shape (hard-exclusion rules, then one cheap per-finding call carrying real
 * file content, fail-open on error), and BitsAI-CR reports +8.5pp precision
 * from the same pattern in production.
 *
 * ── Two guards against making things worse ──────────────────────────────────
 *
 * Stage 1 spends no API call on punts that are *legitimately* human: the
 * OGE-1559 linter categories (post-merge, operator-action, prod-credentials)
 * and any `[human]`-marked item keep their verdict untouched. Adjudicating
 * those would only ever pressure the model to un-punt something a person
 * genuinely owns.
 *
 * Fail-open everywhere: an API error, a malformed reply, or a low-confidence
 * answer keeps the original punt. The adjudicator can only ever *reduce* the
 * punt count by finding evidence — it can never manufacture a PASS out of
 * silence, which is the failure mode that would turn a falling punt rate into
 * a lie.
 */

import { lintChecklist, type LintFindingKind } from "./lint/checklist.js";
import { parseUatChecklist, type UatItem } from "./parser/uat.js";
import { VerdictStatus, type ItemVerdict, type ReviewVerdict } from "./schema/verdict.js";
import type { ToolCallRecord } from "./tools/loop.js";

/**
 * Linter categories whose punts are correct and must never be challenged.
 * These are release-runbook and credential-bound items — a person owns them.
 */
const LEGITIMATE_PUNT_KINDS: ReadonlySet<LintFindingKind> = new Set([
  "post-merge",
  "operator-action",
  "prod-credentials",
]);

/**
 * Minimum confidence before an adjudicator is allowed to overturn a punt.
 * Deliberately high: replacing an honest "I don't know" with a wrong PASS on a
 * merge-gating check is worse than leaving the punt in place.
 */
export const ADJUDICATION_CONFIDENCE_FLOOR = 0.75;

/** The cheap model used for adjudication. Injected, like `VerdictModel`. */
export interface AdjudicatorModel {
  /** Returns raw JSON text: `{ keepPunt, revisedStatus?, confidence, reason }`. */
  adjudicate(args: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

export interface AdjudicationOutcome {
  itemId: number;
  /** True when the punt stood. */
  keptPunt: boolean;
  /** Why — for the operator log and the sidecar. */
  reason: string;
  /** False when stage 1 short-circuited, so cost is auditable. */
  spentCall: boolean;
}

export interface AdjudicationResult {
  verdict: ReviewVerdict;
  outcomes: AdjudicationOutcome[];
  /** Punt count before adjudication, for `puntRatePre`. */
  puntsBefore: number;
  /** Punt count after, for `puntRatePost`. */
  puntsAfter: number;
}

export const ADJUDICATOR_SYSTEM_PROMPT = [
  `You are a second-pass reviewer auditing one verdict from an automated code`,
  `reviewer. The reviewer marked a checklist item UNVERIFIABLE — meaning it`,
  `could not decide.`,
  ``,
  `Your only question: given the evidence it actually gathered, was the item`,
  `decidable after all?`,
  ``,
  `Answer keepPunt=false ONLY when the gathered evidence genuinely settles it.`,
  `If the evidence is thin, absent, or merely suggestive, keep the punt — an`,
  `honest "unknown" is far better than a confident wrong answer on a check that`,
  `gates a merge. You are not being asked to be decisive; you are being asked`,
  `to catch hedging where the answer was already in hand.`,
  ``,
  `Return ONE JSON object, no prose:`,
  `{"keepPunt": true|false, "revisedStatus": "PASS"|"CODE_VERIFIED"|"PARTIAL"|"FAIL",`,
  ` "confidence": 0.0-1.0, "reason": "one sentence"}`,
  `Omit revisedStatus when keepPunt is true.`,
].join("\n");

export function buildAdjudicationPrompt(args: {
  item: ItemVerdict;
  transcript: ToolCallRecord[];
}): string {
  const observations = args.transcript.length
    ? args.transcript
        .map((c) => `- ${c.name}${c.isError ? " (error)" : ""}: ${c.result}`)
        .join("\n")
    : "(the reviewer gathered no tool observations)";

  return [
    `## Checklist item`,
    args.item.itemText,
    ``,
    `## The reviewer's rationale for punting`,
    args.item.rationale,
    ...(args.item.confidence !== undefined
      ? [``, `Its stated confidence: ${args.item.confidence}`]
      : []),
    ``,
    `## Evidence it gathered`,
    observations,
    ``,
    `Was this decidable from that evidence?`,
  ].join("\n");
}

interface AdjudicatorReply {
  keepPunt: boolean;
  revisedStatus?: string;
  confidence?: number;
  reason?: string;
}

function parseReply(text: string): AdjudicatorReply | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.keepPunt !== "boolean") return null;
    return {
      keepPunt: r.keepPunt,
      revisedStatus: typeof r.revisedStatus === "string" ? r.revisedStatus : undefined,
      confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    };
  } catch {
    return null;
  }
}

/** Linter kinds that apply to a given checklist item, by id. */
function legitimatePuntIds(prBody: string): Set<number> {
  const checklist = parseUatChecklist(prBody);
  const findings = lintChecklist(checklist).findings;
  const ids = new Set<number>();
  for (const f of findings) {
    if (LEGITIMATE_PUNT_KINDS.has(f.kind)) ids.add(f.itemId);
  }
  // `[human]` items are the author's own declaration that a person decides.
  for (const item of checklist.items as UatItem[]) {
    if (item.human) ids.add(item.id);
  }
  return ids;
}

/**
 * Challenge each UNVERIFIABLE verdict once, cheaply.
 *
 * Returns a new verdict; the input is not mutated. When nothing is punted this
 * is a no-op that spends no API calls at all.
 */
export async function adjudicateVerdict(args: {
  verdict: ReviewVerdict;
  transcript: ToolCallRecord[];
  prBody: string;
  model: AdjudicatorModel;
}): Promise<AdjudicationResult> {
  const punts = args.verdict.items.filter((it) => it.status === "UNVERIFIABLE");
  const puntsBefore = punts.length;
  if (puntsBefore === 0) {
    return { verdict: args.verdict, outcomes: [], puntsBefore: 0, puntsAfter: 0 };
  }

  const legitimate = legitimatePuntIds(args.prBody);
  const outcomes: AdjudicationOutcome[] = [];
  const revised = new Map<number, ItemVerdict>();

  for (const item of punts) {
    if (legitimate.has(item.id) || item.human === true) {
      outcomes.push({
        itemId: item.id,
        keptPunt: true,
        reason: "legitimately human (linter category or [human] marker) — not challenged",
        spentCall: false,
      });
      continue;
    }

    let reply: AdjudicatorReply | null = null;
    try {
      reply = parseReply(
        await args.model.adjudicate({
          systemPrompt: ADJUDICATOR_SYSTEM_PROMPT,
          userPrompt: buildAdjudicationPrompt({ item, transcript: args.transcript }),
        }),
      );
    } catch (err) {
      // Fail-open: an adjudicator outage must never change a verdict.
      outcomes.push({
        itemId: item.id,
        keptPunt: true,
        reason: `adjudicator unavailable (${err instanceof Error ? err.message : String(err)})`,
        spentCall: true,
      });
      continue;
    }

    if (!reply || reply.keepPunt) {
      outcomes.push({
        itemId: item.id,
        keptPunt: true,
        reason: reply?.reason ?? "adjudicator reply unparseable — punt kept",
        spentCall: true,
      });
      continue;
    }

    const status = VerdictStatus.safeParse(reply.revisedStatus);
    const confident = (reply.confidence ?? 0) >= ADJUDICATION_CONFIDENCE_FLOOR;
    if (!status.success || status.data === "UNVERIFIABLE" || !confident) {
      // Overturning requires a valid, confident, non-punt verdict. Anything
      // else — including a confident answer of "UNVERIFIABLE" — leaves it be.
      outcomes.push({
        itemId: item.id,
        keptPunt: true,
        reason: !confident
          ? `overturn below the ${ADJUDICATION_CONFIDENCE_FLOOR} confidence floor — punt kept`
          : "adjudicator returned no usable revised status — punt kept",
        spentCall: true,
      });
      continue;
    }

    revised.set(item.id, {
      ...item,
      status: status.data,
      rationale: `${item.rationale} [adjudicated: ${reply.reason ?? "decidable from gathered evidence"}]`,
      confidence: reply.confidence,
    });
    outcomes.push({
      itemId: item.id,
      keptPunt: false,
      reason: reply.reason ?? "decidable from gathered evidence",
      spentCall: true,
    });
  }

  // Mark every item the pass actually challenged, whether or not it overturned
  // the punt (OGE-1587). Kept punts are marked too: "we looked again and stood
  // by it" is a different, and measurable, fact from "we never looked".
  const challenged = new Set(outcomes.filter((o) => o.spentCall).map((o) => o.itemId));
  const items = args.verdict.items.map((it) => {
    const next = revised.get(it.id) ?? it;
    return challenged.has(it.id) ? { ...next, adjudicated: true } : next;
  });
  return {
    verdict: { ...args.verdict, items },
    outcomes,
    puntsBefore,
    puntsAfter: items.filter((it) => it.status === "UNVERIFIABLE").length,
  };
}
