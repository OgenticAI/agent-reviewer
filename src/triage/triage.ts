/**
 * Cheap-model pre-review triage (OGE-1595).
 *
 * The expensive pass spends its 12-iteration / 5-minute tool-loop cap uniformly
 * across easy and hard items alike — a checklist item that's trivially decidable
 * from the diff gets the same budget as one that needs deep investigation. That
 * uniformity is where budget leaks and, indirectly, where punts come from: the
 * loop runs out on the hard item because the easy ones spent its turns.
 *
 * A haiku-class pass over {checklist items × changed-file list} — NOT the full
 * diff — routes each item into one of three buckets before the expensive call:
 *   - **trivial**: decidable straight from the diff, needs no tool use,
 *   - **untouched**: this diff doesn't bear on the item at all,
 *   - **needs_tools**: requires investigation; name the files to prioritize.
 *
 * CodeRabbit and claude-code-action both route a cheap classifier before the
 * expensive review. Their budget reality check underlines it: they spend 10–20
 * minutes per review, we cap at 5 — routing is *more* necessary for us, not less.
 *
 * ── Fail-open, always ───────────────────────────────────────────────────────
 *
 * Triage is an optimization, never a gate. Any error — API failure, malformed
 * response, a class it can't parse — falls back to today's uniform behaviour:
 * every item `needs_tools`, no file priorities. It can make the review faster
 * or cheaper; it can never make it wrong.
 */

import { z } from "zod";

export const TriageClass = z.enum(["trivial", "untouched", "needs_tools"]);
export type TriageClass = z.infer<typeof TriageClass>;

export const ItemTriage = z.object({
  id: z.number().int().positive(),
  routing: TriageClass,
  /** Files the item's verification depends on — prioritized in the diff pack. */
  suggestedFiles: z.array(z.string()).default([]),
});
export type ItemTriage = z.infer<typeof ItemTriage>;

export const TriageResult = z.object({
  items: z.array(ItemTriage),
});
export type TriageResult = z.infer<typeof TriageResult>;

/** The haiku-class model. Returns raw JSON text; we parse + validate here. */
export interface TriageModel {
  triage(args: { prompt: string }): Promise<string>;
}

/** Fail-open default: treat every item as needing tools, no priorities. */
export function uniformTriage(itemIds: number[]): TriageResult {
  return { items: itemIds.map((id) => ({ id, routing: "needs_tools", suggestedFiles: [] })) };
}

export function buildTriagePrompt(args: {
  checklist: Array<{ id: number; text: string }>;
  changedFiles: string[];
}): string {
  const items = args.checklist.map((it) => `${it.id}. ${it.text}`).join("\n");
  const files = args.changedFiles.map((f) => `- ${f}`).join("\n");
  return [
    `You are a fast triage pass before an expensive code review. You do NOT`,
    `decide whether items pass — you only route where the deep reviewer should`,
    `spend its limited budget.`,
    ``,
    `For each UAT checklist item, classify it as one of:`,
    `- "trivial": the changed-file list makes clear this is decidable straight`,
    `  from the diff, no investigation needed.`,
    `- "untouched": none of the changed files bear on this item at all.`,
    `- "needs_tools": deciding it needs reading code beyond the diff. List the`,
    `  changed files most relevant to it in suggestedFiles.`,
    ``,
    `Checklist:`,
    items,
    ``,
    `Changed files:`,
    files,
    ``,
    `Return ONLY a JSON object: { "items": [ { "id": <n>, "routing": "...",`,
    `"suggestedFiles": ["..."] } ] }. Include every item id exactly once.`,
  ].join("\n");
}

/**
 * Run triage, returning routing per item. Fail-open on any error.
 *
 * The result is reconciled against the real checklist ids: any item the model
 * dropped or invented is normalized back to `needs_tools`, so a partial or
 * malformed triage degrades gracefully to the uniform default for the affected
 * items rather than losing them.
 */
export async function runTriage(args: {
  model: TriageModel;
  checklist: Array<{ id: number; text: string }>;
  changedFiles: string[];
}): Promise<TriageResult> {
  const ids = args.checklist.map((it) => it.id);
  try {
    const raw = await args.model.triage({
      prompt: buildTriagePrompt({ checklist: args.checklist, changedFiles: args.changedFiles }),
    });
    const parsed = TriageResult.parse(JSON.parse(extractJson(raw)));
    const byId = new Map(parsed.items.map((it) => [it.id, it]));
    // Reconcile: every real item gets a routing; unknown ids are dropped.
    return {
      items: ids.map(
        (id) => byId.get(id) ?? { id, routing: "needs_tools" as const, suggestedFiles: [] },
      ),
    };
  } catch {
    return uniformTriage(ids);
  }
}

/** Pull the first JSON object out of a possibly-fenced model reply. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (fenced) return fenced[1]!;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** All files any needs_tools item flagged — the diff-pack priority set. */
export function priorityFilesFrom(result: TriageResult): string[] {
  const out = new Set<string>();
  for (const item of result.items) {
    if (item.routing === "needs_tools") for (const f of item.suggestedFiles) out.add(f);
  }
  return [...out];
}
