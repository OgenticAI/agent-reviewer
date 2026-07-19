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
});
export type EvalFixture = z.infer<typeof EvalFixture>;

export function parseFixture(json: unknown): EvalFixture {
  return EvalFixture.parse(json);
}
