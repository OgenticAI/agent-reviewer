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

/**
 * Per-item outcomes.
 *
 * `CODE_VERIFIED` exists because UNVERIFIABLE was doing two incompatible jobs
 * (OGE-1580). "No evidence either way" and "the code plainly does this; only
 * running it would prove the rest" are not the same answer, and collapsing
 * them made honest, well-evidenced reviews indistinguishable from blind
 * punts — which is a large slice of the 88% baseline.
 *
 * Qodo Merge reached the same conclusion independently: their ticket-
 * compliance taxonomy carries "PR Code Verified" as an affirmative outcome
 * meaning code meets requirements, manual testing still advisable. It is a
 * *result*, not a shrug, and it does not gate a merge.
 */
export const VerdictStatus = z.enum([
  "PASS",
  "CODE_VERIFIED",
  "FAIL",
  "PARTIAL",
  "UNVERIFIABLE",
]);
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
  /**
   * Mirrors `UatItem.human` — the author declared this criterion as needing a
   * person via a `[human]` marker (OGE-1559). Set by the orchestrator from the
   * parsed checklist, NOT by the model; it is not the model's call to make.
   *
   * Optional for the same reason as `autoPatchable`: keeps existing fixtures
   * and older sidecar payloads valid. Read as `=== true` everywhere.
   */
  human: z.boolean().optional(),
  /**
   * How sure the model is, 0–1 (OGE-1580).
   *
   * Load-bearing rather than decorative: the prompt's rubric says a punt above
   * the confidence floor is illegitimate, so this is the field that makes
   * "don't punt when you actually know" checkable. It is also the guard
   * against the failure mode this whole batch risks — a falling punt rate that
   * means bolder guessing rather than better verification. Without a
   * confidence trail you cannot tell those apart after the fact.
   */
  confidence: z.number().min(0).max(1).optional(),
  /**
   * What the model actually looked at, in its own words — "read src/foo.ts:40-58",
   * "CI job `test` reported success". Distinct from `evidenceRefs`, which is
   * structured pointers for rendering; this is the observation trail behind
   * the verdict, and for UNVERIFIABLE items it must name the missing capability.
   */
  evidence: z.array(z.string()).optional(),
});
export type ItemVerdict = z.infer<typeof ItemVerdict>;

/**
 * Statuses that do NOT represent a punt to a human.
 *
 * Single source of truth — `overallStatus`, the metrics, and the renderers all
 * read this rather than each re-deciding what counts. Adding a verdict class
 * later means changing one set.
 */
export const NON_PUNT_STATUSES: ReadonlySet<VerdictStatus> = new Set([
  "PASS",
  "CODE_VERIFIED",
  "PARTIAL",
]);

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
  /**
   * SHA-256 of the exact user prompt this verdict was produced from (OGE-1566).
   *
   * This is the cache key for skipping a re-run. `headSha` alone is NOT
   * sufficient: a PR description can be edited — adding a UAT item, fixing a
   * `[human]` marker — without producing a new commit, and reusing a verdict
   * across that change would score the new checklist with the old answers.
   * Hashing the prompt covers every input in the determinism vector at once.
   *
   * Optional so verdicts written before this field existed still parse.
   * A cached verdict without a hash simply never matches, so it re-runs —
   * failing toward correctness rather than toward a stale reuse.
   */
  promptHash: z.string().optional(),
  /**
   * Fingerprint of normalised client-side tool output (OGE-1553). Recorded for
   * observability — not part of the cache key. See `isCacheHit`.
   */
  toolOutputHash: z.string().optional(),
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
  // Items the author explicitly declared as needing a person (`[human]`) are
  // excluded from the UNVERIFIABLE roll-up (OGE-1559).
  //
  // Why: before this, a well-written checklist that honestly declared two
  // human criteria was indistinguishable from a blind punt — both reported
  // HUMAN_REVIEW. That made the reviewer's headline metric unmovable no matter
  // how much verification capability it gained, and it quietly penalised the
  // authoring behaviour we want. Declaring a human criterion is good practice.
  //
  // A FAIL on a `[human]` item still counts. The marker says "a person decides
  // whether this passes", not "ignore this item" — so if the model finds
  // positive evidence the item is broken, that's a real signal and it stands.
  //
  // Note for repos running `fail_on: HUMAN_REVIEW`: this is a deliberate
  // loosening. Correctly-marked human items no longer gate merge. They never
  // gated it meaningfully anyway — HUMAN_REVIEW maps to a `neutral` Check
  // conclusion by default, and human sign-off is enforced by PR approval, not
  // by this Check.
  const statuses = verdict.items.map((it) => it.status);
  if (statuses.includes("FAIL")) return "NEEDS_WORK";

  const verifiable = verdict.items.filter((it) => it.human !== true);

  // Every item is `[human]`-marked: there is nothing here the reviewer was
  // ever going to check, so HUMAN_REVIEW is the honest answer rather than a
  // vacuous PASS. Reporting PASS would read as a green light on a checklist
  // nobody has actually verified.
  if (verifiable.length === 0 && verdict.items.length > 0) return "HUMAN_REVIEW";

  const verifiableStatuses = verifiable.map((it) => it.status);
  if (verifiableStatuses.includes("UNVERIFIABLE")) return "HUMAN_REVIEW";
  // CODE_VERIFIED rolls up alongside PARTIAL rather than PASS: both mean
  // "nothing is wrong here, and a person may still want to look". Reporting a
  // checklist of CODE_VERIFIED items as a clean PASS would overclaim — the
  // whole point of the verdict is that runtime validation is still outstanding.
  if (verifiableStatuses.includes("PARTIAL") || verifiableStatuses.includes("CODE_VERIFIED")) {
    return "PASS_WITH_PARTIALS";
  }
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
