import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  semgrepAdapter,
  semgrepMeta,
  gitleaksAdapter,
  npmAuditAdapter,
  npmAuditError,
  osvMeta,
  GITLEAKS_VALUE_FIELDS,
} from "../../src/engine/audit/analyzers.js";
import {
  ALL_FILES,
  analyzerContext,
  describeToolFailure,
  GITLEAKS_CONFIG,
  MAX_DETAIL_CHARS,
  OSV_CONFIG,
  runAnalyzer,
  runAnalyzers,
  analyzerLanguageCoverage,
  skippedAnalyzerNotes,
  treeConfigNames,
  withTreeConfigAside,
  SEMGREP,
  SECRET_SCAN,
  DEPENDENCY_AUDIT,
  DEPENDENCY_AUDIT_OSV,
  AUDIT_ANALYZERS,
  type AnalyzerSpec,
} from "../../src/engine/audit/analyze.js";
import type { Inventory } from "../../src/engine/audit/inventory.js";
import type { JobFindings } from "../../src/engine/findings/schema.js";
import type { TreeFile } from "../../src/engine/audit/tree.js";

let scratch: string;
/** A second temp dir for fixtures that must NOT be inside the tree under audit. */
let outside: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "analyze-test-"));
  outside = mkdtempSync(join(tmpdir(), "analyze-fixture-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const full = join(scratch, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

/** Whether a real tool is on this machine. The adapter tests below run the binaries, not stubs. */
function installed(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
}

const hasSemgrep = installed("semgrep");
const hasGitleaks = installed("gitleaks");
const hasOsv = installed("osv-scanner");
const hasNpm = installed("npm");

/** Long enough for a registry fetch; the real-binary tests need the network. */
const TOOL_TIMEOUT = 180_000;

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
  paths: { scanned: ["src/routes/user.ts", "src/config.ts"] },
});

/**
 * What semgrep actually printed for one failed rule pack, probed on the
 * installed version: exit 7, no results, nothing scanned, two errors without
 * a path. The first version of the runner called this a clean scan.
 */
const SEMGREP_BAD_PACK_JSON = JSON.stringify({
  version: "1.174.0",
  results: [],
  errors: [
    {
      code: 2,
      level: "error",
      type: "SemgrepError",
      message: "Failed to download configuration from https://semgrep.dev/c/p/does-not-exist HTTP 404.",
    },
    { code: 7, level: "error", type: "SemgrepError", message: "invalid configuration file found (1 configs were invalid)" },
  ],
  paths: { scanned: [] },
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

describe("what semgrep says it read", () => {
  it("lists the scanned paths the report carries", () => {
    const meta = semgrepMeta(SEMGREP_JSON)!;
    expect(meta.scannedPaths).toEqual(["src/routes/user.ts", "src/config.ts"]);
    expect(meta.fatal).toBeNull();
  });

  // The probe that motivated this: a pack that never loaded is not a clean scan.
  it("treats a rule-pack error as fatal, because nothing was scanned under it", () => {
    const meta = semgrepMeta(SEMGREP_BAD_PACK_JSON)!;
    expect(meta.scannedPaths).toEqual([]);
    expect(meta.fatal).toMatch(/Failed to download configuration/);
    expect(meta.fatal).toMatch(/does-not-exist/);
  });

  // A file semgrep could not fully parse is a gap in THAT file, and the scan
  // went on past it. Recorded, not fatal.
  it("records a per-file error without discarding the report", () => {
    const raw = JSON.stringify({
      results: [],
      errors: [{ code: 3, level: "warn", type: "PartialParsing", message: "syntax error", path: "src/odd.ts" }],
      paths: { scanned: ["src/odd.ts", "src/fine.ts"] },
    });
    const meta = semgrepMeta(raw)!;
    expect(meta.fatal).toBeNull();
    expect(meta.errors).toHaveLength(1);
    expect(meta.errors[0]).toContain("src/odd.ts");
    expect(meta.scannedPaths).toHaveLength(2);
  });

  it("returns null for output that is not a semgrep report", () => {
    expect(semgrepMeta("nope")).toBeNull();
    expect(semgrepMeta("[]")).toBeNull();
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

/** What npm prints on stdout, as JSON, when it cannot reach a registry. Probed. */
const NPM_ERROR_ENVELOPE = JSON.stringify({
  message: "request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  error: { summary: "", detail: "" },
});

describe("npm's error envelope", () => {
  it("is read for its message rather than blamed on the adapter", () => {
    expect(npmAuditError(NPM_ERROR_ENVELOPE)).toMatch(/ECONNREFUSED/);
  });

  it("is not confused with a clean audit", () => {
    expect(npmAuditError(JSON.stringify({ vulnerabilities: {} }))).toBeNull();
  });
});

describe("what osv-scanner says it read", () => {
  it("lists each manifest once, however many packages it held", () => {
    const raw = JSON.stringify({
      results: [
        { source: { path: "/tree/requirements.txt" }, packages: [] },
        { source: { path: "/tree/requirements.txt", type: "unknown" }, packages: [] },
        { source: { path: "/tree/api/Api.csproj" }, packages: [] },
      ],
    });
    expect(osvMeta(raw)?.scannedPaths).toEqual(["/tree/requirements.txt", "/tree/api/Api.csproj"]);
  });
});

/* ── never execute the tree's own config ─────────────────────────────────── */

const HOSTILE_CONFIG = [".semgrepignore", ".semgrep.yml", ".gitleaksignore", ".gitleaks.toml", ".npmrc", "osv-scanner.toml"];

describe("the tree under audit cannot configure the tools", () => {
  it("plants a hostile config and it appears in no argument list", () => {
    // Everything a codebase might ship to silence or subvert a scan.
    mkdirSync(join(scratch, ".github"), { recursive: true });
    for (const name of HOSTILE_CONFIG) writeFileSync(join(scratch, name), "# hostile\n");

    const context = analyzerContext(scratch);
    for (const spec of AUDIT_ANALYZERS) {
      const args = spec.args(scratch, REPORT, context).join(" ");
      for (const name of HOSTILE_CONFIG) expect(args).not.toContain(name);
    }
  });

  // Flags were shown not to be enough. Each of these files was probed on the
  // installed tool and silenced the scan behind the flag meant to stop it, so
  // every one is named for moving aside.
  it("names every file the tools would read from the tree", () => {
    const names = treeConfigNames();
    for (const name of [".semgrepignore", ".gitleaksignore", ".gitleaks.toml", ".npmrc", "osv-scanner.toml"]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("names its own semgrep ruleset instead of resolving one at run time", () => {
    const args = SEMGREP.args(scratch, REPORT, analyzerContext(scratch));
    expect(args).toContain("--config=p/security-audit");
    expect(args).not.toContain("--config=auto");
    expect(args).toContain("--no-git-ignore");
  });

  // A rule that hangs on one file must not take the run with it, and the
  // budget must be ours rather than semgrep's default, which drops the rule
  // for that file without saying so on stdout.
  it("gives semgrep an explicit per-file budget", () => {
    const args = SEMGREP.args(scratch, REPORT, analyzerContext(scratch));
    expect(args.some((a) => /^--timeout=\d+$/.test(a))).toBe(true);
    expect(args.some((a) => /^--timeout-threshold=\d+$/.test(a))).toBe(true);
  });

  it("adds a language pack only for languages the inventory saw", () => {
    write("Handler.cs", "class Handler {}");
    const args = SEMGREP.args(scratch, REPORT, analyzerContext(scratch));
    expect(args).toContain("--config=p/csharp");
    expect(args).not.toContain("--config=p/python");
  });

  it("hands the secret scanner our bundled config, which exists", () => {
    const args = SECRET_SCAN.args(scratch, REPORT, analyzerContext(scratch));
    expect(args[args.indexOf("--config") + 1]).toBe(GITLEAKS_CONFIG);
    expect(existsSync(GITLEAKS_CONFIG)).toBe(true);
    expect(args).toContain("--no-git");
  });

  it("hands osv-scanner our bundled config, which exists", () => {
    const args = DEPENDENCY_AUDIT_OSV.args(scratch, REPORT, analyzerContext(scratch));
    expect(args[args.indexOf("--config") + 1]).toBe(OSV_CONFIG);
    expect(existsSync(OSV_CONFIG)).toBe(true);
  });

  it("keeps the operator's own npm configuration out of the audit", () => {
    const args = DEPENDENCY_AUDIT.args(scratch, REPORT, analyzerContext(scratch));
    expect(args[args.indexOf("--userconfig") + 1]).toBe("/dev/null");
  });
});

describe("moving the tree's configuration aside", () => {
  it("moves every named file for the duration and puts each one back", async () => {
    write(".semgrepignore", "src/\n");
    write("client/.npmrc", "registry=http://127.0.0.1:9/\n");
    write("src/a.ts", "export const a = 1;\n");

    const context = analyzerContext(scratch);
    let during: string[] = [];
    const moved = await withTreeConfigAside(scratch, context.inventory, AUDIT_ANALYZERS, async (neutralised) => {
      during = readdirSync(scratch).sort();
      return neutralised;
    });

    expect(moved.sort()).toEqual([".semgrepignore", "client/.npmrc"]);
    expect(during).not.toContain(".semgrepignore");
    expect(existsSync(join(scratch, ".semgrepignore"))).toBe(true);
    expect(readFileSync(join(scratch, ".semgrepignore"), "utf8")).toBe("src/\n");
    expect(readFileSync(join(scratch, "client/.npmrc"), "utf8")).toBe("registry=http://127.0.0.1:9/\n");
    // Nothing of ours left behind under a scratch name.
    expect(readdirSync(scratch).filter((n) => n.includes("audit-aside"))).toEqual([]);
  });

  it("restores the files even when the scan throws", async () => {
    write(".gitleaksignore", "x\n");
    const context = analyzerContext(scratch);
    await expect(
      withTreeConfigAside(scratch, context.inventory, AUDIT_ANALYZERS, async () => {
        throw new Error("scan fell over");
      }),
    ).rejects.toThrow("scan fell over");
    expect(readFileSync(join(scratch, ".gitleaksignore"), "utf8")).toBe("x\n");
  });

  it("leaves a tree with none of them alone", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const context = analyzerContext(scratch);
    const moved = await withTreeConfigAside(scratch, context.inventory, AUDIT_ANALYZERS, async (m) => m);
    expect(moved).toEqual([]);
  });

  it("records only the files the analyzer itself reads on its job", async () => {
    write(".npmrc", "registry=http://127.0.0.1:9/\n");
    write("secret.txt", "nothing here\n");
    const echo: AnalyzerSpec = {
      job: "echo-clean",
      command: "echo",
      args: () => [JSON.stringify({ results: [], paths: { scanned: [] } })],
      adapter: semgrepAdapter,
      treeConfig: [".npmrc"],
      reach: "*",
    };
    const job = await runAnalyzer(echo, scratch);
    expect(job.neutralised).toEqual([".npmrc"]);
    expect(existsSync(join(scratch, ".npmrc"))).toBe(true);
  });
});

/* ── the real binaries, on trees that try to silence them ────────────────── */

/**
 * A value gitleaks' generic rule flags: a keyword and a high-entropy string.
 * Generated per run so nothing shaped like a credential is ever committed,
 * which is the same reason the adapter fixture above is not vendor-shaped.
 */
function plantedSecret(): string {
  return randomBytes(24).toString("hex");
}

describe("gitleaks against a tree that ships its own config", () => {
  // Probed on the installed version: a tree .gitleaks.toml that sets
  // `useDefault = false` gives zero findings and a clean exit. With --config
  // pointing at ours and the file moved aside, the secret is found again.
  it.skipIf(!hasGitleaks)(
    "still finds the planted secret under a .gitleaks.toml that disables every rule",
    async () => {
      write("settings.txt", `api_key = "${plantedSecret()}"\n`);
      write(".gitleaks.toml", "[extend]\nuseDefault = false\n");

      const job = await runAnalyzer(SECRET_SCAN, scratch);

      expect(job.parsed).toBe(true);
      expect(job.findings.map((f) => f.path)).toEqual(["settings.txt"]);
      expect(job.neutralised).toEqual([".gitleaks.toml"]);
      expect(readFileSync(join(scratch, ".gitleaks.toml"), "utf8")).toContain("useDefault = false");
    },
    TOOL_TIMEOUT,
  );

  // A .gitleaksignore at the source root is honoured whatever
  // --gitleaks-ignore-path says, so it has to be moved. The test first proves
  // the file bites when left in place, then that the runner defeats it.
  it.skipIf(!hasGitleaks)(
    "still finds a secret the tree's .gitleaksignore lists",
    async () => {
      write("settings.txt", `api_key = "${plantedSecret()}"\n`);
      // Both fingerprint forms gitleaks has used for a directory scan.
      write(".gitleaksignore", `settings.txt:generic-api-key:1\n${join(scratch, "settings.txt")}:generic-api-key:1\n`);

      const leftInPlace = await runAnalyzer({ ...SECRET_SCAN, treeConfig: [] }, scratch);
      expect(leftInPlace.parsed).toBe(true);
      expect(leftInPlace.findings).toEqual([]);

      const job = await runAnalyzer(SECRET_SCAN, scratch);
      expect(job.findings.map((f) => f.path)).toEqual(["settings.txt"]);
      expect(job.neutralised).toEqual([".gitleaksignore"]);
    },
    TOOL_TIMEOUT,
  );

  it.skipIf(!hasGitleaks)(
    "records the walked files, the version and no secret value",
    async () => {
      const secret = plantedSecret();
      write("settings.txt", `api_key = "${secret}"\n`);
      write("README.md", "# nothing\n");

      const job = await runAnalyzer(SECRET_SCAN, scratch);

      expect(job.scannedPaths).toEqual(["README.md", "settings.txt"]);
      expect(job.toolVersion).toMatch(/^\d+\.\d+/);
      expect(JSON.stringify(job)).not.toContain(secret);
    },
    TOOL_TIMEOUT,
  );

  it.skipIf(!hasGitleaks)(
    "reports a malformed tree config as a failure of ours to move it, never as the banner",
    async () => {
      // A config the tool cannot parse, and a spec that leaves it in place:
      // the failure line must be the FTL line, not the glyphs above it.
      write("settings.txt", "api_key = \"nothing\"\n");
      write(".gitleaks.toml", "this is not toml [[[\n");
      const job = await runAnalyzer({ ...SECRET_SCAN, treeConfig: [], args: (root, report) =>
        SECRET_SCAN.args(root, report, analyzerContext(root)).filter((a, i, all) => a !== "--config" && all[i - 1] !== "--config"),
      }, scratch);

      expect(job.parsed).toBe(false);
      expect(job.reason).toMatch(/unable to load gitleaks config/);
      expect(job.reason).not.toMatch(/○/);
    },
    TOOL_TIMEOUT,
  );
});

describe("semgrep against a tree that ships its own config", () => {
  // Probed: --no-git-ignore does not touch .semgrepignore. A tree that lists
  // its own source there scans clean by its own instruction unless the file
  // is moved. The pattern is one p/security-audit flags on the installed
  // version, and the test asserts the file was read rather than a rule id.
  it.skipIf(!hasSemgrep)(
    "still reads a file the tree's .semgrepignore excludes",
    async () => {
      write("loader.py", "import pickle\n\ndef load(blob):\n    return pickle.loads(blob)\n");
      write(".semgrepignore", "loader.py\n");

      const job = await runAnalyzer(SEMGREP, scratch);

      expect(job.parsed).toBe(true);
      expect(job.scannedPaths).toContain("loader.py");
      // Repo-relative, as every other path in the run, even though semgrep
      // printed the absolute path it was handed.
      expect(job.findings.map((f) => f.path)).toContain("loader.py");
      expect(job.neutralised).toEqual([".semgrepignore"]);
      expect(job.toolVersion).toMatch(/^\d+\.\d+/);
      expect(readFileSync(join(scratch, ".semgrepignore"), "utf8")).toBe("loader.py\n");
    },
    TOOL_TIMEOUT,
  );

  // The probe that motivated measured reach: one bad pack, exit 7, nothing
  // scanned, and a job that used to read as clean.
  it.skipIf(!hasSemgrep)(
    "refuses to call a scan clean when a rule pack never loaded",
    async () => {
      write("loader.py", "import pickle\n\ndef load(blob):\n    return pickle.loads(blob)\n");
      const broken: AnalyzerSpec = {
        ...SEMGREP,
        args: (root, report, context) =>
          SEMGREP.args(root, report, context).map((a) => (a === "--config=p/security-audit" ? "--config=p/ogenticai-no-such-pack" : a)),
      };

      const job = await runAnalyzer(broken, scratch);

      expect(job.parsed).toBe(false);
      expect(job.reason).toMatch(/could not load its rules/);
      expect(job.reason).toMatch(/no-such-pack/);
    },
    TOOL_TIMEOUT,
  );
});

/** A lockfile npm audit can read, pinning a version with a known advisory. */
const VULNERABLE_LOCK = JSON.stringify({
  name: "probe",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "probe", version: "1.0.0", dependencies: { minimist: "1.2.0" } },
    "node_modules/minimist": { version: "1.2.0", resolved: "https://registry.npmjs.org/minimist/-/minimist-1.2.0.tgz" },
  },
});
const VULNERABLE_MANIFEST = JSON.stringify({ name: "probe", version: "1.0.0", dependencies: { minimist: "1.2.0" } });

describe("npm audit against a tree that ships its own .npmrc", () => {
  // Probed: --userconfig /dev/null does not reach the project-level .npmrc,
  // and one that points the registry at a dead port turns the audit into an
  // error envelope. Left in place, the failure is named for what npm said;
  // moved aside, the advisory comes back.
  it.skipIf(!hasNpm)(
    "names the registry error when the .npmrc is left in place, and finds the advisory when it is moved",
    async () => {
      write("package.json", VULNERABLE_MANIFEST);
      write("package-lock.json", VULNERABLE_LOCK);
      write(".npmrc", "registry=http://127.0.0.1:9/\nfetch-retries=0\n");

      const leftInPlace = await runAnalyzer({ ...DEPENDENCY_AUDIT, treeConfig: [] }, scratch);
      expect(leftInPlace.parsed).toBe(false);
      expect(leftInPlace.reason).toMatch(/reported an error instead of a report/);
      expect(leftInPlace.reason).toMatch(/127\.0\.0\.1:9/);
      expect(leftInPlace.reason).not.toMatch(/does not recognise/);

      const job = await runAnalyzer(DEPENDENCY_AUDIT, scratch);
      expect(job.parsed).toBe(true);
      expect(job.findings.map((f) => f.code)).toContain("minimist");
      expect(job.neutralised).toEqual([".npmrc"]);
      expect(job.scannedPaths).toEqual(["package-lock.json"]);
    },
    TOOL_TIMEOUT,
  );

  // `--prefix root` resolves the root lockfile only. A client app with its
  // own lockfile was never audited at all.
  it.skipIf(!hasNpm)(
    "audits a lockfile that is not at the root, and attaches findings to its own manifest",
    async () => {
      write("README.md", "# monorepo\n");
      write("client/package.json", VULNERABLE_MANIFEST);
      write("client/package-lock.json", VULNERABLE_LOCK);

      const job = await runAnalyzer(DEPENDENCY_AUDIT, scratch);

      expect(job.parsed).toBe(true);
      expect(job.findings.map((f) => f.path)).toEqual(["client/package.json"]);
      expect(job.scannedPaths).toEqual(["client/package-lock.json"]);
    },
    TOOL_TIMEOUT,
  );
});

describe("osv-scanner against a tree that ships its own osv-scanner.toml", () => {
  // Probed: a tree config listing every advisory under [[IgnoredVulns]] turns
  // a known-vulnerable manifest into zero findings.
  it.skipIf(!hasOsv)(
    "still reports the advisories the tree's config tells it to ignore",
    async () => {
      write("requirements.txt", "requests==2.19.0\n");
      const first = await runAnalyzer({ ...DEPENDENCY_AUDIT_OSV, treeConfig: [], args: (root) => ["--format", "json", "--recursive", root] }, scratch);
      expect(first.parsed).toBe(true);
      const ids = [...new Set(first.findings.map((f) => f.code))];
      expect(ids.length).toBeGreaterThan(0);

      write("osv-scanner.toml", ids.map((id) => `[[IgnoredVulns]]\nid = "${id}"\nreason = "hostile"\n`).join("\n"));
      const job = await runAnalyzer(DEPENDENCY_AUDIT_OSV, scratch);

      expect(job.parsed).toBe(true);
      expect(job.findings.length).toBe(first.findings.length);
      expect(job.neutralised).toEqual(["osv-scanner.toml"]);
      expect(job.scannedPaths).toEqual(["requirements.txt"]);
    },
    TOOL_TIMEOUT,
  );
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

  // The npm job speaks for npm. On a host with osv-scanner those NuGet
  // packages ARE checked, so "not checked" here would be a lie; it names the
  // count and hands them to the job that owns them.
  it("hands another ecosystem's packages to the OSV job rather than declaring them unchecked", async () => {
    write("Api.csproj", '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>');
    const job = await runAnalyzer(DEPENDENCY_AUDIT, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/1 nuget package/i);
    expect(job.reason).toMatch(/dependency-audit-osv/);
    expect(job.reason).not.toMatch(/NOT checked/);
  });

  // The count travels with the job that could have checked it.
  it("carries the unscanned count on the OSV skip when the scanner is absent", async () => {
    write("Api.csproj", '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>');
    const absent: AnalyzerSpec = { ...DEPENDENCY_AUDIT_OSV, command: "ogenticai-no-such-binary" };
    const job = await runAnalyzer(absent, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/is not installed/);
    expect(job.reason).toMatch(/1 nuget package/i);
    expect(job.reason).toMatch(/NOT checked/);
    expect(job.reason).toMatch(/no advisory source/);
  });

  // A pnpm tree is lock-pinned, and npm audit still cannot read it. The skip
  // blames the lockfile, not a missing advisory source, because npm is right
  // there.
  it("blames the lockfile, not a missing tool, for an npm tree npm audit cannot read", async () => {
    write("package.json", JSON.stringify({ dependencies: { react: "^18" } }));
    write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^18\n        version: 18.3.1\npackages:\n  react@18.3.1:\n    resolution: {integrity: sha512-x}\n");
    const job = await runAnalyzer(DEPENDENCY_AUDIT, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/pnpm or yarn lockfile/);
    expect(job.reason).toMatch(/NOT checked/);
    expect(job.reason).not.toMatch(/advisory source/);
    // And the OSV job, which does read pnpm lockfiles, is not blocked.
    expect(DEPENDENCY_AUDIT_OSV.precondition!(scratch)).toBeNull();
  });

  it("passes the precondition once a lockfile is present anywhere in the tree", () => {
    write("client/package-lock.json", "{}\n");
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

  // A timeout arrives as `killed: true` with empty stdout, which the first
  // version reported as "no output". Real process, real clock.
  it("names a timeout as a timeout", async () => {
    const slow: AnalyzerSpec = {
      job: "sleeps",
      command: "sleep",
      args: () => ["5"],
      adapter: semgrepAdapter,
      reach: "*",
      timeoutMs: 200,
    };
    const job = await runAnalyzer(slow, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/stopped after/);
    expect(job.reason).not.toMatch(/no output/);
  });

  // An overrun of maxBuffer truncates the output and kills the child. What
  // survives is not a report, and blaming the adapter for it hid the cause.
  it("names a truncated report as truncated, not as unrecognised", async () => {
    const chatty: AnalyzerSpec = {
      job: "floods-stdout",
      command: "sh",
      args: () => ["-c", 'head -c 200000 /dev/zero | tr "\\0" a'],
      adapter: semgrepAdapter,
      reach: "*",
      maxOutputBytes: 1000,
    };
    const job = await runAnalyzer(chatty, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/truncated/);
    expect(job.reason).not.toMatch(/does not recognise/);
  });

  it("reads the reason out of an error envelope the adapter rightly refuses", async () => {
    writeFileSync(join(outside, "envelope.json"), NPM_ERROR_ENVELOPE);
    const spec: AnalyzerSpec = {
      job: "envelope",
      command: "cat",
      args: () => [join(outside, "envelope.json")],
      adapter: npmAuditAdapter,
      explainOutput: npmAuditError,
      reach: [],
    };
    const job = await runAnalyzer(spec, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/reported an error instead of a report/);
    expect(job.reason).toMatch(/ECONNREFUSED/);
  });

  it("refuses a report whose rules never loaded, with the tool's own reason", async () => {
    writeFileSync(join(outside, "bad-pack.json"), SEMGREP_BAD_PACK_JSON);
    const spec: AnalyzerSpec = {
      job: "bad-pack",
      command: "cat",
      args: () => [join(outside, "bad-pack.json")],
      adapter: semgrepAdapter,
      inspect: semgrepMeta,
      reach: "*",
    };
    const job = await runAnalyzer(spec, scratch);

    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/could not load its rules/);
    expect(job.reason).toMatch(/does-not-exist/);
  });

  it("records the tool's version from whatever it prints", async () => {
    const spec: AnalyzerSpec = {
      job: "versioned",
      command: "sh",
      args: () => ["-c", `echo '${SEMGREP_JSON}'`],
      adapter: semgrepAdapter,
      versionArgs: ["-c", "echo 'tool version: 4.5.6 (built today)'"],
      reach: "*",
    };
    const job = await runAnalyzer(spec, scratch);
    expect(job.toolVersion).toBe("4.5.6");
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

  // One job's timeout is its own skip. It must never be a rejection that
  // takes the other jobs' records with it.
  it("keeps every other job's record when one of them fails", async () => {
    const slow: AnalyzerSpec = {
      job: "sleeps",
      command: "sleep",
      args: () => ["5"],
      adapter: semgrepAdapter,
      reach: "*",
      timeoutMs: 200,
    };
    const fine: AnalyzerSpec = {
      job: "fine",
      command: "sh",
      args: () => ["-c", `echo '${SEMGREP_JSON}'`],
      adapter: semgrepAdapter,
      reach: "*",
    };
    const jobs = await runAnalyzers(scratch, [slow, fine]);
    expect(jobs.map((j) => [j.job, j.parsed])).toEqual([
      ["sleeps", false],
      ["fine", true],
    ]);
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
  }, TOOL_TIMEOUT);
});

/* ── analyzers that write their report to a file ──────────────────────────── */

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
    const context = analyzerContext(scratch);
    for (const spec of AUDIT_ANALYZERS) {
      expect(spec.args(scratch, REPORT, context).join(" ")).not.toContain("/dev/stdout");
    }
  });

  it("hands the secret scanner the path the runner chose", () => {
    const args = SECRET_SCAN.args(scratch, REPORT, analyzerContext(scratch));
    expect(args[args.indexOf("--report-path") + 1]).toBe(REPORT);
    expect(SECRET_SCAN.usesReportFile).toBe(true);
  });

  // A report bigger than maxBuffer on stdout kills the child and loses the
  // whole thing. semgrep writes to a file we name instead.
  it("has semgrep write its report to the path the runner chose", () => {
    const args = SEMGREP.args(scratch, REPORT, analyzerContext(scratch));
    expect(args[args.indexOf("--output") + 1]).toBe(REPORT);
    expect(SEMGREP.usesReportFile).toBe(true);
  });

  // The report is ours and belongs nowhere near the subject: a file we create
  // inside a client's checkout could be mistaken for part of it. Proven by
  // running a tool that records where it was told to write.
  it("puts the report outside the tree under audit", async () => {
    let told = "";
    const spec: AnalyzerSpec = {
      job: "report-file",
      command: "sh",
      usesReportFile: true,
      args: (_root, reportPath) => {
        told = reportPath;
        return ["-c", `printf '%s' '${SEMGREP_JSON}' > "${reportPath}"`];
      },
      adapter: semgrepAdapter,
      reach: "*",
    };
    const job = await runAnalyzer(spec, scratch);

    expect(job.parsed).toBe(true);
    expect(job.findings).toHaveLength(2);
    expect(told.startsWith(scratch)).toBe(false);
    expect(told.startsWith(tmpdir())).toBe(true);
    // And the scratch directory is gone afterwards.
    expect(existsSync(told)).toBe(false);
  });

  // Several gitleaks versions write nothing at all when they find nothing.
  // That is an empty result, not a failure to run.
  it("treats an absent report after a clean exit as no findings when the tool is known to do that", async () => {
    const spec: AnalyzerSpec = {
      job: "writes-nothing",
      command: "true",
      usesReportFile: true,
      emptyReport: "[]",
      args: () => [],
      adapter: gitleaksAdapter,
      reach: "*",
    };
    const job = await runAnalyzer(spec, scratch);
    expect(job.parsed).toBe(true);
    expect(job.findings).toEqual([]);
  });

  it("treats an absent report as a failure for a tool that always writes one", async () => {
    const spec: AnalyzerSpec = {
      job: "should-have-written",
      command: "true",
      usesReportFile: true,
      args: () => [],
      adapter: semgrepAdapter,
      reach: "*",
    };
    const job = await runAnalyzer(spec, scratch);
    expect(job.parsed).toBe(false);
    expect(job.reason).toMatch(/wrote no report/);
  });

  // With the report in a file, a non-zero exit says nothing about whether the
  // tool reported. The file decides.
  it("reads the report a tool wrote before exiting non-zero", async () => {
    const spec: AnalyzerSpec = {
      job: "report-then-fail",
      command: "sh",
      usesReportFile: true,
      args: (_root, reportPath) => ["-c", `printf '%s' '${SEMGREP_JSON}' > "${reportPath}"; exit 1`],
      adapter: semgrepAdapter,
      reach: "*",
    };
    const job = await runAnalyzer(spec, scratch);
    expect(job.parsed).toBe(true);
    expect(job.findings).toHaveLength(2);
  });
});

/* ── analyzer reach per language ─────────────────────────────────────────── */

function file(path: string, language: string): TreeFile {
  return { path, language, bytes: 1, loc: 1, sha256: "x" };
}

function inventoryOf(files: TreeFile[]): Inventory {
  return { files, excluded: [], builtAt: "2026-08-24T00:00:00.000Z" };
}

describe("analyzer reach, measured from what each tool read", () => {
  const inventory = inventoryOf([
    file("a.ts", "typescript"),
    file("b.ts", "typescript"),
    file("Handler.cs", "csharp"),
    file("notes.md", "markdown"),
  ]);
  const everything = ["a.ts", "b.ts", "Handler.cs", "notes.md"];

  it("credits a language per file the analyzer said it read", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: true, findings: [], scannedPaths: ["a.ts", "b.ts"] },
      { job: "secret-scan", parsed: true, findings: [], scannedPaths: everything },
      { job: "dependency-audit", parsed: false, findings: [], reason: "no lockfile" },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);

    expect(coverage.typescript).toEqual({
      files: 2,
      analyzers: ["semgrep"],
      scanned: { semgrep: 2, "secret-scan": 2 },
    });
    // semgrep CAN read C#, and did not on this run. The declared reach is not
    // what is printed; the measured one is.
    expect(coverage.csharp?.analyzers).toEqual([]);
    expect(coverage.csharp?.scanned).toEqual({ semgrep: 0, "secret-scan": 1 });
  });

  // A content scanner reads every file. Listing it under each language would
  // make a markdown file look as deterministically reviewed as a TypeScript one.
  it("lists a content scanner once, under all files, rather than under every language", () => {
    const jobs: JobFindings[] = [
      { job: "secret-scan", parsed: true, findings: [], scannedPaths: everything },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);

    expect(coverage.markdown?.analyzers).toEqual([]);
    expect(coverage.markdown?.scanned).toEqual({ "secret-scan": 1 });
    expect(coverage[ALL_FILES]).toEqual({ files: 4, analyzers: ["secret-scan"], scanned: { "secret-scan": 4 } });
  });

  // The probe that motivated this: a job that ran, reported nothing, and read
  // nothing. Declared reach would have credited it with every language here.
  it("credits nothing to a job that read nothing", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: true, findings: [], scannedPaths: [] },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);
    expect(coverage.typescript?.analyzers).toEqual([]);
    expect(coverage.typescript?.scanned).toEqual({ semgrep: 0 });
  });

  // An older record that did not measure its reach cannot claim any.
  it("credits nothing to a job that did not record what it read", () => {
    const jobs: JobFindings[] = [{ job: "semgrep", parsed: true, findings: [] }];
    const coverage = analyzerLanguageCoverage(inventory, jobs);
    expect(coverage.typescript?.analyzers).toEqual([]);
    expect(coverage.typescript?.scanned).toEqual({});
  });

  // npm audit reads the dependency tree, not the code. Crediting it to
  // TypeScript would report hundreds of source files as deterministically
  // covered on a run where no code analyzer started at all, and crediting it to
  // JSON is the same overclaim one language over: the lockfile's dependency
  // graph was resolved, the JSON files themselves were not examined for
  // defects. Its declared reach is empty and that is the ceiling, so it earns
  // no language row while its own read count is still reported.
  it("credits the dependency audit to no language, whatever it read", () => {
    const withLock = inventoryOf([...inventory.files, file("package-lock.json", "json")]);
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: false, findings: [], reason: "not installed" },
      { job: "dependency-audit", parsed: true, findings: [], scannedPaths: ["package-lock.json"] },
    ];
    const coverage = analyzerLanguageCoverage(withLock, jobs);

    expect(coverage.typescript?.analyzers).toEqual([]);
    expect(coverage.json?.analyzers).toEqual([]);
    // The read still happened and is still counted; what it does not do is buy
    // a language row.
    expect(coverage.json?.scanned["dependency-audit"]).toBe(0);
  });

  // The overclaim that motivated the ceiling. semgrep's paths.scanned lists
  // every file it TARGETED, so a tree carrying languages no loaded pack holds a
  // rule for had them all credited, and the parity sentence printed over the
  // result. A language is credited only when the analyzer both declares it and
  // is measured to have read a file of it.
  it("credits only languages the analyzer both declares and was measured reading", () => {
    const mixed = inventoryOf([
      file("A.cs", "csharp"),
      file("a.rs", "rust"),
      file("a.kt", "kotlin"),
    ]);
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: true, findings: [], scannedPaths: ["A.cs", "a.rs", "a.kt"] },
    ];
    const coverage = analyzerLanguageCoverage(mixed, jobs);

    expect(coverage.csharp?.analyzers).toEqual(["semgrep"]);
    expect(coverage.rust?.analyzers).toEqual([]);
    expect(coverage.kotlin?.analyzers).toEqual([]);
  });

  it("does not credit an analyzer that failed to run", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: false, findings: [], reason: "not installed", scannedPaths: everything },
      { job: "secret-scan", parsed: true, findings: [], scannedPaths: everything },
    ];
    const coverage = analyzerLanguageCoverage(inventory, jobs);
    expect(coverage.typescript?.analyzers).toEqual([]);
    expect(coverage.typescript?.scanned).toEqual({ "secret-scan": 2 });
  });

  it("ignores a scanned path that is not in the inventory", () => {
    const jobs: JobFindings[] = [
      { job: "semgrep", parsed: true, findings: [], scannedPaths: ["a.ts", ".semgrepignore.audit-aside-1", "../elsewhere.ts"] },
    ];
    expect(analyzerLanguageCoverage(inventory, jobs).typescript?.scanned).toEqual({ semgrep: 1 });
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

  // gitleaks opens with a banner drawn in box glyphs, then a zerolog line. The
  // first line is a lone circle; the cause is the FTL line, in colour.
  it("skips a banner with no letters in it and reports the FTL line", () => {
    const stderr = [
      "",
      "    ○",
      "    │╲",
      "    │ ○",
      "    ○ ░",
      "    ░    gitleaks",
      "",
      "\x1b[90m2:05AM\x1b[0m \x1b[31mFTL\x1b[0m \x1b[1munable to load gitleaks config, err: While parsing config: toml: expected character =\x1b[0m",
    ].join("\n");

    const detail = describeToolFailure(stderr);
    expect(detail).toMatch(/unable to load gitleaks config/);
    expect(detail).not.toMatch(/○/);
    expect(detail).not.toContain(String.fromCharCode(0x1b));
  });

  it("prefers an ERR line over an earlier line that is merely first", () => {
    expect(describeToolFailure("Scanning dir /x\n10:00AM ERR could not open database\nbye")).toMatch(/could not open database/);
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

  it.each([undefined, null, "", "   \n  ", "○\n│╲\n"])("says so when there is no output: %s", (stderr) => {
    expect(describeToolFailure(stderr)).toBe("no output");
  });

  // This ends up on one row of a dashboard.
  it("truncates a very long line rather than filling the page", () => {
    const detail = describeToolFailure(`Traceback (most recent call last):\nValueError: ${"x".repeat(2000)}`);
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    expect(detail.endsWith("…")).toBe(true);
  });
});
