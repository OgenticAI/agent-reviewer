import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  semgrepAdapter,
  gitleaksAdapter,
  npmAuditAdapter,
  GITLEAKS_VALUE_FIELDS,
} from "../../src/engine/audit/analyzers.js";
import {
  describeToolFailure,
  MAX_DETAIL_CHARS,
  runAnalyzer,
  runAnalyzers,
  analyzerLanguageCoverage,
  skippedAnalyzerNotes,
  SEMGREP,
  SECRET_SCAN,
  DEPENDENCY_AUDIT,
  type AnalyzerSpec,
} from "../../src/engine/audit/analyze.js";
import type { Inventory } from "../../src/engine/audit/inventory.js";
import type { JobFindings } from "../../src/engine/findings/schema.js";
import type { TreeFile } from "../../src/engine/audit/tree.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "analyze-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ── semgrep ─────────────────────────────────────────────────────────────── */

const SEMGREP_JSON = JSON.stringify({
  results: [
    {
      check_id: "javascript.express.security.audit.xss",
      path: "src/routes/user.ts",
      start: { line: 42, col: 7 },
      extra: { message: "Untrusted input reaches res.send", severity: "ERROR" },
    },
    {
      check_id: "generic.secrets.hardcoded",
      path: "src/config.ts",
      start: { line: 3 },
      extra: { message: "Hardcoded value", severity: "WARNING" },
    },
  ],
  errors: [],
});

/** A report path the caller names; only the file-mode analyzers use it. */
const REPORT = "/tmp/audit-report.json";

describe("the semgrep adapter", () => {
  it("normalises results into findings", () => {
    const findings = semgrepAdapter.parse(SEMGREP_JSON)!;
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      path: "src/routes/user.ts",
      position: { line: 42, column: 7 },
      severity: "error",
      source: "semgrep",
      code: "javascript.express.security.audit.xss",
    });
    expect(findings[1]?.severity).toBe("warning");
  });

  // A clean run is a POSITIVE fact and must not read as "could not parse".
  it("returns an empty array for a clean run, not null", () => {
    expect(semgrepAdapter.parse(JSON.stringify({ results: [], errors: [] }))).toEqual([]);
  });

  it.each([
    ["not json", "this is not json"],
    ["json without results", JSON.stringify({ errors: [] })],
    ["a bare array", JSON.stringify([{ path: "a.ts" }])],
    ["null", "null"],
  ])("returns null for %s rather than throwing", (_name, raw) => {
    expect(semgrepAdapter.parse(raw)).toBeNull();
  });

  it("drops a result with no path rather than inventing one", () => {
    const raw = JSON.stringify({ results: [{ check_id: "x", extra: { message: "m" } }] });
    expect(semgrepAdapter.parse(raw)).toEqual([]);
  });
});

/* ── the secret scanner ──────────────────────────────────────────────────── */

/**
 * Real gitleaks output shape, including the fields that carry the value.
 *
 * The fixture value is deliberately NOT shaped like any vendor's key. The first
 * version used a realistic vendor-shaped key and GitHub push protection
 * rejected the branch — a test about never leaking a secret, blocked for
 * looking like one. The properties under test do not need a realistic key, only
 * a distinctive string that must not survive into a finding.
 */
const FIXTURE_SECRET = "EXAMPLE-SECRET-VALUE-DO-NOT-MATCH";
const GITLEAKS_JSON = JSON.stringify([
  {
    RuleID: "stripe-access-token",
    // gitleaks echoes a prefix of the match in its own description.
    Description: `Stripe access token found, ${FIXTURE_SECRET.slice(0, 14)}...`,
    File: "src/config/appsettings.json",
    StartLine: 46,
    Secret: FIXTURE_SECRET,
    Match: `"StripeKey": "${FIXTURE_SECRET}"`,
    Line: `  "StripeKey": "${FIXTURE_SECRET}",`,
  },
]);

describe("the secret scanner adapter", () => {
  it("records the location", () => {
    const findings = gitleaksAdapter.parse(GITLEAKS_JSON)!;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "src/config/appsettings.json",
      position: { line: 46 },
      severity: "error",
      source: "secret-scan",
      code: "stripe-access-token",
    });
  });

  // The standing rule for client work: existence and location, never the value.
  // A findings file that quotes the secret is a second copy of the credential.
  it("carries NO part of the secret value into the finding", () => {
    const serialised = JSON.stringify(gitleaksAdapter.parse(GITLEAKS_JSON));

    expect(serialised).not.toContain(FIXTURE_SECRET);
    expect(serialised).not.toContain(FIXTURE_SECRET.slice(0, 14));
    expect(serialised).not.toContain("StripeKey");
  });

  // gitleaks' own Description echoes a prefix of the match, so it is never used.
  it("does not reuse the tool's description, which leaks a prefix", () => {
    const serialised = JSON.stringify(gitleaksAdapter.parse(GITLEAKS_JSON));
    expect(serialised).not.toContain(FIXTURE_SECRET.slice(0, 14));
    expect(serialised).not.toContain("Stripe access token found");
  });

  it("names every value-bearing field so the deny-list can be reviewed", () => {
    expect([...GITLEAKS_VALUE_FIELDS]).toEqual(["Secret", "Match", "Line"]);
  });

  it("treats an explicit null report as clean rather than unparseable", () => {
    expect(gitleaksAdapter.parse("null")).toEqual([]);
  });

  it("returns null for output it does not recognise", () => {
    expect(gitleaksAdapter.parse(JSON.stringify({ findings: [] }))).toBeNull();
  });
});

/* ── dependency audit ────────────────────────────────────────────────────── */

describe("the dependency-audit adapter", () => {
  it("attaches advisories to the manifest, where the fix is", () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        "left-pad": {
          severity: "high",
          range: "<1.3.0",
          via: [{ title: "Prototype pollution in left-pad" }],
        },
      },
    });
    const findings = npmAuditAdapter.parse(raw)!;

    expect(findings[0]).toMatchObject({
      path: "package.json",
      severity: "error", // npm "high" normalises to the reviewdog error level
      source: "dependency-audit",
      code: "left-pad",
    });
    expect(findings[0]?.message).toContain("Prototype pollution");
  });

  // npm's words are its own. Every one of them maps to `unknown` through the
  // shared normaliser, which would leave a CRITICAL advisory unranked and
  // invisible to the findings gate.
  it.each([
    ["critical", "error"],
    ["high", "error"],
    ["moderate", "warning"],
    ["low", "info"],
    ["something-new", "unknown"],
  ])("maps npm severity %s to %s", (npm, expected) => {
    const raw = JSON.stringify({ vulnerabilities: { pkg: { severity: npm, via: [] } } });
    expect(npmAuditAdapter.parse(raw)![0]!.severity).toBe(expected);
  });

  it("reads a clean audit as clean", () => {
    expect(npmAuditAdapter.parse(JSON.stringify({ vulnerabilities: {} }))).toEqual([]);
  });

  it("returns null when the vulnerabilities key is absent", () => {
    expect(npmAuditAdapter.parse(JSON.stringify({ metadata: {} }))).toBeNull();
  });
});

/* ── never execute the tree's own config ─────────────────────────────────── */

describe("the tree under audit cannot configure the tools", () => {
  it("plants a hostile config and it appears in no argument list", () => {
    // Everything a codebase might ship to silence or subvert a scan.
    mkdirSync(join(scratch, ".github"), { recursive: true });
    for (const name of [".semgrepignore", ".semgrep.yml", ".gitleaksignore", ".gitleaks.toml", ".npmrc"]) {
      writeFileSync(join(scratch, name), "# hostile\n");
    }

    for (const spec of [SEMGREP, SECRET_SCAN, DEPENDENCY_AUDIT]) {
      const args = spec.args(scratch, REPORT).join(" ");
      for (const name of [".semgrepignore", ".semgrep.yml", ".gitleaksignore", ".gitleaks.toml", ".npmrc"]) {
        expect(args).not.toContain(name);
      }
    }
  });

  it("names its own semgrep ruleset instead of resolving one at run time", () => {
    const args = SEMGREP.args(scratch, REPORT);
    expect(args).toContain("--config=p/security-audit");
    expect(args).not.toContain("--config=auto");
    // A codebase that excludes itself from review would otherwise scan clean
    // by its own instruction.
    expect(args).toContain("--no-git-ignore");
  });

  it("stops the secret scanner honouring an ignore file in the tree", () => {
    expect(SECRET_SCAN.args(scratch, REPORT)).toContain("--no-git");
  });
});

/* ── skipping, with a reason ─────────────────────────────────────────────── */

describe("a skipped analyzer says why", () => {
  // An empty tree genuinely has nothing to scan. The reason names every
  // ecosystem that was looked for, because "no npm lockfile" over a .NET or Go
  // tree reads as "there is nothing here" when nobody had looked.
  it("names every ecosystem it looked for when it finds none", async () => {
    const job = await runAnalyzer(DEPENDENCY_AUDIT, scratch);

    expect(job.parsed).toBe(false);
    expect(job.findings).toEqual([]);
    expect(job.reason).toMatch(/npm/i);
    expect(job.reason).toMatch(/nuget/i);
  });

  // The case that motivated this: a tree full of dependencies in an ecosystem
  // npm audit cannot answer for. The skip must carry the count, or the report
  // implies zero advisories where the truth is zero looking.
  it("counts what went unscanned when the ecosystem is not npm", async () => {
    writeFileSync(
      join(scratch, "Api.csproj"),
      '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>',
    );
    const job = await runAnalyzer(DEPENDENCY_AUDIT, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/1 nuget package/i);
    expect(job.reason).toMatch(/NOT checked/);
  });

  it("passes the precondition once a lockfile is present", () => {
    writeFileSync(join(scratch, "package-lock.json"), "{}\n");
    expect(DEPENDENCY_AUDIT.precondition!(scratch)).toBeNull();
  });

  // Proven with a tool that genuinely is not installed, not with a stub.
  it("reports an uninstalled tool as a skip rather than a crash", async () => {
    const absent: AnalyzerSpec = {
      ...SEMGREP,
      job: "definitely-not-installed",
      command: "ogenticai-no-such-binary",
    };
    const job = await runAnalyzer(absent, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/is not installed/);
  });

  it("reports unrecognised output as a skip, not as a clean run", async () => {
    const nonsense: AnalyzerSpec = {
      job: "echo-nonsense",
      command: "echo",
      args: () => ["definitely not json"],
      adapter: semgrepAdapter,
      reach: "*",
    };
    const job = await runAnalyzer(nonsense, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/does not recognise/);
  });

  // Many analyzers exit non-zero BECAUSE they found something, and still wrote
  // good JSON. Treating that as "could not run" would drop the findings we came for.
  it("keeps the output of a tool that exited non-zero but still reported", async () => {
    const noisy: AnalyzerSpec = {
      job: "exits-nonzero",
      command: "sh",
      args: () => ["-c", `echo '${SEMGREP_JSON}'; exit 1`],
      adapter: semgrepAdapter,
      reach: "*",
    };
    const job = await runAnalyzer(noisy, scratch);

    expect(job.parsed).toBe(true);
    expect(job.findings).toHaveLength(2);
  });

  it("renders every skip as a Coverage line, generated not authored", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: true, findings: [] },
      { job: "dependency-audit", parsed: false, findings: [], reason: "no npm lockfile at the repository root" },
    ];
    expect(skippedAnalyzerNotes(jobs)).toEqual([
      "dependency-audit: not run — no npm lockfile at the repository root",
    ]);
  });

  it("still says something when a skip lost its reason", () => {
    expect(skippedAnalyzerNotes([{ job: "x", parsed: false, findings: [] }])[0]).toMatch(
      /no reason recorded/,
    );
  });

  // The timeout is explicit because this test invokes the REAL analyzers. It
  // was written when none of them was installed, so it returned skips in
  // milliseconds; once OGE-2463 put semgrep on the machine it started actually
  // scanning and blew vitest's 5s default. A test that passes only while the
  // tooling is missing is a test that fails on every properly set-up machine.
  it("runs the whole set without one failure taking down the others", async () => {
    const jobs = await runAnalyzers(scratch);
    expect(jobs.map((j) => j.job).sort()).toEqual([
      "dependency-audit",
      "dependency-audit-osv",
      "secret-scan",
      "semgrep",
    ]);
    // Nothing throws, whether the tools are installed or not.
    expect(jobs.every((j) => Array.isArray(j.findings))).toBe(true);
  }, 120_000);
});

/* ── analyzer reach per language ─────────────────────────────────────────── */

function file(path: string, language: string): TreeFile {
  return { path, language, bytes: 1, loc: 1, sha256: "x" };
}

function inventoryOf(files: TreeFile[]): Inventory {
  return { files, excluded: [], builtAt: "2026-08-24T00:00:00.000Z" };
}

describe("analyzer reach, so a report cannot imply parity", () => {
  const inventory = inventoryOf([
    file("a.ts", "typescript"),
    file("b.ts", "typescript"),
    file("Handler.cs", "csharp"),
    file("notes.md", "markdown"),
  ]);

  it("lists which analyzers actually ran, per language", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: true, findings: [] },
      { job: "secret-scan", parsed: true, findings: [] },
      { job: "dependency-audit", parsed: false, findings: [], reason: "no lockfile" },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);

    expect(coverage.typescript).toEqual({ files: 2, analyzers: ["semgrep", "secret-scan"] });
    expect(coverage.csharp).toEqual({ files: 1, analyzers: ["semgrep", "secret-scan"] });
    // markdown gets only the content-based scanner.
    expect(coverage.markdown).toEqual({ files: 1, analyzers: ["secret-scan"] });
  });

  // npm audit reads the dependency tree, not the code. Crediting it to
  // TypeScript would report hundreds of source files as deterministically
  // covered on a run where no code analyzer started at all.
  it("does not credit the dependency audit to any source language", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: false, findings: [], reason: "not installed" },
      { job: "secret-scan", parsed: false, findings: [], reason: "not installed" },
      { job: "dependency-audit", parsed: true, findings: [] },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);

    expect(coverage.typescript?.analyzers).toEqual([]);
    expect(coverage.javascript).toBeUndefined();
  });

  // The honest headline: a language nothing deterministic ran over.
  it("shows an empty analyzer list when the pass reached a language not at all", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: false, findings: [], reason: "not installed" },
      { job: "secret-scan", parsed: false, findings: [], reason: "not installed" },
      { job: "dependency-audit", parsed: false, findings: [], reason: "no lockfile" },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);

    expect(coverage.csharp?.analyzers).toEqual([]);
    expect(coverage.typescript?.analyzers).toEqual([]);
  });

  it("does not credit an analyzer that failed to run", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: false, findings: [], reason: "not installed" },
      { job: "secret-scan", parsed: true, findings: [] },
    ];
    expect(analyzerLanguageCoverage(inventory, jobs).typescript?.analyzers).toEqual(["secret-scan"]);
  });
});

/* ── /dev/stdout is not a report path ─────────────────────────────────────── */

describe("analyzers that write their report to a file", () => {
  // gitleaks pre-checks that --report-path is writable by opening it, and
  // /dev/stdout fails that check with EACCES whenever stdout is a pipe — which
  // it always is under a spawn. The failure is total: the scan never starts.
  //
  // The trap is that the old form LOOKED fine. On a developer's terminal stdout
  // is a tty and /dev/stdout opens happily, so it broke only where it mattered:
  // on the box, where every run is piped. Measured there as
  // "secret-scan SKIPPED — gitleaks failed to run" with every non-code language
  // reading NOTHING RAN OVER THIS.
  it("never asks a tool to write its report to /dev/stdout", () => {
    for (const spec of [SEMGREP, SECRET_SCAN, DEPENDENCY_AUDIT]) {
      expect(spec.args(scratch, REPORT).join(" ")).not.toContain("/dev/stdout");
    }
  });

  it("hands the secret scanner the path the runner chose", () => {
    const args = SECRET_SCAN.args(scratch, REPORT);
    expect(args[args.indexOf("--report-path") + 1]).toBe(REPORT);
    expect(SECRET_SCAN.usesReportFile).toBe(true);
  });

  // The report is ours and belongs nowhere near the subject: a file we create
  // inside a client's checkout could be mistaken for part of it.
  it("puts the report outside the tree under audit", () => {
    expect(REPORT.startsWith(scratch)).toBe(false);
    const src = readFileSync(
      fileURLToPath(new URL("../../src/engine/audit/analyze.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/mkdtemp\(join\(tmpdir\(\)/);
  });

  // Several gitleaks versions write nothing at all when they find nothing.
  // That is an empty result, not a failure to run.
  it("treats an absent report after a clean exit as no findings", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/engine/audit/analyze.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/existsSync\(reportPath\) \? readFileSync\(reportPath, "utf8"\) : "\[\]"/);
  });
});

/* ── The line of stderr worth showing ─────────────────────────────────────── */

describe("what a failed tool is reported as", () => {
  // Measured on the box: semgrep crashed three times and every report read
  // "semgrep failed to run: Traceback (most recent call last):" — the first
  // line of a Python traceback, which is the one line guaranteed to carry no
  // information. The cause was five frames below it.
  it("reports the exception from a traceback, not its header", () => {
    const stderr = [
      "Traceback (most recent call last):",
      '  File "semgrep/cli.py", line 12, in main',
      "    self.configure()",
      '  File "semgrep/terminal.py", line 91, in configure',
      "    env.user_log_file.parent.mkdir(parents=True, exist_ok=True)",
      "PermissionError: [Errno 13] Permission denied: '/home/x/.semgrep'",
    ].join("\n");

    const detail = describeToolFailure(stderr);
    expect(detail).toMatch(/PermissionError/);
    expect(detail).toMatch(/Permission denied/);
    expect(detail).not.toMatch(/Traceback/);
  });

  // Taking the last line is only right for a traceback. A tool that prints one
  // error and then some noise should still report the error.
  it("reports the first line for anything that is not a traceback", () => {
    const stderr = "fatal: repository not found\nsome trailing noise";
    expect(describeToolFailure(stderr)).toBe("fatal: repository not found");
  });

  it("ignores blank lines at either end", () => {
    expect(describeToolFailure("\n\n  fatal: nope  \n\n")).toBe("fatal: nope");
  });

  it.each([undefined, null, "", "   \n  "])("says so when there is no output: %s", (stderr) => {
    expect(describeToolFailure(stderr)).toBe("no output");
  });

  // This ends up on one row of a dashboard.
  it("truncates a very long line rather than filling the page", () => {
    const detail = describeToolFailure(`Traceback (most recent call last):\nValueError: ${"x".repeat(2000)}`);
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    expect(detail.endsWith("\u2026")).toBe(true);
  });
});
