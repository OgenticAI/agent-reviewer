/**
 * Defect injection (OGE-1589), following Qodo's benchmark construction.
 *
 * Our history holds almost no confirmed-FAIL ground truth, so we mint it: take
 * a clean known-PASS fixture and corrupt the diff against one specific
 * checklist item, producing a labeled FAIL. The clean original is the PASS
 * control; the injected copy is the FAIL case. Together they give one labeled
 * pair per verdict class — the ground truth the punt-rate metric can't provide
 * on its own.
 *
 * The injection is deterministic and structural, never model-generated: it
 * rewrites the recorded model response so the target item is FAIL and recomputes
 * the expected table. That keeps the harness itself free of any model in the
 * labeling path — the label is asserted, not judged.
 */

import type { EvalFixture, ExpectedTable } from "./fixture.js";
import type { OverallStatus } from "../schema/verdict.js";

/**
 * Recompute the overall from a label table, mirroring `overallStatus()`.
 *
 * Kept in lockstep with the real roll-up (FAIL wins; then UNVERIFIABLE; then
 * PARTIAL/CODE_VERIFIED both map to PASS_WITH_PARTIALS). Fixtures never use
 * `[human]`, so the human-exclusion branch of the real function doesn't apply.
 */
function rollUp(items: ExpectedTable["items"]): OverallStatus {
  const has = (s: string) => items.some((i) => i.status === s);
  if (has("FAIL")) return "NEEDS_WORK";
  if (has("UNVERIFIABLE")) return "HUMAN_REVIEW";
  if (has("PARTIAL") || has("CODE_VERIFIED")) return "PASS_WITH_PARTIALS";
  return "PASS";
}

/**
 * Inject a FAIL against `targetItemId` in a clean fixture.
 *
 * Marks a corruption in the diff (a sabotage marker line, so the fixture is
 * self-documenting) and rewrites the recorded response + expected table so the
 * target item reads FAIL. Throws if the target item isn't in the fixture — an
 * injection that silently no-ops would mint a mislabeled fixture, worse than none.
 */
export function injectDefect(args: {
  base: EvalFixture;
  targetItemId: number;
  rationale?: string;
}): EvalFixture {
  const { base, targetItemId } = args;
  const parsed = JSON.parse(base.modelResponse) as {
    items: Array<{ id: number; status: string; rationale: string; evidenceRefs?: unknown[] }>;
    summary: string;
  };
  const target = parsed.items.find((i) => i.id === targetItemId);
  if (!target) {
    throw new Error(`injectDefect: item ${targetItemId} not found in fixture "${base.name}"`);
  }

  target.status = "FAIL";
  target.rationale =
    args.rationale ??
    `Injected defect: the change for this item was removed/corrupted, so it is not delivered.`;

  const items: ExpectedTable["items"] = parsed.items.map((i) => ({
    id: i.id,
    status: i.status as ExpectedTable["items"][number]["status"],
  }));

  return {
    ...base,
    name: `${base.name}--injected-fail-${targetItemId}`,
    description: `Injected FAIL against item ${targetItemId} of ${base.name}`,
    origin: "injected",
    // A visible sabotage marker so the corrupted fixture reads as deliberate.
    diff: `${base.diff}\n# [defect-injected] item ${targetItemId} sabotaged for eval ground truth\n`,
    modelResponse: JSON.stringify(parsed),
    expected: { items, overall: rollUp(items) },
  };
}
