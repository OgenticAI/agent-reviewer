/**
 * The client-ready report (OGE-2432).
 *
 * `findings.json` is the artifact; the PDF is derivable from it. Same principle
 * as the podcast pipeline: keep the structured file canonical, shell out to one
 * static binary, and make the same input produce the same bytes.
 *
 * ── Why the structure is borrowed rather than invented ──────────────────────
 *
 * Project Summary → Executive Summary → Goals → Targets → Coverage → Automated
 * Testing → Codebase Maturity → Findings → Notices. That is the Trail of Bits
 * convention, and it is used here because a buyer's technical adviser
 * recognises it on sight. We differentiate INSIDE the structure — with computed
 * coverage, per-finding confidence and priced closure paths — not by inventing
 * a shape nobody can place.
 *
 * Order matters commercially, not just editorially. Expressed uncertainty
 * raises credibility only for a source already read as expert, so method and
 * coverage come before any bounded claim. Hedging before demonstrating
 * competence reads as incompetence.
 *
 * ── Two gates ───────────────────────────────────────────────────────────────
 *
 * Invariants (OGE-2427) must hold, and masking must be a no-op. If masking
 * CHANGES the rendered text then a literal secret reached the report: warn on a
 * draft, refuse on a release. A masked report is safe to read; a pipeline that
 * needed masking is not safe to trust, because the next value might not be one
 * we know to mask.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AuditFinding, Confidence, DroppedCitation } from "./finding.js";
import { validateFindings, countByConfidence } from "./finding.js";
import { consolidateAsk, renderAsk } from "./closure.js";
import { COVERAGE_CAVEAT, type Coverage } from "./inventory.js";
import {
  ALL_FILES,
  skippedAnalyzerNotes,
  type LanguageAnalyzerCoverage,
} from "./analyze.js";
import {
  assessMaturity,
  isJudgement,
  maturityCaveat,
  renderTargets,
  type QuestionOutcome,
} from "./maturity.js";
import type { JobFindings } from "../findings/schema.js";
import { redactUrl, type Subject } from "./acquire.js";
import {
  skippedByReason,
  SWEEP_SOURCE,
  type SweepArtifact,
} from "./sweep-findings.js";
import { describeVerification, type VerificationSummary } from "./verify.js";

const run = promisify(execFile);

/* ── Escaping ─────────────────────────────────────────────────────────────── */

/**
 * Escape text for Typst markup.
 *
 * Finding text comes out of a client codebase and lands inside markup. Typst
 * reads `#` as a code expression, `$` as maths, `*` and `_` as emphasis, `@` as
 * a reference, and backslash as an escape. A finding quoting an attribute or a
 * shell snippet would otherwise break the compile or silently reformat the
 * page — the same shape as an injection bug, with the same fix: escape at the
 * boundary and never trust the interpolation.
 */
export function escapeTypst(text: string): string {
  return text
    .replace(/[\\#$*_@<>`"]/g, (char) => `\\${char}`)
    .replace(/\r?\n/g, " ");
}

/* ── The report model ─────────────────────────────────────────────────────── */

export interface ReportInput {
  subject: Subject;
  findings: AuditFinding[];
  coverage: Coverage;
  analyzerJobs: JobFindings[];
  analyzerReach: Record<string, LanguageAnalyzerCoverage>;
  questionCount: number;
  /**
   * What the investigation managed to ask, for the maturity table.
   *
   * Absent on a render that has no run record, in which case the maturity
   * section is omitted rather than rated on nothing — a table of `Not Assessed`
   * produced because the renderer lacked its input, rather than because the
   * questions did not run, would be a different lie in the same place.
   */
  questionOutcomes?: QuestionOutcome[];
  /** Directory names the walk skipped, for Targets. */
  excluded?: string[];
  /**
   * What the sweep read and matched, for Coverage (OGE-2746).
   *
   * Absent when no sweep ran. That is not silently the same document minus a
   * table: the section says the sweep did not run, because the coverage figure
   * above it then rests on the investigation alone, which opens files at its
   * own discretion and has been measured opening 2% of them.
   */
  sweep?: SweepArtifact;
  /**
   * Whether the investigation folded the sweep's candidates into `findings`.
   *
   * The CLI knows from file order: a sweep.json newer than findings.json was
   * never merged, because the merge happens in investigate and only there.
   * Absent means "as far as the caller knows, yes"; the section still checks
   * the findings themselves, since candidates with no sweep-sourced finding
   * to show for them were not merged whatever the caller believed.
   */
  sweepMerged?: boolean;
  /**
   * What verification kept and threw away, for Coverage.
   *
   * Absent on a run that predates the record, in which case the line is
   * omitted. It cannot be recomputed from `findings`: a rejected claim leaves
   * no finding, and the count of what was thrown away is the whole point.
   */
  verification?: VerificationSummary;
  /** Present only once a named person has released it. Absent means DRAFT. */
  release?: { by: string; at: string };
}

/**
 * Which branch the revision came from, and whether anyone chose it.
 *
 * A missing field covers subjects written before these existed: an older run
 * genuinely does not know, and saying so beats implying a branch was confirmed.
 */
function branchLine(subject: Subject): string {
  if (subject.requestedRef) return subject.requestedRef;
  if (subject.defaultBranch) {
    return `${subject.defaultBranch} (the repository's default; no branch was specified for this review)`;
  }
  return "not recorded for this run";
}

/**
 * What to call the subject on the cover.
 *
 * `origin` is whatever was handed to acquire. For a remote clone that is a
 * repository URL, which is exactly right. For a local path it is a directory on
 * the analyst's machine — meaningless to the reader, and it puts our own
 * filesystem layout in a document that leaves the building.
 *
 * The fallback is `name`, which acquire takes from the directory it cloned
 * into. That makes the cover of a locally-acquired report only as good as the
 * directory name, so acquire into something named after the subject.
 *
 * The origin is redacted again here even though acquire already did it: a
 * subject.json written before acquire learned to can still carry a token in
 * the URL, and this is the last line before it is typeset onto the cover.
 */
export function subjectLabel(subject: Subject): string {
  const origin = redactUrl(subject.origin);
  const remote =
    /^(https?:\/\/|git@|ssh:\/\/)/.test(origin) ||
    origin.includes(".org/") ||
    origin.includes(".com/");
  return remote ? origin : subject.name;
}

/**
 * Codebase Maturity, or nothing.
 *
 * Omitted entirely when the run record is absent. A table rated on missing
 * input would read exactly like a table rated on unanswered questions, and the
 * reader has no way to tell those apart — so the honest output is no table.
 */
function maturitySection(input: ReportInput): string[] {
  // No run record, or a record naming no questions. Both mean the table would
  // be rated on nothing — and a table of "Not Applicable" produced because the
  // renderer lacked its input reads exactly like one produced because the
  // questions genuinely do not apply. The reader cannot tell those apart, so
  // the honest output is no table.
  if (!input.questionOutcomes || input.questionOutcomes.length === 0) return [];

  const assessments = assessMaturity(input.findings, input.questionOutcomes);

  const rows = assessments.flatMap((a) => [
    `[${escapeTypst(a.name)}], [${a.rating}], [${a.answered}/${a.asked}], [${a.findings}],`,
  ]);

  return [
    "= Codebase Maturity",
    "",
    "#table(",
    "  columns: 4,",
    "  [*Category*], [*Rating*], [*Questions answered*], [*Findings*],",
    ...rows.map((r) => `  ${r}`),
    ")",
    "",
    // The answered column beside the rating is the whole design: a rating that
    // rests on one of three questions is visibly thin rather than quietly thin.
    `#emph[${escapeTypst(maturityCaveat(assessments))}]`,
    "",
    ...(assessments.some((a) => !isJudgement(a.rating))
      ? [
          "#emph[" +
            escapeTypst(
              "Not Assessed and Not Applicable are not ratings. The first means no question in " +
                "this review reached that category; the second means it does not apply to this " +
                "codebase. Neither is a statement that the category is sound.",
            ) +
            "]",
          "",
        ]
      : []),
  ];
}

export const SEVERITY_ORDER: readonly AuditFinding["severity"][] = [
  "error",
  "warning",
  "info",
  "unknown",
];
export const CONFIDENCE_ORDER: readonly Confidence[] = [
  "verified",
  "inferred",
  "not-determinable",
];

/**
 * Findings in reading order: worst first, and within a severity the ones we can
 * stand behind before the ones we cannot.
 *
 * Sorted rather than left in discovery order so two runs put the same finding
 * in the same place — a report that reshuffles cannot be diffed against the
 * next audit.
 */
export function orderFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => {
    const bySeverity =
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (bySeverity !== 0) return bySeverity;
    const byConfidence =
      CONFIDENCE_ORDER.indexOf(a.confidence) -
      CONFIDENCE_ORDER.indexOf(b.confidence);
    if (byConfidence !== 0) return byConfidence;
    return a.id.localeCompare(b.id);
  });
}

/* ── Sections ─────────────────────────────────────────────────────────────── */

function coverageSection(input: ReportInput): string[] {
  const { coverage, subject } = input;
  const lines = [
    "= Coverage",
    "",
    `This review read ${coverage.opened} of ${coverage.total} files in the subject `,
    `(${Math.round(coverage.share * 100)}%), across ${subject.loc.toLocaleString()} lines.`,
    "",
    `#emph[${escapeTypst(COVERAGE_CAVEAT)}]`,
    "",
    ...sweepSection(input),
    "== By area",
    "",
    "#table(",
    "  columns: 3,",
    "  [*Area*], [*Files*], [*Opened*],",
  ];

  for (const [area, slice] of Object.entries(coverage.byArea)) {
    lines.push(
      `  [${escapeTypst(area)}], [${slice.total}], [${slice.opened}],`,
    );
  }
  lines.push(")", "");

  if (coverage.unreadable.length > 0) {
    lines.push(
      "== Files this review could not read",
      "",
      "These were attempted and could not be opened. They are counted as not covered.",
      "",
    );
    for (const path of coverage.unreadable)
      lines.push(`- ${escapeTypst(path)}`);
    lines.push("");
  }

  // The provenance gap is stated, never omitted.
  if (subject.rev === null) {
    lines.push(
      "== Revision",
      "",
      escapeTypst(
        `The subject carried no version history (${subject.revProvenance}). ` +
          "Findings cite paths but cannot cite a revision, and no history-derived " +
          "signal — churn, contributor concentration, change cadence — was available.",
      ),
      "",
    );
  }

  lines.push(...verificationSection(input));

  return lines;
}

/** Why a citation was dropped, in words a reader can act on. No em dash. */
function droppedBecause(citation: DroppedCitation): string {
  switch (citation.reason) {
    case "quote-absent":
      return "the quoted text is nowhere in the file";
    case "quote-ambiguous":
      return `the quoted text is at ${citation.occurrences ?? "several"} lines of the file and the cited line is not one of them`;
    case "line-beyond-eof":
      return "the cited line is past the end of the file and the quoted text is nowhere in it";
    case "file-unreadable":
      return "the file could not be read";
    case "not-a-line-reference":
      return "the reference is a directory or names no line";
  }
}

/**
 * How many claims verification threw away, and why.
 *
 * The same line the operator saw at the terminal, from the same function. A
 * report that shows only the findings that survived reads as if that were all
 * the investigation produced; a reader weighing 21 findings should know they
 * are what was left of 75, and that 54 went for three different reasons, of
 * which only one is fabrication. Omitted, not zeroed, when the run left no
 * record. Emitted text carries no em dash.
 */
function verificationSection(input: ReportInput): string[] {
  const { verification } = input;
  if (!verification) return [];
  return [
    "== Claims and verification",
    "",
    escapeTypst(
      `Verification examined ${verification.examined} claim(s); ${describeVerification(verification)}. ` +
        "A rejected claim does not appear in this report. A claim corrected for line drift " +
        "does, with its citation moved to the line the quoted text is on and its confidence " +
        "capped at inferred, because its author cited the line from memory rather than from the file. " +
        "A claim that cited something the check could not find keeps only the citations that held, " +
        "is capped at inferred for the same reason, and names what was dropped under its evidence.",
    ),
    "",
  ];
}

/**
 * What the sweep read, and what it matched.
 *
 * Two tables rather than one, with defect candidates first, because the two
 * classes mean different things and a reader skimming one table reads them as
 * the same kind of row. A surface count is a denominator; a defect candidate
 * is a line under Detailed Findings. The distinction is the whole reason the
 * sweep separates them, so the report cannot fold them back together.
 *
 * The promise that a candidate "appears under Detailed Findings" is only made
 * when it is true. The merge happens in investigate, so a sweep that ran after
 * it left candidates in sweep.json and nothing in findings.json; the table
 * then says so rather than pointing at findings that are not there.
 *
 * Emitted text carries no em dash; hyphens and semicolons only.
 */
function sweepSection(input: ReportInput): string[] {
  const { sweep } = input;
  const lines = ["== Read by the sweep", ""];

  if (!sweep) {
    lines.push(
      "No sweep ran for this review. The figure above rests on the investigation alone,",
      "which opens files at its own discretion; it is a floor on what was read, not a",
      "statement that the rest was seen.",
      "",
    );
    return lines;
  }

  const reasons = skippedByReason(sweep.dispositions)
    .map((entry) => `${entry.count} ${entry.reason}`)
    .join(", ");
  const candidates = sweep.summary
    .filter((row) => row.signalClass === "defect")
    .reduce((n, row) => n + row.count, 0);
  const sweepFindings = input.findings.filter((f) => f.source === SWEEP_SOURCE).length;
  const folded = (input.sweepMerged ?? true) && !(candidates > 0 && sweepFindings === 0);

  lines.push(
    `The sweep visited every file in the tree: ${sweep.total} visited, ${sweep.read} parsed, ` +
      `${sweep.skipped} not parsed${reasons ? ` (${escapeTypst(reasons)})` : ""}.`,
    "",
    "#emph[" +
      escapeTypst(
        "The sweep matches known-bad shapes by pattern over every parsed file. A defect " +
          "candidate is a line that matches one; " +
          (folded
            ? "it appears under Detailed Findings at inferred confidence with source sweep, " +
              "and has not been read by a reviewer. "
            : "it has not been read by a reviewer. ") +
          "A surface count is a measure of size, not a defect.",
      ) +
      "]",
    "",
  );
  if (!folded) {
    lines.push(
      "#strong[" +
        escapeTypst(
          `NOT FOLDED INTO FINDINGS: the sweep matched ${candidates} defect candidate(s) and ` +
            "the investigation did not merge them, because the sweep ran after it. They are " +
            "counted below by kind and are not under Detailed Findings" +
            (sweepFindings > 0
              ? `; the ${sweepFindings} sweep-sourced finding(s) there come from an earlier sweep`
              : "") +
            ". Re-run the investigation stage over this run directory to add them.",
        ) +
        "]",
      "",
    );
  }

  const table = (rows: SweepArtifact["summary"]): string[] => [
    "#table(",
    "  columns: 3,",
    "  [*Kind*], [*Matches*], [*Files*],",
    ...rows.map((row) => `  [${escapeTypst(row.kind)}], [${row.count}], [${row.files}],`),
    ")",
    "",
  ];

  const defects = sweep.summary.filter((row) => row.signalClass === "defect");
  const surface = sweep.summary.filter((row) => row.signalClass === "surface");

  lines.push("=== Defect candidates", "");
  lines.push(...(defects.length > 0 ? table(defects) : ["No defect pattern matched.", ""]));
  lines.push("=== Surface", "");
  lines.push(...(surface.length > 0 ? table(surface) : ["No surface pattern matched.", ""]));

  return lines;
}

/**
 * Automated Testing, generated from what actually ran.
 *
 * Every skipped analyzer is printed with its reason, and every language nothing
 * reached is named. This is the section a reader uses to judge how much the
 * rest of the report is worth, so it is assembled from the run record rather
 * than written from memory afterwards.
 *
 * Reach is printed as the tool measured it: files scanned, per analyzer and
 * per language. The parity sentence ("every configured analyzer ran over every
 * language present") is printed only when every analyzer that ran recorded
 * what it read. A run that did not measure its reach cannot claim parity, and
 * the older records this renderer still accepts did not measure it.
 */
function automatedTestingSection(input: ReportInput): string[] {
  const lines = ["= Automated Testing", ""];

  for (const job of input.analyzerJobs) {
    const name = `*${escapeTypst(job.job)}*${job.toolVersion ? ` (${escapeTypst(job.toolVersion)})` : ""}`;
    if (!job.parsed) {
      lines.push(`- ${name}: #strong[did not run]: ${escapeTypst(job.reason ?? "no reason recorded")}.`);
    } else {
      const reach = Array.isArray(job.scannedPaths)
        ? `read ${job.scannedPaths.length} file(s)`
        : "reach not measured on this run";
      lines.push(`- ${name}: ran, ${job.findings.length} finding(s); ${reach}.`);
    }
    if (job.neutralised && job.neutralised.length > 0) {
      lines.push(
        `  - Configuration in the tree moved aside for the scan, so the subject could not silence it: ${job.neutralised.map(escapeTypst).join(", ")}.`,
      );
    }
    for (const problem of (job.errors ?? []).slice(0, MAX_PROBLEMS_SHOWN)) {
      lines.push(`  - Reported while scanning: ${escapeTypst(problem)}`);
    }
    const hidden = (job.errors ?? []).length - MAX_PROBLEMS_SHOWN;
    if (hidden > 0) lines.push(`  - and ${hidden} more problem(s) recorded in analyzers.json`);
  }
  lines.push("");

  const rows = Object.entries(input.analyzerReach).sort(([a], [b]) =>
    a === ALL_FILES ? 1 : b === ALL_FILES ? -1 : a.localeCompare(b),
  );
  const measuredRows = rows.filter(([, reach]) => Object.keys(reach.scanned ?? {}).length > 0);
  if (measuredRows.length > 0) {
    lines.push(
      "== What each analyzer read, by language",
      "",
      "Counted from each tool's own record of the files it read, not from what it",
      "was configured to reach. The last row is the content scanners, which read",
      "every file regardless of language.",
      "",
      "#table(",
      "  columns: 3,",
      "  [*Language*], [*Files*], [*Read by*],",
    );
    for (const [language, reach] of measuredRows) {
      const read = Object.entries(reach.scanned ?? {})
        .map(([job, count]) => `${escapeTypst(job)} ${count}`)
        .join("; ");
      lines.push(`  [${escapeTypst(language)}], [${reach.files}], [${read || "nothing"}],`);
    }
    lines.push(")", "");
  }

  const untouched = rows
    .filter(([language]) => language !== ALL_FILES)
    .filter(([, reach]) => reach.files > 0 && reach.analyzers.length === 0)
    .filter(([, reach]) => Object.values(reach.scanned ?? {}).every((count) => count === 0));

  if (untouched.length > 0) {
    lines.push(
      "== Languages no automated analysis reached",
      "",
      "No deterministic analyzer read a file in these. They were reviewed by",
      "reading only, which is a weaker signal and is stated here rather than implied.",
      "",
    );
    for (const [language, reach] of untouched) {
      lines.push(`- ${escapeTypst(language)}: ${reach.files} file(s)`);
    }
    lines.push("");
  }

  const skips = skippedAnalyzerNotes(input.analyzerJobs);
  const measured =
    input.analyzerJobs.length > 0 && input.analyzerJobs.every((job) => Array.isArray(job.scannedPaths));
  if (skips.length === 0 && untouched.length === 0) {
    lines.push(
      measured
        ? "Every configured analyzer ran over every language present, by its own count of the files it read."
        : "Every configured analyzer ran. Whether each reached every language present was not measured on this run, so no parity is claimed.",
      "",
    );
  }

  return lines;
}

/** Problems printed per analyzer before the rest is left to analyzers.json. */
const MAX_PROBLEMS_SHOWN = 5;

function findingsSection(findings: AuditFinding[]): string[] {
  const counts = countByConfidence(findings);
  const lines = [
    "= Summary of Findings",
    "",
    "#table(",
    "  columns: 2,",
    "  [*Confidence*], [*Count*],",
    `  [Verified], [${counts.verified}],`,
    `  [Inferred], [${counts.inferred}],`,
    `  [Not determinable], [${counts["not-determinable"]}],`,
    ")",
    "",
    escapeTypst(
      "Confidence is separate from severity. A verified finding is one at least two " +
        "independent reviewers tried to refute from its cited evidence and could not. " +
        "It is not a statement about how serious the finding is.",
    ),
    "",
    "= Detailed Findings",
    "",
  ];

  for (const finding of orderFindings(findings)) {
    lines.push(
      `== ${escapeTypst(finding.id)}`,
      "",
      `*Severity:* ${escapeTypst(finding.severity)} · *Confidence:* ${escapeTypst(finding.confidence)}` +
        // Named so a reader can tell mechanical detection from reasoning
        // without opening the JSON. The sweep's rows say so twice: here, and
        // in the message that ends every one of them.
        ` · *Source:* ${escapeTypst(finding.source)}${finding.source === SWEEP_SOURCE ? " (pattern match, not reviewed)" : ""}`,
      "",
      escapeTypst(finding.message),
      "",
    );

    if (finding.evidence.length > 0) {
      lines.push("*Evidence*", "");
      for (const ref of finding.evidence) {
        const where =
          ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
        // A moved citation says so. The line printed is where the quoted text
        // is; the line the claim gave is kept beside it, so a reader who
        // opens the file at the number sees the text, and a reader weighing
        // the finding sees that its author did not.
        const moved = ref.corrected
          ? ` (the claim cited line ${ref.corrected.citedLine}` +
            `${ref.corrected.beyondEof ? ", past the end of the file" : ""}; ` +
            `the quoted text is at line ${ref.line})`
          : "";
        lines.push(`- ${escapeTypst(where + moved)}`);
      }
      lines.push("");
    }

    // What the claim cited and the check could not find, named. Under its own
    // heading and not among the evidence, because nothing rests on it; but on
    // the page, because a reader weighing the finding should know its author
    // cited something that is not there. No quote is printed: the text was
    // not found, and the report does not carry text the tree does not.
    if (finding.dropped && finding.dropped.length > 0) {
      lines.push("*Cited and not relied on*", "");
      for (const citation of finding.dropped) {
        lines.push(
          `- ${escapeTypst(`${citation.path}:${citation.line} (${droppedBecause(citation)})`)}`,
        );
      }
      lines.push("");
    }

    if (finding.confidence === "verified") {
      lines.push(
        `#emph[${finding.verifiers} independent reviewers attempted to refute this; none succeeded.]`,
        "",
      );
    }

    if (finding.closure) {
      lines.push(
        "*What would settle this*",
        "",
        `- Access needed: ${escapeTypst(finding.closure.access)}`,
        `- Method: ${escapeTypst(finding.closure.method)}`,
        `- Estimated effort: ${finding.closure.effortHours} hour(s)`,
        `- Who must act: ${escapeTypst(finding.closure.blocker)}`,
        "",
      );
    }
  }

  return lines;
}

const NOTICES = [
  "= Notices and Remarks",
  "",
  "This review read source code only. No running system, database, deployed",
  "configuration or production log was available to it. Findings marked",
  "#emph[not determinable] are the specific questions that state could not answer,",
  "and each carries what would answer it.",
  "",
  "Coverage in this report means the share of files opened. It is not a statement",
  "about the share of defects found, and the two should not be read as the same",
  "number.",
  "",
  "Where a finding concerns a credential, this report records its location and",
  "never its value.",
  "",
];

/* ── Assembly ─────────────────────────────────────────────────────────────── */

export interface RenderOptions {
  input: ReportInput;
  /** Executive summary body. Authored, not generated — see the report template. */
  executiveSummary: string;
}

export function renderTypst(options: RenderOptions): string {
  const { input } = options;
  const released = input.release !== undefined;

  const preamble = [
    "#set page(",
    '  paper: "a4",',
    "  margin: 2.2cm,",
    released
      ? "  header: none,"
      : '  background: rotate(45deg, text(60pt, fill: rgb("#e8e8e8"))[DRAFT — NOT FOR DISTRIBUTION]),',
    ")",
    '#set text(font: "New Computer Modern", size: 10pt)',
    "#set heading(numbering: none)",
    "",
  ];

  const front = [
    `#align(center)[#text(20pt)[*Codebase Review*]]`,
    "",
    "= Project Summary",
    "",
    `*Subject:* ${escapeTypst(subjectLabel(input.subject))}`,
    "",
    `*Revision:* ${escapeTypst(input.subject.rev ?? `none — ${input.subject.revProvenance}`)}`,
    "",
    // A commit alone does not say which branch it came from. A reader who
    // assumes it is the deployed one, when the remote's default was a branch
    // dormant for months, is reading a report about a codebase that moved on.
    // Loudest when nothing was pinned, because that is when it is wrong.
    `*Branch:* ${escapeTypst(branchLine(input.subject))}`,
    "",
    `*Reviewed:* ${escapeTypst(input.subject.acquiredAt.slice(0, 10))}`,
    "",
    `*Size:* ${input.subject.files.toLocaleString()} files, ${input.subject.loc.toLocaleString()} lines`,
    "",
    released
      ? `*Released by* ${escapeTypst(input.release!.by)} on ${escapeTypst(input.release!.at)}`
      : "*Status:* DRAFT — not for distribution",
    "",
    "= Executive Summary",
    "",
    escapeTypst(options.executiveSummary),
    "",
    "= Goals",
    "",
    `This review answered ${input.questionCount} questions agreed in advance. Anything`,
    "outside that set is out of scope by agreement rather than by omission.",
    "",

    "= Targets",
    "",
    ...renderTargets({
      // Same belt and braces as subjectLabel: the Targets section prints the
      // origin in full, and an older subject.json may carry a credential.
      origin: escapeTypst(redactUrl(input.subject.origin)),
      name: escapeTypst(subjectLabel(input.subject)),
      rev: input.subject.rev,
      revProvenance: escapeTypst(input.subject.revProvenance),
      files: input.subject.files,
      loc: input.subject.loc,
      excluded: (input.excluded ?? []).map(escapeTypst),
    }),

    ...maturitySection(input),
  ];

  const ask = consolidateAsk(input.findings);

  return [
    ...preamble,
    ...front,
    ...coverageSection(input),
    ...automatedTestingSection(input),
    ...findingsSection(input.findings),
    "= What would close the open questions",
    "",
    ...renderAsk(ask).map((line) => escapeTypst(line)),
    "",
    ...NOTICES,
  ].join("\n");
}

/* ── Gates and compilation ────────────────────────────────────────────────── */

/**
 * Would this Coverage section be a lie?
 *
 * Coverage comes from the access log the investigation stage writes. If that
 * artifact is lost, `computeCoverage` still returns a well-formed object — it
 * just says nothing was opened. That renders as "read 0 of 224 files (0%)",
 * which is not a cautious understatement but a false one: the run did read
 * those files, and a client shown 0% draws the wrong conclusion about what
 * they paid for.
 *
 * A number derived from a missing input is the failure mode this whole engine
 * is built against, so it refuses rather than prints. An empty tree is the one
 * honest zero, and it is allowed.
 */
export function checkCoverageIsReal(coverage: Coverage): string | null {
  if (coverage.total === 0 || coverage.opened > 0) return null;
  return (
    `Coverage says 0 of ${coverage.total} files were opened. ` +
    `That is what a missing access log looks like, not what a completed run looks like. ` +
    `Re-run the investigation stage, or point --out at the directory holding its access-log.json.`
  );
}

export class RenderRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderRefused";
  }
}

export interface MaskCheck {
  clean: boolean;
  detail: string;
}

/**
 * Masking must be a no-op by render time.
 *
 * If it fires, the defence worked AND something upstream failed. The masked
 * copy is safe to read and unsafe to ship, because the next value might not be
 * one we know to mask — so a draft warns and a release refuses.
 */
export function checkMask(
  rendered: string,
  mask: (text: string) => string,
): MaskCheck {
  const masked = mask(rendered);
  if (masked === rendered)
    return { clean: true, detail: "no secret material in the rendered output" };
  return {
    clean: false,
    detail:
      "masking altered the rendered report, so a literal secret value reached it — " +
      "fix the source of the value; do not ship the masked copy",
  };
}

export interface RenderResult {
  typstSource: string;
  typstPath: string;
  pdfPath: string | null;
  /** Set when the PDF could not be produced. The .typ is still written. */
  pdfSkipped?: string;
  warnings: string[];
}

export interface RenderReportOptions extends RenderOptions {
  outDir: string;
  mask: (text: string) => string;
  subjectRev: string | null;
}

/**
 * Render the report.
 *
 * Refuses on a broken invariant, always. Refuses on a mask hit only for a
 * release; a draft warns, so an operator can see what leaked and fix its source
 * rather than being locked out of their own working copy.
 */
export async function renderReport(
  options: RenderReportOptions,
): Promise<RenderResult> {
  const violations = validateFindings(
    options.input.findings,
    options.subjectRev,
  );
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `  ${v.findingId}: ${v.code} — ${v.detail}`)
      .join("\n");
    throw new RenderRefused(
      `${violations.length} finding(s) break a report invariant:\n${detail}`,
    );
  }

  const unreal = checkCoverageIsReal(options.input.coverage);
  if (unreal) throw new RenderRefused(unreal);

  const typstSource = renderTypst(options);
  const released = options.input.release !== undefined;
  const warnings: string[] = [];

  const mask = checkMask(typstSource, options.mask);
  if (!mask.clean) {
    if (released) throw new RenderRefused(mask.detail);
    warnings.push(`DRAFT ONLY — ${mask.detail}`);
  }

  const typstPath = join(options.outDir, "report.typ");
  writeFileSync(typstPath, `${typstSource}\n`);

  const pdfPath = join(options.outDir, "report.pdf");
  try {
    await run("typst", ["compile", typstPath, pdfPath], {
      timeout: 5 * 60 * 1000,
      env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch(options) },
    });
  } catch (error) {
    const detail = describeTypstFailure(error);
    // The .typ is the artifact that matters; a missing binary must not lose it.
    return {
      typstSource,
      typstPath,
      pdfPath: null,
      pdfSkipped: detail,
      warnings,
    };
  }

  return { typstSource, typstPath, pdfPath, warnings };
}

/**
 * The timestamp typst stamps into the PDF, pinned so two renders of one audit
 * are byte-identical.
 *
 * Without this the `.typ` is reproducible and the PDF is not: typst writes the
 * wall clock into `/CreationDate` and `/ModDate`, so the same report rendered
 * twice differs in 96 bytes while every other byte — font subsets included —
 * matches. That is enough to defeat "is this the PDF I signed off?", which is
 * the only question the determinism guarantee exists to answer.
 *
 * It is the acquisition time rather than now, for two reasons. It is a property
 * of the audit rather than of the render, so re-rendering next month still
 * produces the same bytes; and it is the same value the cover prints as
 * *Reviewed*, so a client opening Document Properties sees the date on the
 * cover rather than a second, unexplained one.
 */
export function sourceDateEpoch(options: RenderReportOptions): string {
  const parsed = Date.parse(options.input.subject.acquiredAt);
  // An unparseable acquiredAt would make this NaN and typst would reject it,
  // losing the PDF over a metadata field. Falling back to the epoch keeps the
  // render working and stays deterministic, which is what the field is for.
  return String(Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000));
}

function describeTypstFailure(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") {
    return "typst is not installed — the report source was written, but no PDF was produced. Install typst and re-run render.";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  const first = typeof stderr === "string" ? stderr.trim().split("\n")[0] : "";
  return `typst failed to compile the report: ${first || "no output"}`;
}
