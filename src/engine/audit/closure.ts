/**
 * Closure paths (OGE-2431).
 *
 * Turns "we could not determine this" into "we could not determine this, and
 * here is the one hour of access that settles it".
 *
 * ── Why this exists, given calibration is not our differentiator ────────────
 *
 * We went into the research believing that labelling findings verified /
 * inferred / not-determinable was the thing that set us apart. It is not.
 * Trail of Bits already ships "Undetermined" as a printed severity class and
 * used it on 4 of 19 findings in a January 2025 assessment; SARIF has carried
 * `review` and `open` result kinds since 2019; CodeQL ships `@precision`,
 * Semgrep requires a `confidence` key, OpenVEX has `under_investigation`. CVSS
 * *had* a Report Confidence metric in v3.1 and deleted it in v4.0.
 *
 * The commercial evidence is worse than merely unsupportive. Where feedback on
 * an adviser's accuracy is unavailable or costly — which is exactly a
 * vendor-selection decision — confident advisers hold sway regardless of
 * accuracy, and people make *less* effort to check them.
 *
 * What survives is narrower and this module implements it: bounded claims are
 * not penalised, but VAGUE ones are. A bare "we could not determine this"
 * hands the risk back to the buyer, which is the losing move. The same finding
 * with an access, a method, an hour count and a named blocker absorbs the risk
 * instead. That difference is the whole of this file.
 */

import type { AuditFinding, ClosurePath, EvidenceRef } from "./finding.js";
import { closureAsk } from "./finding.js";
import type { VerifiedClaim } from "./verify.js";
import { severityFor } from "./severity.js";
import { createHash } from "node:crypto";

/**
 * Known kinds of access, with what they cost.
 *
 * A catalogue rather than a model call, deliberately. These estimates are
 * quoted against — someone signs off on the hours and the client plans around
 * them — so they belong in a reviewable file with a git history, not in a
 * sentence generated fresh each run. An unmatched access falls through to
 * `null` and the pipeline refuses to render until a human writes one, which is
 * the right failure: an invented estimate is worse than an absent one.
 */
export interface ClosureTemplate {
  /** Lower-case keywords; all must appear in the access text for a match. */
  match: string[];
  access: string;
  method: string;
  effortHours: number;
  blocker: string;
}

export const CLOSURE_CATALOGUE: readonly ClosureTemplate[] = [
  {
    match: ["configuration"],
    access: "A dump of the deployed configuration for the environment in question",
    method: "Compare the deployed values against what the repository would load, key by key",
    effortHours: 1,
    blocker: "Client exports the configuration from the hosting console",
  },
  {
    match: ["environment", "variable"],
    access: "The environment variables set on the running service",
    method: "Check which keys are pinned at deploy time and which fall through to a committed file",
    effortHours: 1,
    blocker: "Client exports the environment from the hosting console",
  },
  {
    match: ["container", "acl"],
    access: "The access policy on the storage container",
    method: "Read the container's public-access setting; no object is fetched",
    effortHours: 0.5,
    blocker: "Client reads the setting from the storage console",
  },
  {
    match: ["database"],
    access: "A read-only connection, or a schema dump",
    method: "Confirm the shape the code assumes matches what is deployed",
    effortHours: 2,
    blocker: "Client provisions read-only credentials, or exports the schema",
  },
  {
    match: ["log"],
    access: "A sample of production logs for the relevant window",
    method: "Confirm whether the path in question is reached, and how often",
    effortHours: 2,
    blocker: "Client exports a log sample with sensitive fields removed",
  },
  {
    match: ["runtime"],
    access: "A running instance, or a recording of the behaviour in question",
    method: "Exercise the path and observe what actually happens",
    effortHours: 4,
    blocker: "Client provides a non-production instance",
  },
  {
    match: ["pipeline"],
    access: "The deployment pipeline's run history",
    method: "Establish which commit is deployed and how it got there",
    effortHours: 1,
    blocker: "Client grants read access to the CI/CD project",
  },
  {
    match: ["credential"],
    access: "Confirmation of which credential the service uses, by name only",
    method: "Match the named credential against the code path; no value is requested or handled",
    effortHours: 0.5,
    blocker: "Client confirms the credential name",
  },
];

/**
 * Draft a closure path for an access requirement.
 *
 * `null` when nothing in the catalogue matches. That is not a failure to
 * handle gracefully — it is the signal that a human must write this one, and
 * `unresolvedClosures` below turns it into a gate.
 */
export function deriveClosure(needsAccess: string): ClosurePath | null {
  const text = needsAccess.toLowerCase();
  const template = CLOSURE_CATALOGUE.find((entry) => entry.match.every((word) => text.includes(word)));
  if (!template) return null;

  return {
    // The verifier's own words for what it lacked, kept so the finding reads as
    // an answer to its own question rather than a catalogue entry.
    access: `${template.access} — specifically: ${needsAccess}`,
    method: template.method,
    effortHours: template.effortHours,
    blocker: template.blocker,
  };
}

/* ── Verified claims become findings ──────────────────────────────────────── */

/**
 * A stable id, so two audits of the same tree diff instead of merging.
 *
 * Derived from the question, the statement and the first cited path — the three
 * things that identify a finding independently of how many times it is re-run.
 * Not the line number: a finding that moved down a file is the same finding.
 */
export function findingId(questionId: string, statement: string, evidence: EvidenceRef[]): string {
  const anchor = evidence[0]?.path ?? "(no-path)";
  const digest = createHash("sha256").update(`${questionId}\u0000${statement}\u0000${anchor}`).digest("hex");
  return `${questionId}-${digest.slice(0, 8)}`;
}

export interface ClosureResult {
  findings: AuditFinding[];
  /** Not-determinable findings the catalogue could not price. The gate. */
  unresolved: Array<{ id: string; needsAccess: string }>;
}

export interface ToFindingsOptions {
  verified: VerifiedClaim[];
  /** Severity is not this stage's to decide; the caller supplies it. */
  severityFor?: (claim: VerifiedClaim) => AuditFinding["severity"];
  source?: string;
}

/**
 * Turn verified claims into findings, attaching a closure path to every
 * not-determinable one.
 *
 * A not-determinable finding whose access the catalogue cannot price comes back
 * in `unresolved` rather than with a guessed estimate. The render refuses while
 * anything is unresolved, so the only way past is a real number someone will
 * stand behind.
 */
export function toAuditFindings(options: ToFindingsOptions): ClosureResult {
  // The real ranking rule by default; a caller may still override, e.g. to
  // feed an analyzer severity in for a finding that came from one.
  const decideSeverity = options.severityFor ?? ((entry: VerifiedClaim) => severityFor({ entry }));
  const source = options.source ?? "audit";

  const findings: AuditFinding[] = [];
  const unresolved: ClosureResult["unresolved"] = [];

  for (const entry of options.verified) {
    const { claim, confidence } = entry;
    const id = findingId(claim.questionId, claim.statement, claim.evidence);

    const finding: AuditFinding = {
      id,
      path: claim.evidence[0]?.path ?? "(no path)",
      message: claim.statement,
      severity: decideSeverity(entry),
      source,
      confidence,
      evidence: claim.evidence,
      verifiers: entry.verifiers,
      refutations: entry.refutations,
    };

    if (confidence === "not-determinable") {
      const needsAccess = entry.needsAccess ?? inferAccessFromAbsence(entry);
      const closure = needsAccess ? deriveClosure(needsAccess) : null;

      if (!closure) {
        unresolved.push({ id, needsAccess: needsAccess ?? "(no access named)" });
      } else {
        finding.closure = closure;
      }
    }

    findings.push(finding);
  }

  return { findings, unresolved };
}

/**
 * An absence claim downgraded for insufficient searching needs no client
 * access — it needs more work from us. Naming that honestly keeps it out of the
 * client's ask, where it does not belong.
 */
function inferAccessFromAbsence(entry: VerifiedClaim): string | null {
  if (!entry.claim.absence) return null;
  return "runtime confirmation that the behaviour is genuinely absent";
}

/* ── The consolidated ask ─────────────────────────────────────────────────── */

export interface ConsolidatedAsk {
  totalHours: number;
  /** One line per distinct blocker, so the client sees who must do what. */
  byBlocker: Array<{ blocker: string; hours: number; access: string[] }>;
  openFindings: number;
}

/**
 * Every open finding's access requirement, gathered into one ask.
 *
 * Scattered caveats read as excuses; one priced list reads as a plan. Grouped
 * by blocker because that is the unit of action — one person exports one thing
 * and several findings close at once, which is a much easier conversation than
 * five separate requests.
 */
export function consolidateAsk(findings: AuditFinding[]): ConsolidatedAsk {
  const ask = closureAsk(findings);

  const groups = new Map<string, { hours: number; access: Set<string> }>();
  for (const item of ask.items) {
    const group = groups.get(item.blocker) ?? { hours: 0, access: new Set<string>() };
    group.hours += item.effortHours;
    group.access.add(item.access);
    groups.set(item.blocker, group);
  }

  return {
    totalHours: ask.totalHours,
    openFindings: ask.items.length,
    byBlocker: [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([blocker, group]) => ({
        blocker,
        hours: group.hours,
        access: [...group.access].sort(),
      })),
  };
}

/** The report's closing section. Generated from the findings, never authored. */
export function renderAsk(ask: ConsolidatedAsk): string[] {
  if (ask.openFindings === 0) {
    return ["No open questions require further access."];
  }

  const lines = [
    `${ask.openFindings} finding(s) could not be settled from the source alone.`,
    `Closing all of them needs an estimated ${ask.totalHours} hour(s) once access is granted:`,
    "",
  ];
  for (const group of ask.byBlocker) {
    lines.push(`  ${group.blocker} — ${group.hours} hour(s)`);
    for (const access of group.access) lines.push(`    · ${access}`);
  }
  return lines;
}

/**
 * The gate.
 *
 * A not-determinable finding with no priced closure path must not reach a
 * report. `checkClosurePresent` in `finding.ts` catches one that is malformed;
 * this catches one that was never drafted, before the renderer is even called.
 */
export function assertAllClosuresResolved(result: ClosureResult): void {
  if (result.unresolved.length === 0) return;

  const detail = result.unresolved
    .map((entry) => `  ${entry.id}: needs "${entry.needsAccess}" — no catalogue entry, no estimate`)
    .join("\n");

  throw new Error(
    `${result.unresolved.length} not-determinable finding(s) have no closure path:\n${detail}\n` +
      `Add a template to CLOSURE_CATALOGUE, or write the closure by hand. ` +
      `A bare "not determinable" hands the risk back to the client, which is the one thing this stage exists to prevent.`,
  );
}
