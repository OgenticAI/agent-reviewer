/**
 * Per-item verdict the model produces for each UAT checklist entry.
 *
 * Status semantics:
 *   PASS          — clear evidence in the diff (or the existing repo) that the
 *                   item is delivered. Pin the evidence in `evidenceRefs`.
 *   FAIL          — clear evidence the item is NOT delivered (regression, missing
 *                   feature the PR claims to add, broken behavior).
 *   PARTIAL       — partially done. Use sparingly; PARTIAL+rationale should
 *                   read like a code review note, not a hedge.
 *   UNVERIFIABLE  — needs human verification (e.g. "renders cleanly on GitHub"
 *                   is a visual claim). NOT a get-out-of-jail card; the rationale
 *                   must explain WHY it can't be checked from the diff alone.
 *
 * Stability: the same diff + same checklist must produce the same verdicts on
 * every run. The model temperature is pinned at 0 in the Action; if you see
 * verdicts drift in CI, that's a bug, not a feature.
 */

import { z } from "zod";

export const VerdictStatus = z.enum(["PASS", "FAIL", "PARTIAL", "UNVERIFIABLE"]);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

/**
 * A pointer to evidence that justifies a verdict — typically a file path,
 * optionally with a line range. Keep it human-clickable in GitHub comments.
 *
 * Examples:
 *   { kind: "file", path: "src/redaction.py" }
 *   { kind: "lines", path: "src/redaction.py", start: 42, end: 58 }
 *   { kind: "test", path: "tests/test_redaction.py", name: "test_round_trip" }
 *   { kind: "external", url: "https://github.com/...", note: "rendered README" }
 */
export const EvidenceRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("lines"),
    path: z.string().min(1),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("test"),
    path: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("external"),
    url: z.string().url(),
    note: z.string().optional(),
  }),
]);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const ItemVerdict = z.object({
  /** Matches `UatItem.id` from the parser — 1-based position in the checklist. */
  id: z.number().int().positive(),
  /** Verbatim copy of the UAT item text the verdict applies to. */
  itemText: z.string().min(1),
  status: VerdictStatus,
  /**
   * One- to three-sentence rationale. Written as if to a teammate in code
   * review, not as filler. UNVERIFIABLE rationales must explain *why*.
   */
  rationale: z.string().min(1).max(800),
  evidenceRefs: z.array(EvidenceRef).default([]),
  /**
   * Hint for OGE-341's auto-patch flow: when `true` AND status is `FAIL`,
   * the Action (with `auto_patch: true`) attempts to open a draft PR with
   * a candidate fix. Use sparingly — only set it when the fix is mechanical
   * (missing test for an asserted behavior, missing docstring, a README
   * claim that doesn't match the code).
   *
   * Optional rather than `.default(false)`: the model is instructed to omit
   * the field entirely when not flagging an item. Runtime code reads it as
   * `=== true`, so missing / false / undefined all collapse to "no
   * auto-patch". Keeping it optional avoids forcing every test fixture and
   * model output to spell out `false` redundantly.
   */
  autoPatchable: z.boolean().optional(),
});
export type ItemVerdict = z.infer<typeof ItemVerdict>;

/** The whole-PR verdict envelope produced by the agent on each run. */
export const ReviewVerdict = z.object({
  /** Schema version. Bumped when we change the comment format incompatibly. */
  schemaVersion: z.literal(1),
  /** Reviewer agent version (e.g. "v1") — matches `REVIEWER_VERSION`. */
  reviewerVersion: z.string().min(1),
  /** Linear ticket id (e.g. "OGE-308") that this PR was reviewed against. */
  ticketId: z.string().min(1),
  /** PR identifier in `owner/repo#NNN` form. */
  prRef: z.string().min(1),
  /** Head SHA the verdict was computed against. */
  headSha: z.string().min(7),
  /** Per-item verdicts, in the order produced by `parseUatChecklist`. */
  items: z.array(ItemVerdict),
  /** Free-form 1-2 sentence summary across all items. */
  summary: z.string().min(1).max(600),
  /** UTC ISO-8601 timestamp the verdict was rendered. */
  generatedAt: z.string().datetime(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/**
 * The single overall outcome used by the merge-gate Check (Ticket OGE-340):
 *   - PASS         → every item PASS
 *   - PASS_WITH_PARTIALS → mix of PASS and PARTIAL, no FAIL
 *   - NEEDS_WORK   → at least one FAIL
 *   - HUMAN_REVIEW → at least one UNVERIFIABLE and no FAIL
 *
 * Mapping to the GitHub Check conclusion:
 *   PASS                 → success
 *   PASS_WITH_PARTIALS   → success (with note)
 *   NEEDS_WORK           → failure
 *   HUMAN_REVIEW         → neutral
 */
export type OverallStatus = "PASS" | "PASS_WITH_PARTIALS" | "NEEDS_WORK" | "HUMAN_REVIEW";

export function overallStatus(verdict: ReviewVerdict): OverallStatus {
  const statuses = verdict.items.map((it) => it.status);
  if (statuses.includes("FAIL")) return "NEEDS_WORK";
  if (statuses.includes("UNVERIFIABLE")) return "HUMAN_REVIEW";
  if (statuses.includes("PARTIAL")) return "PASS_WITH_PARTIALS";
  return "PASS";
}

/**
 * Items the auto-patch flow (OGE-341) will attempt to fix. Returns `[]` when
 * there are none — used by the Action to decide whether to spend a second
 * `claude-code-action` invocation on patch generation.
 */
export function autoPatchableFails(verdict: ReviewVerdict): ReviewVerdict["items"] {
  return verdict.items.filter((it) => it.status === "FAIL" && it.autoPatchable);
}
