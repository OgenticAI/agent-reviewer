/**
 * What the sweep hands to the rest of the pipeline (OGE-2746).
 *
 * `sweep.ts` reads every file and emits signals. Nothing downstream consumes a
 * signal directly: the report renders findings, the dashboard stores findings,
 * the recall scorer matches findings. This module is the seam between the two
 * shapes, and it is deliberately the ONLY place a signal can become a finding,
 * because the rules for doing so are the rules that keep a pattern match from
 * being read as a reviewed result.
 *
 * ── The one rule that must not soften ───────────────────────────────────────
 *
 * A sweep finding is never `verified`. `verified` means two independent
 * verifiers tried to refute the claim from its cited evidence and could not.
 * A regex has not been refuted by anything; it has not been read by anything.
 * `inferred` is the most it can carry, and `verifiers: 0` says so on the
 * finding itself, so a reader who checks the number sees what happened rather
 * than trusting the label.
 *
 * Surface signals never become findings at all. An endpoint is not a defect,
 * and printing hundreds of them as findings would bury the handful of lines
 * that are. They are reported as counts in the Coverage section and nowhere
 * else.
 */

import type { AuditFinding, EvidenceRef } from "./finding.js";
import { findingId } from "./closure.js";
import type { FindingSeverity } from "../findings/schema.js";
import {
  summariseSignals,
  type FileDisposition,
  type FileOutcome,
  type Signal,
  type SignalKind,
  type SweepResult,
} from "./sweep.js";

/**
 * What `sweep.json` holds. Written by `audit sweep`, read by investigate and
 * render.
 *
 * `rev` is the revision the excerpts were read at, carried on the artifact
 * rather than assumed by its reader. `toSweepFindings` stamps a rev onto
 * every evidence ref, and before this field existed it stamped the subject's
 * current rev onto whatever sweep.json sat in the run directory; with an
 * `--out` reused across a re-acquire at another ref, lines and excerpts from
 * the old tree were cited against the new rev and the evidence gate passed,
 * because the rev had been assigned rather than read. Null when the tree had
 * no subject beside it, or a subject with no history.
 */
export interface SweepArtifact extends SweepResult {
  summary: ReturnType<typeof summariseSignals>;
  rev: string | null;
}

export function sweepArtifactFrom(result: SweepResult, rev: string | null): SweepArtifact {
  return { ...result, summary: summariseSignals(result.signals), rev };
}

/**
 * How a defect-class kind ranks, and what a match means in one sentence.
 *
 * Exhaustive over every kind, surface included, so adding a kind to the sweep
 * without deciding its rank here is a type error rather than a finding that
 * quietly lands at `info`. Surface kinds carry a rank they never use: they are
 * excluded before this table is consulted, and `toSweepFindings` is the only
 * reader.
 *
 * The ranking is by consequence if the line means what it appears to mean.
 * Rank is not confidence: an `error` here is still `inferred`, and the two
 * fields stay orthogonal as `finding.ts` requires.
 *
 * The meaning is prose for the report, so it must state the mechanism a reader
 * can check at the cited line, not restate the kind's name. No em dashes: this
 * text is emitted.
 */
const SWEEP_RULES: Record<SignalKind, { severity: FindingSeverity; meaning: string }> = {
  // Consequence: every authorisation decision downstream rests on it.
  "unvalidated-token": {
    severity: "error",
    meaning:
      "A token is decoded or accepted without its signature or expiry being checked, " +
      "so every authorisation decision downstream rests on a claim the caller could have written.",
  },
  "weak-password-hash": {
    severity: "error",
    meaning:
      "A password is hashed with a general-purpose digest rather than a purpose-built " +
      "password hash, so a leaked table is cheap to invert.",
  },
  "raw-sql": {
    severity: "error",
    meaning:
      "A SQL statement is assembled by concatenation or interpolation rather than " +
      "parameterised, so input can change the structure of the query.",
  },

  // Consequence depends on what sits behind the line, which a pattern cannot read.
  "anonymous-endpoint": {
    severity: "warning",
    meaning:
      "An endpoint is marked reachable without authentication. Whether that is intended " +
      "depends on what the handler does, which the sweep cannot read.",
  },
  "permissive-cors": {
    severity: "warning",
    meaning: "Cross-origin requests are accepted from any origin.",
  },
  "debug-enabled": {
    severity: "warning",
    meaning:
      "Debug output, tracing or a developer exception page is enabled, which discloses " +
      "internals to whoever triggers an error.",
  },
  "disabled-cert-validation": {
    severity: "warning",
    meaning:
      "TLS certificate validation is switched off, so the connection accepts any " +
      "certificate presented to it.",
  },
  "config-precedence": {
    severity: "warning",
    meaning:
      "A test or environment-specific settings file is loaded where its values can " +
      "override the production configuration.",
  },
  "identity-from-request": {
    severity: "warning",
    meaning:
      "An identity or tenant value is taken from a request header the caller controls, " +
      "ahead of the token's own claim.",
  },

  // Real when true, but the cited line rarely settles it on its own.
  "weak-crypto": {
    severity: "info",
    meaning:
      "A cryptographic primitive with known weaknesses is referenced. Whether it protects " +
      "anything depends on what is passed through it.",
  },
  "insecure-cookie": {
    severity: "info",
    meaning:
      "A cookie is configured without HttpOnly or Secure, or with an expiry mode that " +
      "extends a session indefinitely.",
  },

  // Surface. Never findings; ranked only so the table stays exhaustive.
  "http-endpoint": { severity: "info", meaning: "An HTTP route." },
  "authorization-check": { severity: "info", meaning: "An authorisation attribute." },
  "insecure-direct-object-reference": {
    severity: "info",
    meaning: "A by-id fetch through a data accessor.",
  },
  "missing-csrf-token": { severity: "info", meaning: "An anti-forgery attribute." },
  "sensitive-field": { severity: "info", meaning: "A field that names sensitive data." },
};

/** The rank a defect-class kind lands at. Exported for the report and for tests. */
export function sweepSeverity(kind: SignalKind): FindingSeverity {
  return SWEEP_RULES[kind].severity;
}

export const SWEEP_SOURCE = "sweep";

/**
 * Defect-class signals as findings. Surface signals are dropped here, on
 * purpose; see the module comment.
 *
 * ── Why the id is not `findingId(kind, statement, evidence)` as written ─────
 *
 * That helper hashes question, statement and first path, and NOT the line, so
 * a model finding that moved down a file keeps its id. Applied unchanged to
 * signals it collides: two `[AllowAnonymous]` in one controller are the same
 * kind, the same message and the same path, so they would share an id and
 * `validateFindings` would refuse the report as a duplicate. The excerpt goes
 * into the statement instead, and identical excerpts in one file are numbered
 * in file order. Two runs over an unchanged tree still diff clean; a line that
 * moved keeps its id; a line whose text changed gets a new one, which is right,
 * because the excerpt IS the evidence.
 */
export function toSweepFindings(signals: Signal[], subjectRev: string | null): AuditFinding[] {
  const seen = new Map<string, number>();
  const out: AuditFinding[] = [];

  for (const signal of signals) {
    if (signal.signalClass !== "defect") continue;

    const rule = SWEEP_RULES[signal.kind];
    // NUL-separated like findingId, and written as the escape rather than the
    // byte: a raw NUL makes grep skip the file (see source-hygiene.test.ts).
    const key = `${signal.path}\u0000${signal.kind}\u0000${signal.excerpt}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);

    const evidence: EvidenceRef[] = [
      { path: signal.path, rev: subjectRev, line: signal.line, quote: signal.excerpt },
    ];
    const standard = signal.owasp ? `${signal.cwe}; ${signal.owasp}` : signal.cwe;

    out.push({
      id: findingId(`sweep-${signal.kind}`, `${signal.excerpt}\u0000${ordinal}`, evidence),
      path: signal.path,
      position: { line: signal.line },
      message:
        `${rule.meaning} Matched by the sweep and not read by a reviewer; ` +
        `treat it as a candidate. ${standard}.`,
      severity: rule.severity,
      source: SWEEP_SOURCE,
      // The ceiling, never the floor. A pattern nothing with judgment has read
      // has not earned `verified`, and `verifiers: 0` records why.
      confidence: "inferred",
      evidence,
      verifiers: 0,
      refutations: 0,
    });
  }

  return out;
}

/**
 * Add sweep findings to a run's findings, letting a model finding on the same
 * line win.
 *
 * The model finding has been read, verified and closed; the sweep finding is
 * the pattern that would have pointed at the same line. Printing both tells the
 * reader the same thing twice at two confidences, and the lower one is noise.
 * Matched on every line the model finding cites, not only its first, because a
 * claim spanning two files is anchored at both.
 */
export function mergeSweepFindings(
  model: AuditFinding[],
  sweep: AuditFinding[],
): { findings: AuditFinding[]; added: number; displaced: number } {
  const taken = new Set<string>();
  for (const finding of model) {
    if (finding.position) taken.add(`${finding.path}:${finding.position.line}`);
    for (const ref of finding.evidence) {
      if (ref.line !== undefined) taken.add(`${ref.path}:${ref.line}`);
    }
  }

  const added: AuditFinding[] = [];
  let displaced = 0;
  for (const finding of sweep) {
    const line = finding.position?.line ?? finding.evidence[0]?.line;
    if (line !== undefined && taken.has(`${finding.path}:${line}`)) {
      displaced += 1;
      continue;
    }
    added.push(finding);
  }

  return { findings: [...model, ...added], added: added.length, displaced };
}

/**
 * Why files were not parsed, counted per reason, in a fixed order.
 *
 * A single "skipped" number hides the difference between a vendored bundle
 * and a permission error, and only one of those is the client's problem to
 * hear about. The order is by how much a reader should worry.
 */
export const SKIP_REASONS: readonly Exclude<FileOutcome, "read">[] = [
  "unreadable",
  "too-large",
  "binary",
];

export function skippedByReason(
  dispositions: FileDisposition[],
): Array<{ reason: Exclude<FileOutcome, "read">; count: number }> {
  return SKIP_REASONS.map((reason) => ({
    reason,
    count: dispositions.filter((d) => d.outcome === reason).length,
  })).filter((entry) => entry.count > 0);
}
