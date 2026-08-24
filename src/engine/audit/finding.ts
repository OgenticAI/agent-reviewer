/**
 * The audit finding model (OGE-2427).
 *
 * Pure types and pure validators. No I/O, no model call, nothing that needs a
 * network — every rule below is a function you can call in a test, which is the
 * point: these decide whether a client-facing report may be produced, and a rule
 * that only exists inside a renderer is a rule nobody can check.
 *
 * ── Why this extends `Finding` rather than replacing it ─────────────────────
 *
 * `Finding` is reviewdog's RDFormat, the shape every analyzer adapter in that
 * ecosystem already normalises to. Extending it means the deterministic pass
 * (OGE-2428) hands its output straight in, and none of the existing adapters
 * change.
 *
 * ── Confidence is not severity ──────────────────────────────────────────────
 *
 * They are orthogonal and must never collapse into one field. `severity` is how
 * bad it is if true. `confidence` is how sure we are that it is true. A
 * low-severity finding can be `verified`; a critical one can be
 * `not-determinable`. Reporting only their product is how a report ends up
 * either overclaiming or burying its most important open question.
 *
 * ── Confidence is COMPUTED, never asserted ──────────────────────────────────
 *
 * A model reporting its own confidence is a vibe. `verified` here means
 * something specific and mechanical: at least two independent verifiers tried
 * to refute the finding from its cited evidence and none succeeded (OGE-2430).
 * `verifiers` and `refutations` are carried on the finding so the claim can be
 * audited after the fact rather than trusted.
 */

import type { Finding } from "../findings/schema.js";

/**
 * How sure we are, as an outcome of the verification stage.
 *
 * - `verified`          — independently re-derived from the cited code.
 * - `inferred`          — supported, but depends on a link the code does not
 *                         close (a value set at deploy time, a caller outside
 *                         the repository).
 * - `not-determinable`  — cannot be settled without access we do not have.
 *                         Always carries a closure path; see `ClosurePath`.
 */
export type Confidence = "verified" | "inferred" | "not-determinable";

export const CONFIDENCES: readonly Confidence[] = ["verified", "inferred", "not-determinable"];

/**
 * A pointer at the evidence for a claim.
 *
 * `rev` is the pinned revision of the subject, repeated on every ref rather
 * than assumed, so a finding read in isolation still says which tree it was
 * true of. `null` when the subject arrived as an archive with no history — an
 * honest gap, not a blank to be filled in later.
 */
export interface EvidenceRef {
  /** Repo-relative path. */
  path: string;
  /** The subject revision this was read at, or null when there is no history. */
  rev: string | null;
  /** 1-based, matching every analyzer's convention. */
  line?: number;
  /** The excerpt relied on. Masked before it reaches a rendered report. */
  quote?: string;
}

/**
 * What would settle a `not-determinable` finding.
 *
 * Required on every one of them. A bare "we could not determine this" hands the
 * risk back to the buyer, which is the move that loses; "we could not determine
 * this, and here is the one hour of access that closes it" absorbs the risk,
 * which is the move that wins. The difference is this object.
 */
export interface ClosurePath {
  /** What we would need — "App Service configuration dump". */
  access: string;
  /** What we would do with it once we had it. */
  method: string;
  /** Our estimate, in hours. Someone signs off on this; keep it honest. */
  effortHours: number;
  /** Who has to act — "client exports the settings blade". */
  blocker: string;
}

export interface AuditFinding extends Finding {
  /** Stable across runs over the same tree, so two audits can be diffed. */
  id: string;
  /** Written by the verification stage. Never by the model that made the claim. */
  confidence: Confidence;
  evidence: EvidenceRef[];
  /** Required if and only if `confidence` is `not-determinable`. */
  closure?: ClosurePath;
  /** How many independent verifiers examined this claim. */
  verifiers: number;
  /** How many of them refuted it. */
  refutations: number;
}

/** One broken rule. `code` is stable; `detail` is for a human. */
export interface Violation {
  code:
    | "evidence-missing"
    | "closure-missing"
    | "closure-incomplete"
    | "unearned-verified"
    | "evidence-rev-mismatch"
    | "closure-not-applicable";
  detail: string;
  findingId: string;
}

/* ── The invariants ─────────────────────────────────────────────────────────
   Each is separately exported and separately testable. The renderer runs all
   of them; the verification stage runs some as it goes. They are the same
   functions in both places on purpose — a second copy is a second opinion. */

/**
 * 1. A claim must point at something.
 *
 * The exception is exact: a `not-determinable` finding is precisely the case
 * where the code does NOT contain the answer, so demanding a citation for it
 * would force either a fabricated reference or the finding's removal. Both are
 * worse than the gap.
 */
export function checkEvidencePresent(f: AuditFinding): Violation | null {
  if (f.confidence === "not-determinable") return null;
  if (f.evidence.length > 0) return null;
  return {
    code: "evidence-missing",
    findingId: f.id,
    detail: `"${f.confidence}" requires at least one evidence ref`,
  };
}

/** 2. Every `not-determinable` carries a usable closure path. */
export function checkClosurePresent(f: AuditFinding): Violation | null {
  if (f.confidence !== "not-determinable") {
    // A closure path on a settled finding means the confidence and the prose
    // disagree. Better to fail than to print a next step for a closed question.
    return f.closure
      ? {
          code: "closure-not-applicable",
          findingId: f.id,
          detail: `closure path on a "${f.confidence}" finding`,
        }
      : null;
  }

  if (!f.closure) {
    return {
      code: "closure-missing",
      findingId: f.id,
      detail: "not-determinable without a closure path",
    };
  }

  const { access, method, blocker, effortHours } = f.closure;
  const blank: string[] = [];
  if (!access.trim()) blank.push("access");
  if (!method.trim()) blank.push("method");
  if (!blocker.trim()) blank.push("blocker");
  if (!Number.isFinite(effortHours) || effortHours <= 0) blank.push("effortHours");

  return blank.length
    ? {
        code: "closure-incomplete",
        findingId: f.id,
        detail: `closure path missing: ${blank.join(", ")}`,
      }
    : null;
}

/** Minimum independent verifiers before a finding may be called `verified`. */
export const MIN_VERIFIERS = 2;

/**
 * 3. `verified` has to be earned.
 *
 * Two independent attempts to break it, and none succeeded. One verifier is an
 * opinion; a single refutation means the claim is live, not settled.
 */
export function checkVerifiedIsEarned(f: AuditFinding): Violation | null {
  if (f.confidence !== "verified") return null;
  if (f.verifiers >= MIN_VERIFIERS && f.refutations === 0) return null;
  return {
    code: "unearned-verified",
    findingId: f.id,
    detail: `verified needs >= ${MIN_VERIFIERS} verifiers and 0 refutations; got ${f.verifiers} and ${f.refutations}`,
  };
}

/**
 * 4. Every citation is against the revision actually audited.
 *
 * Skipped — not silently passed — when the subject has no revision, which is
 * what an archive with no history gives us. `subjectRev: null` means the check
 * cannot run, and the report says so in Coverage rather than implying it did.
 */
export function checkEvidenceRev(f: AuditFinding, subjectRev: string | null): Violation | null {
  if (subjectRev === null) return null;
  const stray = f.evidence.filter((e) => e.rev !== subjectRev);
  if (stray.length === 0) return null;
  return {
    code: "evidence-rev-mismatch",
    findingId: f.id,
    detail: `${stray.length} evidence ref(s) cite a different revision than ${subjectRev}`,
  };
}

/**
 * 5. Masking must be a no-op by the time anything is rendered.
 *
 * The check lives here; the call site is the renderer (OGE-2432). `maskSecrets`
 * is a defence, but if it CHANGES the text then a literal secret value reached
 * the report, and something upstream is wrong. Warn on a draft, refuse on a
 * release — a masked report is safe, but a pipeline that needed masking is not.
 *
 * Takes the masker as an argument so this module stays free of I/O: the real
 * one reads process env to collect known secrets.
 */
export function checkMaskIsNoop(
  rendered: string,
  mask: (text: string) => string,
): { clean: boolean; detail: string } {
  const masked = mask(rendered);
  if (masked === rendered) return { clean: true, detail: "no secret material in the rendered output" };
  return {
    clean: false,
    detail:
      "masking altered the rendered report, so a literal secret value reached it — " +
      "fix the source of the value, do not ship the masked copy",
  };
}

/** Every structural rule over one finding. Invariant 5 is separate: it needs rendered text. */
export function validateFinding(f: AuditFinding, subjectRev: string | null): Violation[] {
  return [
    checkEvidencePresent(f),
    checkClosurePresent(f),
    checkVerifiedIsEarned(f),
    checkEvidenceRev(f, subjectRev),
  ].filter((v): v is Violation => v !== null);
}

/**
 * Every rule over a whole report, plus the one rule about the set: ids must be
 * unique, or a re-audit diff silently merges two findings into one.
 */
export function validateFindings(
  findings: AuditFinding[],
  subjectRev: string | null,
): Violation[] {
  const out = findings.flatMap((f) => validateFinding(f, subjectRev));

  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.id)) {
      out.push({
        code: "evidence-missing",
        findingId: f.id,
        detail: `duplicate finding id "${f.id}" — a re-audit diff would merge these`,
      });
    }
    seen.add(f.id);
  }
  return out;
}

/** Counts by confidence, for the report's summary and the run's telemetry. */
export function countByConfidence(findings: AuditFinding[]): Record<Confidence, number> {
  const out: Record<Confidence, number> = {
    verified: 0,
    inferred: 0,
    "not-determinable": 0,
  };
  for (const f of findings) out[f.confidence] += 1;
  return out;
}

/**
 * Total access being asked of the client, aggregated across every open finding.
 *
 * Scattered caveats read as excuses; one consolidated ask reads as a plan. This
 * is what the report's closing section is built from.
 */
export function closureAsk(findings: AuditFinding[]): {
  totalHours: number;
  items: Array<{ findingId: string; access: string; effortHours: number; blocker: string }>;
} {
  const items = findings
    .filter((f) => f.confidence === "not-determinable" && f.closure)
    .map((f) => ({
      findingId: f.id,
      access: f.closure!.access,
      effortHours: f.closure!.effortHours,
      blocker: f.closure!.blocker,
    }));
  return { totalHours: items.reduce((n, i) => n + i.effortHours, 0), items };
}
