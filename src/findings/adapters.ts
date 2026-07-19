/**
 * Analyzer-output adapters (OGE-1588).
 *
 * Each adapter takes text CI already produced and returns normalized
 * `Finding`s. Nothing here executes a tool or reads a PR-supplied config — see
 * the security note in `schema.ts`. Every adapter is total: unparseable input
 * returns `null`, never throws, so one malformed artifact can't take down the
 * ingestion of the others.
 *
 * Three formats, chosen because they cover the mechanical-item classes that
 * punt most: eslint (JSON), tsc (human output — there is no stable JSON mode),
 * and JUnit XML (the lingua franca of test runners).
 */

import { normalizeSeverity, type Finding } from "./schema.js";

export interface Adapter {
  source: string;
  /** Parse raw text into findings, or null when the text isn't this format. */
  parse(raw: string): Finding[] | null;
}

// ─── eslint JSON (`eslint -f json`) ──────────────────────────────────────────

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
}
interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

/** Trim an absolute checkout path to something repo-relative-ish. */
function relativizePath(p: string): string {
  // CI reports absolute paths (/home/runner/work/repo/repo/src/x.ts). Keep the
  // tail after the doubled repo segment when we can spot it, else the basename
  // chain — a loose match, since the finding is still useful attached to the
  // right file even if the prefix is imperfect.
  const norm = p.replace(/\\/g, "/");
  const work = norm.match(/\/work\/[^/]+\/[^/]+\/(.+)$/);
  if (work) return work[1]!;
  return norm.replace(/^\/+/, "");
}

export const eslintAdapter: Adapter = {
  source: "eslint",
  parse(raw) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(data)) return null;
    // eslint's shape: array of {filePath, messages: [...]}. Anything else isn't
    // eslint JSON, even if it happens to be a JSON array.
    const looksRight = data.every(
      (f) => f && typeof f === "object" && "filePath" in f && "messages" in f,
    );
    if (!looksRight) return null;

    const findings: Finding[] = [];
    for (const file of data as EslintFileResult[]) {
      for (const m of file.messages ?? []) {
        findings.push({
          path: relativizePath(file.filePath),
          ...(m.line ? { position: { line: m.line, ...(m.column ? { column: m.column } : {}) } } : {}),
          message: m.message,
          severity: normalizeSeverity(m.severity),
          source: "eslint",
          ...(m.ruleId ? { code: m.ruleId } : {}),
        });
      }
    }
    return findings;
  },
};

// ─── tsc (`tsc --noEmit` console output) ─────────────────────────────────────

// `src/foo.ts(42,10): error TS2345: message` — tsc's stable one-line format.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

export const tscAdapter: Adapter = {
  source: "tsc",
  parse(raw) {
    const findings: Finding[] = [];
    let sawAny = false;
    for (const line of raw.split(/\r?\n/)) {
      const m = TSC_LINE.exec(line.trim());
      if (!m) continue;
      sawAny = true;
      findings.push({
        path: relativizePath(m[1]!),
        position: { line: Number(m[2]), column: Number(m[3]) },
        message: m[6]!,
        severity: normalizeSeverity(m[4]),
        source: "tsc",
        code: m[5]!,
      });
    }
    // No matching lines means this wasn't tsc output — signal "not mine" rather
    // than "clean", so the caller doesn't record a false all-clear.
    return sawAny ? findings : null;
  },
};

// ─── JUnit XML (the test-runner lingua franca) ───────────────────────────────

/**
 * Parse JUnit XML without an XML dependency.
 *
 * A regex parser is deliberate here: JUnit XML is flat and regular (testcase
 * elements with optional failure/error children), we only need three fields,
 * and pulling in a full XML library — which resolves entities and DTDs — would
 * add exactly the kind of parser attack surface this ticket is trying to avoid
 * on untrusted CI artifacts.
 */
// One pattern for both forms: `[^>]*?` (lazy, no `>`) captures the attributes,
// then either a self-close `/>` (no body) or `>…</testcase>`. Written as one
// alternation so a self-closing case can't be swallowed into a later paired
// case's body — the bug a naive `>([\s\S]*?)</testcase>` alternative causes.
const TESTCASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const FAILURE_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1]!] = decodeXmlEntities(m[2]!);
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export const junitAdapter: Adapter = {
  source: "junit",
  parse(raw) {
    if (!raw.includes("<testcase")) return null;
    const findings: Finding[] = [];
    for (const tc of raw.matchAll(TESTCASE_RE)) {
      const body = tc[2] ?? "";
      const caseAttrs = attrs(tc[1] ?? "");
      const fail = FAILURE_RE.exec(body);
      if (!fail) continue; // passing test — not a finding
      const failAttrs = attrs(fail[2] ?? "");
      const name = [caseAttrs.classname, caseAttrs.name].filter(Boolean).join(" › ");
      findings.push({
        path: caseAttrs.file ? relativizePath(caseAttrs.file) : name || "unknown test",
        message:
          failAttrs.message ??
          decodeXmlEntities((fail[3] ?? "").trim()).split(/\r?\n/)[0] ??
          `test failed: ${name}`,
        severity: "error",
        source: "junit",
        ...(name ? { code: name } : {}),
      });
    }
    return findings;
  },
};

export const ALL_ADAPTERS: Adapter[] = [eslintAdapter, tscAdapter, junitAdapter];

/**
 * Try every adapter, return the first that recognizes the text.
 *
 * Order matters only in that each adapter self-identifies (returns null when
 * the shape isn't its own), so the first non-null wins and there is no
 * ambiguity between, say, eslint JSON and JUnit XML.
 */
export function parseAnyFindings(raw: string, adapters = ALL_ADAPTERS): Finding[] | null {
  for (const adapter of adapters) {
    const result = adapter.parse(raw);
    if (result !== null) return result;
  }
  return null;
}
