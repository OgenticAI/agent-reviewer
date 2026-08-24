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
import { join } from "node:path";

import { acquire, AcquireError, writeSubject, subjectPathFor, type Subject } from "./engine/audit/acquire.js";
import { buildInventory, writeInventory, computeCoverage, FileAccessLog, COVERAGE_CAVEAT } from "./engine/audit/inventory.js";
import { runAnalyzers, analyzerLanguageCoverage, skippedAnalyzerNotes } from "./engine/audit/analyze.js";
import { renderReport, RenderRefused } from "./engine/audit/render.js";
import type { AuditFinding } from "./engine/audit/finding.js";
import type { JobFindings } from "./engine/findings/schema.js";
import { investigate, summariseInvestigation, type Claim } from "./engine/audit/investigate.js";
import { verifyClaims, summariseVerification, type LineReader } from "./engine/audit/verify.js";
import { toAuditFindings, assertAllClosuresResolved, consolidateAsk, renderAsk } from "./engine/audit/closure.js";
import { loadQuestionSet } from "./engine/audit/questions.js";
import { makeReadTool } from "./engine/audit/read-tool.js";
import { buildRepoMap, TagCache, type RepoFile } from "./engine/repomap/index.js";
import { makeInvestigateModel, makeVerifierModel } from "./audit-model.js";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";

/**
 * The baseline question set, resolved relative to this file rather than the
 * working directory — the CLI is run from wherever the tree happens to be.
 */
const DEFAULT_QUESTIONS = fileURLToPath(new URL("../questions/taxonomy.yml", import.meta.url));
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

async function runAcquire(args: string[]): Promise<number> {
  const from = flag(args, "--from");
  const into = flag(args, "--into");
  if (!from || !into) {
    process.stderr.write("acquire needs --from and --into\n\n" + USAGE);
    return 2;
  }

  const subject = await acquire({ from, into, replace: args.includes("--replace") });
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

  const inventory = buildInventory(tree);
  const path = writeInventory(flag(args, "--out") ?? tree, inventory);

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

  const jobs = await runAnalyzers(tree);
  const out = flag(args, "--out") ?? tree;
  writeFileSync(join(out, "analyzers.json"), `${JSON.stringify(jobs, null, 2)}\n`);

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
    const ran = analyzers.length > 0 ? analyzers.join(", ") : "NOTHING RAN OVER THIS";
    lines.push(`    ${language.padEnd(12)} ${String(files).padStart(5)} files  ${ran}`);
  }

  const skips = skippedAnalyzerNotes(jobs);
  if (skips.length > 0) {
    lines.push("", "  for the report's Coverage section:");
    for (const note of skips) lines.push(`    ${note}`);
  }

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
    const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : "could not be read";
    throw new CliError(`${path} ${why}.\nIt is written by ${producedBy}. Run that first, or pass the directory it wrote to.`);
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
  if (!apiKey) throw new CliError("ANTHROPIC_API_KEY is not set. The investigation stage needs a model.");

  const subject = readArtifact<Subject>(subjectPathFor(tree), "audit acquire");
  const jobs = readArtifact<JobFindings[]>(join(out, "analyzers.json"), "audit analyze");
  const questionSet = loadQuestionSet(flag(args, "--questions") ?? DEFAULT_QUESTIONS);

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
  const repoFiles = readRepoFiles(tree, inventory);

  process.stdout.write(
    `investigating ${subject.name} — ${questionSet.questions.length} question(s), ` +
      `${inventory.files.length} file(s) in scope\n`,
  );

  const results = await investigate({
    questions: questionSet.questions,
    model: makeInvestigateModel(modelOptions),
    repoMapFor: (seedTexts) =>
      buildRepoMap({ files: repoFiles, diffTouchedFiles: [], seedTexts, diffText: "", cache }).text,
    analyzerJobs: jobs,
    subjectRev: subject.rev,
  });

  const investigation = summariseInvestigation(results);
  const claims: Claim[] = results.flatMap((r) => r.claims);
  process.stdout.write(
    `  claims     ${claims.length} kept, ${investigation.dropped} dropped\n` +
      `  files      ${accessLog.opened().size} opened\n`,
  );

  const verification = await verifyClaims({
    claims,
    model: makeVerifierModel(modelOptions),
    readLine: lineReaderFor(tree),
    ...(flag(args, "--verifiers") ? { verifiers: Number(flag(args, "--verifiers")) } : {}),
  });

  const summary = summariseVerification(verification);
  process.stdout.write(
    `  verified   ${summary.verified} · inferred ${summary.inferred} · ` +
      `not-determinable ${summary.notDeterminable} · rejected ${verification.rejected.length}\n`,
  );

  const closure = toAuditFindings({ verified: verification.verified });
  assertAllClosuresResolved(closure);

  accessLog.writeTo(out);
  const findingsPath = join(out, "findings.json");
  writeFileSync(findingsPath, `${JSON.stringify(closure.findings, null, 2)}\n`);

  process.stdout.write(
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
function readRepoFiles(tree: string, inventory: ReturnType<typeof buildInventory>): RepoFile[] {
  const files: RepoFile[] = [];
  for (const file of inventory.files) {
    try {
      const full = join(tree, file.path);
      files.push({ path: file.path, content: readFileSync(full, "utf8"), mtimeMs: statSync(full).mtimeMs });
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

async function runRender(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  const findingsPath = flag(args, "--findings");
  if (!tree || !findingsPath) {
    process.stderr.write("render needs --tree and --findings\n\n" + USAGE);
    return 2;
  }

  const out = flag(args, "--out") ?? tree;
  const subject = readArtifact<Subject>(subjectPathFor(tree), "audit acquire");
  const findings = readArtifact<AuditFinding[]>(findingsPath, "the verify and closure stages");
  const jobs = readArtifact<JobFindings[]>(join(out, "analyzers.json"), "audit analyze");

  const inventory = buildInventory(tree);
  const accessLog = readAccessLog(out);
  const releaseBy = flag(args, "--release-by");

  const result = await renderReport({
    input: {
      subject,
      findings,
      // Coverage is only as real as the access log behind it; a run whose log
      // is missing is refused by the renderer rather than printed as 0%.
      coverage: computeCoverage(inventory, accessLog),
      analyzerJobs: jobs,
      analyzerReach: analyzerLanguageCoverage(inventory, jobs),
      questionCount: 10,
      ...(releaseBy ? { release: { by: releaseBy, at: new Date().toISOString().slice(0, 10) } } : {}),
    },
    executiveSummary:
      "This review read source code only. Every finding below carries the evidence it rests on, " +
      "and every open question carries what would settle it.",
    outDir: out,
    subjectRev: subject.rev ?? null,
    mask: (text) => maskSecrets(text),
  });

  const lines = [
    `rendered ${findings.length} finding(s)`,
    `  source     ${result.typstPath}`,
    result.pdfPath ? `  pdf        ${result.pdfPath}` : `  pdf        NOT PRODUCED — ${result.pdfSkipped}`,
    releaseBy ? `  released   ${releaseBy}` : "  status     DRAFT — watermarked, not for distribution",
  ];
  for (const warning of result.warnings) lines.push(`  ! ${warning}`);
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
    // An AcquireError is a refusal we chose — say it plainly, without a stack
    // that makes a deliberate safety check look like a crash.
    if (error instanceof AcquireError || error instanceof RenderRefused || error instanceof CliError) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
