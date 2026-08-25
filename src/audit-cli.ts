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
 *   acquire → inventory → map → analyze → investigate → verify → closure → render
 */

import { writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

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
  COVERAGE_CAVEAT,
} from "./engine/audit/inventory.js";
import {
  runAnalyzers,
  analyzerLanguageCoverage,
  skippedAnalyzerNotes,
} from "./engine/audit/analyze.js";
import { renderReport, RenderRefused } from "./engine/audit/render.js";
import type { QuestionOutcome } from "./engine/audit/maturity.js";
import type { AuditFinding } from "./engine/audit/finding.js";
import type { JobFindings } from "./engine/findings/schema.js";
import {
  investigate,
  summariseInvestigation,
  type Claim,
} from "./engine/audit/investigate.js";
import {
  verifyClaims,
  summariseVerification,
  type LineReader,
} from "./engine/audit/verify.js";
import {
  toAuditFindings,
  assertAllClosuresResolved,
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
import { makeInvestigateModel, makeVerifierModel } from "./audit-model.js";
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

  audit acquire   --from <source> --into <dir> [--replace]
  audit inventory --tree <dir> [--out <dir>]
  audit analyze   --tree <dir> [--out <dir>]
  audit investigate --tree <dir> [--out <dir>] [--questions <yml>] [--verifiers <n>]
  audit render    --tree <dir> --findings <findings.json> [--out <dir>] [--release-by <email>]

    <source>  a clone URL, host/owner/repo, a local path, or a .zip / .tar.gz
    --into    where the tree lands; refuses an existing directory
    --replace overwrite an existing directory instead of refusing
    --tree    an acquired tree to enumerate
    --out     where inventory.json / findings land (default: beside the tree)
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
 * The run this invocation belongs to.
 *
 * Each subcommand is a separate process, so the id has to live on disk or the
 * dashboard sees five unrelated runs instead of one audit with five stages.
 * Written by whichever stage runs first; every later stage joins it.
 */
function resolveRun(outDir: string): {
  runId: string;
  telemetry: AuditTelemetry;
  note: string;
} {
  const path = join(outDir, "run.json");

  let runId: string;
  if (existsSync(path)) {
    runId = (JSON.parse(readFileSync(path, "utf8")) as { runId: string }).runId;
  } else {
    runId = randomUUID();
    writeFileSync(
      path,
      `${JSON.stringify({ runId, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

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

  const { telemetry: acquireTelemetry } = resolveRun(dirname(resolve(into)));
  const subject = await withStage(acquireTelemetry, "acquire", () =>
    acquire({
      from,
      into,
      replace: args.includes("--replace"),
    }).then((acquired) => {
      acquireTelemetry.stageFinished("acquire", {
        files: acquired.files,
        lines: acquired.loc,
      });
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
  const { telemetry, note: telemetryNote } = resolveRun(out);

  const inventory = await withStage(telemetry, "inventory", () => {
    const built = buildInventory(tree);
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
  const { telemetry, note: telemetryNote } = resolveRun(out);

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

  const coverage = analyzerLanguageCoverage(buildInventory(tree), jobs);
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
        `Run the investigation stage over this tree first.`,
    );
  }
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

  const { telemetry, note: telemetryNote } = resolveRun(out);
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
    // requested" forever.
    if (error instanceof RunCancelled) await telemetry.flush();
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
  const inventory = buildInventory(tree);

  // The log the model writes into, and the only source of the coverage figure.
  const accessLog = new FileAccessLog();
  const readTool = makeReadTool({ root: tree, log: accessLog });

  const anthropic = new Anthropic({ apiKey });
  const modelOptions = { anthropic, readTool };

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
  });

  process.stdout.write(
    `investigating ${subject.name} — ${questionSet.questions.length} question(s), ` +
      `${inventory.files.length} file(s) in scope\n`,
  );

  const results = await withStage(telemetry, "investigate", async () => {
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
      onProgress: (done, total) =>
        telemetry.progress("investigate", done, total),
    });
    telemetry.stageFinished("investigate", {
      questions: runs.length,
      claims: runs.reduce((n, r) => n + r.claims.length, 0),
      filesOpened: accessLog.opened().size,
    });
    return runs;
  });

  const investigation = summariseInvestigation(results);
  const claims: Claim[] = results.flatMap((r) => r.claims);
  process.stdout.write(
    `  claims     ${claims.length} kept, ${investigation.dropped} dropped\n` +
      `  files      ${accessLog.opened().size} opened\n`,
  );

  const verification = await withStage(telemetry, "verify", async () => {
    const result = await verifyClaims({
      claims,
      model: makeVerifierModel(modelOptions),
      readLine: lineReaderFor(tree),
      log: (message) => telemetry.log("verify", "info", message),
      onProgress: (done, total) => {
        telemetry.progress("verify", done, total);
        void telemetry.flush();
      },
      shouldStop: () => telemetry.cancelRequested(),
      ...(flag(args, "--verifiers")
        ? { verifiers: Number(flag(args, "--verifiers")) }
        : {}),
    });
    telemetry.stageFinished("verify", {
      verified: result.verified.length,
      rejected: result.rejected.length,
    });
    return result;
  });

  const summary = summariseVerification(verification);
  process.stdout.write(
    `  verified   ${summary.verified} · inferred ${summary.inferred} · ` +
      `not-determinable ${summary.notDeterminable} · rejected ${verification.rejected.length}\n`,
  );

  // Verification stops mid-list on a cancel, so the claim set here is partial.
  // Rendering a report from it would produce a document that looks complete and
  // is not — the one output this engine must never produce.
  telemetry.throwIfCancelled("closure");

  const closure = await withStage(telemetry, "closure", () => {
    const result = toAuditFindings({ verified: verification.verified });
    assertAllClosuresResolved(result);
    // Findings go up as they are settled, so the UI can show them long before
    // the PDF exists.
    for (const found of result.findings) telemetry.finding(found);
    telemetry.stageFinished("closure", { findings: result.findings.length });
    return result;
  });

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

  accessLog.writeTo(out);
  const findingsPath = join(out, "findings.json");
  writeFileSync(findingsPath, `${JSON.stringify(closure.findings, null, 2)}\n`);

  await telemetry.flush();
  const outstanding = telemetry.outstanding();

  process.stdout.write(
    `  ${telemetryNote}\n` +
      (outstanding.events > 0
        ? `  ! ${outstanding.events} telemetry event(s) undelivered after ${outstanding.failedFlushes} failed flush(es)\n`
        : "") +
      `  access log ${join(out, "access-log.json")}\n  findings   ${findingsPath}\n\n` +
      renderAsk(consolidateAsk(closure.findings)).join("\n") +
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
  await telemetry.flush();
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

  const inventory = buildInventory(tree);
  const accessLog = readAccessLog(out);
  const questionOutcomes = readQuestionOutcomes(out);
  const releaseBy = flag(args, "--release-by");

  const { telemetry: renderTelemetry } = resolveRun(out);
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
  if (command === "analyze") return runAnalyze(args.slice(1));
  if (command === "investigate") return runInvestigate(args.slice(1));
  if (command === "render") return runRender(args.slice(1));

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

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
