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
 *
 * ── Reach is measured, not declared ─────────────────────────────────────────
 *
 * The first version credited an analyzer that ran with every language its
 * spec listed. One failed rule pack gave semgrep exit 7, `results: []` and
 * `paths.scanned: []`, and the job was still `parsed: true`; the report then
 * credited semgrep with the whole tree and the model was told "ran and
 * reported nothing, a positive fact". Now every job records the files the tool
 * itself said it read, and credit is given per scanned file.
 *
 * ── The tree's own configuration ────────────────────────────────────────────
 *
 * The rule in `analyzers.ts` is that we never execute a config from the tree
 * under audit. Three of the four tools broke it behind the flags meant to
 * stop them, each probed on the installed version: a tree `.gitleaks.toml` or
 * `.gitleaksignore` gave zero secrets, a tree `.semgrepignore` gave zero
 * results despite `--no-git-ignore`, and `npm audit` read the tree's `.npmrc`
 * despite `--userconfig /dev/null`. So the files are moved aside for the
 * duration of the run and put back in a `finally`, and every one moved is
 * recorded on the job so the report can name it.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Adapter } from "../findings/adapters.js";
import type { Finding, JobFindings } from "../findings/schema.js";
import {
  capErrors,
  gitleaksAdapter,
  npmAuditAdapter,
  npmAuditError,
  osvMeta,
  osvScannerAdapter,
  semgrepAdapter,
  semgrepMeta,
  type ScanMeta,
} from "./analyzers.js";
import { describeUnscanned, NPM_AUDIT_LOCKFILES, npmLockfileDirs, scanDependencyManifests } from "./dependencies.js";
import { buildInventory, type Inventory } from "./inventory.js";

const run = promisify(execFile);

export const ANALYZER_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * semgrep's per-file budget. Its default is five seconds per rule per file,
 * after which the rule is dropped for that file silently unless the JSON is
 * read for it. Thirty seconds is generous enough that a timeout means the file
 * is genuinely pathological, and every one is recorded in `errors` regardless.
 */
export const SEMGREP_RULE_TIMEOUT_SECONDS = 30;
/** Rules allowed to time out on one file before semgrep gives up on the file. */
export const SEMGREP_TIMEOUT_THRESHOLD = 3;

/** Our own tool configuration, resolved from the repository, never from the tree. */
const CONFIG_DIR = fileURLToPath(new URL("../../../config/", import.meta.url));
export const GITLEAKS_CONFIG = join(CONFIG_DIR, "audit-gitleaks.toml");
export const OSV_CONFIG = join(CONFIG_DIR, "audit-osv.toml");

/**
 * A language token from `tree.ts`, or `"*"` for an analyzer whose reach does
 * not depend on language — a secret scanner reads bytes, not syntax.
 */
export type AnalyzerReach = readonly string[] | "*";

/**
 * What every analyzer in a run shares: the tree walked once, and the record of
 * which of the tree's config files are out of the way while the tools run.
 */
export interface AnalyzerContext {
  inventory: Inventory;
  /** Languages present in the tree, from the inventory. Spares each spec a walk of its own. */
  languages: ReadonlySet<string>;
  /** Tree config moved aside for the run, repo-relative. */
  neutralised: string[];
  /** Tree config that could not be moved aside, repo-relative. A tool that reads one of these must not run. */
  stuck: string[];
}

export interface AnalyzerSpec {
  job: string;
  /** The executable. Absent from PATH is a skip, not a failure. */
  command: string;
  /**
   * Arguments, built by us from the root path and the run context alone.
   *
   * Nothing here may be read out of the tree under audit. `--config` values are
   * ours; the flags below exist to stop the tool picking up the target's own
   * configuration behind our back, and `treeConfig` names what is moved aside
   * because flags alone were shown not to be enough.
   *
   * `root` is the directory this invocation scans. For an analyzer with
   * `targets`, that is one target directory at a time.
   */
  args(root: string, reportPath: string, context: AnalyzerContext): string[];
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
   *
   * semgrep uses it for a different reason: a report bigger than `maxBuffer`
   * on stdout kills the child and loses the whole report, and the error that
   * comes back looks like an adapter fault. A file has no such limit.
   */
  usesReportFile?: boolean;
  /**
   * What to read when the tool exits cleanly and writes no report at all.
   * Several gitleaks versions do that when they find nothing. Absent means a
   * missing report is a failure.
   */
  emptyReport?: string;
  reach: AnalyzerReach;
  /** A precondition that is not the tool's fault — a missing lockfile, say. */
  precondition?(root: string): string | null;
  /** What a "not installed" skip should add: the count of what went unexamined. */
  notInstalledDetail?(root: string): string | null;
  /** Filenames the tool reads from the tree if present. Moved aside for the run. */
  treeConfig?: readonly string[];
  /** How to ask the tool its version; the first dotted number in the answer is recorded. */
  versionArgs?: readonly string[];
  /** What the tool's own report says about the scan. Absent for a tool whose report has no such section. */
  inspect?(raw: string): ScanMeta | null;
  /**
   * The files the tool read, as absolute paths, for a tool whose report does
   * not say. gitleaks walks the tree and prints nothing about it; the
   * inventory is the honest stand-in, because those are the files the run is
   * answerable for.
   */
  walked?(root: string, context: AnalyzerContext): string[];
  /**
   * A reason hidden inside otherwise well-formed output: npm's JSON error
   * envelope is valid JSON the adapter rightly refuses, and without this the
   * skip blamed the adapter for a registry that could not be reached.
   */
  explainOutput?(raw: string): string | null;
  /**
   * Directories to run in, repo-relative and sorted; `""` is the root.
   * Absent means the root only. npm audit resolves one lockfile per run.
   */
  targets?(root: string): string[];
  /** Per-spec overrides, for tests that exercise the limits with real processes. */
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const SEMGREP: AnalyzerSpec = {
  job: "semgrep",
  command: "semgrep",
  usesReportFile: true,
  args: (root, reportPath, context) => [
    "--json",
    // OUR rulesets, named explicitly. Never `--config auto`, which resolves
    // against the registry at run time, and never a path inside the target.
    //
    // p/security-audit alone is not enough, and the gap is not small. Measured
    // on a .NET subject of a couple of thousand files: p/security-audit
    // returned ZERO findings with zero parse errors, while p/csharp returned a
    // handful on the same tree, several of them a token-expiry rule that
    // corroborated a high-severity finding established by hand. The pack was
    // reading the files and had nothing to say about them.
    //
    // So the language packs are added from what the tree actually contains. A
    // pack for a language that is absent costs a registry fetch and finds
    // nothing, which is why this is computed rather than fixed.
    "--config=p/security-audit",
    ...languagePacks(context.languages).map((pack) => `--config=${pack}`),
    // Stop semgrep honouring the tree's .gitignore. Its .semgrepignore is a
    // different mechanism this flag does not touch, which is why that file is
    // in `treeConfig` below and moved aside for the run.
    "--no-git-ignore",
    "--disable-version-check",
    "--metrics=off",
    "--quiet",
    `--timeout=${SEMGREP_RULE_TIMEOUT_SECONDS}`,
    `--timeout-threshold=${SEMGREP_TIMEOUT_THRESHOLD}`,
    // To a file, not stdout: see `usesReportFile`.
    ...(reportPath ? ["--output", reportPath] : []),
    root,
  ],
  adapter: semgrepAdapter,
  inspect: semgrepMeta,
  treeConfig: [".semgrepignore"],
  versionArgs: ["--version"],
  // semgrep's registry rulesets span many languages, but not evenly. What this
  // claims is only that it CAN produce findings for these; what it actually
  // read is measured per file from its own report, not taken from this list.
  //
  // csharp earns its place here only because `languagePacks` now adds p/csharp.
  // Under p/security-audit alone it produced nothing on a C# tree.
  reach: ["typescript", "javascript", "python", "go", "java", "ruby", "php", "csharp"],
};

/**
 * Registry packs for the languages this tree actually contains.
 *
 * Keyed off the inventory rather than fixed, so a repository gets the rules
 * for what it is written in, and off the inventory rather than a walk of its
 * own, so building the arguments does not read the tree a second time. The
 * general pack still runs alongside these.
 */
export function languagePacks(languages: ReadonlySet<string>): string[] {
  const packs: string[] = [];
  const add = (language: string, pack: string) => {
    if (languages.has(language)) packs.push(pack);
  };
  add("csharp", "p/csharp");
  add("java", "p/java");
  add("python", "p/python");
  add("go", "p/golang");
  add("ruby", "p/ruby");
  add("php", "p/php");
  if (languages.has("typescript") || languages.has("javascript")) packs.push("p/javascript");
  return packs;
}

export const SECRET_SCAN: AnalyzerSpec = {
  job: "secret-scan",
  command: "gitleaks",
  usesReportFile: true,
  emptyReport: "[]",
  args: (root, reportPath) => [
    "detect",
    "--source",
    root,
    // Ours, always. Without it gitleaks reads a .gitleaks.toml at the source
    // root, and one with `useDefault = false` turns every secret into nothing.
    "--config",
    GITLEAKS_CONFIG,
    "--report-format",
    "json",
    "--report-path",
    reportPath,
    // The tree may have no history at all (an archive).
    "--no-git",
    "--redact",
    "--exit-code",
    "0",
  ],
  adapter: gitleaksAdapter,
  // A .gitleaksignore at the source root is honoured whatever
  // --gitleaks-ignore-path says; probed. Moving it is the only thing that works.
  treeConfig: [".gitleaks.toml", ".gitleaksignore"],
  versionArgs: ["version"],
  // gitleaks prints nothing about what it walked. The inventory is what the
  // run is answerable for, so that is what it is credited with.
  walked: (root, context) => context.inventory.files.map((file) => join(root, ...file.path.split("/"))),
  reach: "*",
};

export const DEPENDENCY_AUDIT: AnalyzerSpec = {
  job: "dependency-audit",
  command: "npm",
  // `--userconfig /dev/null` keeps the operator's own ~/.npmrc out of it. The
  // tree's .npmrc is a separate config level this flag does not reach, which
  // is why it is in `treeConfig`.
  args: (root) => ["audit", "--json", "--prefix", root, "--userconfig", "/dev/null"],
  adapter: npmAuditAdapter,
  treeConfig: [".npmrc"],
  versionArgs: ["--version"],
  // NO source language. This analyzer reads the dependency tree, not the code:
  // its findings attach to package.json and say nothing about any .ts file.
  //
  // Claiming it reaches "typescript" made the reach table report 904 TypeScript
  // files as deterministically covered on a run where semgrep never started —
  // which is precisely the implied parity this table exists to prevent. The
  // first version of this file got that wrong.
  reach: [],
  // One audit per lockfile directory. `--prefix root` resolves the root
  // lockfile only, and a `client/package-lock.json` was never audited.
  targets: (root) => npmLockfileDirs(root),
  walked: (dir) => NPM_AUDIT_LOCKFILES.map((name) => join(dir, name)).filter((path) => existsSync(path)),
  explainOutput: npmAuditError,
  // The skip speaks for npm only. What another ecosystem declares is the OSV
  // job's to report, because on a host where osv-scanner is installed those
  // packages ARE checked, and "no advisory source" here would be a lie.
  precondition: (root) => {
    if (npmLockfileDirs(root).length > 0) return null;
    const found = scanDependencyManifests(root);
    if (found.length === 0) {
      return "no dependency manifest found in any supported ecosystem (npm, NuGet, PyPI, Go, Maven)";
    }
    const others = found.filter((f) => f.ecosystem !== "npm");
    const handoff =
      others.length === 0
        ? ""
        : `; ${others
            .map((f) => `${f.packages} ${f.ecosystem} package(s) across ${f.manifests.length} manifest(s)`)
            .join("; ")} left to dependency-audit-osv`;
    const noLockfile = "no package-lock.json or npm-shrinkwrap.json anywhere in the tree";
    const unscanned = describeUnscanned(found, others.map((f) => f.ecosystem));
    if (unscanned) return `${noLockfile}; ${unscanned}${handoff}`;
    if (found.some((f) => f.ecosystem === "npm")) {
      return `${noLockfile}, and the npm manifest(s) present declare no packages${handoff}`;
    }
    return `no npm manifest in the tree${handoff}`;
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
 * told about is a wrong report. The skip carries the count of what went
 * unexamined, because that is the number a reader will ask about.
 */
export const DEPENDENCY_AUDIT_OSV: AnalyzerSpec = {
  job: "dependency-audit-osv",
  command: "osv-scanner",
  // Ours, always: an osv-scanner.toml beside a manifest lists advisories to
  // ignore, and an override keeps it out of the run.
  args: (root) => ["--format", "json", "--recursive", "--config", OSV_CONFIG, root],
  adapter: osvScannerAdapter,
  inspect: osvMeta,
  treeConfig: ["osv-scanner.toml"],
  versionArgs: ["--version"],
  // Same reason as above: this reads the dependency graph, not the code. Its
  // findings attach to manifests and say nothing about any source file.
  reach: [],
  // Also the pnpm and yarn trees: osv-scanner reads those lockfiles, and npm
  // audit cannot, so without this a pnpm repository had no advisory scan at all.
  precondition: (root) => {
    const found = scanDependencyManifests(root);
    const covered = found.some((f) => f.packages > 0 && (f.ecosystem !== "npm" || hasPnpmOrYarnLock(f.manifests)));
    return covered ? null : "no non-npm dependency manifest in the tree";
  },
  notInstalledDetail: (root) => describeUnscanned(scanDependencyManifests(root), ["npm"]),
};

function hasPnpmOrYarnLock(manifests: string[]): boolean {
  return manifests.some((m) => ["pnpm-lock.yaml", "yarn.lock"].includes(basename(m)));
}

export const AUDIT_ANALYZERS: AnalyzerSpec[] = [SEMGREP, SECRET_SCAN, DEPENDENCY_AUDIT, DEPENDENCY_AUDIT_OSV];

/** Every filename any configured analyzer would read from the tree. */
export function treeConfigNames(specs: AnalyzerSpec[] = AUDIT_ANALYZERS): Set<string> {
  return new Set(specs.flatMap((spec) => [...(spec.treeConfig ?? [])]));
}

function skipped(job: string, reason: string, extra: Partial<JobFindings> = {}): JobFindings {
  return { job, parsed: false, findings: [], reason, ...extra };
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
 * The tool's version, from whatever it prints for `versionArgs`.
 *
 * The first dotted number is enough: `1.174.0`, `8.30.1`, or the first line
 * of osv-scanner's four. Recorded so a finding can be reproduced against the
 * same rules, and undefined rather than a guess when the tool will not say.
 */
export async function toolVersion(spec: AnalyzerSpec): Promise<string | undefined> {
  if (!spec.versionArgs) return undefined;
  try {
    const result = await run(spec.command, [...spec.versionArgs], { timeout: 10_000 });
    return `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
  } catch {
    return undefined;
  }
}

/**
 * A path as the tree knows it: repo-relative, POSIX separators.
 *
 * Tools print paths relative to THEIR working directory, which is ours, not
 * the tree's: semgrep given `./work/tree` prints `work/tree/a.ts`. Resolving
 * both sides against the same cwd is what makes the two agree.
 */
export function relativeToRoot(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

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
 * gitleaks is the other shape. It opens with a banner drawn in box glyphs, so
 * the first line is a lone circle, and the cause follows as a zerolog line
 * tagged FTL or ERR. So: a line with no letters in it is never the one; a line
 * tagged FTL or ERR wins outright; for a traceback, the last non-empty line,
 * which is the exception; for anything else the first, which is still the
 * summary. All truncated, because this ends up on one row of a dashboard.
 */
export const MAX_DETAIL_CHARS = 300;

/** Terminal colour codes, which gitleaks emits even into a pipe. Built, not written, so no control character sits in a regex literal. */
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

export function describeToolFailure(stderr: unknown): string {
  if (typeof stderr !== "string" || stderr.trim() === "") return "no output";
  const lines = stderr
    .trim()
    .split("\n")
    .map((line) => line.replace(ANSI_COLOUR, "").trim())
    .filter((line) => /\p{L}/u.test(line));
  if (lines.length === 0) return "no output";

  const tagged = lines.find((line) => /(^|\s)(FTL|ERR)(\s|$)/.test(line));
  const isTraceback = /^Traceback \(most recent call last\)/.test(lines[0] ?? "");
  const chosen = tagged ?? (isTraceback ? (lines[lines.length - 1] as string) : (lines[0] as string));
  return chosen.length <= MAX_DETAIL_CHARS ? chosen : `${chosen.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/* ── Moving the tree's configuration out of the way ───────────────────────── */

/**
 * Run `fn` with every tree config file the given analyzers would read moved
 * aside, then put every one of them back.
 *
 * Renamed in place, next to where it was, rather than moved to a temp dir: a
 * rename within one directory is atomic and cannot fail across filesystems,
 * and if the process dies mid-run the file is still there under a name a
 * human can recognise, not lost. The suffix carries the pid so two runs over
 * one tree cannot collide.
 *
 * A file that cannot be renamed (a read-only checkout, say) is reported in
 * `stuck`, and `runAnalyzer` refuses to run any tool that would read it. The
 * scan would otherwise proceed under the subject's own instruction, which is
 * exactly the outcome this exists to prevent.
 */
export async function withTreeConfigAside<T>(
  root: string,
  inventory: Inventory,
  specs: AnalyzerSpec[],
  fn: (moved: string[], stuck: string[]) => Promise<T>,
): Promise<T> {
  const names = treeConfigNames(specs);
  const suffix = `.audit-aside-${process.pid}`;
  const moved: Array<{ rel: string; from: string; to: string }> = [];
  const stuck: string[] = [];

  for (const file of inventory.files) {
    if (!names.has(basename(file.path))) continue;
    const from = join(root, ...file.path.split("/"));
    const to = `${from}${suffix}`;
    try {
      renameSync(from, to);
      moved.push({ rel: file.path, from, to });
    } catch {
      stuck.push(file.path);
    }
  }

  // The outcome is held rather than returned from a `finally`, so a failed
  // restore can be raised after every rename has been attempted, and the
  // scan's own error still surfaces when the restore went fine.
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await fn(moved.map((m) => m.rel), stuck) };
  } catch (error) {
    outcome = { error };
  }

  const lost: string[] = [];
  for (const m of moved) {
    try {
      renameSync(m.to, m.from);
    } catch {
      lost.push(m.to);
    }
  }
  // Loud, and after every restore has been attempted: a subject's file left
  // under a scratch name is the one outcome worse than a bad scan.
  if (lost.length > 0) {
    throw new Error(`could not restore tree configuration moved aside for the scan: ${lost.join(", ")}`);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/** The run context for a tree: one walk, shared by every analyzer. */
export function analyzerContext(root: string, inventory: Inventory = buildInventory(root)): AnalyzerContext {
  return {
    inventory,
    languages: new Set(inventory.files.map((file) => file.language)),
    neutralised: [],
    stuck: [],
  };
}

/* ── One invocation ───────────────────────────────────────────────────────── */

interface Invocation {
  findings: Finding[];
  meta: ScanMeta | null;
}

interface InvocationFailure {
  failure: string;
}

/** What `execFile` rejects with. `killed` is set only when OUR timeout stopped it. */
interface ExecFailure {
  killed?: unknown;
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/**
 * Run the tool once over one directory, with every failure named for what it
 * was.
 *
 * The first version accepted any non-empty stdout as a report. A `maxBuffer`
 * overrun, which truncates the output and kills the child, and npm's JSON
 * error envelope both reached the adapter, which rightly refused them, and the
 * skip then blamed the adapter. A timeout arrived as `killed: true` with empty
 * stdout and was reported as "no output". Each now has its own reason.
 */
async function invoke(
  spec: AnalyzerSpec,
  dir: string,
  context: AnalyzerContext,
): Promise<Invocation | InvocationFailure> {
  const timeoutMs = spec.timeoutMs ?? ANALYZER_TIMEOUT_MS;
  const maxBuffer = spec.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  // Scratch for the report file. Ours, in the OS temp dir rather than in the
  // tree, so nothing we create is ever mistaken for part of the subject and
  // no write lands inside a client's checkout. Created inside the try so a
  // failure here is this job's failure and not a rejection that takes every
  // other job down with it.
  let workDir: string;
  try {
    workDir = await mkdtemp(join(tmpdir(), `audit-${spec.job}-`));
  } catch (error) {
    return { failure: `could not create a scratch directory for the report: ${(error as Error).message}` };
  }

  try {
    const reportPath = spec.usesReportFile ? join(workDir, "report.json") : "";
    const args = spec.args(dir, reportPath, context);

    let stdout = "";
    let execError: ExecFailure | null = null;
    try {
      stdout = (await run(spec.command, args, { timeout: timeoutMs, maxBuffer })).stdout;
    } catch (error) {
      execError = error as ExecFailure;
      if (typeof execError.stdout === "string") stdout = execError.stdout;
    }

    if (execError?.killed === true) {
      const minutes = Math.round((timeoutMs / 60_000) * 100) / 100;
      return { failure: `${spec.command} was stopped after ${minutes} minute(s) without finishing` };
    }
    if (execError?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      const mb = Math.round(maxBuffer / (1024 * 1024));
      return {
        failure: `${spec.command} wrote more than ${mb} MB to stdout and was stopped; its report is truncated and cannot be trusted`,
      };
    }

    if (spec.usesReportFile) {
      if (existsSync(reportPath)) {
        stdout = readFileSync(reportPath, "utf8");
      } else if (execError) {
        return { failure: `${spec.command} failed to run: ${describeToolFailure(execError.stderr)}` };
      } else if (spec.emptyReport !== undefined) {
        stdout = spec.emptyReport;
      } else {
        return { failure: `${spec.command} exited cleanly but wrote no report` };
      }
    } else if (execError && stdout.trim() === "") {
      // Many analyzers exit non-zero simply BECAUSE they found something, and
      // still wrote perfectly good JSON. Only an empty stdout is a failure;
      // treating "found problems" as "could not run" would silently drop
      // exactly the findings we came for.
      return { failure: `${spec.command} failed to run: ${describeToolFailure(execError.stderr)}` };
    }

    const explained = spec.explainOutput?.(stdout);
    if (explained) return { failure: `${spec.command} reported an error instead of a report: ${explained}` };

    const meta = spec.inspect?.(stdout) ?? null;
    if (meta?.fatal) {
      return { failure: `${spec.command} could not load its rules and scanned nothing: ${meta.fatal}` };
    }

    const findings = spec.adapter.parse(stdout);
    if (findings === null) {
      return { failure: `${spec.command} produced output this adapter does not recognise` };
    }
    return { findings, meta };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/* ── One analyzer ─────────────────────────────────────────────────────────── */

/**
 * Run one analyzer over the tree.
 *
 * Never throws. Every failure mode becomes a `parsed: false` with a reason a
 * reader can act on, because an audit that fell over silently is worse than one
 * that says which tool it could not run.
 *
 * Without a context of its own, this builds one and moves the tree's config
 * aside for just this run. `runAnalyzers` does that once for the whole set.
 */
export async function runAnalyzer(
  spec: AnalyzerSpec,
  root: string,
  context?: AnalyzerContext,
): Promise<JobFindings> {
  if (!context) {
    const fresh = analyzerContext(root);
    return withTreeConfigAside(root, fresh.inventory, [spec], (neutralised, stuck) =>
      runAnalyzer(spec, root, { ...fresh, neutralised, stuck }),
    );
  }

  const blocked = spec.precondition?.(root);
  if (blocked) return skipped(spec.job, blocked);

  const mine = (paths: string[]) => paths.filter((p) => (spec.treeConfig ?? []).includes(basename(p)));
  const stuck = mine(context.stuck);
  if (stuck.length > 0) {
    return skipped(
      spec.job,
      `${stuck.join(", ")} in the tree could not be moved aside, so ${spec.command} would have run under the subject's own configuration`,
    );
  }

  if (!(await isInstalled(spec.command))) {
    const detail = spec.notInstalledDetail?.(root);
    return skipped(spec.job, `${spec.command} is not installed on this machine${detail ? `; ${detail}` : ""}`);
  }

  const version = await toolVersion(spec);
  const neutralised = mine(context.neutralised);
  const record: Partial<JobFindings> = {
    ...(version === undefined ? {} : { toolVersion: version }),
    ...(neutralised.length > 0 ? { neutralised } : {}),
  };

  const targets = spec.targets?.(root) ?? [""];
  if (targets.length === 0) return skipped(spec.job, `${spec.command} has no directory to run in`, record);
  const findings: Finding[] = [];
  const scannedPaths = new Set<string>();
  const errors: string[] = [];
  const failures: string[] = [];

  for (const target of targets) {
    const dir = target ? join(root, ...target.split("/")) : root;
    const result = await invoke(spec, dir, context);
    if ("failure" in result) {
      failures.push(target ? `${target}: ${result.failure}` : result.failure);
      continue;
    }
    for (const finding of result.findings) {
      // Repo-relative, as `Finding.path` promises. semgrep and gitleaks print
      // the path they were handed, absolute when the root is, and the model
      // is later asked to open these by the tree's own names. A finding npm
      // attaches to "package.json" belongs to the lockfile directory it was
      // audited in, not to the root's.
      let path = finding.path;
      if (isAbsolute(path)) path = relativeToRoot(root, path);
      else if (target && !path.startsWith(`${target}/`)) path = `${target}/${path}`;
      findings.push({ ...finding, path });
    }
    for (const p of result.meta?.scannedPaths ?? spec.walked?.(dir, context) ?? []) {
      scannedPaths.add(relativeToRoot(root, p));
    }
    errors.push(...(result.meta?.errors ?? []));
  }

  if (failures.length === targets.length) {
    return skipped(
      spec.job,
      targets.length === 1 ? (failures[0] as string) : `every lockfile directory failed: ${failures.join("; ")}`,
      record,
    );
  }

  return {
    job: spec.job,
    parsed: true,
    findings,
    scannedPaths: [...scannedPaths].sort(),
    errors: capErrors([...failures, ...errors]),
    ...record,
  };
}

/**
 * Every analyzer over the tree, with the walk done once and the tree's config
 * out of the way for all of them. One job's failure is its own skip and never
 * a rejection that drops the rest.
 */
export async function runAnalyzers(
  root: string,
  specs: AnalyzerSpec[] = AUDIT_ANALYZERS,
  inventory?: Inventory,
): Promise<JobFindings[]> {
  const base = analyzerContext(root, inventory);
  return withTreeConfigAside(root, base.inventory, specs, (neutralised, stuck) => {
    const context: AnalyzerContext = { ...base, neutralised, stuck };
    return Promise.all(specs.map((spec) => runAnalyzer(spec, root, context)));
  });
}

/* ── What the deterministic pass actually reached ─────────────────────────── */

/**
 * The row for analyzers whose reach does not depend on language. A secret
 * scanner reads every file, and listing it under each language would make a
 * markdown file look as deterministically reviewed as a TypeScript one.
 */
export const ALL_FILES = "all files";

export interface LanguageAnalyzerCoverage {
  files: number;
  /**
   * Language-specific analyzers measured to have read at least one file of
   * this language. On the `ALL_FILES` row, the content scanners that read
   * anything at all.
   */
  analyzers: string[];
  /**
   * Files each analyzer reported reading, content scanners included. An
   * analyzer absent here did not measure its reach; one present with zero
   * read nothing of this language.
   */
  scanned: Record<string, number>;
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
 * Credit is per scanned file, from the job's own `scannedPaths`. A job that
 * ran but recorded no paths is credited with nothing: reach it did not
 * measure is reach it cannot claim. A language with an empty `analyzers` list
 * is the honest headline: nothing language-aware ran over it at all.
 */
export function analyzerLanguageCoverage(
  inventory: Inventory,
  jobs: JobFindings[],
  specs: AnalyzerSpec[] = AUDIT_ANALYZERS,
): Record<string, LanguageAnalyzerCoverage> {
  const languageOf = new Map(inventory.files.map((file) => [file.path, file.language]));
  const contentJobs = new Set(specs.filter((spec) => spec.reach === "*").map((spec) => spec.job));

  const filesByLanguage = new Map<string, number>();
  for (const file of inventory.files) {
    filesByLanguage.set(file.language, (filesByLanguage.get(file.language) ?? 0) + 1);
  }

  // job -> language -> files read.
  const measured = new Map<string, Map<string, number>>();
  for (const job of jobs) {
    if (!job.parsed || !Array.isArray(job.scannedPaths)) continue;
    const byLanguage = new Map<string, number>();
    for (const path of new Set(job.scannedPaths)) {
      const language = languageOf.get(path);
      if (language === undefined) continue;
      byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
    }
    measured.set(job.job, byLanguage);
  }

  const out: Record<string, LanguageAnalyzerCoverage> = {};
  for (const [language, files] of [...filesByLanguage].sort(([a], [b]) => a.localeCompare(b))) {
    const scanned: Record<string, number> = {};
    for (const [job, byLanguage] of measured) scanned[job] = byLanguage.get(language) ?? 0;
    out[language] = {
      files,
      analyzers: [...measured]
        .filter(([job, byLanguage]) => !contentJobs.has(job) && (byLanguage.get(language) ?? 0) > 0)
        .map(([job]) => job),
      scanned,
    };
  }

  if (contentJobs.size > 0) {
    const scanned: Record<string, number> = {};
    for (const [job, byLanguage] of measured) {
      if (contentJobs.has(job)) scanned[job] = [...byLanguage.values()].reduce((a, b) => a + b, 0);
    }
    out[ALL_FILES] = {
      files: inventory.files.length,
      analyzers: Object.entries(scanned)
        .filter(([, count]) => count > 0)
        .map(([job]) => job),
      scanned,
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
