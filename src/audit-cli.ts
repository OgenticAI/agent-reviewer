#!/usr/bin/env node
/**
 * The audit CLI (OGE-2425).
 *
 * Deliberately separate from `cli.ts`. That one is the pull-request reviewer and
 * it loads Octokit to do its job; an audit that clones a Bitbucket repository
 * has no use for a GitHub client, and importing one to acquire a tree would put
 * the first crack in the seam OGE-2424 just established.
 *
 * Subcommands land here as the stages are built:
 *   acquire → inventory → sweep → map → analyze → investigate → verify → closure → render
 */

import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

import {
  acquire,
  AcquireError,
  writeSubject,
  subjectPathFor,
  type Subject,
} from "./engine/audit/acquire.js";
import {
  buildInventory,
  writeInventory,
  computeCoverage,
  FileAccessLog,
  TeeAccessLog,
  COVERAGE_CAVEAT,
} from "./engine/audit/inventory.js";
import {
  runAnalyzers,
  analyzerLanguageCoverage,
  skippedAnalyzerNotes,
} from "./engine/audit/analyze.js";
import { renderReport, RenderRefused } from "./engine/audit/render.js";
import type { QuestionOutcome } from "./engine/audit/maturity.js";
import {
  appendRecallRun,
  DEFECT_CATALOGUE,
  injectIntoTree,
  matchDefects,
  recallReport,
  renderRecall,
} from "./eval/audit-recall.js";
import type { AuditFinding } from "./engine/audit/finding.js";
import type { JobFindings } from "./engine/findings/schema.js";
import {
  investigate,
  modelUnusableFrom,
  questionsWithoutFindings,
  summariseInvestigation,
  type Claim,
} from "./engine/audit/investigate.js";
import { ModelCallFailures } from "./engine/audit/model-failures.js";
import {
  UsageMeter,
  rateCardFromEnv,
  buildUsageReport,
  renderUsage,
  type UsageReport,
} from "./engine/audit/usage.js";
import { sweepTree } from "./engine/audit/sweep.js";
import {
  sweepArtifactFrom,
  toSweepFindings,
  mergeSweepFindings,
  type SweepArtifact,
} from "./engine/audit/sweep-findings.js";
import {
  verifyClaims,
  summariseVerification,
  describeVerification,
  verificationCounts,
  type LineReader,
  type PathKind,
  type VerificationSummary,
} from "./engine/audit/verify.js";
import {
  toAuditFindings,
  settleClosure,
  consolidateAsk,
  renderAsk,
} from "./engine/audit/closure.js";
import { loadQuestionSet } from "./engine/audit/questions.js";
import { makeReadTool } from "./engine/audit/read-tool.js";
import {
  buildRepoMap,
  TagCache,
  type RepoFile,
} from "./engine/repomap/index.js";
import { makeInvestigateModel, makeVerifierModel,
  AUDIT_MODEL,
} from "./audit-model.js";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  AuditTelemetry,
  RunCancelled,
  type AuditStage,
} from "./engine/audit/telemetry.js";
import { sinkFromEnv } from "./audit-telemetry-http.js";
import { uploaderFromEnv } from "./audit-artifacts.js";

/**
 * The baseline question set, resolved relative to this file rather than the
 * working directory — the CLI is run from wherever the tree happens to be.
 */
const DEFAULT_QUESTIONS = fileURLToPath(
  new URL("../questions/taxonomy.yml", import.meta.url),
);
import { maskSecrets } from "./engine/tools/sanitize.js";

const USAGE = `audit — codebase audit

  audit acquire   --from <source> --into <dir> [--ref <branch|tag|sha>] [--replace] [--started-by <email>]
  audit inventory --tree <dir> [--out <dir>]
  audit sweep     --tree <dir> [--out <dir>]        read every file; no model
  audit analyze   --tree <dir> [--out <dir>]
  audit investigate --tree <dir> [--out <dir>] [--questions <yml>] [--verifiers <n>]
  audit render    --tree <dir> --findings <findings.json> [--out <dir>] [--release-by <email>]
  audit inject    --tree <dir>                       plant known defects, for calibration
  audit recall    --tree <dir> --findings <f.json> [--out <dir>]   score a run against them

    <source>  a clone URL, host/owner/repo, a local path, or a .zip / .tar.gz
    --into    where the tree lands; refuses an existing directory
    --ref     the branch, tag or commit to read. WITHOUT this the remote's
              default branch is taken, which is frequently not the branch that
              deploys; either way the subject records which was read
    --replace overwrite an existing directory instead of refusing
    --started-by who is running this, reported once to Mission Control
                 alongside the subject it resolves; falls back to the
                 machine's own 'git config --global user.email', then omitted
    --tree    an acquired tree to enumerate
    --out     where inventory.json / sweep.json / findings land (default: the tree
              itself; the run's own artifacts there are left out of the walk).
              One run per directory: a stage over another revision is refused
    --questions  a question set (default: questions/taxonomy.yml)
    --verifiers  independent refutation attempts per claim (minimum 2)
    --findings   an AuditFinding[] produced by the verify + closure stages
    --release-by removes the DRAFT watermark, attributed to this person

  Writes <dir>/../<name>.subject.json — the audit's identity. Every finding
  cites path@rev, so a re-audit can be diffed against this one.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Who is running this, for the subject telemetry event (OGE-2563).
 *
 * An explicit `--started-by` always wins. Absent that, a best-effort read of
 * the machine's own global git identity — the same value every commit on
 * this box already carries — rather than nothing. Never thrown on: a machine
 * with no git identity configured, or no git at all, must not fail an audit
 * over a byline. Never a local (per-repo) identity: `--into` is the SUBJECT
 * being cloned, and its committers have no bearing on who is running the
 * audit against it.
 *
 * `env` is injected for tests only — real callers take the default so this
 * reads the same `~/.gitconfig` every commit on the machine already does.
 */
export async function resolveStartedBy(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (explicit) return explicit;
  try {
    const { stdout } = await run("git", ["config", "--global", "user.email"], { env });
    const email = stdout.trim();
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/**
 * The subject's revision, when acquire has written one beside the tree.
 *
 * Undefined when there is no subject file at all (a scratch tree that was
 * never acquired), which is different from a subject whose rev is null; the
 * run record treats only the first as "unknown".
 */
function subjectRevIfPresent(tree: string): string | null | undefined {
  const path = subjectPathFor(tree);
  if (!existsSync(path)) return undefined;
  return readArtifact<Subject>(path, "audit acquire").rev;
}

/** What run.json holds. `rev` is absent on records older than OGE-2746. */
interface RunRecord {
  runId: string;
  startedAt: string;
  rev?: string | null;
}

/**
 * Join the run a directory already holds, or start one.
 *
 * A run is one revision. The ledger accumulates across stages in this
 * directory, so an `--out` reused after a re-acquire at another ref would
 * continue a log of reads made over a tree that no longer exists, and stamp
 * the new rev onto them. The record carries the rev from the first stage that
 * knows it, and a later stage over a different rev is refused rather than
 * joined: the remedy is a fresh directory, not a merged ledger.
 *
 * `rev` undefined means the caller could not know it (no subject beside the
 * tree yet); null means the subject has no history. Only a known, differing
 * rev refuses. Exported for the tests; the file I/O stays in `resolveRun`.
 */
export function joinRun(
  existing: RunRecord | undefined,
  rev: string | null | undefined,
  path: string,
): { record: RunRecord; write: boolean } {
  if (!existing) {
    return {
      record: { runId: randomUUID(), startedAt: new Date().toISOString(), ...(rev !== undefined ? { rev } : {}) },
      write: true,
    };
  }
  if (rev === undefined || existing.rev === undefined) {
    return rev === undefined ? { record: existing, write: false } : { record: { ...existing, rev }, write: true };
  }
  if (existing.rev !== rev) {
    throw new CliError(
      `${path} belongs to a run over revision ${existing.rev ?? "(none)"}; this tree is at ${rev ?? "(none)"}.\n` +
        `The ledger in that directory was built over a different tree. Point --out at a fresh directory ` +
        `rather than continuing it.`,
    );
  }
  return { record: existing, write: false };
}

/**
 * The run this invocation belongs to.
 *
 * Each subcommand is a separate process, so the id has to live on disk or the
 * dashboard sees five unrelated runs instead of one audit with five stages.
 * Written by whichever stage runs first; every later stage joins it, and a
 * stage that knows the subject's revision pins the run to it (`joinRun`).
 */
function resolveRun(
  outDir: string,
  rev?: string | null,
): {
  runId: string;
  telemetry: AuditTelemetry;
  note: string;
} {
  const path = join(outDir, "run.json");
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as RunRecord)
    : undefined;
  const { record, write } = joinRun(existing, rev, path);
  if (write) writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  const { runId } = record;

  const { sink, note } = sinkFromEnv(runId);
  return {
    runId,
    telemetry: new AuditTelemetry({ runId, ...(sink ? { sink } : {}) }),
    note,
  };
}

/**
 * Run one stage, reporting what happened to it.
 *
 * The flush is in a `finally` because a failed stage is the one the dashboard
 * most needs to hear about, and the throw still propagates — telemetry
 * observes the run, it does not catch for it.
 */
async function withStage<T>(
  telemetry: AuditTelemetry,
  stage: AuditStage,
  fn: () => Promise<T> | T,
  /**
   * Queued before the flush, whether the stage succeeded or threw.
   *
   * This is where the running cost is emitted. Money is spent as the stage
   * runs, so it has to be reported on the way out of the stage rather than at
   * the end of the run — a run that dies has still spent it (OGE-2515).
   */
  onSettled?: () => void,
): Promise<T> {
  // A stage boundary is the cheapest honest checkpoint: nothing is half-done,
  // and the artifacts written so far stay valid. Stages that take an hour check
  // again at their own progress points.
  telemetry.throwIfCancelled();
  telemetry.stageStarted(stage);
  try {
    return await fn();
  } catch (error) {
    telemetry.stageFailed(
      stage,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    // Before the flush, so the spend leaves on the same trip as the stage
    // result. Never allowed to throw: failing to report a cost must not be
    // what fails a run.
    try {
      onSettled?.();
    } catch {
      /* reporting spend is never worth losing the run over */
    }
    await telemetry.flush();
  }
}

async function runAcquire(args: string[]): Promise<number> {
  const from = flag(args, "--from");
  const into = flag(args, "--into");
  if (!from || !into) {
    process.stderr.write("acquire needs --from and --into\n\n" + USAGE);
    return 2;
  }

  const startedBy = await resolveStartedBy(flag(args, "--started-by"));
  const { telemetry: acquireTelemetry } = resolveRun(dirname(resolve(into)));
  const subject = await withStage(acquireTelemetry, "acquire", () =>
    acquire({
      from,
      into,
      ...(flag(args, "--ref") ? { ref: flag(args, "--ref") as string } : {}),
      replace: args.includes("--replace"),
    }).then((acquired) => {
      acquireTelemetry.stageFinished("acquire", {
        files: acquired.files,
        lines: acquired.loc,
      });
      // Inside withStage's try, before its finally flushes — recordSubject and
      // stageFinished go out on the same POST. `runAcquire` never flushes
      // again itself (each subcommand is a separate process; see
      // resolveRun's own doc comment), so a subject recorded any later than
      // this would sit in `pending` until whichever process happens to call
      // acquire again, which may be never for a one-shot acquire.
      acquireTelemetry.recordSubject(acquired, startedBy);
      return acquired;
    }),
  );
  const subjectPath = writeSubject(into, subject);

  const revLine = subject.rev ?? `none (${subject.revProvenance})`;
  const languages = Object.entries(subject.langs)
    .sort(([, a], [, b]) => b - a)
    .map(([name, share]) => `${name} ${Math.round(share * 100)}%`)
    .join(" · ");

  process.stdout.write(
    [
      `acquired ${subject.origin}`,
      `  kind       ${subject.kind}`,
      `  revision   ${revLine}`,
      // Named on its own line, and loudest when nothing was pinned. An operator
      // who reads "ref  default branch (develop) — CONFIRM this is what deploys"
      // has been told the thing that, unsaid, took a client meeting to surface.
      `  ref        ${
        subject.requestedRef
          ? subject.requestedRef
          : `default branch${subject.defaultBranch ? ` (${subject.defaultBranch})` : ""} — no --ref given; confirm this is what deploys`
      }`,
      `  files      ${subject.files.toLocaleString()}`,
      `  lines      ${subject.loc.toLocaleString()}`,
      `  languages  ${languages || "(none detected)"}`,
      `  subject    ${subjectPath}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runInventory(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  if (!tree) {
    process.stderr.write("inventory needs --tree\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  const { telemetry, note: telemetryNote } = resolveRun(out, subjectRevIfPresent(tree));

  const inventory = await withStage(telemetry, "inventory", () => {
    const built = buildInventory(tree, out);
    telemetry.stageFinished("inventory", {
      files: built.files.length,
      lines: built.files.reduce((n, f) => n + f.loc, 0),
    });
    return built;
  });
  const path = writeInventory(out, inventory);

  const byLanguage = new Map<string, number>();
  for (const file of inventory.files) {
    byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + 1);
  }
  const languages = [...byLanguage]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");

  process.stdout.write(
    [
      `inventoried ${tree}`,
      `  files      ${inventory.files.length.toLocaleString()}  (the coverage denominator)`,
      `  lines      ${inventory.files.reduce((n, f) => n + f.loc, 0).toLocaleString()}`,
      `  languages  ${languages || "(none detected)"}`,
      `  excluded   ${inventory.excluded.join(", ")}`,
      `  inventory  ${path}`,
      "",
      `  ${COVERAGE_CAVEAT}`,
      "",
      `  ${telemetryNote}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runAnalyze(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  if (!tree) {
    process.stderr.write("analyze needs --tree\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  const { telemetry, note: telemetryNote } = resolveRun(out, subjectRevIfPresent(tree));

  const jobs = await withStage(telemetry, "analyze", async () => {
    const result = await runAnalyzers(tree);
    for (const job of result) {
      // An analyzer that did not run is reported at warn, so it is visible in
      // the UI hours before the PDF exists rather than only in its Coverage
      // section.
      if (job.parsed)
        telemetry.log(
          "analyze",
          "info",
          `${job.job}: ${job.findings.length} finding(s)`,
        );
      else
        telemetry.log(
          "analyze",
          "warn",
          `${job.job} did not run — ${job.reason ?? "no reason recorded"}`,
        );
    }
    telemetry.stageFinished("analyze", {
      analyzers: result.length,
      ran: result.filter((j) => j.parsed).length,
    });
    return result;
  });

  writeFileSync(
    join(out, "analyzers.json"),
    `${JSON.stringify(jobs, null, 2)}\n`,
  );

  const lines: string[] = [`analyzed ${tree}`];
  for (const job of jobs) {
    lines.push(
      job.parsed
        ? `  ✓ ${job.job.padEnd(18)} ${job.findings.length} finding(s)`
        : `  ! ${job.job.padEnd(18)} SKIPPED — ${job.reason ?? "no reason recorded"}`,
    );
  }

  const coverage = analyzerLanguageCoverage(buildInventory(tree, out), jobs);
  lines.push("", "  deterministic reach by language:");
  for (const [language, { files, analyzers }] of Object.entries(coverage)) {
    const ran =
      analyzers.length > 0 ? analyzers.join(", ") : "NOTHING RAN OVER THIS";
    lines.push(
      `    ${language.padEnd(12)} ${String(files).padStart(5)} files  ${ran}`,
    );
  }

  const skips = skippedAnalyzerNotes(jobs);
  if (skips.length > 0) {
    lines.push("", "  for the report's Coverage section:");
    for (const note of skips) lines.push(`    ${note}`);
  }

  lines.push("", `  ${telemetryNote}`);
  process.stdout.write(lines.join("\n") + "\n\n");
  return 0;
}

/**
 * Read a JSON artifact from an earlier stage.
 *
 * A missing artifact is an ordering mistake, not a crash: the operator ran the
 * stages out of order or pointed at the wrong directory. Say which stage writes
 * the file rather than printing a Node stack trace at them.
 *
 * The type parameter is a claim about what the file holds, not a check on it —
 * nothing here validates the parsed shape. It is worth stating anyway, because
 * naming the expected type at each call site is how the next reader learns
 * which stage writes what.
 */
function readArtifact<T>(path: string, producedBy: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const why =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "not found"
        : "could not be read";
    throw new CliError(
      `${path} ${why}.\nIt is written by ${producedBy}. Run that first, or pass the directory it wrote to.`,
    );
  }
}

/**
 * The access log the investigation stage wrote for this run.
 *
 * Named separately from `readArtifact` because the remedy differs: a missing
 * access log is not a wrong --out, it is a run that never opened any files.
 */
function readAccessLog(outDir: string): FileAccessLog {
  try {
    return FileAccessLog.load(outDir);
  } catch {
    throw new CliError(
      `${join(outDir, "access-log.json")} not found.\n` +
        `It records which files the run opened, and Coverage is computed from it. ` +
        `Without it the report would claim 0% coverage, so render refuses. ` +
        `Run the sweep or the investigation stage over this tree first.`,
    );
  }
}

/**
 * The run's access log, continued rather than replaced.
 *
 * One ledger per run. The sweep writes what it read and the investigation
 * appends what the model opened, and coverage is computed from the union; a
 * stage that started a fresh log would erase the other's reads and print a
 * coverage figure for itself alone. `opened()` is a set, so a stage re-run
 * over the same directory adds records without changing the number.
 *
 * A log that exists and cannot be parsed is an error, not an empty log: the
 * fresh-log fallback exists for a directory nothing has written to yet, and
 * treating corruption the same way would quietly restart coverage from zero.
 */
function openAccessLog(outDir: string): FileAccessLog {
  if (!existsSync(join(outDir, "access-log.json"))) return new FileAccessLog();
  try {
    return FileAccessLog.load(outDir);
  } catch (error) {
    throw new CliError(
      `${join(outDir, "access-log.json")} exists but could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `Coverage accumulates into this file across stages. Fix or remove it rather than ` +
        `letting a stage start a new one over it.`,
    );
  }
}

/**
 * Put the run's ledger on disk now: the access log and the usage total.
 *
 * Called at every stage boundary of the investigation, not once at the end.
 * The end-only write is the one that shipped first, and it left a run that
 * threw at the closure gate with no access-log.json at all; the renderer then
 * refused, correctly, because the only coverage number it could compute was
 * zero. Eighteen minutes of verified reading, on disk nowhere. Writing the
 * latest state at each boundary means whatever stage a run dies in, what it
 * read and what it spent are already recorded (OGE-2746).
 *
 * Exported so the write can be tested without a model. Throws on a failed
 * write like any other file operation; the caller decides whether that may
 * mask a stage's own error.
 */
export function writeLedger(
  outDir: string,
  accessLog: FileAccessLog,
  usage: UsageReport,
): { accessLogPath: string; usagePath: string } {
  const accessLogPath = accessLog.writeTo(outDir);
  const usagePath = join(outDir, "usage.json");
  writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`);
  return { accessLogPath, usagePath };
}

/**
 * The stage-boundary writer of the ledger.
 *
 * A write failure is reported through `warn` and swallowed rather than thrown,
 * because the returned function runs inside `keepingLedger`'s `finally`: a
 * throw there replaces the error the stage died of, and "could not write
 * usage.json" is a worse diagnosis than the closure gate's own message. The
 * final writes at the end of investigate are outside any `finally` and throw
 * as normal. Exported, with `keepingLedger`, so the property can be tested
 * without a model.
 */
export function ledgerPersister(deps: {
  out: string;
  accessLog: FileAccessLog;
  usage: () => UsageReport;
  warn: (stage: AuditStage, message: string) => void;
}): (stage: AuditStage) => void {
  return (stage) => {
    try {
      writeLedger(deps.out, deps.accessLog, deps.usage());
    } catch (error) {
      deps.warn(
        stage,
        `ledger not written after ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

/**
 * Run a stage and put the ledger on disk on the way out, returned or thrown.
 *
 * The `finally` is the whole point: the stage's result or error passes through
 * untouched, and whatever it read and spent by the time it stopped is already
 * recorded. `persist` must not throw; `ledgerPersister` sees to that.
 */
export async function keepingLedger<T>(
  stage: AuditStage,
  persist: (stage: AuditStage) => void,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } finally {
    persist(stage);
  }
}

/**
 * Was the sweep on disk before the findings were written, i.e. did the
 * investigation have it to merge? True when the findings file cannot be
 * stat'ed: the caller has already read it, so that is a race, not an answer.
 */
function sweepPredates(sweepPath: string, findingsPath: string): boolean {
  try {
    return statSync(sweepPath).mtimeMs <= statSync(findingsPath).mtimeMs;
  } catch {
    return true;
  }
}

/**
 * What the sweep read and matched, if it ran.
 *
 * Optional for the same reason `readQuestionOutcomes` is: a run that predates
 * the sweep, or an operator who skipped it, must still render. The report says
 * the sweep did not run rather than omitting the section, so the coverage
 * figure above it is read for what it is.
 *
 * Absent and damaged are not the same answer. A sweep.json that exists and
 * cannot be read is a sweep that DID run, and reporting it as "no sweep ran"
 * is the false statement `openAccessLog` refuses to make about the ledger.
 * Exported for the tests.
 */
export function readSweep(outDir: string): SweepArtifact | undefined {
  const path = join(outDir, "sweep.json");
  if (!existsSync(path)) return undefined;
  let parsed: Partial<SweepArtifact>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SweepArtifact>;
  } catch (error) {
    throw new CliError(
      `${path} exists but could not be read: ${error instanceof Error ? error.message : String(error)}\n` +
        `A sweep ran and its record is damaged. Re-run audit sweep over this directory, or remove ` +
        `the file if the report is meant to say no sweep ran.`,
    );
  }
  if (!Array.isArray(parsed.signals) || !Array.isArray(parsed.dispositions) || !Array.isArray(parsed.summary)) {
    throw new CliError(
      `${path} is not a sweep record: it lacks signals, dispositions or summary.\n` +
        `Re-run audit sweep over this directory, or remove the file if the report is meant to say no sweep ran.`,
    );
  }
  return parsed as SweepArtifact;
}

/**
 * Read every file in the tree, with no model (OGE-2746).
 *
 * Runs before the investigation so its reads are already in the ledger when
 * the model starts; runs after it just as well, since the log is continued
 * rather than replaced. Surface counts and defect candidates land in
 * sweep.json, and investigate folds the candidates into findings.json behind
 * whatever the model settled on the same lines.
 */
async function runSweep(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  if (!tree) {
    process.stderr.write("sweep needs --tree\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  // Undefined on a tree nothing acquired: the sweep still runs, and the
  // artifact records that no revision was known rather than inventing one.
  const rev = subjectRevIfPresent(tree);
  const { telemetry, note: telemetryNote } = resolveRun(out, rev);
  const accessLog = openAccessLog(out);

  const sweep = await withStage(telemetry, "sweep", () => {
    // `runDir` keeps this run's own artifacts out of the walk. With the
    // default --out they sit inside the tree, and a second sweep once raised a
    // weak-crypto candidate at sweep.json: the previous run's own excerpt.
    const result = sweepArtifactFrom(sweepTree(tree, accessLog, { runDir: out }), rev ?? null);
    telemetry.stageFinished("sweep", {
      files: result.total,
      read: result.read,
      signals: result.signals.length,
    });
    return result;
  });

  const sweepPath = join(out, "sweep.json");
  writeFileSync(sweepPath, `${JSON.stringify(sweep, null, 2)}\n`);
  const accessLogPath = accessLog.writeTo(out);

  // The merge into findings.json happens in investigate and only there. A
  // findings.json that already exists predates this sweep, so its candidates
  // are in sweep.json and nowhere else until investigate runs again; the
  // report will say so, and so does this, at the moment it can be acted on.
  const findingsPredate = existsSync(join(out, "findings.json"));
  if (findingsPredate)
    telemetry.log(
      "sweep",
      "warn",
      "findings.json predates this sweep; its candidates are not folded in until investigate runs again",
    );

  // drain, not flush: this process exits next, and a stage that Mission
  // Control does not know yet is refused as a whole batch, since every event
  // in it carries the same stage. What could not be delivered is said here
  // rather than lost in silence with an exit code of 0.
  const outstanding = await telemetry.drain();

  const defects = sweep.summary.filter((row) => row.signalClass === "defect");
  const surface = sweep.summary.filter((row) => row.signalClass === "surface");
  const lines = [
    `swept ${tree}`,
    `  revision   ${rev === undefined ? "unknown; no subject beside the tree" : (rev ?? "none (subject has no history)")}`,
    `  visited    ${sweep.total.toLocaleString()}`,
    `  parsed     ${sweep.read.toLocaleString()}`,
    `  skipped    ${sweep.skipped.toLocaleString()}`,
    "",
    `  defect candidates (${defects.reduce((n, r) => n + r.count, 0)}); inferred at most, never verified:`,
    ...defects.map((r) => `    ${r.kind.padEnd(34)} ${String(r.count).padStart(5)} in ${r.files} file(s)`),
    "",
    `  surface (${surface.reduce((n, r) => n + r.count, 0)}); counted, never findings:`,
    ...surface.map((r) => `    ${r.kind.padEnd(34)} ${String(r.count).padStart(5)} in ${r.files} file(s)`),
    "",
    `  sweep      ${sweepPath}`,
    `  access log ${accessLogPath}`,
    ...(findingsPredate
      ? [
          "  ! findings.json predates this sweep. The candidates above are not in it; re-run",
          "    audit investigate over this directory to fold them in, or the report will say so.",
        ]
      : []),
    "",
    `  ${telemetryNote}`,
    ...(outstanding.events > 0
      ? [
          `  ! LOST ${outstanding.events} telemetry event(s) after ${outstanding.failedFlushes} failed flush(es); ` +
            `the sweep is on disk, but Mission Control did not record this stage. A dashboard that ` +
            `does not know the sweep stage refuses the whole batch.`,
        ]
      : []),
    "",
  ];
  process.stdout.write(lines.join("\n"));
  return 0;
}

/**
 * Investigate, verify, price the open questions, and write findings.json.
 *
 * The three stages run as one command rather than three because their
 * intermediate values are not artifacts anyone reviews — a claim that failed
 * anchor checking is debris, not output. What lands on disk is the access log
 * (coverage is computed from it) and the findings (the report is rendered from
 * them).
 */
async function runInvestigate(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  if (!tree) {
    process.stderr.write("investigate needs --tree\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey)
    throw new CliError(
      "ANTHROPIC_API_KEY is not set. The investigation stage needs a model.",
    );

  const subject = readArtifact<Subject>(subjectPathFor(tree), "audit acquire");
  const jobs = readArtifact<JobFindings[]>(
    join(out, "analyzers.json"),
    "audit analyze",
  );
  const questionSet = loadQuestionSet(
    flag(args, "--questions") ?? DEFAULT_QUESTIONS,
  );

  const { telemetry, note: telemetryNote } = resolveRun(out, subject.rev);
  try {
    return await investigateRun({
      args,
      tree,
      out,
      telemetry,
      telemetryNote,
      apiKey,
      subject,
      jobs,
      questionSet,
    });
  } catch (error) {
    // The confirmation is already recorded; this is the flush that delivers it,
    // so the dashboard shows "cancelled" rather than a run stuck at "stop
    // requested" forever. Drained rather than flushed once: this is an exit
    // path, and a cancel confirmation lost to a network stall leaves exactly
    // the stuck run this line exists to prevent.
    if (error instanceof RunCancelled) await telemetry.drain();
    throw error;
  }
}

async function investigateRun(ctx: {
  args: string[];
  tree: string;
  out: string;
  telemetry: AuditTelemetry;
  telemetryNote: string;
  apiKey: string;
  subject: Subject;
  jobs: JobFindings[];
  questionSet: ReturnType<typeof loadQuestionSet>;
}): Promise<number> {
  const {
    args,
    tree,
    out,
    telemetry,
    telemetryNote,
    apiKey,
    subject,
    jobs,
    questionSet,
  } = ctx;
  const inventory = buildInventory(tree, out);

  // The run's ledger, continued from whatever the sweep already recorded, and
  // the only source of the coverage figure. The model reads through a tee
  // into it, so "files the model opened" is the model's own count: reported
  // from the ledger it was the sweep's whole-tree pass, and the dashboard was
  // told the model had read every file whatever it had actually opened.
  const accessLog = openAccessLog(out);
  const modelLog = new TeeAccessLog(accessLog);
  const readTool = makeReadTool({ root: tree, log: modelLog });

  const anthropic = new Anthropic({ apiKey });
  // One meter for the whole run. audit-model.ts is the only place this path
  // reaches the API, so this sees every call including each tool-loop
  // iteration (OGE-2502).
  const meter = new UsageMeter();
  const rateCard = rateCardFromEnv();
  // One counter for the whole run, at the same seam as the meter (OGE-2711).
  // Every call the API rejected is counted where it was made, so the number
  // covers investigate and verify alike, and the run record can carry it on
  // the stage row the release gate reads.
  const failures = new ModelCallFailures();

  /**
   * Publish what has been spent SO FAR (OGE-2515).
   *
   * Called on the way out of every stage and on every progress tick, not once
   * at the end. Two reasons, and the second is why this exists at all:
   *
   *   - A run that dies has still spent the money. Reporting only on success
   *     meant a failed run showed no cost — which reads as "cost nothing"
   *     rather than "cost unknown", and that is the same well-formed lie this
   *     engine keeps being built against. One run burned an eighteen-minute
   *     verify stage, died at closure, and recorded nothing at all.
   *   - Spend needs to be legible WHILE a run is going. That verify stage ran
   *     for sixteen minutes; the cost of it should not be a surprise revealed
   *     at the end.
   *
   * Safe to call repeatedly: the dashboard applies a usage event as an UPDATE,
   * so each call simply replaces the total with a more complete one.
   */
  const reportUsage = (): void => {
    telemetry.usage(buildUsageReport(meter, AUDIT_MODEL, rateCard));
  };

  // The on-disk counterpart of `reportUsage`, plus the access log; see
  // `ledgerPersister` for why a failed write here warns rather than throws.
  const persistLedger = ledgerPersister({
    out,
    accessLog,
    usage: () => buildUsageReport(meter, AUDIT_MODEL, rateCard),
    warn: (stage, message) => telemetry.log(stage, "warn", message),
  });
  // `log` is not optional in practice, whatever the type says. Without it the
  // model layer falls back to console.error, and the one thing it reports —
  // that a question ran out of tool-loop budget before it answered — goes to a
  // stream nothing posts. A whole run once came back with ten questions
  // "unparseable" while the real reason sat in stderr, and the investigation
  // went after the parser (OGE-2511).
  //
  // Attributed to `investigate` because that is the stage whose budget this
  // reports on; the verify stage rebinds it below.
  const modelOptions = {
    anthropic,
    readTool,
    meter,
    failures,
    log: (message: string) => telemetry.log("investigate", "info", message),
  };

  // Building the repo map parses every file for tags. Those reads are
  // deliberately NOT access-log events: the map shows the model a ranked
  // outline, not file contents, and counting them would put coverage at 100%
  // on every run — a number that cannot be wrong is a number that says nothing.
  const cache = new TagCache();
  const repoFiles = await withStage(telemetry, "map", () => {
    const files = readRepoFiles(tree, inventory);
    telemetry.stageFinished("map", {
      parsed: files.length,
      inScope: inventory.files.length,
    });
    return files;
  }, reportUsage);

  process.stdout.write(
    `investigating ${subject.name} — ${questionSet.questions.length} question(s), ` +
      `${inventory.files.length} file(s) in scope\n`,
  );

  meter.enter("investigate");
  // Kept outside the stage so the same counts can be re-sent after verify
  // with the failure total brought up to date; see the re-emit below.
  let investigateCounts: Record<string, number> = {};
  const results = await keepingLedger("investigate", persistLedger, () =>
    withStage(telemetry, "investigate", async () => {
      const runs = await investigate({
        questions: questionSet.questions,
        model: makeInvestigateModel(modelOptions),
        repoMapFor: (seedTexts) =>
          buildRepoMap({
            files: repoFiles,
            diffTouchedFiles: [],
            seedTexts,
            diffText: "",
            cache,
          }).text,
        analyzerJobs: jobs,
        subjectRev: subject.rev,
        log: (message) => telemetry.log("investigate", "info", message),
        // Cost rides along with progress. A stage that runs for minutes should
        // show what it is spending while it spends it, not at the end.
        onProgress: (done, total) => {
          telemetry.progress("investigate", done, total);
          reportUsage();
        },
      });
      // One cause reported once, rather than ten identical failures and a stage
      // that claims to have finished. This throws BEFORE stageFinished so the
      // stage is recorded as failed, and the message reaches stderr where the
      // worker can see it and stop retrying something that cannot succeed.
      const unusable = modelUnusableFrom(runs);
      if (unusable) throw new CliError(`investigate: ${unusable}`);

      // Which questions came out with nothing to verify, by name. The count
      // below goes on the stage row; the names go in the log, because the
      // release gate can say "3 of 9 questions produced nothing" from the
      // row alone but can only say WHICH three from here.
      const empty = questionsWithoutFindings(runs);
      if (empty.length > 0) {
        telemetry.log(
          "investigate",
          "warn",
          `${empty.length} of ${runs.length} question(s) produced no kept claim: ${empty.join(", ")}`,
        );
      }

      const summary = summariseInvestigation(runs);
      investigateCounts = {
        questions: summary.questions,
        claims: summary.claims,
        // The model's own reads. The ledger's size is coverage, reported by
        // render from the union; here it would say the model read the sweep's
        // files.
        filesOpened: modelLog.opened().size,
        filesInLedger: accessLog.opened().size,
        // What the release gate reads (OGE-2711). A run that lost calls to
        // the API, or that answered from a fraction of its questions, has
        // "finished" in exactly the shape of one that did neither, and these
        // two numbers are how the gate tells them apart. The failure count
        // is what it is SO FAR; verify adds to it and re-sends this row.
        modelCallFailures: failures.count(),
        questionsWithFindings: summary.questionsWithFindings,
      };
      telemetry.stageFinished("investigate", investigateCounts);
      return runs;
    }, reportUsage),
  );

  const investigation = summariseInvestigation(results);
  const claims: Claim[] = results.flatMap((r) => r.claims);
  const investigateFailures = failures.count();
  process.stdout.write(
    `  claims     ${claims.length} kept, ${investigation.dropped} dropped\n` +
      `  questions  ${investigation.questionsWithFindings} of ${investigation.questions} produced a kept claim\n` +
      `  model      ${investigateFailures} call(s) failed\n` +
      `  files      ${modelLog.opened().size} opened by the model; ${accessLog.opened().size} in the run's ledger\n`,
  );

  meter.enter("verify");
  const verification = await keepingLedger("verify", persistLedger, () =>
    withStage(telemetry, "verify", async () => {
      const result = await verifyClaims({
        claims,
        // Rebound so a verifier that runs out of budget is reported against the
        // verify stage rather than mislabelled as investigate.
        model: makeVerifierModel({
          ...modelOptions,
          log: (message: string) => telemetry.log("verify", "info", message),
        }),
        readLine: lineReaderFor(tree),
        pathKind: pathKindFor(tree),
        log: (message) => telemetry.log("verify", "info", message),
        onProgress: (done, total) => {
          telemetry.progress("verify", done, total);
          reportUsage();
          void telemetry.flush();
        },
        shouldStop: () => telemetry.cancelRequested(),
        ...(flag(args, "--verifiers")
          ? { verifiers: Number(flag(args, "--verifiers")) }
          : {}),
      });
      // The breakdown goes up with the totals. A dashboard that shows "54
      // rejected" and nothing else leaves the operator to guess whether the
      // investigation invented 54 citations or misnumbered them, and the two
      // call for different fixes.
      telemetry.stageFinished("verify", {
        verified: result.verified.length,
        ...verificationCounts(summariseVerification(result)),
      });
      return result;
    }, reportUsage),
  );

  const summary = summariseVerification(verification);
  process.stdout.write(
    `  verified   ${summary.verified} · inferred ${summary.inferred} · ` +
      `not-determinable ${summary.notDeterminable} · rejected ${verification.rejected.length}\n` +
      `  ${describeVerification(summary)}\n`,
  );

  // Verify's failed calls, added to the investigate row (OGE-2711).
  //
  // The release gate reads one row for the run's model-call failures, and it
  // is the investigate row: that is the stage record every run has, and the
  // gate's contract names it. But the count is meant to cover verify too, and
  // verify has not run when that row is first sent. So the row is sent again,
  // same counts with the failure total brought up to date, and only when the
  // total actually moved. The dashboard replaces a stage's counts wholesale on
  // a re-sent finish, which is why the whole object goes back rather than the
  // one field; it also takes the re-send's timestamp as the stage's finish,
  // which is the price of putting the number where the gate looks, and it is
  // paid only on a run the gate is going to block anyway.
  if (failures.count() > investigateFailures) {
    investigateCounts = { ...investigateCounts, modelCallFailures: failures.count() };
    telemetry.stageFinished("investigate", investigateCounts);
    process.stdout.write(
      `  model      ${failures.count()} call(s) failed across investigate and verify\n`,
    );
    await telemetry.flush();
  }

  // Verification stops mid-list on a cancel, so the claim set here is partial.
  // Rendering a report from it would produce a document that looks complete and
  // is not — the one output this engine must never produce.
  telemetry.throwIfCancelled("closure");

  // What verification kept and threw away, persisted for the report's
  // coverage section. Before closure, whose gate throws on purpose: a run
  // refused there still has this to show for its verify stage, the same way
  // the ledger survives. Findings alone cannot reconstruct it, because a
  // rejected claim leaves no finding.
  writeFileSync(join(out, "verification.json"), `${JSON.stringify(summary, null, 2)}\n`);

  // The gate inside throws on purpose, and before the ledger was kept on the
  // way out that throw was the last thing the run did: no access-log.json, no
  // usage.json, and a renderer that refused a coverage figure of zero. The
  // evidence now survives the refusal the same way the findings do.
  const closure = await keepingLedger("closure", persistLedger, () =>
    withStage(telemetry, "closure", () => {
      const result = toAuditFindings({ verified: verification.verified });
      // Findings go up as they are settled, so the UI can show them long before
      // the PDF exists.
      //
      // BEFORE the closure gate, not after it. The gate throws, and everything
      // after a throw does not run — so a single not-determinable finding with no
      // closure path discarded every finding in the run, including the ones that
      // verified cleanly. An agent-knowledge audit finished investigate 9/9,
      // verified 83 of 84 claims over 67 minutes, and persisted NOTHING because
      // the 84th had no closure path. The comment above this loop already said
      // findings should arrive as they settle; the ordering was what prevented it.
      //
      // The gate still fails the run, which is right: a bare "not determinable"
      // hands the risk back to the client. What changes is that the evidence
      // survives the refusal. A failed run's findings are already treated as
      // partial downstream, and its report is not released.
      settleClosure(result, (found) => telemetry.finding(found));
      telemetry.stageFinished("closure", { findings: result.findings.length });
      return result;
    }, reportUsage),
  );

  // The sweep's defect candidates, behind the model's findings (OGE-2746).
  //
  // A model finding on a line the sweep also matched wins: it has been read,
  // verified and closed, and the pattern that would have pointed at the same
  // line adds nothing but a second, weaker entry. Everything else the sweep
  // matched is added at `inferred` with `source: sweep`, and sent up like any
  // other finding so the dashboard and findings.json agree.
  const sweep = readSweep(out);
  // The rev on the evidence is the one the excerpts were READ at, taken from
  // the artifact. A sweep over another revision is refused rather than
  // re-stamped: its lines and excerpts describe a tree that is not this one.
  if (sweep && sweep.rev !== subject.rev)
    throw new CliError(
      `${join(out, "sweep.json")} was swept at revision ${sweep.rev ?? "(none)"}; this tree is at ` +
        `${subject.rev ?? "(none)"}. Its excerpts and line numbers describe a different tree. ` +
        `Re-run audit sweep over this tree before investigating.`,
    );
  const merged = sweep
    ? mergeSweepFindings(closure.findings, toSweepFindings(sweep.signals, sweep.rev))
    : { findings: closure.findings, added: 0, displaced: 0 };
  if (sweep) {
    for (const found of merged.findings.slice(closure.findings.length)) telemetry.finding(found);
    telemetry.log(
      "closure",
      "info",
      `sweep: ${merged.added} candidate(s) added at inferred, ${merged.displaced} on lines the model already settled`,
    );
  } else {
    telemetry.log("closure", "warn", "no sweep.json in the run directory; findings are the model's alone");
  }

  // What the investigation managed to ask, persisted for the maturity table.
  // A question that ran and found nothing is evidence; a question that never
  // ran is not — and from findings alone the two are indistinguishable, because
  // both produce none.
  writeFileSync(
    join(out, "questions.json"),
    `${JSON.stringify(
      results.map((r) => ({
        id: r.questionId,
        answered: r.dropped.length === 0 || r.claims.length > 0,
      })),
      null,
      2,
    )}\n`,
  );

  // The final total, written to disk beside what the run produced (OGE-2502).
  //
  // This is no longer what makes spend survive a failure — `reportUsage` does
  // that, on the way out of every stage. This line USED to carry that job, and
  // its comment claimed it covered "a run that dies during render". It sat
  // after the closure stage, so it covered render and nothing earlier: a run
  // that spent eighteen minutes and then died at closure recorded no cost at
  // all, and the page showed nothing, which reads as free rather than unknown.
  //
  // Nor is this any longer what puts usage.json on disk: `persistLedger` does
  // that at every stage boundary, alongside the access log, for the same
  // reason (OGE-2746). What remains here is one last authoritative total for
  // a run that completed, written outside any `finally` so a failure to write
  // it fails the run rather than being logged and passed over.
  const usage = buildUsageReport(meter, AUDIT_MODEL, rateCard);
  writeFileSync(join(out, "usage.json"), `${JSON.stringify(usage, null, 2)}\n`);
  telemetry.usage(usage);

  accessLog.writeTo(out);
  const findingsPath = join(out, "findings.json");
  writeFileSync(findingsPath, `${JSON.stringify(merged.findings, null, 2)}\n`);

  // drain, not flush: this is the last chance these events have. A single
  // flush that lands in one of the box's outbound stalls loses closure and
  // every finding, and the process exits before anything can retry.
  const outstanding = await telemetry.drain();

  process.stdout.write(
    `  ${telemetryNote}\n` +
      (outstanding.events > 0
        ? `  ! LOST ${outstanding.events} telemetry event(s) after ${outstanding.failedFlushes} failed flush(es) — ` +
          `the audit is complete and its report is on disk, but Mission Control did not receive ` +
          `this run's findings\n`
        : "") +
      `  access log ${join(out, "access-log.json")}\n  findings   ${findingsPath}\n` +
      (sweep
        ? `  sweep      ${merged.added} candidate(s) added, ${merged.displaced} displaced by a model finding on the same line\n\n`
        : "  sweep      NOT RUN; findings are the model's alone\n\n") +
      renderUsage(usage, subject.loc).join("\n") +
      "\n\n" +
      renderAsk(consolidateAsk(merged.findings)).join("\n") +
      "\n\n",
  );
  return 0;
}

/**
 * Every in-scope file, with contents, for the tag parser.
 *
 * Unreadable files are skipped rather than fatal — a binary or a permission
 * error should cost one file's ranking, not the run. They are already counted
 * in the inventory denominator, so skipping here cannot flatter coverage.
 */
function readRepoFiles(
  tree: string,
  inventory: ReturnType<typeof buildInventory>,
): RepoFile[] {
  const files: RepoFile[] = [];
  for (const file of inventory.files) {
    try {
      const full = join(tree, file.path);
      files.push({
        path: file.path,
        content: readFileSync(full, "utf8"),
        mtimeMs: statSync(full).mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return files;
}

/**
 * Read one line of one file, for the verifier's anchor check.
 *
 * Returns null rather than throwing on anything unreadable, because a missing
 * line is a legitimate verdict — it is how a citation to a file that does not
 * exist gets caught.
 */
/**
 * What a cited path is, so the gate can tell a directory from a fabrication.
 * Cached like the line reader: the same handful of paths are asked about
 * repeatedly, and a stat per citation is a syscall for nothing.
 */
function pathKindFor(tree: string): PathKind {
  const cache = new Map<string, "file" | "directory" | "missing">();
  return (path: string) => {
    let kind = cache.get(path);
    if (kind === undefined) {
      try {
        kind = statSync(join(tree, path)).isDirectory() ? "directory" : "file";
      } catch {
        kind = "missing";
      }
      cache.set(path, kind);
    }
    return kind;
  };
}

function lineReaderFor(tree: string): LineReader {
  const cache = new Map<string, string[] | null>();
  return (path: string, line: number): string | null => {
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(join(tree, path), "utf8").split("\n"));
      } catch {
        cache.set(path, null);
      }
    }
    const lines = cache.get(path);
    return lines ? (lines[line - 1] ?? null) : null;
  };
}

/**
 * Send the rendered artifacts to Mission Control, if it is configured.
 *
 * Returns lines for the operator rather than throwing. A failed upload is not a
 * failed audit: the report is on disk, which is where the real artifact has
 * always been, and this is the copy that lets somebody who is not at this
 * machine read it.
 */
async function uploadArtifacts(
  telemetry: AuditTelemetry,
  result: { typstPath: string; pdfPath: string | null },
  released: boolean,
): Promise<string[]> {
  const uploader = uploaderFromEnv(telemetry.runIdValue());
  if (!uploader)
    return ["  artifacts  local only — Mission Control is not configured"];

  const targets: Array<{ path: string; kind: "pdf" | "typ" }> = [
    ...(result.pdfPath ? [{ path: result.pdfPath, kind: "pdf" as const }] : []),
    { path: result.typstPath, kind: "typ" as const },
  ];

  const lines: string[] = [];
  for (const target of targets) {
    const outcome = await uploader.upload(target.path, target.kind, released);
    if (outcome.uploaded) {
      telemetry.log(
        "render",
        "info",
        `uploaded ${target.kind} (${outcome.bytes} bytes)`,
      );
      lines.push(`  uploaded   ${target.kind} — ${outcome.bytes} bytes`);
    } else {
      // Warn, not error: the audit succeeded. But it is said out loud, because
      // an operator who thinks the report is in Mission Control and finds it is
      // not has been misled by silence.
      telemetry.log(
        "render",
        "warn",
        `${target.kind} not uploaded — ${outcome.reason}`,
      );
      lines.push(`  ! ${target.kind} not uploaded — ${outcome.reason}`);
    }
  }
  // Render's own last chance, for the same reason investigate drains.
  await telemetry.drain();
  return lines;
}

/**
 * What the investigation asked, if the run left a record.
 *
 * Optional rather than required: a render-only invocation over an older run
 * predates this file, and omitting the maturity table is a better answer than
 * fabricating one. Unlike the access log, its absence does not make any
 * PRINTED number wrong — it removes a section rather than falsifying one.
 */
function readQuestionOutcomes(outDir: string): QuestionOutcome[] | undefined {
  try {
    return JSON.parse(
      readFileSync(join(outDir, "questions.json"), "utf8"),
    ) as QuestionOutcome[];
  } catch {
    return undefined;
  }
}

/**
 * What verification kept and threw away, if the run left a record, and
 * whether that record belongs to the findings being rendered.
 *
 * Optional for the same reason `readQuestionOutcomes` is: an older run never
 * wrote it, and the report then omits the line rather than printing a count
 * it does not have. A run that reaches render without it is not wrong about
 * anything it prints; it is silent about one thing.
 *
 * `paired` is the same mtime rule `sweepPredates` applies to sweep.json.
 * verification.json is written before the closure gate, on purpose, so a run
 * refused there still has its verify stage on record; but that run writes no
 * findings.json, and with --out reused across runs the next render would put
 * the refused run's "examined 75, rejected 54" above the previous run's
 * findings, and its "a rejected claim does not appear in this report" would
 * be about a different set of claims. Every investigate run writes
 * verification.json before findings.json, so a verification.json that is
 * NEWER than the findings is from a run that never got that far. Unreadable
 * stats pair, as they do for the sweep: the caller has the findings open, so
 * that is a race, not an answer.
 */
export function readVerificationSummary(
  outDir: string,
  findingsPath: string,
): { summary: VerificationSummary; paired: boolean } | undefined {
  const path = join(outDir, "verification.json");
  let summary: VerificationSummary;
  try {
    summary = JSON.parse(readFileSync(path, "utf8")) as VerificationSummary;
  } catch {
    return undefined;
  }
  let paired = true;
  try {
    paired = statSync(path).mtimeMs <= statSync(findingsPath).mtimeMs;
  } catch {
    paired = true;
  }
  return { summary, paired };
}

/**
 * Plant known defects in a tree, for recall calibration (OGE-2433).
 *
 * Destructive, and deliberately so — it rewrites source files in place. Point
 * it at a throwaway copy. It refuses nothing and copies nothing: a command that
 * silently duplicates a tree is one that eventually duplicates the wrong one.
 */
async function runInject(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  if (!tree) {
    process.stderr.write("inject needs --tree\n\n" + USAGE);
    return 2;
  }

  const { injected, notApplied } = injectIntoTree(tree);
  writeFileSync(
    join(tree, "..", "injected.json"),
    `${JSON.stringify(injected, null, 2)}\n`,
  );

  const lines = [
    `planted ${injected.length} defect(s) of ${DEFECT_CATALOGUE.length} in ${tree}`,
    ...injected.map(
      (d) => `  ${d.class.padEnd(22)} ${d.path}:${d.line}  ${d.id}`,
    ),
  ];
  // Named, never silent. A defect that did not apply leaves the denominator,
  // and an operator who does not know that will read the recall figure as
  // covering the whole catalogue.
  if (notApplied.length > 0) {
    lines.push("", "  not planted (these leave the denominator):");
    for (const n of notApplied) lines.push(`    ${n.id}: ${n.reason}`);
  }
  lines.push(
    "",
    "  THIS TREE IS NOW CORRUPT. Run the audit over it, then `audit recall`.",
  );

  process.stdout.write(lines.join("\n") + "\n\n");
  return 0;
}

/** Score an audit run against the defects planted in its tree. */
async function runRecall(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  const findingsPath = flag(args, "--findings");
  if (!tree || !findingsPath) {
    process.stderr.write("recall needs --tree and --findings\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  const injected = readArtifact<
    Array<Parameters<typeof matchDefects>[0][number]>
  >(join(tree, "..", "injected.json"), "audit inject");
  const findings = readArtifact<AuditFinding[]>(
    findingsPath,
    "the verify and closure stages",
  );

  const matches = matchDefects(injected, findings);
  const report = recallReport(
    matches,
    DEFECT_CATALOGUE.length - injected.length,
  );

  appendRecallRun(out, {
    ...report,
    at: new Date().toISOString(),
    subjectRev: null,
  });

  const lines = [
    ...renderRecall(report),
    "per defect:",
    "",
    ...matches.map(
      (m) =>
        `  ${m.kind === "found" ? "FOUND " : m.kind === "missed" ? "MISSED" : "vague "} ` +
        `${m.defect.class.padEnd(22)} ${m.defect.id}` +
        (m.confidence ? `  (${m.confidence})` : ""),
    ),
    "",
    `  appended to ${join(out, "recall.jsonl")}`,
  ];
  process.stdout.write(lines.join("\n") + "\n\n");
  return 0;
}

async function runRender(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  const findingsPath = flag(args, "--findings");
  if (!tree || !findingsPath) {
    process.stderr.write("render needs --tree and --findings\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  const subject = readArtifact<Subject>(subjectPathFor(tree), "audit acquire");
  const findings = readArtifact<AuditFinding[]>(
    findingsPath,
    "the verify and closure stages",
  );
  const jobs = readArtifact<JobFindings[]>(
    join(out, "analyzers.json"),
    "audit analyze",
  );

  const inventory = buildInventory(tree, out);
  const accessLog = readAccessLog(out);
  const questionOutcomes = readQuestionOutcomes(out);
  const sweep = readSweep(out);
  const verification = readVerificationSummary(out, findingsPath);
  // The merge lives in investigate, so a sweep.json written after the
  // findings holds candidates the findings do not. File order is the record
  // of that; the section says so rather than pointing at findings that are
  // not there.
  const sweepMerged = sweep ? sweepPredates(join(out, "sweep.json"), findingsPath) : true;
  const releaseBy = flag(args, "--release-by");

  const { telemetry: renderTelemetry } = resolveRun(out, subject.rev);
  if (sweep && !sweepMerged)
    renderTelemetry.log(
      "render",
      "warn",
      "sweep.json is newer than findings.json; its candidates were not folded into the findings",
    );
  if (verification && !verification.paired)
    renderTelemetry.log(
      "render",
      "warn",
      "verification.json is newer than the findings; it is from a run that wrote no findings, and the report omits it",
    );
  const result = await withStage(renderTelemetry, "render", async () => {
    const rendered = await renderReport({
      input: {
        subject,
        findings,
        // Coverage is only as real as the access log behind it; a run whose log
        // is missing is refused by the renderer rather than printed as 0%.
        coverage: computeCoverage(inventory, accessLog),
        analyzerJobs: jobs,
        analyzerReach: analyzerLanguageCoverage(inventory, jobs),
        questionCount: 10,
        // Absent when the run record is missing: the renderer omits the maturity
        // table rather than rating every category on nothing.
        ...(questionOutcomes ? { questionOutcomes } : {}),
        // Absent on a run that predates the record, and on a record from a
        // later run that wrote no findings: the line is omitted rather than
        // counted from findings, which cannot see a rejected claim, and rather
        // than printed over findings it does not describe.
        ...(verification?.paired ? { verification: verification.summary } : {}),
        // Absent when no sweep ran: the section then says so, rather than the
        // coverage figure passing as whole-tree when it is the model's alone.
        ...(sweep ? { sweep, sweepMerged } : {}),
        excluded: inventory.excluded,
        ...(releaseBy
          ? {
              release: {
                by: releaseBy,
                at: new Date().toISOString().slice(0, 10),
              },
            }
          : {}),
      },
      executiveSummary:
        "This review read source code only. Every finding below carries the evidence it rests on, " +
        "and every open question carries what would settle it.",
      outDir: out,
      subjectRev: subject.rev ?? null,
      mask: (text) => maskSecrets(text),
    });

    // Masking altering the rendered text means a literal secret reached the
    // report. The renderer refuses this outright on a release; on a draft it
    // warns, and the warning must not stop at this terminal — it is a release
    // blocker, and only the engine can see it.
    if (rendered.warnings.some((w) => /DRAFT ONLY/.test(w))) {
      renderTelemetry.recordMaskFired();
      renderTelemetry.log(
        "render",
        "error",
        "secret masking altered the rendered report",
      );
    }

    // A skipped PDF is a skipped stage with a reason, not a silent success.
    if (rendered.pdfSkipped)
      renderTelemetry.stageSkipped("render", rendered.pdfSkipped);
    else renderTelemetry.stageFinished("render", { findings: findings.length });
    return rendered;
  });

  // Upload after the render, never before: there is nothing to send until the
  // file exists, and a cancelled run never reaches here at all — verification
  // stops mid-list on a cancel, so any report built from it would look complete
  // and not be.
  const uploads = await uploadArtifacts(
    renderTelemetry,
    result,
    releaseBy !== undefined,
  );

  const lines = [
    `rendered ${findings.length} finding(s)`,
    ...(sweep && !sweepMerged
      ? ["  ! sweep.json is newer than the findings; its candidates are listed in the report as NOT folded in"]
      : []),
    `  source     ${result.typstPath}`,
    result.pdfPath
      ? `  pdf        ${result.pdfPath}`
      : `  pdf        NOT PRODUCED — ${result.pdfSkipped}`,
    releaseBy
      ? `  released   ${releaseBy}`
      : "  status     DRAFT — watermarked, not for distribution",
  ];
  for (const warning of result.warnings) lines.push(`  ! ${warning}`);
  for (const line of uploads) lines.push(line);
  process.stdout.write(lines.join("\n") + "\n\n");
  return 0;
}

/** An operator mistake, printed as a sentence rather than a stack trace. */
class CliError extends Error {}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command === "acquire") return runAcquire(args.slice(1));
  if (command === "inventory") return runInventory(args.slice(1));
  if (command === "sweep") return runSweep(args.slice(1));
  if (command === "analyze") return runAnalyze(args.slice(1));
  if (command === "investigate") return runInvestigate(args.slice(1));
  if (command === "inject") return runInject(args.slice(1));
  if (command === "recall") return runRecall(args.slice(1));
  if (command === "render") return runRender(args.slice(1));

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

// Only run the CLI when this file is the entry point. Without this guard,
// `import { resolveStartedBy } from "./audit-cli.js"` — which is exactly what
// a test importing an exported helper does — ran the whole dispatcher against
// the test runner's own argv, printed USAGE, and called `process.exit(1)` as
// an unhandled rejection (found writing tests for OGE-2563, the first test
// this file ever had).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      // A run someone stopped is not a failure. Its own exit code, so a script
      // wrapping this can tell "the operator stopped it" from "it broke".
      if (error instanceof RunCancelled) {
        process.stderr.write(`\n${error.message}\n`);
        process.exit(130);
      }
      // An AcquireError is a refusal we chose — say it plainly, without a stack
      // that makes a deliberate safety check look like a crash.
      if (
        error instanceof AcquireError ||
        error instanceof RenderRefused ||
        error instanceof CliError
      ) {
        process.stderr.write(`\n${error.message}\n`);
        process.exit(1);
      }
      process.stderr.write(
        `\n${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exit(1);
    });
}
