/**
 * Running the deterministic pass (OGE-2428).
 *
 * The one place in audit mode that executes anything. Everything it learns is
 * turned into `JobFindings` by an adapter in `analyzers.ts`, which only ever
 * parses text.
 *
 * ── Why a skipped analyzer is a product feature ─────────────────────────────
 *
 * `findings: []` with `parsed: true` means the analyzer ran and found nothing.
 * `parsed: false` means we could not tell what it would have found. Collapsing
 * those into one silence is how a report implies a clean bill of health it
 * never earned — the model, and the reader, both take absence for green.
 *
 * So every skip carries a reason, and every reason is printed in the report's
 * Coverage section. The limitations section is generated from what actually
 * happened on the run, not written from memory afterwards.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Adapter } from "../findings/adapters.js";
import type { JobFindings } from "../findings/schema.js";
import { gitleaksAdapter, npmAuditAdapter, osvScannerAdapter, semgrepAdapter } from "./analyzers.js";
import { describeUnscanned, scanDependencyManifests } from "./dependencies.js";
import { languageOf, walkTree } from "./tree.js";
import type { Inventory } from "./inventory.js";

const run = promisify(execFile);

const ANALYZER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * A language token from `tree.ts`, or `"*"` for an analyzer whose reach does
 * not depend on language — a secret scanner reads bytes, not syntax.
 */
export type AnalyzerReach = readonly string[] | "*";

export interface AnalyzerSpec {
  job: string;
  /** The executable. Absent from PATH is a skip, not a failure. */
  command: string;
  /**
   * Arguments, built by us from the root path alone.
   *
   * Nothing here may be read out of the tree under audit. `--config` values are
   * ours; the flags below exist to stop the tool picking up the target's own
   * configuration behind our back.
   */
  args(root: string, reportPath: string): string[];
  adapter: Adapter;
  /**
   * The tool writes its report to a FILE we name, rather than to stdout.
   *
   * gitleaks needs this. It pre-checks that `--report-path` is writable by
   * opening it, and `/dev/stdout` fails that check with EACCES whenever stdout
   * is a pipe — which it always is under a spawn. The failure is total: the
   * scan never starts, and the only signal is a banner on stderr.
   *
   * Worth stating plainly because the old form appeared to work: a run on a
   * developer's terminal, where stdout is a tty, opens /dev/stdout happily. It
   * broke only where it mattered, on the box, where every run is piped.
   */
  usesReportFile?: boolean;
  reach: AnalyzerReach;
  /** A precondition that is not the tool's fault — a missing lockfile, say. */
  precondition?(root: string): string | null;
}

export const SEMGREP: AnalyzerSpec = {
  job: "semgrep",
  command: "semgrep",
  args: (root) => [
    "--json",
    // OUR rulesets, named explicitly. Never `--config auto`, which resolves
    // against the registry at run time, and never a path inside the target.
    //
    // p/security-audit alone is not enough, and the gap is not small. Measured
    // on a 2,177-file tree that is 42% C#: p/security-audit returned ZERO
    // findings with zero parse errors, while p/csharp returned 7 on the same
    // tree, including five instances of a token-expiry rule that corroborated a
    // high-severity finding established by hand. The pack was reading the files
    // and had nothing to say about them.
    //
    // So the language packs are added from what the tree actually contains. A
    // pack for a language that is absent costs a registry fetch and finds
    // nothing, which is why this is computed rather than fixed.
    "--config=p/security-audit",
    ...languagePacks(root).map((pack) => `--config=${pack}`),
    // Stop semgrep honouring a .semgrepignore shipped inside the tree: a
    // codebase that excludes itself from review would scan clean by its own
    // instruction, which is the audit equivalent of marking your own homework.
    "--no-git-ignore",
    "--disable-version-check",
    "--metrics=off",
    "--quiet",
    root,
  ],
  adapter: semgrepAdapter,
  // semgrep's registry rulesets span many languages, but not evenly. What this
  // claims is only that it CAN produce findings for these; how well is a
  // question the report answers with its own numbers, not with this list.
  //
  // csharp earns its place here only because `languagePacks` now adds p/csharp.
  // Under p/security-audit alone it produced nothing on a 900-file C# tree, and
  // listing it then would have reported those files as deterministically
  // covered by a pack that had no rules for them.
  reach: ["typescript", "javascript", "python", "go", "java", "ruby", "php", "csharp"],
};

/**
 * Registry packs for the languages this tree actually contains.
 *
 * Keyed off the tree rather than fixed, so a repository gets the rules for what
 * it is written in. The general pack still runs alongside these.
 */
export function languagePacks(root: string): string[] {
  const byLanguage = new Set<string>();
  for (const file of walkTree(root)) byLanguage.add(languageOf(file.path));
  const packs: string[] = [];
  const add = (language: string, pack: string) => {
    if (byLanguage.has(language)) packs.push(pack);
  };
  add("csharp", "p/csharp");
  add("java", "p/java");
  add("python", "p/python");
  add("go", "p/golang");
  add("ruby", "p/ruby");
  add("php", "p/php");
  if (byLanguage.has("typescript") || byLanguage.has("javascript")) packs.push("p/javascript");
  return packs;
}

export const SECRET_SCAN: AnalyzerSpec = {
  job: "secret-scan",
  command: "gitleaks",
  usesReportFile: true,
  args: (root, reportPath) => [
    "detect",
    "--source",
    root,
    "--report-format",
    "json",
    "--report-path",
    reportPath,
    // The tree may have no history at all (an archive), and a .gitleaksignore
    // inside it must not be allowed to silence the scan.
    "--no-git",
    "--redact",
    "--exit-code",
    "0",
  ],
  adapter: gitleaksAdapter,
  reach: "*",
};

export const DEPENDENCY_AUDIT: AnalyzerSpec = {
  job: "dependency-audit",
  command: "npm",
  args: (root) => ["audit", "--json", "--prefix", root],
  adapter: npmAuditAdapter,
  // NO source language. This analyzer reads the dependency tree, not the code:
  // its findings attach to package.json and say nothing about any .ts file.
  //
  // Claiming it reaches "typescript" made the reach table report 904 TypeScript
  // files as deterministically covered on a run where semgrep never started —
  // which is precisely the implied parity this table exists to prevent. The
  // first version of this file got that wrong.
  reach: [],
  // The skip has to say what went unexamined, not just what was absent. "No npm
  // lockfile at the repository root" is true over a .NET tree and reads as
  // "there is nothing here", when the truth was 123 NuGet packages nobody had
  // looked at. Counting them first is what makes the sentence honest.
  precondition: (root) => {
    if (existsSync(join(root, "package-lock.json")) || existsSync(join(root, "npm-shrinkwrap.json"))) {
      return null;
    }
    const unscanned = describeUnscanned(scanDependencyManifests(root), []);
    return unscanned
      ? `no npm lockfile at the repository root; ${unscanned}`
      : "no dependency manifest found in any supported ecosystem (npm, NuGet, PyPI, Go, Maven)";
  },
};

/**
 * Advisories for everything npm cannot answer for.
 *
 * One scanner rather than one analyzer per ecosystem. A NuGet-shaped copy of
 * `npm audit` would need the .NET SDK on this host and a successful restore
 * against whatever private feeds the project uses, which fails closed on
 * exactly the repositories most worth scanning — and it would solve this once,
 * with the next Python or Java subject reopening the same gap.
 *
 * Skips loudly rather than silently when the binary is absent: an unscanned
 * ecosystem the reader is told about is a coverage gap, and one they are not
 * told about is a wrong report.
 */
export const DEPENDENCY_AUDIT_OSV: AnalyzerSpec = {
  job: "dependency-audit-osv",
  command: "osv-scanner",
  args: (root) => ["--format", "json", "--recursive", root],
  adapter: osvScannerAdapter,
  // Same reason as above: this reads the dependency graph, not the code. Its
  // findings attach to manifests and say nothing about any source file.
  reach: [],
  precondition: (root) => {
    const found = scanDependencyManifests(root).filter((f) => f.ecosystem !== "npm" && f.packages > 0);
    return found.length === 0 ? "no non-npm dependency manifest in the tree" : null;
  },
};

export const AUDIT_ANALYZERS: AnalyzerSpec[] = [SEMGREP, SECRET_SCAN, DEPENDENCY_AUDIT, DEPENDENCY_AUDIT_OSV];

function skipped(job: string, reason: string): JobFindings {
  return { job, parsed: false, findings: [], reason };
}

/** Is the executable on PATH? A missing tool is a skip with a reason, not a crash. */
async function isInstalled(command: string): Promise<boolean> {
  try {
    await run("command", ["-v", command], { shell: "/bin/sh", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one analyzer over the tree.
 *
 * Never throws. Every failure mode becomes a `parsed: false` with a reason a
 * reader can act on, because an audit that fell over silently is worse than one
 * that says which tool it could not run.
 */
/**
 * The line of a tool's stderr actually worth showing.
 *
 * Taking the FIRST line is right for a tool that prints one error and wrong for
 * anything that raises. A Python traceback opens with
 * "Traceback (most recent call last):" — so semgrep failing on the box reported
 * exactly that, three times, and said nothing whatsoever about why:
 *
 *   analyze  semgrep did not run — semgrep failed to run: Traceback (most recent call last):
 *
 * The real cause was on the LAST line, five frames down:
 * `PermissionError: [Errno 13] Permission denied: '.../.semgrep'`.
 *
 * So: for a traceback, the last non-empty line, which is the exception. For
 * anything else the first, which is still the summary. Both are truncated,
 * because this ends up on one row of a dashboard.
 */
export const MAX_DETAIL_CHARS = 300;

export function describeToolFailure(stderr: unknown): string {
  if (typeof stderr !== "string" || stderr.trim() === "") return "no output";
  const lines = stderr
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return "no output";

  const isTraceback = /^Traceback \(most recent call last\)/.test(lines[0] ?? "");
  const chosen = isTraceback ? (lines[lines.length - 1] as string) : (lines[0] as string);
  return chosen.length <= MAX_DETAIL_CHARS ? chosen : `${chosen.slice(0, MAX_DETAIL_CHARS - 1)}\u2026`;
}

export async function runAnalyzer(spec: AnalyzerSpec, root: string): Promise<JobFindings> {
  const blocked = spec.precondition?.(root);
  if (blocked) return skipped(spec.job, blocked);

  if (!(await isInstalled(spec.command))) {
    return skipped(spec.job, `${spec.command} is not installed on this machine`);
  }

  // A report file for the tools that cannot write to stdout. Ours, in the OS
  // temp dir rather than in the tree, so nothing we create is ever mistaken for
  // part of the subject and no write lands inside a client's checkout.
  const reportDir = spec.usesReportFile
    ? await mkdtemp(join(tmpdir(), `audit-${spec.job}-`))
    : null;
  const reportPath = reportDir ? join(reportDir, "report.json") : "";

  let stdout: string;
  try {
    const result = await run(spec.command, spec.args(root, reportPath), {
      timeout: ANALYZER_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    stdout = result.stdout;
  } catch (error) {
    // Many analyzers exit non-zero simply BECAUSE they found something, and
    // still wrote perfectly good JSON. Try the output before calling it a
    // failure — treating "found problems" as "could not run" would silently
    // drop exactly the findings we came for.
    const partial = (error as { stdout?: unknown }).stdout;
    if (typeof partial === "string" && partial.trim() !== "") {
      stdout = partial;
    } else {
      const stderr = (error as { stderr?: unknown }).stderr;
      const detail = describeToolFailure(stderr);
      return skipped(spec.job, `${spec.command} failed to run: ${detail}`);
    }
  }

  if (reportDir) {
    try {
      // An absent report after a clean exit means the tool found nothing and
      // wrote nothing, which several versions of gitleaks do. That is an empty
      // result, not a failure.
      stdout = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "[]";
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }

  const findings = spec.adapter.parse(stdout);
  if (findings === null) {
    return skipped(spec.job, `${spec.command} produced output this adapter does not recognise`);
  }
  return { job: spec.job, parsed: true, findings };
}

export async function runAnalyzers(
  root: string,
  specs: AnalyzerSpec[] = AUDIT_ANALYZERS,
): Promise<JobFindings[]> {
  return Promise.all(specs.map((spec) => runAnalyzer(spec, root)));
}

/* ── What the deterministic pass actually reached ─────────────────────────── */

export interface LanguageAnalyzerCoverage {
  files: number;
  /** Analyzers that ran successfully and can produce findings for this language. */
  analyzers: string[];
}

/**
 * Which languages the deterministic pass actually covered, and which it did not.
 *
 * This exists to stop a report implying parity it does not have. Semgrep's
 * registry rules are far thinner for C# than for TypeScript, so a codebase that
 * is mostly C# leans much harder on the agentic stages as a result.
 * Printing analyzers-per-language makes that visible instead of leaving a reader
 * to assume every language got the same treatment.
 *
 * A language with an empty `analyzers` list is the honest headline: nothing
 * deterministic ran over it at all.
 */
export function analyzerLanguageCoverage(
  inventory: Inventory,
  jobs: JobFindings[],
  specs: AnalyzerSpec[] = AUDIT_ANALYZERS,
): Record<string, LanguageAnalyzerCoverage> {
  const ran = new Set(jobs.filter((job) => job.parsed).map((job) => job.job));

  const filesByLanguage = new Map<string, number>();
  for (const file of inventory.files) {
    filesByLanguage.set(file.language, (filesByLanguage.get(file.language) ?? 0) + 1);
  }

  const out: Record<string, LanguageAnalyzerCoverage> = {};
  for (const [language, files] of [...filesByLanguage].sort(([a], [b]) => a.localeCompare(b))) {
    out[language] = {
      files,
      analyzers: specs
        .filter((spec) => ran.has(spec.job))
        .filter((spec) => spec.reach === "*" || spec.reach.includes(language))
        .map((spec) => spec.job),
    };
  }
  return out;
}

/** The lines an audit report prints in its Coverage section. Generated, never authored. */
export function skippedAnalyzerNotes(jobs: JobFindings[]): string[] {
  return jobs
    .filter((job) => !job.parsed)
    .map((job) => `${job.job}: not run — ${job.reason ?? "no reason recorded"}`);
}
