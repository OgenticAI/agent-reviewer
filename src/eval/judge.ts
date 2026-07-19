/**
 * Order-swapped pairwise judging (OGE-1589).
 *
 * The eval GATE never uses an LLM — it matches structured labels. This is the
 * separate, optional path for scoring *rationale quality* between two candidate
 * prompts, and it exists to be used carefully: LLM judges have a well-measured
 * position bias (they favor whichever answer came first).
 *
 * The protocol from the judge-bias paper (arXiv:2306.05685): run the judge in
 * BOTH orders and only count a win when both orders agree. A disagreement means
 * the judge is expressing position bias, not preference, so it scores as a tie.
 * This module is the pure aggregation of that protocol; the actual judge call
 * is injected, so the tie-on-disagreement logic is testable without a model.
 */

export type PairChoice = "A" | "B" | "tie";

/** A judge that, given two rationales in order, picks the better or ties. */
export type PairJudge = (first: string, second: string) => Promise<PairChoice>;

export interface PairVerdict {
  /** The unbiased outcome after de-biasing across both orders. */
  result: PairChoice;
  /** True when the two orders disagreed — recorded, since it's the bias signal. */
  disagreed: boolean;
}

/**
 * Judge A vs B in both orders; a win requires agreement across orders.
 *
 * Order 1 presents (A, B); order 2 presents (B, A). We translate the second
 * call back into A/B terms, then:
 *   - both say A → A wins
 *   - both say B → B wins
 *   - anything else (including one tie) → tie, and `disagreed` when the two
 *     non-tie calls actively contradicted.
 */
export async function judgePair(a: string, b: string, judge: PairJudge): Promise<PairVerdict> {
  const order1 = await judge(a, b); // A first
  const order2raw = await judge(b, a); // B first
  // Map order-2's answer (in terms of first/second) back to A/B.
  const order2: PairChoice = order2raw === "A" ? "B" : order2raw === "B" ? "A" : "tie";

  if (order1 === "A" && order2 === "A") return { result: "A", disagreed: false };
  if (order1 === "B" && order2 === "B") return { result: "B", disagreed: false };

  const bothPicked = order1 !== "tie" && order2 !== "tie";
  return { result: "tie", disagreed: bothPicked && order1 !== order2 };
}
