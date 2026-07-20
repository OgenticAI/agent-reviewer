/**
 * Offline eval fixtures (OGE-1589).
 *
 * Prompt and model changes used to ship on vibes: a `REVIEWER_VERSION` bump
 * invalidated the cache but nothing measured whether verdicts got *better*, and
 * our history holds almost no confirmed-FAIL ground truth. This is the trust
 * backstop for the whole batch — it became urgent the moment CODE_VERIFIED made
 * punting cheaper to avoid.
 *
 * A fixture is a hermetic snapshot of one review: the inputs (PR, ticket,
 * checklist-in-body, diff, optional CI), the recorded model response, and the
 * archived verdict table the pipeline must reproduce. Everything volatile is
 * already stripped by OGE-1553's normalization, so replay is byte-stable.
 *
 * ── Why the expected label is structured, never prose ────────────────────────
 *
 * CRScore measured text-similarity regression checks as worthless for this task
 * (BLEU deltas of −0.0001). So the gate matches the **verdict label table** —
 * `{id → status}` plus `overall` — and never the rationale text. A rationale
 * can be reworded freely; a label flip is a real regression.
 */

import { z } from "zod";

import { VerdictStatus } from "../schema/verdict.js";

/** Zod mirror of the `OverallStatus` string union (which has no runtime enum). */
export const OverallStatusEnum = z.enum([
  "PASS",
  "PASS_WITH_PARTIALS",
  "NEEDS_WORK",
  "HUMAN_REVIEW",
]);

/** The expected structured result — labels only, never prose. */
export const ExpectedTable = z.object({
  items: z.array(z.object({ id: z.number().int(), status: VerdictStatus })),
  overall: OverallStatusEnum,
});
export type ExpectedTable = z.infer<typeof ExpectedTable>;

export const EvalFixture = z.object({
  /** Stable fixture name, also its filename stem. */
  name: z.string().min(1),
  /** One line on what this fixture exercises. */
  description: z.string().default(""),
  /** How this fixture was made — real snapshot or injected defect. */
  origin: z.enum(["snapshot", "injected"]).default("snapshot"),
  pr: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number().int(),
    headSha: z.string(),
    headRef: z.string(),
    title: z.string(),
    /** Full PR body — the UAT checklist is parsed out of this. */
    body: z.string(),
    author: z.string(),
    createdAt: z.string(),
  }),
  ticket: z.object({
    identifier: z.string(),
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.string(),
    url: z.string(),
  }),
  /** Unified diff under review. */
  diff: z.string(),
  /** The model's recorded response text (raw JSON verdict). Gold-mode input. */
  modelResponse: z.string(),
  /** The archived verdict-label table the pipeline must reproduce. */
  expected: ExpectedTable,
  /**
   * The triage-on arm of this fixture (OGE-1606) — optional.
   *
   * The triage dimension asks whether the cheap pre-pass changes the punt rate,
   * and a hermetic replay can only answer that if the fixture recorded BOTH
   * arms. Replaying the same `modelResponse` with and without a triage model
   * would return identical verdicts and produce a comparison of zero — a
   * confident-looking number that measured nothing.
   *
   * So the arm is explicit: `triageResponse` drives the pre-pass, and
   * `modelResponse` is what the verdict model actually returned on the run
   * where triage had reordered its context. Fixtures without this field are
   * reported as skipped, never counted as "no difference".
   */
  triageArm: z
    .object({
      /** Recorded reply from the haiku-class triage model (raw JSON). */
      triageResponse: z.string(),
      /** Recorded verdict-model reply from the triage-on run. */
      modelResponse: z.string(),
    })
    .optional(),
});
export type EvalFixture = z.infer<typeof EvalFixture>;

export function parseFixture(json: unknown): EvalFixture {
  return EvalFixture.parse(json);
}
