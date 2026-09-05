/**
 * Deterministic analyzer adapters for audit mode (OGE-2428).
 *
 * This is the stage that buys precision. The 2026 evidence is unambiguous that
 * accuracy comes from the verification loop rather than the model: DARPA's
 * AIxCC winner reported 0.9999 patch accuracy for a proof-validated approach
 * against 44.4% for static-analysis-only, and Berkeley's Revelio found 19
 * previously unknown memory-safety bugs for about $300 by requiring a
 * sanitizer-checked executable proof for every finding.
 *
 * ── The rule that does not bend ─────────────────────────────────────────────
 *
 * We PARSE analyzer output. We never EXECUTE an analyzer config from the tree
 * under audit. That rule was written for the Kudelski RCE on CodeRabbit, which
 * came through executing a PR-supplied `.rubocop.yml`; a client codebase is
 * exactly that untrusted input. Every adapter here takes text a tool already
 * produced. None of them runs anything — see `runAnalyzer` for the one place
 * that does, and the flags it uses to keep the tree's own config out of it.
 *
 * Every adapter is total: unparseable input returns `null`, never throws.
 */

import { normalizeSeverity, type Finding } from "../findings/schema.js";
import type { Adapter } from "../findings/adapters.js";

/**
 * What a tool's own report says about the scan, as distinct from its findings.
 *
 * A finding list answers "what did it flag". This answers "what did it read,
 * and did it get through". The two were conflated once: a semgrep run whose
 * rule pack failed to download returned `results: []`, which the adapter read
 * as a clean scan of the whole tree. The report carried `paths.scanned: []`
 * and two errors the adapter never looked at.
 */
export interface ScanMeta {
  /** Paths the tool says it read, exactly as the tool printed them. */
  scannedPaths: string[];
  /** Trouble the tool reported while still producing a report. */
  errors: string[];
  /**
   * A problem that means the report cannot be trusted at all: the rules never
   * loaded, so an empty result is a scan that did not happen.
   */
  fatal: string | null;
}

/** How many per-file problems a job record keeps before summarising the rest. */
export const MAX_RECORDED_ERRORS = 50;

/** Keep a list of problems readable: the first fifty, then a count. */
export function capErrors(errors: string[]): string[] {
  if (errors.length <= MAX_RECORDED_ERRORS) return errors;
  return [...errors.slice(0, MAX_RECORDED_ERRORS), `and ${errors.length - MAX_RECORDED_ERRORS} more`];
}

/* ── semgrep (`semgrep --json`) ───────────────────────────────────────────── */

interface SemgrepResult {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown; col?: unknown };
  extra?: { message?: unknown; severity?: unknown };
}

/** semgrep's own levels. `WARNING` is its default, so an unknown maps there. */
function semgrepSeverity(raw: unknown): string {
  const value = typeof raw === "string" ? raw.toUpperCase() : "";
  if (value === "ERROR") return "error";
  if (value === "INFO") return "info";
  return "warning";
}

export const semgrepAdapter: Adapter = {
  source: "semgrep",
  parse(raw) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null) return null;

    const results = (data as { results?: unknown }).results;
    if (!Array.isArray(results)) return null;

    return results.flatMap((entry): Finding[] => {
      const result = entry as SemgrepResult;
      const path = typeof result.path === "string" ? result.path : "";
      if (!path) return [];

      const line = typeof result.start?.line === "number" ? result.start.line : undefined;
      const column = typeof result.start?.col === "number" ? result.start.col : undefined;

      return [
        {
          path,
          ...(line === undefined ? {} : { position: { line, ...(column === undefined ? {} : { column }) } }),
          message: typeof result.extra?.message === "string" ? result.extra.message : "(no message)",
          severity: normalizeSeverity(semgrepSeverity(result.extra?.severity)),
          source: "semgrep",
          ...(typeof result.check_id === "string" ? { code: result.check_id } : {}),
        },
      ];
    });
  },
};

interface SemgrepError {
  level?: unknown;
  type?: unknown;
  message?: unknown;
  path?: unknown;
}

/**
 * What semgrep read and what stopped it.
 *
 * semgrep reports two kinds of error in the same list. One has a `path`: a
 * file it could not fully parse, or one where too many rules timed out. The
 * scan continued past it, so it is recorded and the report stands. The other
 * has no path and is about the rules themselves: a pack that failed to
 * download, a config that did not validate. Nothing was scanned under those
 * rules, and the probe that motivated this showed the shape exactly: exit 7,
 * `results: []`, `paths.scanned: []`, two errors. That is fatal here, because
 * the alternative is reporting the tree clean on rules that never loaded.
 */
export function semgrepMeta(raw: string): ScanMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const report = data as { results?: unknown; paths?: { scanned?: unknown }; errors?: unknown };
  // The same test the adapter applies: no results list, not a semgrep report.
  if (!Array.isArray(report.results)) return null;

  const scanned = Array.isArray(report.paths?.scanned) ? report.paths.scanned : [];
  const scannedPaths = scanned.filter((p): p is string => typeof p === "string");

  const fatal: string[] = [];
  const errors: string[] = [];
  for (const entry of Array.isArray(report.errors) ? (report.errors as SemgrepError[]) : []) {
    const type = typeof entry.type === "string" ? entry.type : "error";
    const message = typeof entry.message === "string" ? entry.message.replace(/\s+/g, " ").trim() : "";
    if (typeof entry.path === "string" && entry.path) {
      errors.push(`${type} at ${entry.path}${message ? `: ${message}` : ""}`);
    } else if (entry.level === "error") {
      fatal.push(message || type);
    } else {
      errors.push(message ? `${type}: ${message}` : type);
    }
  }
  return { scannedPaths, errors, fatal: fatal.length > 0 ? fatal.join("; ") : null };
}

/* ── gitleaks (`gitleaks detect --report-format json`) ────────────────────── */

interface GitleaksResult {
  File?: unknown;
  StartLine?: unknown;
  RuleID?: unknown;
  Description?: unknown;
  // `Secret`, `Match` and `Line` also arrive here. They are deliberately never
  // read — see the note below.
}

/**
 * The fields gitleaks emits that carry the secret itself, or enough of the
 * surrounding line to reconstruct it.
 *
 * Named so the test can assert on the list rather than on one example, and so
 * adding a field to the deny-list is a one-line change if gitleaks grows one.
 */
export const GITLEAKS_VALUE_FIELDS = ["Secret", "Match", "Line"] as const;

/**
 * Location only. Never the value.
 *
 * The standing rule for client work is existence and location, never the
 * secret itself. A findings file that quotes the value turns an audit artefact
 * into a second copy of the credential — in a JSON file, on our disk, and
 * potentially in a report. The rule is enforced by construction here: the
 * fields that carry the value are never read, so there is no path by which one
 * reaches a `Finding`.
 */
export const gitleaksAdapter: Adapter = {
  source: "secret-scan",
  parse(raw) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    // gitleaks emits a bare array, and `null` for "clean" in some versions.
    if (data === null) return [];
    if (!Array.isArray(data)) return null;

    return data.flatMap((entry): Finding[] => {
      const result = entry as GitleaksResult;
      const path = typeof result.File === "string" ? result.File : "";
      if (!path) return [];

      const line = typeof result.StartLine === "number" ? result.StartLine : undefined;
      const rule = typeof result.RuleID === "string" ? result.RuleID : "secret";

      return [
        {
          path,
          ...(line === undefined ? {} : { position: { line } }),
          // Deliberately generic. Even gitleaks' own Description can echo the
          // matched shape, so the message is composed from the rule id alone.
          message: `Possible secret (${rule}) — location only; value not read.`,
          severity: normalizeSeverity("error"),
          source: "secret-scan",
          code: rule,
        },
      ];
    });
  },
};

/* ── npm audit (`npm audit --json`) ───────────────────────────────────────── */

interface NpmAdvisory {
  severity?: unknown;
  via?: unknown;
  range?: unknown;
}

/**
 * npm's severity words are its own, and none of them are in reviewdog's
 * vocabulary — `normalizeSeverity` maps every one of them to `unknown`.
 *
 * That matters more than it looks: an advisory npm calls CRITICAL would arrive
 * unranked, the findings gate could not act on it, and a report would list the
 * worst dependency vulnerability in the codebase alongside the trivia. The
 * translation belongs here rather than in the shared normaliser, which the
 * pull-request path also uses.
 */
function npmSeverity(raw: unknown): string {
  switch (typeof raw === "string" ? raw.toLowerCase() : "") {
    case "critical":
    case "high":
      return "error";
    case "moderate":
      return "warning";
    case "low":
      return "info";
    default:
      return "unknown";
  }
}

function advisoryTitle(via: unknown): string | null {
  if (!Array.isArray(via)) return null;
  for (const entry of via) {
    if (typeof entry === "object" && entry !== null && typeof (entry as { title?: unknown }).title === "string") {
      return (entry as { title: string }).title;
    }
  }
  return null;
}

/**
 * Dependency advisories.
 *
 * Attached to the manifest rather than to a source line, because that is where
 * the fix is: a vulnerable transitive dependency is not a defect in any file
 * the reviewer can read.
 */
export const npmAuditAdapter: Adapter = {
  source: "dependency-audit",
  parse(raw) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null) return null;

    const vulnerabilities = (data as { vulnerabilities?: unknown }).vulnerabilities;
    // npm audit always emits this key, even when empty. Its absence means the
    // text is some other JSON, not a clean audit.
    if (typeof vulnerabilities !== "object" || vulnerabilities === null) return null;

    return Object.entries(vulnerabilities as Record<string, NpmAdvisory>).flatMap(
      ([name, advisory]): Finding[] => {
        const title = advisoryTitle(advisory.via);
        const range = typeof advisory.range === "string" ? ` (${advisory.range})` : "";
        return [
          {
            path: "package.json",
            message: title
              ? `${name}${range}: ${title}`
              : `${name}${range}: advisory reported by npm audit`,
            severity: normalizeSeverity(npmSeverity(advisory.severity)),
            source: "dependency-audit",
            code: name,
          },
        ];
      },
    );
  },
};

/**
 * npm's error envelope, when `npm audit --json` could not reach a registry.
 *
 * It is valid JSON on stdout, `{"message": "...", "error": {...}}`, with no
 * `vulnerabilities` key. The adapter rightly returns null for it, but "output
 * this adapter does not recognise" blames the adapter for a network failure a
 * reader could act on. This reads the envelope so the reason can say what npm
 * said.
 */
export function npmAuditError(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const envelope = data as { vulnerabilities?: unknown; message?: unknown; error?: unknown };
  if (typeof envelope.vulnerabilities === "object" && envelope.vulnerabilities !== null) return null;
  if (typeof envelope.message === "string" && envelope.message) return envelope.message;
  if (typeof envelope.error === "object" && envelope.error !== null) {
    const summary = (envelope.error as { summary?: unknown }).summary;
    return typeof summary === "string" && summary ? summary : "npm reported an error without a message";
  }
  return null;
}

/**
 * The manifests OSV read. Its report carries no error list, so `errors` is
 * always empty here and `fatal` never set: a scanner that could not reach its
 * database exits non-zero with nothing on stdout, which the runner reports
 * from stderr.
 */
export function osvMeta(raw: string): ScanMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const scannedPaths = new Set<string>();
  for (const result of results as OsvResult[]) {
    if (typeof result.source?.path === "string") scannedPaths.add(result.source.path);
  }
  return { scannedPaths: [...scannedPaths], errors: [], fatal: null };
}

/**
 * Advisories from OSV, for the ecosystems npm cannot answer for.
 *
 * OSV reports per package inside per source file, so a finding is attached to
 * the manifest that declares the package. That keeps it consistent with the npm
 * adapter above: the fix is a version bump in a manifest, not an edit to any
 * source line a reviewer could read.
 *
 * Severity comes from the advisory's own database-specific rating when it has
 * one. OSV entries frequently carry NO severity at all, and those are reported
 * as warnings rather than promoted or silently dropped: an advisory with an
 * unstated severity is still an advisory.
 */
export const osvScannerAdapter: Adapter = {
  source: "dependency-audit-osv",
  parse(raw) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null) return null;
    const results = (data as { results?: unknown }).results;
    // osv-scanner always emits `results`, empty when it found nothing. Its
    // absence means this is some other JSON, not a clean scan.
    if (!Array.isArray(results)) return null;

    const findings: Finding[] = [];
    for (const result of results as OsvResult[]) {
      const manifest = typeof result.source?.path === "string" ? result.source.path : "(manifest)";
      for (const pkg of result.packages ?? []) {
        const name = pkg.package?.name ?? "(unnamed package)";
        const version = pkg.package?.version ? `@${pkg.package.version}` : "";
        for (const vuln of pkg.vulnerabilities ?? []) {
          const id = vuln.id ?? "advisory";
          const summary = typeof vuln.summary === "string" && vuln.summary ? `: ${vuln.summary}` : "";
          findings.push({
            path: manifest,
            message: `${name}${version}: ${id}${summary}`,
            severity: normalizeSeverity(osvSeverity(vuln)),
            source: "dependency-audit-osv",
            code: id,
          });
        }
      }
    }
    return findings;
  },
};

interface OsvResult {
  source?: { path?: string };
  packages?: Array<{
    package?: { name?: string; version?: string; ecosystem?: string };
    vulnerabilities?: Array<{ id?: string; summary?: string; database_specific?: { severity?: string } }>;
  }>;
}

/** OSV severity where the advisory states one; unstated is not the same as low. */
function osvSeverity(vuln: { database_specific?: { severity?: string } }): string {
  const stated = vuln.database_specific?.severity;
  return typeof stated === "string" && stated ? stated.toLowerCase() : "moderate";
}

export const AUDIT_ADAPTERS: Adapter[] = [semgrepAdapter, gitleaksAdapter, npmAuditAdapter, osvScannerAdapter];
