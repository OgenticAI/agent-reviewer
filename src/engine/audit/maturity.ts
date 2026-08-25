/**
 * Codebase Maturity and Targets (OGE-2458) — the two sections OGE-2432 left out.
 *
 * Maturity is the section a buyer's advisor reads first and the only one they
 * can skim, so it carries more commercial weight than anything else in the
 * document. That is exactly why it is the easiest place to lie.
 *
 * ── The decision this implements (OGE-2458, David) ──────────────────────────
 *
 * RATE ON WHAT WE FOUND. STATE COVERAGE SEPARATELY.
 *
 * A category's rating derives only from findings actually made in it. Coverage
 * sits beside it as its own column, so a rating resting on one answered
 * question is visibly thin rather than quietly thin.
 *
 * The rejected alternative was folding certainty into the rating — rating a
 * category lower because we are less sure about it. That reintroduces the
 * confidence-into-severity coupling `severity.ts` exists to prevent, one level
 * up. A `not-determinable` finding counts toward its category at its own
 * severity, unchanged.
 *
 * ── The trap that basis creates ─────────────────────────────────────────────
 *
 * Rating on findings alone means a category with no findings rates well. A
 * category nothing looked at also has no findings. Without a guard the section
 * rewards us for not looking — invisible to the reader and flattering to us,
 * which is the worst combination a document like this can have.
 *
 * So `Strong` requires that EVERY question in the category was answered. A
 * category whose questions did not run is `Not Assessed`, which is not a
 * judgement at all and must never render as a grade.
 */

import type { AuditFinding } from "./finding.js";
import type { Question } from "./questions.js";

/**
 * Ratings, worst to best, plus the two non-judgements.
 *
 * `Not Assessed` is not in Trail of Bits' vocabulary and is the most important
 * entry here. Theirs runs Strong / Satisfactory / Moderate / Weak / Missing /
 * Not Applicable — every one of which is a conclusion. We need a word for "we
 * did not look", or the absence of a conclusion gets read as a good one.
 */
export type Rating =
  | "Weak"
  | "Moderate"
  | "Satisfactory"
  | "Strong"
  | "Not Assessed"
  | "Not Applicable";

export const RATING_ORDER: readonly Rating[] = [
  "Weak",
  "Moderate",
  "Satisfactory",
  "Strong",
  "Not Applicable",
  "Not Assessed",
];

/** A rating is a judgement about the code. These two are not. */
export function isJudgement(rating: Rating): boolean {
  return rating !== "Not Assessed" && rating !== "Not Applicable";
}

/**
 * Categories, and the questions that speak to each.
 *
 * Seven categories over the ten baseline questions — a mapping, not an
 * invention. Every question belongs to exactly one category and no category is
 * empty, so nothing is silently unrated and nothing is rated on nothing.
 *
 * A question added to `questions/taxonomy.yml` and not listed here would rate
 * no category, so `unmappedQuestions` below turns that into a visible gap
 * rather than a silent one.
 */
export const CATEGORIES: ReadonlyArray<{
  name: string;
  questions: readonly string[];
}> = [
  {
    name: "Access controls",
    questions: [
      "authn-completeness",
      "unauthenticated-side-effects",
      "tenancy-isolation",
    ],
  },
  { name: "Secrets and data at rest", questions: ["secrets-and-data-at-rest"] },
  {
    name: "Configuration and deployment",
    questions: ["config-precedence", "deployment-provenance"],
  },
  { name: "Testing and verification", questions: ["test-reality"] },
  { name: "Monitoring and observability", questions: ["observability"] },
  { name: "Data model and scale", questions: ["data-model-scale"] },
  { name: "Third-party surface", questions: ["third-party-surface"] },
];

/** Questions in the active set that no category claims. */
export function unmappedQuestions(questions: Question[]): string[] {
  const mapped = new Set(CATEGORIES.flatMap((c) => c.questions));
  return questions.map((q) => q.id).filter((id) => !mapped.has(id));
}

/**
 * What the investigation actually managed to ask.
 *
 * `answered` is the distinction the whole section rests on: a question that ran
 * and found nothing is evidence, and a question that never ran is not. Without
 * this the two are indistinguishable from findings alone, because both produce
 * zero findings.
 */
export interface QuestionOutcome {
  id: string;
  answered: boolean;
}

export interface CategoryAssessment {
  name: string;
  rating: Rating;
  /** Questions in this category that produced an answer. */
  answered: number;
  /** Questions in this category that are in the active set at all. */
  asked: number;
  findings: number;
  worstSeverity: string | null;
}

/**
 * Rate one category.
 *
 * Severity decides the rating and confidence never enters it — a
 * `not-determinable` error counts exactly as much as a `verified` one, because
 * an unanswered question about production credentials is not less bad than a
 * confirmed one.
 */
export function assessCategory(
  category: { name: string; questions: readonly string[] },
  findings: AuditFinding[],
  outcomes: QuestionOutcome[],
): CategoryAssessment {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const inSet = category.questions.filter((q) => byId.has(q));
  const answered = inSet.filter((q) => byId.get(q)?.answered).length;

  const mine = findings.filter((f) =>
    category.questions.some((q) => f.id.startsWith(`${q}-`)),
  );

  const worst =
    (["error", "warning", "info"] as const).find((s) =>
      mine.some((f) => f.severity === s),
    ) ?? null;

  const base = {
    name: category.name,
    answered,
    asked: inSet.length,
    findings: mine.length,
    worstSeverity: worst,
  };

  // Nothing in this run asked about it. Not a judgement — and it must never
  // render as one.
  if (inSet.length === 0) return { ...base, rating: "Not Applicable" };
  if (answered === 0) return { ...base, rating: "Not Assessed" };

  if (worst === "error") return { ...base, rating: "Weak" };
  if (worst === "warning") return { ...base, rating: "Moderate" };

  // No findings at all. `Strong` is the only rating that claims an absence of
  // problems, so it is the only one that requires we asked everything — a
  // partially-asked category with nothing found is `Satisfactory` at best.
  if (mine.length === 0 && answered === inSet.length)
    return { ...base, rating: "Strong" };
  return { ...base, rating: "Satisfactory" };
}

export function assessMaturity(
  findings: AuditFinding[],
  outcomes: QuestionOutcome[],
): CategoryAssessment[] {
  return CATEGORIES.map((c) => assessCategory(c, findings, outcomes));
}

/**
 * The sentence under the table.
 *
 * A first run over an unfamiliar codebase should produce a table that is mostly
 * `Not Assessed` and looks sparse. That is the honest output, and saying so
 * beside it is what stops a reader mistaking sparseness for a gap in the work.
 */
export function maturityCaveat(assessments: CategoryAssessment[]): string {
  const unassessed = assessments.filter(
    (a) => a.rating === "Not Assessed",
  ).length;
  const thin = assessments.filter(
    (a) => isJudgement(a.rating) && a.answered < a.asked,
  ).length;

  const parts = [
    "Each rating reflects only what this review found in that category. " +
      "It is not a score, and it is not comparable between codebases.",
  ];
  if (unassessed > 0) {
    const one = unassessed === 1;
    parts.push(
      `${unassessed} categor${one ? "y was" : "ies were"} not assessed — no question in this run ` +
        `reached ${one ? "it" : "them"}. That is not a passing grade and should not be read as one.`,
    );
  }
  if (thin > 0) {
    const one = thin === 1;
    parts.push(
      `${thin} rated categor${one ? "y rests" : "ies rest"} on ${one ? "some of its" : "some of their"} ` +
        `questions rather than all; the answered column says which.`,
    );
  }
  return parts.join(" ");
}

/* ── Targets ──────────────────────────────────────────────────────────────── */

export interface TargetsInput {
  origin: string;
  name: string;
  rev: string | null;
  revProvenance: string;
  files: number;
  loc: number;
  /** Directory names the walk skipped, recorded rather than dropped. */
  excluded: string[];
}

/**
 * What was in scope, and what was not.
 *
 * The exclusions matter more than the inclusions. A reader can see what we
 * looked at from the coverage section; what they cannot see, unless it is
 * printed, is the set of directories that were never candidates — and
 * `node_modules` being excluded is the difference between a coverage figure
 * that means something and one that does not.
 */
export function renderTargets(input: TargetsInput): string[] {
  const lines = [
    `*Subject:* ${input.name}`,
    ``,
    `*Origin:* ${input.origin}`,
    ``,
  ];

  if (input.rev) {
    lines.push(
      `*Revision:* ${input.rev}`,
      ``,
      `*Revision provenance:* ${input.revProvenance}`,
      ``,
    );
  } else {
    // Stated, never omitted. A subject with no revision cannot be re-audited
    // against the same code, and that is a property of this engagement rather
    // than a gap in this section.
    lines.push(
      `*Revision:* none recorded — ${input.revProvenance}.`,
      ``,
      `This review cannot be repeated against exactly this code, and a later review ` +
        `cannot be diffed against it.`,
      ``,
    );
  }

  lines.push(
    `*Size in scope:* ${input.files.toLocaleString()} files, ${input.loc.toLocaleString()} lines`,
    ``,
  );

  if (input.excluded.length > 0) {
    lines.push(
      `*Excluded from the walk:* ${input.excluded.join(", ")}`,
      ``,
      `These directories were never candidates for review. Coverage below is a share ` +
        `of what remained after these were removed, not of everything on disk.`,
      ``,
    );
  }

  return lines;
}
