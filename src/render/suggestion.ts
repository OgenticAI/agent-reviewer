/**
 * Committable suggestion blocks (OGE-1596).
 *
 * The missing middle rung of remediation. Today there are two: a prose FAIL
 * rationale (the author does everything) and auto-patch opening a whole draft
 * PR (heavyweight, a separate review). GitHub's native ```suggestion block on
 * an inline comment is the rung between — the author applies a small, certain
 * fix with one click, inside their own PR, no second PR to review.
 *
 * ── The certainty gate is the whole design ──────────────────────────────────
 *
 * A wrong one-click suggestion is worse than none: it invites the author to
 * accept a bad change with a single tap. So a suggestion block is emitted ONLY
 * when the fix is a contiguous single-hunk replacement the model is confident
 * about AND every replaced line is anchorable in the diff. Everything else —
 * multi-hunk fixes, low confidence, lines outside the diff — falls through to
 * the existing draft-PR auto-patch path, unchanged.
 */

import type { ItemVerdict } from "../schema/verdict.js";
import {
  inlineMarker,
  type DiffPositionMap,
  type InlineComment,
  type SplitFindings,
} from "./inline.js";

/** Max lines a single-click suggestion may span. Beyond this it's not "small". */
export const MAX_SUGGESTION_LINES = 20;

/** Confidence below which a fix is never offered as one-click. */
export const SUGGESTION_CONFIDENCE_FLOOR = 0.8;

export interface SuggestionDecision {
  eligible: boolean;
  /** Why it was rejected, for logs. Empty when eligible. */
  reason: string;
}

/**
 * Whether an item's `suggestedFix` may be rendered as a committable block.
 *
 * Every clause is a reason a one-click apply could go wrong, so each is a hard
 * gate rather than a heuristic. When any fails, the caller leaves the item on
 * the draft-PR path.
 */
export function suggestionEligibility(
  item: ItemVerdict,
  positionMap: DiffPositionMap,
): SuggestionDecision {
  const fix = item.suggestedFix;
  if (item.status !== "FAIL") return { eligible: false, reason: "not a FAIL" };
  if (item.autoPatchable !== true) return { eligible: false, reason: "not autoPatchable" };
  if (!fix) return { eligible: false, reason: "no suggestedFix" };
  if (fix.endLine < fix.startLine) return { eligible: false, reason: "inverted line range" };
  if (fix.endLine - fix.startLine + 1 > MAX_SUGGESTION_LINES) {
    return { eligible: false, reason: `spans more than ${MAX_SUGGESTION_LINES} lines` };
  }
  if (item.confidence !== undefined && item.confidence < SUGGESTION_CONFIDENCE_FLOOR) {
    return { eligible: false, reason: `confidence ${item.confidence} below floor` };
  }
  const anchorable = positionMap.get(fix.path);
  if (!anchorable) return { eligible: false, reason: "file not in diff" };
  // Every replaced line must be anchorable — a suggestion on a line GitHub
  // won't accept is a broken one-click, which is exactly what this gate exists
  // to prevent. This also rejects non-contiguous coverage of the range.
  for (let ln = fix.startLine; ln <= fix.endLine; ln += 1) {
    if (!anchorable.has(ln)) {
      return { eligible: false, reason: `line ${ln} not anchorable in diff` };
    }
  }
  return { eligible: true, reason: "" };
}

/**
 * The GitHub suggestion block for a fix.
 *
 * A fenced ```suggestion block replaces the comment's anchored line range with
 * its contents verbatim. The replacement is emitted as-is — no reflow — because
 * GitHub applies it literally.
 */
export function renderSuggestionBlock(replacement: string): string {
  // Strip a single trailing newline so the block doesn't inject a blank line on
  // apply; keep everything else exactly as the model produced it.
  const body = replacement.replace(/\n$/, "");
  return ["```suggestion", body, "```"].join("\n");
}

function suggestionComment(item: ItemVerdict): InlineComment {
  const fix = item.suggestedFix!;
  const multiLine = fix.endLine > fix.startLine;
  return {
    path: fix.path,
    line: fix.endLine,
    ...(multiLine ? { startLine: fix.startLine } : {}),
    itemId: item.id,
    status: item.status,
    body: [
      inlineMarker(item.id),
      `**FAIL** — ${item.itemText}`,
      ``,
      item.rationale,
      ``,
      `Suggested fix (apply with one click):`,
      renderSuggestionBlock(fix.replacement),
    ].join("\n"),
  };
}

/**
 * Upgrade suggestion-eligible findings to committable blocks.
 *
 * Operates on the whole `splitFindings` result, because an eligible item's
 * *evidence* may have landed in the fallback channel even though its *fix* is
 * anchorable — the certainty gate is about the fix range, not the evidence. So
 * for each eligible item we emit a suggestion comment anchored to the fix and
 * pull that item out of whichever channel it was in. Everything else is
 * untouched and stays on its existing rung (prose inline, or draft-PR).
 *
 * Returns the ids that got a suggestion so the caller can feed applied/ignored
 * into outcome telemetry (OGE-1592).
 */
export function attachSuggestions(args: {
  split: SplitFindings;
  items: ItemVerdict[];
  positionMap: DiffPositionMap;
}): { split: SplitFindings; suggestedItemIds: number[] } {
  const eligible = new Map<number, ItemVerdict>();
  for (const item of args.items) {
    if (suggestionEligibility(item, args.positionMap).eligible) eligible.set(item.id, item);
  }
  if (eligible.size === 0) return { split: args.split, suggestedItemIds: [] };

  // Drop eligible items from both channels; they're re-added as suggestions.
  const inline = args.split.inline.filter((c) => !eligible.has(c.itemId));
  const unanchored = args.split.unanchored.filter((u) => !eligible.has(u.itemId));
  for (const item of eligible.values()) inline.push(suggestionComment(item));

  return {
    split: { inline, unanchored },
    suggestedItemIds: [...eligible.keys()],
  };
}
