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

import type { AuditFinding, Confidence } from "./finding.js";
import { validateFindings, countByConfidence } from "./finding.js";
import { consolidateAsk, renderAsk } from "./closure.js";
import { COVERAGE_CAVEAT, type Coverage } from "./inventory.js";
import {
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
import type { Subject } from "./acquire.js";

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
  /** Present only once a named person has released it. Absent means DRAFT. */
  release?: { by: string; at: string };
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
 */
export function subjectLabel(subject: Subject): string {
  const remote =
    /^(https?:\/\/|git@|ssh:\/\/)/.test(subject.origin) ||
    subject.origin.includes(".org/") ||
    subject.origin.includes(".com/");
  return remote ? subject.origin : subject.name;
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

  return lines;
}

/**
 * Automated Testing, generated from what actually ran.
 *
 * Every skipped analyzer is printed with its reason, and every language nothing
 * reached is named. This is the section a reader uses to judge how much the
 * rest of the report is worth, so it is assembled from the run record rather
 * than written from memory afterwards.
 */
function automatedTestingSection(input: ReportInput): string[] {
  const lines = ["= Automated Testing", ""];

  for (const job of input.analyzerJobs) {
    lines.push(
      job.parsed
        ? `- *${escapeTypst(job.job)}* — ran, ${job.findings.length} finding(s).`
        : `- *${escapeTypst(job.job)}* — #strong[did not run]: ${escapeTypst(job.reason ?? "no reason recorded")}.`,
    );
  }
  lines.push("");

  const untouched = Object.entries(input.analyzerReach)
    .filter(([, reach]) => reach.analyzers.length === 0 && reach.files > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (untouched.length > 0) {
    lines.push(
      "== Languages no automated analysis reached",
      "",
      "No deterministic analyzer produced findings for these. They were reviewed by",
      "reading only, which is a weaker signal and is stated here rather than implied.",
      "",
    );
    for (const [language, reach] of untouched) {
      lines.push(`- ${escapeTypst(language)} — ${reach.files} file(s)`);
    }
    lines.push("");
  }

  const skips = skippedAnalyzerNotes(input.analyzerJobs);
  if (skips.length === 0 && untouched.length === 0) {
    lines.push(
      "Every configured analyzer ran over every language present.",
      "",
    );
  }

  return lines;
}

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
      `*Severity:* ${escapeTypst(finding.severity)} · *Confidence:* ${escapeTypst(finding.confidence)}`,
      "",
      escapeTypst(finding.message),
      "",
    );

    if (finding.evidence.length > 0) {
      lines.push("*Evidence*", "");
      for (const ref of finding.evidence) {
        const where =
          ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
        lines.push(`- ${escapeTypst(where)}`);
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
      origin: escapeTypst(input.subject.origin),
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
