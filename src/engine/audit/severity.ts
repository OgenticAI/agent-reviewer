/**
 * How severe is a finding? (OGE-2432)
 *
 * Severity answers "how bad is this if true". Confidence — computed separately
 * by the verification stage — answers "how sure are we that it is true". They
 * are orthogonal, and `orderFindings` sorts by severity first, so this function
 * decides what a client reads at the top of the report.
 *
 * ── What is available to decide with ────────────────────────────────────────
 *
 * `entry.claim.questionId`   which question produced it (see questions/taxonomy.yml)
 * `entry.claim.statement`    what the finding says
 * `entry.claim.absence`      whether it asserts something does NOT exist
 * `entry.confidence`         verified | inferred | not-determinable
 * `entry.verifiers`          how many independent reviewers examined it
 * `entry.refutations`        always 0 here; a refuted claim never reaches this
 * `analyzerSeverity`         the deterministic analyzer's own severity, when
 *                            this finding came from one — already reviewdog's
 *                            error/warning/info/unknown
 *
 * ── The rule this must not break ────────────────────────────────────────────
 *
 * Severity must NOT be derived from confidence. Ranking a not-determinable
 * finding as less severe because we are less sure of it would bury exactly the
 * open questions the closure paths exist to surface — an unanswered question
 * about production credentials is not "less bad" than a confirmed typo.
 */

import type { AuditFinding } from "./finding.js";
import type { VerifiedClaim } from "./verify.js";

export type Severity = AuditFinding["severity"];

export interface SeverityInput {
  entry: VerifiedClaim;
  /** Set when the finding originated in a deterministic analyzer. */
  analyzerSeverity?: Severity;
}

/**
 * Question ids whose findings concern security or data exposure.
 *
 * Kept beside the decision rather than inside it so the list is reviewable on
 * its own, and so adding a question to the taxonomy does not require reading
 * the scoring logic to know whether it counts.
 */
export const SECURITY_QUESTIONS: ReadonlySet<string> = new Set([
  "unauthenticated-side-effects",
  "secrets-and-data-at-rest",
  "authn-completeness",
  "tenancy-isolation",
]);

/** One rung down. Used for capability gaps, never for uncertainty. */
function demote(severity: Severity): Severity {
  if (severity === "error") return "warning";
  if (severity === "warning") return "info";
  return severity;
}

/**
 * Decide the severity of one finding.
 *
 * Three rules, in order.
 *
 * 1. AN ANALYZER'S OWN SEVERITY WINS. semgrep, the secret scanner and the
 *    dependency audit rank against calibrated rules that encode consequence
 *    far better than prose about a finding can. The rest of this pipeline
 *    already treats analyzer output as established fact the model annotates
 *    rather than re-derives; overriding it here would be re-deriving it. That
 *    includes passing through `unknown` when the tool declined to rank —
 *    inventing a ranking the tool withheld is the same error in the other
 *    direction.
 *
 * 2. SECURITY QUESTIONS START AT ERROR. An unauthenticated write, an
 *    unprotected credential, a broken tenancy boundary — these carry a
 *    consequence a thin test suite does not, and a report whose top is a
 *    coverage complaint has buried the thing that matters.
 *
 * 3. AN ABSENCE CLAIM DROPS ONE RUNG. "There is no telemetry" is a capability
 *    gap, not a defect: nothing is broken, something was never built. Worth
 *    reporting, not worth outranking a thing that is actively wrong. A
 *    security absence still lands at `warning` rather than `info`, because
 *    the missing control is itself the exposure.
 *
 * Confidence is not consulted, deliberately. Ranking a not-determinable
 * finding lower because we are less sure of it would bury exactly the open
 * questions the closure paths exist to surface.
 */
export function severityFor(input: SeverityInput): Severity {
  if (input.analyzerSeverity) return input.analyzerSeverity;

  const base: Severity = SECURITY_QUESTIONS.has(input.entry.claim.questionId) ? "error" : "warning";
  return input.entry.claim.absence ? demote(base) : base;
}
