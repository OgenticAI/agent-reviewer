/**
 * The pass that reads every file (OGE-2746).
 *
 * Coverage used to be a by-product of agent discretion. The investigation is an
 * agent answering a question set with Read and Grep under a turn cap, so it
 * opens what it judges relevant and stops: two runs over comparable trees
 * opened 5.5% and 2.2% of their files, the second AFTER the iteration cap was
 * raised. Raising a budget does not fix a stage that decides for itself when it
 * has read enough.
 *
 * So this stage does not decide. It visits every file in the tree, records the
 * disposition of each one, and extracts what can be established without a
 * model. Cost is a function of tree size rather than of turns, which is what
 * makes a whole-repository claim affordable and quotable before the run.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 *
 * Not a replacement for the investigation. A regex knows that an endpoint is
 * anonymous; it does not know whether that matters for this product. The sweep
 * raises the floor and the investigation keeps the ceiling, and the two report
 * separately so a reader can tell mechanical detection from reasoning.
 *
 * Signals are CANDIDATES, never findings. They carry `confidence:
 * "inferred"` at most and go through the same verify and closure gates as
 * anything else, because a pattern match that has not been read by anything
 * with judgment has not earned the word "verified".
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileAccessLog } from "./inventory.js";
import { languageOf, walkTree, type TreeFile } from "./tree.js";

/** Files above this are recorded as seen and not parsed: minified bundles, vendored blobs. */
export const MAX_SWEEP_BYTES = 1_500_000;

export type SignalKind =
  | "anonymous-endpoint"
  | "http-endpoint"
  | "authorization-check"
  | "unvalidated-token"
  | "identity-from-request"
  | "raw-sql"
  | "weak-crypto"
  | "disabled-cert-validation"
  | "permissive-cors"
  | "config-precedence"
  | "insecure-direct-object-reference"
  | "missing-csrf-token"
  | "debug-enabled"
  | "insecure-cookie"
  | "weak-password-hash"
  | "sensitive-field";

/**
 * What a signal is claiming.
 *
 * `surface` measures the attack surface: endpoints, by-id fetches, authorization
 * attributes. None is a defect, and the ratios between them are the point.
 * Hundreds of by-id fetches against a comparable number of authorization
 * checks is a statement worth making; calling every one of them a defect would
 * bury the handful that are.
 *
 * `defect` is a candidate finding: something that is wrong if the line means
 * what it appears to mean. Still not a finding until something with judgment
 * has read it.
 */
export type SignalClass = "surface" | "defect";

export interface Signal {
  path: string;
  /** 1-based. */
  line: number;
  kind: SignalKind;
  signalClass: SignalClass;
  /** The matched line, trimmed and length-capped. Evidence, not prose. */
  excerpt: string;
  /** CWE identifier, so a finding cites a standard rather than our opinion. */
  cwe: string;
  /** OWASP API Security Top 10 (2023) category, where one applies. */
  owasp?: string;
}

export type FileOutcome = "read" | "too-large" | "unreadable" | "binary";

/** What happened to one file. Every file in the tree gets exactly one of these. */
export interface FileDisposition {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  outcome: FileOutcome;
  signals: number;
}

export interface SweepResult {
  dispositions: FileDisposition[];
  signals: Signal[];
  /** Files the sweep opened and parsed. */
  read: number;
  /** Files present in the tree but not parsed, with the reason kept per file. */
  skipped: number;
  total: number;
}

/**
 * Language-aware patterns, each keyed to what it would mean if true.
 *
 * Deliberately narrow. A pattern that fires on everything trains a reader to
 * ignore the section it appears in, which costs more than the signal is worth.
 * Every entry here corresponds to a class of finding a real audit has had to
 * establish by hand.
 */
interface SignalRule {
  kind: SignalKind;
  signalClass: SignalClass;
  /** Which languages it applies to. Empty means every language. */
  languages: string[];
  pattern: RegExp;
  cwe: string;
  owasp?: string;
}

const RULES: SignalRule[] = [
  // ── Broken authentication (API2) ────────────────────────────────────────
  //
  // Reading a token without validating it is the highest-consequence thing a
  // pattern can find, because every authorisation decision downstream rests on
  // it. `ReadJwtToken` DECODES; `ValidateToken` is the one that checks a
  // signature, and the names are close enough to read past.
  {
    kind: "unvalidated-token",
    signalClass: "defect",
    languages: ["csharp"],
    pattern: /\b(?:new\s+)?JwtSecurityTokenHandler\s*\(\s*\)\s*\.\s*ReadJwtToken\b|\bReadJwtToken\s*\(/,
    cwe: "CWE-347",
    owasp: "API2:2023 Broken Authentication",
  },
  {
    kind: "unvalidated-token",
    signalClass: "defect",
    languages: ["typescript", "javascript"],
    pattern: /\bjwt\s*\.\s*decode\s*\(|verify\s*:\s*false|ignoreExpiration\s*:\s*true/,
    cwe: "CWE-347",
    owasp: "API2:2023 Broken Authentication",
  },

  // ── Broken function level authorization (API5) ──────────────────────────
  { kind: "anonymous-endpoint", signalClass: "defect", languages: ["csharp"], pattern: /\[\s*AllowAnonymous\s*\]/, cwe: "CWE-306", owasp: "API5:2023 Broken Function Level Authorization" },
  { kind: "authorization-check", signalClass: "surface", languages: ["csharp"], pattern: /\[\s*Authorize\b/, cwe: "CWE-862" },

  // ── Broken object level authorization (API1) ────────────────────────────
  //
  // Identity taken from something the caller sets. A tenant id read from a
  // header, ahead of the token's own claim, means the boundary between
  // customers rests on a value the customer supplies.
  {
    kind: "identity-from-request",
    signalClass: "defect",
    languages: ["csharp"],
    pattern: /(?:Request\.Headers|HttpContext\.Request\.Headers)\s*\[\s*"[^"]*(?:tenant|org|account|customer|user|role|admin)[^"]*"/i,
    cwe: "CWE-639",
    owasp: "API1:2023 Broken Object Level Authorization",
  },
  {
    kind: "identity-from-request",
    signalClass: "defect",
    languages: ["typescript", "javascript"],
    pattern: /(?:req|request)\.headers\s*(?:\[\s*['"`]|\.)\s*[^'"`\]]*(?:tenant|org|account|user-id|role|admin)/i,
    cwe: "CWE-639",
    owasp: "API1:2023 Broken Object Level Authorization",
  },

  // Route surface. Not a defect by itself; it is the denominator the two
  // categories above are measured against.
  { kind: "http-endpoint", signalClass: "surface", languages: ["csharp"], pattern: /\[\s*Http(Get|Post|Put|Delete|Patch)\b/, cwe: "CWE-1059" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["csharp"], pattern: /\[\s*Route\s*\(/, cwe: "CWE-1059" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["typescript", "javascript"], pattern: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b/, cwe: "CWE-1059" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["typescript", "javascript"], pattern: /\b(?:app|router)\.(get|post|put|delete|patch)\s*\(/, cwe: "CWE-1059" },

  // ── Injection (CWE-89) ──────────────────────────────────────────────────
  // Parameterised queries do not concatenate.
  {
    kind: "raw-sql",
    signalClass: "defect",
    languages: [],
    pattern: /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;\n]*(?:\+\s*\w|\$\{|\bformat\(|%s)/i,
    cwe: "CWE-89",
    owasp: "API8:2023 Security Misconfiguration",
  },

  // ── Cryptographic failures ──────────────────────────────────────────────
  { kind: "weak-crypto", signalClass: "defect", languages: [], pattern: /\b(MD5|SHA1|DES|RC4|ECB)\b(?!\s*[:=]\s*['"]?(?:false|0))/, cwe: "CWE-327" },
  {
    kind: "disabled-cert-validation",
    signalClass: "defect",
    languages: [],
    pattern: /ServerCertificateValidationCallback\s*[+]?=|rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    cwe: "CWE-295",
  },

  // ── Security misconfiguration (API8) ────────────────────────────────────
  {
    kind: "permissive-cors",
    signalClass: "defect",
    languages: [],
    pattern: /AllowAnyOrigin\s*\(|Access-Control-Allow-Origin["'\s:]*\*|origin\s*:\s*["'`]\*["'`]/,
    cwe: "CWE-942",
    owasp: "API8:2023 Security Misconfiguration",
  },
  // A test settings file loaded after the environment file is how a test value
  // reaches production without anyone choosing it.
  { kind: "config-precedence", signalClass: "defect", languages: ["csharp"], pattern: /AddJsonFile\s*\(\s*"appsettings\.(Test|Development|Staging)/i, cwe: "CWE-15", owasp: "API8:2023 Security Misconfiguration" },
  { kind: "config-precedence", signalClass: "defect", languages: [], pattern: /appsettings\.Test\.json/, cwe: "CWE-15", owasp: "API8:2023 Security Misconfiguration" },

  // ── Insecure direct object reference (API1) ─────────────────────────────
  //
  // Straight from the OWASP .NET cheat sheet's own example: a lookup keyed on a
  // caller-supplied id with no ownership check beside it. A regex cannot prove
  // the check is absent, only that the shape is present, so this is a candidate
  // for the investigation to settle rather than a finding on sight.
  //
  // Calibrated against a real one rather than guessed. The shape of a true
  // positive, in a .NET subject:
  //
  //     public Task<Order> GetOrderById(string orderId)
  //         => _store.GetItemByIdAsync<Order>(orderId);
  //
  // and its own sibling in the same class shows the contrast: GetByTenantId
  // filters on the tenant, this one does not. So the shape worth flagging is a
  // by-id fetch through a data accessor, which is where the ownership check
  // should be and often is not.
  //
  // A first attempt matched any `.FirstOrDefault(x => x.Id == …)` and fired
  // dozens of times, mostly on in-memory filtering of an already-loaded object
  // graph where ownership was settled before the line ran. A rule that fires
  // on everything trains a reader to skip the section it appears in.
  {
    kind: "insecure-direct-object-reference",
    signalClass: "surface",
    languages: ["csharp"],
    pattern: /\.\s*(?:Get|Find|Load|Read|Fetch)\w*ById(?!s)\w*(?:Async)?\s*(?:<[^>]+>)?\s*\(/,
    cwe: "CWE-639",
    owasp: "API1:2023 Broken Object Level Authorization",
  },

  // ── Cross-site request forgery ──────────────────────────────────────────
  { kind: "missing-csrf-token", signalClass: "surface", languages: ["csharp"], pattern: /\[\s*ValidateAntiForgeryToken\s*\]/, cwe: "CWE-352" },

  // ── Security misconfiguration: debug and disclosure (API8) ──────────────
  {
    kind: "debug-enabled",
    signalClass: "defect",
    languages: [],
    pattern: /<compilation[^>]*\bdebug\s*=\s*"true"|<trace[^>]*\benabled\s*=\s*"true"|DeveloperExceptionPage\s*\(/,
    cwe: "CWE-489",
    owasp: "API8:2023 Security Misconfiguration",
  },
  {
    kind: "insecure-cookie",
    signalClass: "defect",
    languages: [],
    pattern: /(?:HttpOnly|CookieHttpOnly)\s*=\s*false|requireSSL\s*=\s*"false"|Secure\s*=\s*false|SlidingExpiration\s*=\s*true/,
    cwe: "CWE-1004",
    owasp: "API8:2023 Security Misconfiguration",
  },

  // ── Password storage ────────────────────────────────────────────────────
  // PBKDF2 is what .NET recommends. A general-purpose digest over a password is
  // the failure this catches, and it is distinct from weak-crypto elsewhere.
  {
    kind: "weak-password-hash",
    signalClass: "defect",
    languages: [],
    pattern: /(?:SHA256|SHA512|MD5|SHA1)[^\n]{0,40}(?:password|passwd|pwd)|(?:password|passwd|pwd)[^\n]{0,40}(?:SHA256|SHA512|MD5|SHA1)\s*\./i,
    cwe: "CWE-916",
  },

  // ── Sensitive data (CWE-311) ────────────────────────────────────────────
  // Not a defect on sight. It marks where the encryption question has to be
  // asked, and it is what decides how serious an incident would be.
  {
    kind: "sensitive-field",
    signalClass: "surface",
    languages: [],
    pattern: /\b(?:BirthDate|DateOfBirth|SSN|SocialSecurity|NationalId|PassportNumber|TaxId|CardNumber|HealthRecord|Diagnosis)\b/,
    cwe: "CWE-311",
  },
];

/** Binary sniff: a NUL byte in the first block is the reliable, cheap signal. */
function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8000);
  return window.includes(0);
}

function excerptOf(line: string): string {
  const flat = line.trim().replace(/\s+/g, " ");
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/**
 * Test code, by path or filename.
 *
 * Test files are still visited and still counted as covered, because they are
 * part of the tree and a coverage number that quietly drops them is wrong. What
 * they do not produce is signals: an unscoped by-id fetch inside a test is a
 * fixture, and reporting it as a risk buries the ones in the service layer.
 */
export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?|mocks?)(\/|$)/i.test(path)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)
    || /Tests?\.cs$|Test\.java$|_test\.go$|test_[^/]+\.py$/i.test(path);
}

/** Signals in one already-read file. Exported so it can be tested without a tree. */
export function signalsIn(path: string, source: string): Signal[] {
  if (isTestPath(path)) return [];
  const language = languageOf(path);
  const applicable = RULES.filter((r) => r.languages.length === 0 || r.languages.includes(language));
  if (applicable.length === 0) return [];

  const out: Signal[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Comment-only lines describe code rather than being it, and a rule that
    // fires on a comment produces a finding nobody can act on.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
    for (const rule of applicable) {
      if (rule.pattern.test(line)) {
        out.push({
          path,
          line: i + 1,
          kind: rule.kind,
          signalClass: rule.signalClass,
          excerpt: excerptOf(line),
          cwe: rule.cwe,
          ...(rule.owasp ? { owasp: rule.owasp } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Read every file in the tree, and say what happened to each one.
 *
 * The access log is the same one the investigation writes to, so the existing
 * coverage machinery reports this without change. That is the point: coverage
 * stops being a claim the report makes and becomes a ledger it can show.
 */
export function sweepTree(root: string, log: FileAccessLog): SweepResult {
  const files: TreeFile[] = walkTree(root);
  const dispositions: FileDisposition[] = [];
  const signals: Signal[] = [];

  for (const file of files) {
    const full = join(root, file.path);
    const language = languageOf(file.path);
    let bytes = 0;
    try {
      bytes = statSync(full).size;
    } catch {
      dispositions.push({ path: file.path, language, bytes: 0, lines: 0, outcome: "unreadable", signals: 0 });
      log.record(file.path, "missing");
      continue;
    }

    if (bytes > MAX_SWEEP_BYTES) {
      dispositions.push({ path: file.path, language, bytes, lines: 0, outcome: "too-large", signals: 0 });
      log.record(file.path, "too-large");
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = readFileSync(full);
    } catch {
      dispositions.push({ path: file.path, language, bytes, lines: 0, outcome: "unreadable", signals: 0 });
      log.record(file.path, "denied");
      continue;
    }

    if (looksBinary(buffer)) {
      // Seen, and honestly not parsed. Counting a PNG as covered would inflate
      // the number this stage exists to make trustworthy.
      dispositions.push({ path: file.path, language, bytes, lines: 0, outcome: "binary", signals: 0 });
      continue;
    }

    const source = buffer.toString("utf8");
    const found = signalsIn(file.path, source);
    signals.push(...found);
    dispositions.push({
      path: file.path,
      language,
      bytes,
      lines: source.split("\n").length,
      outcome: "read",
      signals: found.length,
    });
    log.record(file.path, "read");
  }

  const read = dispositions.filter((d) => d.outcome === "read").length;
  return { dispositions, signals, read, skipped: dispositions.length - read, total: dispositions.length };
}

/** Signals grouped by kind, largest first, for the report's sweep section. */
export function summariseSignals(
  signals: Signal[],
): Array<{ kind: SignalKind; signalClass: SignalClass; count: number; files: number }> {
  const byKind = new Map<SignalKind, { signalClass: SignalClass; count: number; files: Set<string> }>();
  for (const s of signals) {
    const bucket = byKind.get(s.kind) ?? { signalClass: s.signalClass, count: 0, files: new Set<string>() };
    bucket.count += 1;
    bucket.files.add(s.path);
    byKind.set(s.kind, bucket);
  }
  return [...byKind]
    .map(([kind, b]) => ({ kind, signalClass: b.signalClass, count: b.count, files: b.files.size }))
    .sort((a, b) => (a.signalClass === b.signalClass ? b.count - a.count : a.signalClass === "defect" ? -1 : 1));
}
