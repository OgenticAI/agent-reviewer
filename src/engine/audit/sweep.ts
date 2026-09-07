/**
 * The pass that reads every file (OGE-2746).
 *
 * Coverage used to be a by-product of agent discretion. The investigation is an
 * agent answering a question set with Read and Grep under a turn cap, so it
 * opens what it judges relevant and stops: two runs over comparable trees each
 * opened a small fraction of their files, and the second read less than the
 * first AFTER the iteration cap was raised. Raising a budget does not fix a stage that decides for itself when it
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
 *
 * ── What a rule may look at ─────────────────────────────────────────────────
 *
 * The first cut matched every rule against the raw line, and an adversarial
 * pass over it found the cost: `LogInformation("Update user " + id)` was raw
 * SQL because the keyword sat in a log string, a comment mentioning a test
 * settings file was a configuration defect, and a developer exception page
 * guarded by `IsDevelopment()` on the same line was a live one. Each is a
 * finding a reader has to dismiss by hand, and a section a reader learns to
 * dismiss is a section that no longer carries the true positives.
 *
 * So every line is read three ways before any rule sees it: raw, with
 * comments removed (`text`), and with comments and string literals removed
 * (`code`). Each rule says which of the last two it reads. Defect rules whose
 * evidence is an identifier or a call read `code`, so prose in a string cannot
 * trigger them; rules whose evidence lives INSIDE a literal, such as a header
 * name, a settings file name or an XML attribute value, read `text` and say so
 * beside the rule. The excerpt always comes from the raw line, because the
 * excerpt is what a reader opens the file to check.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileAccessLog } from "./inventory.js";
import { languageOf, walkTree, type TreeFile, type WalkOptions } from "./tree.js";
import { maskSecrets, SECRET_MASK } from "../tools/sanitize.js";

/** Files above this are recorded as seen and not parsed: minified bundles, vendored blobs. */
export const MAX_SWEEP_BYTES = 1_500_000;

/**
 * Every kind is named for what the pattern OBSERVES, not for what its absence
 * would mean. `csrf-token-validated` counts `[ValidateAntiForgeryToken]`; its
 * predecessor was called `missing-csrf-token` and matched the same attribute,
 * so a reader of the summary table saw the number of protected actions under a
 * heading that said the opposite.
 */
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
  | "csrf-token-validated"
  | "debug-enabled"
  | "insecure-cookie"
  | "weak-password-hash"
  | "sensitive-field"
  | "hardcoded-secret"
  | "insecure-deserialization"
  | "xxe"
  | "path-traversal"
  | "phi-in-log"
  | "ssrf"
  | "xss-sink"
  | "token-in-web-storage"
  | "rate-limit-absent";

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

/**
 * Why a parsed file was not asked for signals. Only one reason so far; the
 * field is a union so the next one is a type change rather than a string.
 */
export type SuppressReason = "test-path";

/** What happened to one file. Every file in the tree gets exactly one of these. */
export interface FileDisposition {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  outcome: FileOutcome;
  signals: number;
  /**
   * Set when the file was parsed and deliberately produced nothing. Without
   * it a test file and a clean production file look identical in the ledger,
   * and a reader cannot tell "nothing matched" from "nothing was asked".
   */
  suppressed?: SuppressReason;
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

/** The OWASP API Security Top 10 (2023) categories the rules cite, spelled once. */
const OWASP = {
  bola: "API1:2023 Broken Object Level Authorization",
  authn: "API2:2023 Broken Authentication",
  bfla: "API5:2023 Broken Function Level Authorization",
  ssrf: "API7:2023 Server Side Request Forgery",
  misconfig: "API8:2023 Security Misconfiguration",
} as const;

/** One line, read the three ways a rule may ask for it, with its neighbours. */
export interface LineView {
  /** Comments removed; string literals intact. */
  text: string;
  /** Comments and string literal bodies removed. */
  code: string;
  /** The same view of the line `offset` lines away, or undefined off the ends. */
  neighbour: (offset: number) => { text: string; code: string } | undefined;
}

/**
 * Language-aware patterns, each keyed to what it would mean if true.
 *
 * Deliberately narrow. A pattern that fires on everything trains a reader to
 * ignore the section it appears in, which costs more than the signal is worth.
 * Every entry here corresponds to a class of finding a real audit has had to
 * establish by hand.
 */
export interface SignalRule {
  kind: SignalKind;
  signalClass: SignalClass;
  /** Which languages it applies to. Empty means every language. */
  languages: string[];
  /** Narrows further by path, for rules whose evidence is a config file. */
  paths?: RegExp;
  /** Which view of the line the rule reads. See the module comment. */
  scope: "code" | "text";
  /** A regex over the chosen view, or a matcher when a regex cannot say it. */
  pattern: RegExp | ((view: LineView) => boolean);
  /**
   * A shape that, when present, means the match is intended. `above` and
   * `below` widen the check to neighbouring lines, for guards and attributes
   * that conventionally sit on their own line.
   */
  unless?: { pattern: RegExp; above?: number; below?: number };
  cwe: string;
  owasp?: string;
}

/**
 * The fields that name a person. Shared between the surface rule that counts
 * them and the defect rule that catches them in a log call, so the two cannot
 * drift apart.
 *
 * Case-insensitive, and tolerant of camel, Pascal and snake case. A rule
 * anchored on one spelling (`\bDateOfBirth\b`) returns nothing on a codebase
 * that uses another (`dateOfBirth`, `date_of_birth`), and a zero from a rule
 * that could not match reads exactly like a zero from a codebase that has no
 * such field.
 */
const SENSITIVE_FIELD_SOURCE =
  "\\b(?:birth[-_]?date|date[-_]?of[-_]?birth|dob|ssn|social[-_]?security(?:[-_]?(?:number|no))?|national[-_]?id" +
  "|passport[-_]?(?:number|no)|tax[-_]?id|card[-_]?number|health[-_]?record|diagnosis|mrn|medical[-_]?record[-_]?(?:number|no)|npi)\\b";

/**
 * The callee names that mean "this string is going to a log, not a database".
 * A SQL keyword in a log message is not a query, and a log call whose argument
 * is a person's field is exactly what `phi-in-log` is for.
 */
const LOG_CALLEE_SOURCE =
  "(?:Log(?:Information|Warning|Error|Debug|Trace|Critical|Verbose|Fatal)?|_?log(?:ger)?\\.(?:log|info|warn|warning|error|debug|trace|fatal|critical|verbose)" +
  "|console\\.(?:log|info|warn|error|debug|trace)|print(?:ln|f)?|System\\.out\\.print(?:ln|f)?|(?:Console|Debug|Trace)\\.Write(?:Line)?)";
const LOG_CALLEE = new RegExp(`(?:^|\\.)${LOG_CALLEE_SOURCE}$`, "i");
const LOG_CALL = new RegExp(`\\b${LOG_CALLEE_SOURCE}\\s*\\(`, "i");

/**
 * A literal that is a query rather than prose about one. A bare keyword was
 * the first cut, and "Update user" in a log string satisfied it. A statement
 * has a shape: SELECT lists columns and reaches a FROM, UPDATE names a table
 * before SET, WHERE compares a column. "Select an order from the list" has an
 * article where the column list would be, and a message that does pass still
 * has to be concatenated with a non-literal, outside a log call, to fire.
 */
const SQL_SHAPE =
  /\bSELECT\s+(?:DISTINCT\s+|TOP\s+\d+\s+)?(?:\*|COUNT\s*\([^)]*\)|[\w.[\]"]+(?:\s*,\s*[\w.[\]"]+)*)\s+FROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+[\w.[\]"]+\s+SET\b|\bDELETE\s+FROM\b|\bWHERE\s+[\w.[\]"]+\s*(?:=|<>|!=|<|>|\bLIKE\b|\bIN\b)|\bORDER\s+BY\b/i;

/**
 * The shapes that mean "a request value reached this expression". A rule can
 * say a value is request-bound when it is read off the request on the same
 * line; a bare parameter it can only guess at from the name, and the names
 * listed are the ones a file-handling parameter conventionally gets.
 */
const REQUEST_BOUND_SOURCE =
  "(?:\\b(?:Request|request|req|ctx|context)\\.(?:Query|Form|Headers|RouteValues|Path|query|params|body|headers|args|form|values|GET|POST)\\b" +
  "|\\b(?:file[-_]?name|file[-_]?path|relative[-_]?path|user[-_]?path|upload[-_]?name|path[-_]?param)\\b)";

/** A string literal in a line, with its span so the surroundings can be read. */
interface Literal {
  start: number;
  end: number;
  quote: string;
  body: string;
}

/**
 * The string literals of a comment-free line, and the same line with every
 * literal body blanked to spaces so that parentheses inside strings do not
 * count when the enclosing call is worked out. Lengths are preserved so the
 * spans index both.
 */
function literalsOf(text: string): { literals: Literal[]; masked: string } {
  const literals: Literal[] = [];
  let masked = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      const end = Math.min(j, text.length - 1);
      literals.push({ start: i, end, quote: ch, body: text.slice(i + 1, j) });
      masked += ch + " ".repeat(j - i - 1) + (j < text.length ? ch : "");
      i = j + 1;
      continue;
    }
    masked += ch;
    i += 1;
  }
  return { literals, masked };
}

/** The dotted name before the innermost unclosed parenthesis, or "" at top level. */
function enclosingCallee(before: string): string {
  const open: number[] = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === "(") open.push(i);
    else if (before[i] === ")") open.pop();
  }
  const at = open[open.length - 1];
  if (at === undefined) return "";
  const name = /[\w.$]+\s*$/.exec(before.slice(0, at));
  return name ? name[0].trim() : "";
}

/**
 * SQL assembled from input.
 *
 * Fires only when all three hold: a literal has the shape of a statement, that
 * literal is interpolated or concatenated with something that is not another
 * literal, and the call it sits in is not a log call. Each condition removed a
 * class of false positive on its own: prose with a keyword, two literals
 * joined for line length, and a log message built with `+`.
 *
 * EF's `FromSqlInterpolated` and `ExecuteSqlInterpolated` take a `$"..."` and
 * parameterise every hole, so a `$` literal inside them is the safe idiom, not
 * the defect. `FromSqlRaw` with the same literal is the defect, and the
 * dedicated rule below catches its non-statement forms too.
 *
 * The exclusion has to name the Async spellings and the EF7+ short names.
 * Anchoring on `Interpolated$` missed `ExecuteSqlInterpolatedAsync`, which is
 * the same method: the safest idiom in the framework was reported as the
 * defect, which is worse than missing one, because it teaches a reader that the
 * rule does not know the stack. `Raw` is deliberately absent from the list, so
 * `FromSqlRaw` and `ExecuteSqlRawAsync` still fire.
 */
const EF_PARAMETERISED = /(?:^|\.)(?:FromSql|ExecuteSql|SqlQuery)(?:Interpolated)?(?:Async)?$/;
function sqlFromInput(view: LineView): boolean {
  const { literals, masked } = literalsOf(view.text);
  for (const literal of literals) {
    if (!SQL_SHAPE.test(literal.body)) continue;

    const before = masked.slice(0, literal.start);
    const after = masked.slice(literal.end + 1);
    const prefix = /[$@fF]{1,2}$/.exec(before)?.[0] ?? "";
    const beforePrefix = before.slice(0, before.length - prefix.length);

    const interpolated =
      (prefix.includes("$") && /\{\w/.test(literal.body)) ||
      (/f/i.test(prefix) && /\{\w/.test(literal.body)) ||
      (literal.quote === "`" && /\$\{/.test(literal.body));
    const concatenated =
      /[\w)\]]\s*\+\s*$/.test(beforePrefix) ||
      /^\s*\+\s*[^"'`\s]/.test(after) ||
      /^\s*(?:\.format\(|%\s*[\w(])/.test(after) ||
      /\b(?:String|string)\.Format\s*\(\s*$/.test(beforePrefix);
    if (!interpolated && !concatenated) continue;

    const callee = enclosingCallee(beforePrefix);
    if (LOG_CALLEE.test(callee)) continue;
    if (EF_PARAMETERISED.test(callee)) continue;
    return true;
  }
  return false;
}

/**
 * A credential written into a settings file.
 *
 * Reads config files only. A password in `Program.cs` is a finding too, but
 * the shapes that name one in code are the shapes of every string assignment,
 * and the investigation reads code; a connection string in `appsettings.json`
 * is unambiguous and the investigation seldom opens settings files at all.
 *
 * Placeholders are the near miss: `Password=${DB_PASSWORD}`, `<your key here>`
 * and `changeme` are the documented way NOT to commit a secret, and a rule that
 * flags them teaches the reader to skip the one that is real.
 */
const PLACEHOLDER_VALUE = new RegExp(
  // Substitution syntax, matched on the OPENER alone. The value capture stops
  // at `}` so that a JSON object end does not run away with the rest of the
  // line, which means `${JWT_SECRET}` arrives here as `${JWT_SECRET` and a
  // closed-form pattern never matched it. Every documented way of NOT
  // committing a secret was therefore reported as one, and a rule that flags
  // the placeholder teaches the reader to skip the line that is real.
  "^(?:<|\\$\\{|\\$\\(|\\{\\{|#\\{|%\\w|\\$[A-Za-z_][\\w]*$)" +
    "|" +
    // Whole-value stand-ins, still anchored at both ends: `secret` is a
    // placeholder, `secretsauce` is a password.
    "^(?:\\*+|x+|-+|\\.+|change[-_]?me|your[-_][\\w-]*|placeholder|redacted|secret|password|example|sample|todo|tbd|null|none|true|false|\\d{1,3}|https?://.*|[/~@].*)$",
  "i",
);

const SECRET_KEY_SOURCE =
  "(?:password|passwd|pwd|account[-_]?key|shared[-_]?access[-_]?key|secret[-_]?key|client[-_]?secret|api[-_]?key|private[-_]?key|access[-_]?key|auth[-_]?token|secret)";
/** `Password=...;` inside a connection string, in any file type. */
const CONNECTION_STRING_SECRET = new RegExp(`\\b${SECRET_KEY_SOURCE}\\s*=\\s*([^;"'\\s]+)`, "i");
/** `"ClientSecret": "..."` in JSON, `ClientSecret: ...` in YAML, `CLIENT_SECRET=...` in .env. */
const KEYED_SECRET = new RegExp(`(?:^|[{,])\\s*(?:-\\s*)?"?\\w*${SECRET_KEY_SOURCE}"?\\s*[:=]\\s*"?([^"\\s,}#][^",}]*)`, "i");

function hardcodedSecret(view: LineView): boolean {
  const candidates = [CONNECTION_STRING_SECRET.exec(view.text)?.[1], KEYED_SECRET.exec(view.text)?.[1]];
  return candidates.some((value) => value !== undefined && value.length >= 4 && !PLACEHOLDER_VALUE.test(value.trim()));
}

/**
 * A request that names its own host.
 *
 * `$"{baseUrl}/orders/{id}"` and `$"{callbackUrl}/notify"` look alike to a
 * regex, and only the second is a server-side request forgery: the host comes
 * from the caller. The rule fires when the first thing in the URL is a hole or
 * a concatenated identifier, and that identifier is not one of the shapes a
 * configured base address conventionally takes (`_baseUrl`, `options.Api`,
 * `process.env.X`). A hole after a literal prefix is a path, not a host, and
 * is not this rule's business.
 */
const OUTBOUND_CALL =
  /\b(?:GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync|SendAsync|GetStringAsync|GetStreamAsync|GetByteArrayAsync|DownloadString(?:Async)?|DownloadData(?:Async)?|WebRequest\.Create|fetch|axios\.(?:get|post|put|delete|patch|request)|got(?:\.\w+)?|requests\.(?:get|post|put|delete|patch|head))\s*\(\s*/;
const CONFIGURED_HOST = /^(?:_|this\.|self\.|process\.env\b|env\b|config|settings|options|opts|base|BASE|_?api|constants?\b)/;

function requestToCallerHost(view: LineView): boolean {
  const call = OUTBOUND_CALL.exec(view.text);
  if (!call) return false;
  const arg = view.text.slice(call.index + call[0].length);
  // Interpolated with the hole first: $"{x}...", `${x}...`, f"{x}...".
  const hole = /^(?:\$@?"|@\$"|[fF]"|`)\$?\{\s*([\w.]+)/.exec(arg);
  if (hole?.[1] !== undefined) return !CONFIGURED_HOST.test(hole[1]);
  // Concatenated with the identifier first: x + "/notify".
  const concat = /^([\w.]+)\s*\+\s*["'`]/.exec(arg);
  if (concat?.[1] !== undefined) return !CONFIGURED_HOST.test(concat[1]);
  // Read straight off the request, bare or wrapped in new Uri(...).
  return /^(?:new\s+Uri\s*\(\s*)?(?:Request|request|req|ctx)\.[\w.]+\s*[,)]/.test(arg);
}

/** Routes whose purpose is to accept or reset a credential. */
const CREDENTIAL_ROUTE =
  /(?:\[\s*Http(?:Post|Put)\s*\(\s*"|\[\s*Route\s*\(\s*"|\.Map(?:Post|Put)\s*\(\s*"|\b(?:app|router)\.(?:post|put)\s*\(\s*['"`])[^"'`]*\b(?:login|signin|sign-in|logon|authenticate|password|reset|forgot|signup|sign-up|register|otp|mfa|2fa)\b/i;
const THROTTLE = /RateLimit|Throttl|limiter|slowDown|BruteForce|brute-force|RequireRateLimiting|EnableRateLimiting|Lockout/i;

/**
 * A header that names WHO the caller is, rather than one describing the request.
 *
 * The identity word has to be a whole segment of the header name. A substring
 * test reads `User-Agent` as a user header and `Origin` as an org header, both
 * of which nearly every request carries, so the rule fired across whole
 * middleware files and buried the header that actually decides the tenant.
 *
 * `user` alone is not enough for the same reason: only `user-id`, `userid` or
 * `user-name` name a subject. `org` as a full segment does, and stops short of
 * `origin` because a trailing segment boundary is required.
 */
const IDENTITY_HEADER =
  /(?:^|[-_])(?:tenant|organi[sz]ation|org|account|customer|role|admin|impersonat\w*|act[-_]?as|on[-_]?behalf(?:[-_]of)?)(?:[-_]|$)|user[-_]?(?:id|name)\b/i;

const RULES: readonly SignalRule[] = [
  // ── Broken authentication (API2) ────────────────────────────────────────
  //
  // Reading a token without validating it is the highest-consequence thing a
  // pattern can find, because every authorisation decision downstream rests on
  // it. `ReadJwtToken` DECODES; `ValidateToken` is the one that checks a
  // signature, and the names are close enough to read past. The newer
  // `JsonWebTokenHandler` has the same pair under `ReadJsonWebToken`.
  {
    kind: "unvalidated-token",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "code",
    pattern: /\b(?:ReadJwtToken|ReadJsonWebToken)\s*\(/,
    cwe: "CWE-347",
    owasp: OWASP.authn,
  },
  {
    kind: "unvalidated-token",
    signalClass: "defect",
    languages: ["typescript", "javascript"],
    scope: "code",
    pattern: /\bjwt\s*\.\s*decode\s*\(|verify\s*:\s*false|ignoreExpiration\s*:\s*true/,
    cwe: "CWE-347",
    owasp: OWASP.authn,
  },

  // An endpoint that skips authentication altogether is missing authentication
  // (CWE-306), which OWASP files under API2 rather than under function-level
  // authorization: no role check was bypassed, because none was reached.
  {
    kind: "anonymous-endpoint",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "code",
    pattern: /\[\s*AllowAnonymous\s*\]|\.\s*AllowAnonymous\s*\(\s*\)/,
    cwe: "CWE-306",
    owasp: OWASP.authn,
  },

  // ── Broken function level authorization (API5) ──────────────────────────
  {
    kind: "authorization-check",
    signalClass: "surface",
    languages: ["csharp"],
    scope: "code",
    pattern: /\[\s*Authorize\b|\.\s*RequireAuthorization\s*\(/,
    cwe: "CWE-862",
    owasp: OWASP.bfla,
  },

  // ── Broken object level authorization (API1) ────────────────────────────
  //
  // Identity taken from something the caller sets. A tenant id read from a
  // header, ahead of the token's own claim, means the boundary between
  // customers rests on a value the customer supplies. The header name is the
  // evidence and it is a literal, so this rule reads text.
  {
    kind: "identity-from-request",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "text",
    pattern: (view) => {
      const header = /(?:Request\.Headers|HttpContext\.Request\.Headers)\s*\[\s*"([^"]+)"/i.exec(view.text);
      return header?.[1] !== undefined && IDENTITY_HEADER.test(header[1]);
    },
    cwe: "CWE-639",
    owasp: OWASP.bola,
  },
  {
    kind: "identity-from-request",
    signalClass: "defect",
    languages: ["typescript", "javascript"],
    scope: "text",
    pattern: (view) => {
      const header = /(?:req|request)\.headers\s*(?:\[\s*['"`]([^'"`\]]+)|\.\s*([\w$]+))/i.exec(view.text);
      const name = header?.[1] ?? header?.[2];
      return name !== undefined && IDENTITY_HEADER.test(name);
    },
    cwe: "CWE-639",
    owasp: OWASP.bola,
  },

  // Route surface. Not a defect by itself; it is the denominator the
  // categories above are measured against, which is why it carries the parent
  // access-control CWE rather than one of its own.
  { kind: "http-endpoint", signalClass: "surface", languages: ["csharp"], scope: "code", pattern: /\[\s*Http(Get|Post|Put|Delete|Patch)\b/, cwe: "CWE-284" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["csharp"], scope: "code", pattern: /\[\s*Route\s*\(/, cwe: "CWE-284" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["csharp"], scope: "code", pattern: /\b(?:app|group|endpoints)\s*\.\s*Map(?:Get|Post|Put|Delete|Patch|Methods)\s*\(/, cwe: "CWE-284" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["typescript", "javascript"], scope: "code", pattern: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b/, cwe: "CWE-284" },
  { kind: "http-endpoint", signalClass: "surface", languages: ["typescript", "javascript"], scope: "code", pattern: /\b(?:app|router)\.(get|post|put|delete|patch)\s*\(/, cwe: "CWE-284" },

  // ── Injection (CWE-89) ──────────────────────────────────────────────────
  //
  // No OWASP API category: the 2023 list dropped injection, and citing
  // Security Misconfiguration for it, as the first cut did, told the reader
  // the wrong thing about what to fix.
  { kind: "raw-sql", signalClass: "defect", languages: [], scope: "text", pattern: sqlFromInput, cwe: "CWE-89" },
  // EF's raw APIs with an interpolated or concatenated statement, whatever the
  // statement says. `FromSqlRaw("... {0}", id)` is parameterised and does not
  // fire; `FromSqlInterpolated($"...")` is the safe spelling and is not named.
  {
    kind: "raw-sql",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "text",
    pattern: /\b(?:FromSqlRaw|ExecuteSqlRaw(?:Async)?|SqlQueryRaw)\s*(?:<[^>]+>)?\s*\(\s*(?:\$@?"|@\$"|[\w.]+\s*\+|"(?:[^"\\]|\\.)*"\s*\+\s*[\w.])/,
    cwe: "CWE-89",
  },

  // ── Cryptographic failures ──────────────────────────────────────────────
  //
  // Reads code, so a comment or a log message naming MD5 is not a reference
  // to it. The class names `SHA1Managed` and `MD5CryptoServiceProvider` do not
  // have a word boundary after the algorithm, which is why they are spelled.
  {
    kind: "weak-crypto",
    signalClass: "defect",
    languages: [],
    scope: "code",
    pattern: /\b(?:MD5|SHA1|DES|RC4|ECB)\b(?!\s*[:=]\s*['"]?(?:false|0))|\b(?:MD5|SHA1|DES|RC2|TripleDES)(?:Managed|CryptoServiceProvider|Cng)\b/,
    cwe: "CWE-327",
  },
  // Algorithms chosen by name are chosen inside a string.
  {
    kind: "weak-crypto",
    signalClass: "defect",
    languages: [],
    scope: "text",
    pattern: /\b(?:createHash|HashAlgorithm\.Create|CryptoConfig\.CreateFromName)\s*\(\s*['"](?:md5|sha1|sha-1)['"]/i,
    cwe: "CWE-327",
  },
  {
    kind: "disabled-cert-validation",
    signalClass: "defect",
    languages: [],
    scope: "code",
    pattern: /ServerCertificateValidationCallback\s*[+]?=|ServerCertificateCustomValidationCallback\s*=|rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    cwe: "CWE-295",
    owasp: OWASP.misconfig,
  },

  // ── Security misconfiguration (API8) ────────────────────────────────────
  {
    kind: "permissive-cors",
    signalClass: "defect",
    languages: [],
    scope: "text",
    pattern: /AllowAnyOrigin\s*\(|Access-Control-Allow-Origin["'\s:]*\*|origin\s*:\s*["'`]\*["'`]/,
    cwe: "CWE-942",
    owasp: OWASP.misconfig,
  },
  // A test settings file loaded after the environment file is how a test value
  // reaches production without anyone choosing it. The file name is the
  // evidence and it is a literal. A `.csproj` item that copies that file to the
  // output directory names it too and is not a load, so the rule reads the
  // loading call rather than every mention of the name.
  {
    kind: "config-precedence",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "text",
    pattern: /AddJsonFile\s*\(\s*"appsettings\.(Test|Development|Staging)/i,
    cwe: "CWE-15",
    owasp: OWASP.misconfig,
  },
  {
    kind: "config-precedence",
    signalClass: "defect",
    languages: [],
    scope: "text",
    pattern: /appsettings\.Test\.json/,
    unless: { pattern: /<\s*(?:Content|None|EmbeddedResource|Compile)\b[^>]*\b(?:Include|Update|Remove)\s*=/ },
    cwe: "CWE-15",
    owasp: OWASP.misconfig,
  },

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
    scope: "code",
    pattern: /\.\s*(?:Get|Find|Load|Read|Fetch)\w*ById(?!s)\w*(?:Async)?\s*(?:<[^>]+>)?\s*\(/,
    cwe: "CWE-639",
    owasp: OWASP.bola,
  },

  // ── Cross-site request forgery ──────────────────────────────────────────
  // Counts the actions that ARE protected. The ratio against state-changing
  // routes is the statement; the attribute's presence is never a defect.
  { kind: "csrf-token-validated", signalClass: "surface", languages: ["csharp"], scope: "code", pattern: /\[\s*(?:Auto)?ValidateAntiForgeryToken\s*\]/, cwe: "CWE-352" },

  // ── Security misconfiguration: debug and disclosure (API8) ──────────────
  //
  // `UseDeveloperExceptionPage()` inside `if (app.Environment.IsDevelopment())`
  // is the template every new project ships with, and the guard sits on the
  // same line or the line or two above. Only the unguarded call is a defect.
  {
    kind: "debug-enabled",
    signalClass: "defect",
    languages: [],
    scope: "text",
    pattern: /<compilation[^>]*\bdebug\s*=\s*"true"|<trace[^>]*\benabled\s*=\s*"true"|DeveloperExceptionPage\s*\(/,
    unless: { pattern: /\bIsDevelopment\s*\(/, above: 2 },
    cwe: "CWE-489",
    owasp: OWASP.misconfig,
  },
  {
    kind: "insecure-cookie",
    signalClass: "defect",
    languages: [],
    scope: "text",
    pattern: /(?:HttpOnly|CookieHttpOnly)\s*=\s*false|requireSSL\s*=\s*"false"|Secure\s*=\s*false|SlidingExpiration\s*=\s*true/,
    cwe: "CWE-1004",
    owasp: OWASP.misconfig,
  },

  // ── Password storage ────────────────────────────────────────────────────
  // PBKDF2 is what .NET recommends. A general-purpose digest over a password is
  // the failure this catches, and it is distinct from weak-crypto elsewhere.
  {
    kind: "weak-password-hash",
    signalClass: "defect",
    languages: [],
    scope: "code",
    pattern: /(?:SHA256|SHA512|MD5|SHA1)[^\n]{0,40}(?:password|passwd|pwd)|(?:password|passwd|pwd)[^\n]{0,40}(?:SHA256|SHA512|MD5|SHA1)\s*\./i,
    cwe: "CWE-916",
  },

  // ── Sensitive data (CWE-311) ────────────────────────────────────────────
  // Not a defect on sight. It marks where the encryption question has to be
  // asked, and it is what decides how serious an incident would be. Reads text
  // because a JSON schema names its fields inside quotes.
  { kind: "sensitive-field", signalClass: "surface", languages: [], scope: "text", pattern: new RegExp(SENSITIVE_FIELD_SOURCE, "i"), cwe: "CWE-311" },

  // ── Sensitive data in logs (CWE-532) ────────────────────────────────────
  // A log call whose ARGUMENT names a sensitive field. Reads code, so a message
  // that merely says "SSN lookup" does not fire; the value has to be passed.
  { kind: "phi-in-log", signalClass: "defect", languages: [], scope: "code", pattern: new RegExp(`${LOG_CALL.source}[^;]*${SENSITIVE_FIELD_SOURCE}`, "i"), cwe: "CWE-532" },

  // ── Hard-coded credentials (CWE-798) ────────────────────────────────────
  {
    kind: "hardcoded-secret",
    signalClass: "defect",
    languages: ["json", "yaml", "other"],
    paths: /(?:^|\/)(?:appsettings[^/]*\.json|[^/]*\.env|\.env(?!\.(?:example|sample|template|dist)$)[^/]*|web\.config|app\.config|[^/]*\.ya?ml)$/i,
    scope: "text",
    pattern: hardcodedSecret,
    cwe: "CWE-798",
  },

  // ── Deserialization of untrusted data (CWE-502) ─────────────────────────
  // Each of these reconstructs arbitrary types from the payload. `TypeNameHandling.None`
  // and `System.Text.Json` are the safe spellings and are not named.
  {
    kind: "insecure-deserialization",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "code",
    pattern: /\bnew\s+(?:BinaryFormatter|SoapFormatter|NetDataContractSerializer|LosFormatter|ObjectStateFormatter)\s*\(|\bTypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects|Arrays)\b|\bnew\s+JavaScriptSerializer\s*\(\s*new\s+SimpleTypeResolver\b/,
    cwe: "CWE-502",
  },
  {
    kind: "insecure-deserialization",
    signalClass: "defect",
    languages: ["python"],
    scope: "code",
    pattern: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)/,
    cwe: "CWE-502",
  },

  // ── XML external entities (CWE-611) ─────────────────────────────────────
  // DTD processing switched on, or a resolver that will fetch what the DTD
  // names. `DtdProcessing.Prohibit` and `XmlResolver = null` are the defaults
  // since .NET 4.5.2 and are the safe idiom.
  {
    kind: "xxe",
    signalClass: "defect",
    languages: ["csharp"],
    scope: "code",
    pattern: /\bDtdProcessing\s*=\s*DtdProcessing\.Parse\b|\bXmlResolver\s*=\s*new\s+Xml\w*Resolver\b|\bProhibitDtd\s*=\s*false\b/,
    cwe: "CWE-611",
  },

  // ── Path traversal (CWE-22) ─────────────────────────────────────────────
  // A file API given a request-bound value, with no `GetFileName` or
  // `GetFullPath` on the same line to pin it under the root.
  {
    kind: "path-traversal",
    signalClass: "defect",
    languages: ["csharp", "typescript", "javascript", "python"],
    scope: "code",
    pattern: new RegExp(
      "\\b(?:Path\\.Combine|File\\.(?:ReadAllText|ReadAllBytes|ReadAllLines|OpenRead|OpenText|Open|Exists|Delete|WriteAllText|WriteAllBytes|Copy|Move)|new\\s+(?:FileStream|StreamReader|FileInfo)" +
        `|fs\\.\\w+|path\\.(?:join|resolve)|os\\.path\\.join|open|send_file|sendFile)\\s*\\([^)]*${REQUEST_BOUND_SOURCE}`,
      "i",
    ),
    unless: { pattern: /\bGetFileName\s*\(|\bGetFullPath\s*\(|\bbasename\s*\(|\bIsPathRooted\s*\(|\bSanitize\w*\s*\(/ },
    cwe: "CWE-22",
  },

  // ── Server-side request forgery (API7, CWE-918) ─────────────────────────
  {
    kind: "ssrf",
    signalClass: "defect",
    languages: ["csharp", "typescript", "javascript", "python"],
    scope: "text",
    pattern: requestToCallerHost,
    cwe: "CWE-918",
    owasp: OWASP.ssrf,
  },

  // ── Cross-site scripting sinks (CWE-79) ─────────────────────────────────
  // The sink, not the source: the sweep cannot follow the value back. Each of
  // these bypasses the framework's escaping by design, so every use is a place
  // the investigation has to ask where the value came from.
  {
    kind: "xss-sink",
    signalClass: "defect",
    languages: ["typescript", "javascript", "html", "csharp", "other"],
    scope: "code",
    pattern: /\bdangerouslySetInnerHTML\b|\.\s*(?:innerHTML|outerHTML)\s*[+]?=|\bdocument\.write(?:ln)?\s*\(|\bHtml\.Raw\s*\(|\bbypassSecurityTrust\w*\s*\(|\bv-html\b/,
    // `el.innerHTML = ""` clears; a literal on the right is the author's own
    // markup. In the code view every literal is empty quotes, so one shape
    // covers both.
    unless: { pattern: /(?:innerHTML|outerHTML)\s*[+]?=\s*(?:""|''|``)\s*;?\s*$/ },
    cwe: "CWE-79",
  },

  // ── Tokens in web storage (CWE-922) ─────────────────────────────────────
  // Anything in localStorage is readable by any script on the origin, so a
  // token there survives the XSS that an HttpOnly cookie would not. The key is
  // the evidence, and it is usually a literal.
  {
    kind: "token-in-web-storage",
    signalClass: "defect",
    languages: ["typescript", "javascript", "html"],
    scope: "text",
    pattern: /\b(?:localStorage|sessionStorage)\s*(?:\.\s*setItem\s*\(\s*(?:['"`][^'"`]*|[\w.]*)|\.\s*\w*|\[\s*['"`][^'"`]*)(?:token|jwt|auth|bearer|session[-_]?id)/i,
    cwe: "CWE-922",
  },

  // ── Credential endpoints without a throttle (CWE-307) ───────────────────
  // Surface, not defect: the throttle may live in middleware the line cannot
  // see. The count of credential routes with no rate-limit attribute beside
  // them is the question to put to the investigation.
  {
    kind: "rate-limit-absent",
    signalClass: "surface",
    languages: ["csharp", "typescript", "javascript"],
    scope: "text",
    pattern: CREDENTIAL_ROUTE,
    unless: { pattern: THROTTLE, above: 6, below: 2 },
    cwe: "CWE-307",
    owasp: OWASP.authn,
  },
];

/** The rule table, read-only, so a test can check every rule against a standard. */
export const SWEEP_RULES: readonly SignalRule[] = RULES;

/** Binary sniff: a NUL byte in the first block is the reliable, cheap signal. */
function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8000);
  return window.includes(0);
}

/**
 * The value-capturing patterns again, global (OGE-2754).
 *
 * Separate objects on purpose. A global regex carries `lastIndex` across
 * `.exec` calls, so adding the flag to the two constants the detector uses
 * would make `hardcodedSecret` skip every other line it was asked about. The
 * detector would then miss secrets intermittently, which reads as flaky rule
 * coverage and points nowhere near here.
 */
const CONNECTION_STRING_SECRET_ALL = new RegExp(CONNECTION_STRING_SECRET.source, "gi");
const KEYED_SECRET_ALL = new RegExp(KEYED_SECRET.source, "gi");

/**
 * Hide the value, keep everything that makes the signal actionable.
 *
 * A signal's excerpt is the matched line verbatim, and for a secret rule the
 * matched line IS the secret. Written to `sweep.json`, which by default lands
 * inside the acquired tree, that made an audit reporting an exposed credential
 * take a second copy of it to somewhere the operator did not choose.
 *
 * Redaction happens where the excerpt is built rather than at render, so every
 * consumer inherits it: the artifact on disk, findings, telemetry, the report,
 * and any stage added later. A gate at the end only protects the outputs it
 * knows about.
 *
 * The key name, the path and the line all survive, which is what a reader needs
 * to open the file and confirm. Two layers, because each covers the other's
 * blind spot: the rule's own capture groups know where the value is whatever
 * shape it has, and `maskSecrets` catches credential shapes on lines that some
 * OTHER rule matched, where no capture group is looking.
 *
 * A placeholder is left readable, on the same reasoning that keeps the detector
 * from firing on one: `"ClientSecret": "${CLIENT_SECRET}"` is the documented way
 * of not committing a secret, and masking it would teach the reader to skip the
 * line that is real.
 */
export function redactSecretValues(line: string): string {
  let out = line;
  for (const pattern of [CONNECTION_STRING_SECRET_ALL, KEYED_SECRET_ALL]) {
    out = out.replace(pattern, (whole: string, value: string | undefined) => {
      if (value === undefined) return whole;
      const trimmed = value.trim();
      if (trimmed.length < 4 || PLACEHOLDER_VALUE.test(trimmed)) return whole;
      return whole.slice(0, whole.length - value.length) + SECRET_MASK;
    });
  }
  return maskSecrets(out);
}

function excerptOf(line: string): string {
  // Redact before truncating. Truncating first can cut a long connection
  // string mid-value and leave a readable prefix of the key sitting in the
  // artifact, which is a leak that looks handled.
  const flat = redactSecretValues(line).trim().replace(/\s+/g, " ");
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/**
 * Test code, by path.
 *
 * Test files are still visited and still counted as covered, because they are
 * part of the tree and a coverage number that quietly drops them is wrong. What
 * they do not produce is signals: an unscoped by-id fetch inside a test is a
 * fixture, and reporting it as a risk buries the ones in the service layer.
 *
 * Anchored on directory segments and on suffixes with a case-sensitive
 * PascalCase boundary. A case-insensitive `/Tests?\.cs$/` mutes any file whose
 * name merely ends in those letters, such as `Contest.cs`, and treating
 * `fixtures` or `mocks` as test directories mutes shipped code that happens to
 * live under one, since API doubles are often production types. A muted file is
 * the one class of miss the ledger cannot show, so the rule errs towards
 * reading: plural `FooTests.cs` is a test class, but singular `LabTest.cs`
 * is as likely a domain model, so the singular needs a separator before it
 * (`Order.Test.cs`, `Order_Test.cs`) and otherwise stays read.
 */
export function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\//i.test(path) ||
    /(?:^|\/)[^/]+\.Tests?\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /(?:^|\/|[a-z0-9_.])Tests\.cs$/.test(path) ||
    /(?:^|[/._])Test\.cs$/.test(path) ||
    /Test\.java$|_test\.go$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$/.test(path)
  );
}

/** Languages where `#` opens a comment. In C# it opens a directive and in CSS an id. */
const HASH_COMMENT_LANGUAGES = new Set(["python", "ruby", "shell", "yaml", "php", "other"]);

interface StripState {
  inBlock: "*/" | "-->" | null;
}

/**
 * One line as text (comments out) and as code (comments and literal bodies
 * out), carrying block-comment state from line to line so a line in the middle
 * of a block comment is known to be comment without looking for a leading `*`.
 *
 * Deliberately small: no verbatim strings, no multi-line literals, no regex
 * literals. A literal that runs to the end of the line is treated as closed
 * there, which loses the rest of a multi-line string and nothing else.
 */
function stripLine(raw: string, language: string, state: StripState): { text: string; code: string } {
  const hashComments = HASH_COMMENT_LANGUAGES.has(language);
  let text = "";
  let code = "";
  let i = 0;
  while (i < raw.length) {
    if (state.inBlock) {
      const close = raw.indexOf(state.inBlock, i);
      if (close === -1) return { text, code };
      i = close + state.inBlock.length;
      state.inBlock = null;
      continue;
    }
    const ch = raw[i] ?? "";
    const pair = raw.slice(i, i + 2);
    if (pair === "//" || (ch === "#" && hashComments) || (pair === "--" && language === "sql")) break;
    if (pair === "/*") {
      state.inBlock = "*/";
      i += 2;
      continue;
    }
    if (raw.startsWith("<!--", i)) {
      state.inBlock = "-->";
      i += 4;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) {
        if (raw[j] === "\\") j += 1;
        j += 1;
      }
      text += raw.slice(i, j + 1);
      code += ch + holesOf(raw, i, j) + ch;
      i = j + 1;
      continue;
    }
    text += ch;
    code += ch;
    i += 1;
  }
  return { text, code };
}

/**
 * The expressions inside an interpolated literal, which are code even though
 * they sit between quotes: `$"Patient {patient.Ssn}"` passes a field to
 * whatever the string reaches, and `Console.WriteLine($"...")` is the most
 * common way a .NET service logs one. A plain `"Patient {Ssn}"` is a template
 * whose holes are names, not values, and stays empty.
 */
function holesOf(raw: string, open: number, close: number): string {
  const quote = raw[open];
  const body = raw.slice(open + 1, close);
  if (quote === "`") return [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => `{${m[1] ?? ""}}`).join("");
  const prefix = raw.slice(Math.max(0, open - 2), open);
  const interpolated = prefix.includes("$") || /(?:^|[^\w])[fF]$/.test(prefix);
  if (!interpolated) return "";
  return [...body.matchAll(/(?<!\{)\{(?!\{)([^{}]+)\}/g)].map((m) => `{${m[1] ?? ""}}`).join("");
}

function applies(rule: SignalRule, language: string, path: string): boolean {
  // A README that says "we still hash with MD5" is prose about the code, not
  // the code, and a candidate raised on it cannot be fixed at the cited line.
  if (language === "markdown") return false;
  if (rule.languages.length > 0 && !rule.languages.includes(language)) return false;
  if (rule.paths && !rule.paths.test(path)) return false;
  return true;
}

/** Signals in one already-read file. Exported so it can be tested without a tree. */
export function signalsIn(path: string, source: string): Signal[] {
  if (isTestPath(path)) return [];
  const language = languageOf(path);
  const applicable = RULES.filter((r) => applies(r, language, path));
  if (applicable.length === 0) return [];

  // Every line is stripped before any rule runs, because a guard on the line
  // above has to be readable when the line below is matched.
  const state: StripState = { inBlock: null };
  const raw = source.split("\n");
  const views = raw.map((line) => stripLine(line, language, state));
  const viewAt = (index: number) => (index >= 0 && index < views.length ? views[index] : undefined);

  const out: Signal[] = [];
  for (let i = 0; i < views.length; i += 1) {
    const view = views[i];
    if (!view) continue;
    const lineView: LineView = { text: view.text, code: view.code, neighbour: (offset) => viewAt(i + offset) };
    // Two rules of one kind on one line are one observation, not two. The C#
    // AddJsonFile rule and the bare file-name rule both hit the same call.
    const seen = new Set<SignalKind>();
    for (const rule of applicable) {
      if (seen.has(rule.kind)) continue;
      const subject = rule.scope === "code" ? view.code : view.text;
      if (subject.trim() === "") continue;
      const hit = typeof rule.pattern === "function" ? rule.pattern(lineView) : rule.pattern.test(subject);
      if (!hit) continue;
      if (rule.unless && guarded(rule, i, views)) continue;
      seen.add(rule.kind);
      out.push({
        path,
        line: i + 1,
        kind: rule.kind,
        signalClass: rule.signalClass,
        excerpt: excerptOf(raw[i] ?? ""),
        cwe: rule.cwe,
        ...(rule.owasp ? { owasp: rule.owasp } : {}),
      });
    }
  }
  return out;
}

/** Whether the rule's `unless` shape appears on the line or within its window. */
function guarded(rule: SignalRule, index: number, views: Array<{ text: string; code: string }>): boolean {
  const unless = rule.unless;
  if (!unless) return false;
  const from = Math.max(0, index - (unless.above ?? 0));
  const to = Math.min(views.length - 1, index + (unless.below ?? 0));
  for (let i = from; i <= to; i += 1) {
    const view = views[i];
    if (!view) continue;
    if (unless.pattern.test(rule.scope === "code" ? view.code : view.text)) return true;
  }
  return false;
}

/**
 * Read every file in the tree, and say what happened to each one.
 *
 * The access log is the same one the investigation writes to, so the existing
 * coverage machinery reports this without change. That is the point: coverage
 * stops being a claim the report makes and becomes a ledger it can show.
 *
 * `options.runDir` keeps the run's own artifacts out of the walk. Without it
 * a re-run sweep read the previous sweep.json and matched its own excerpts.
 */
export function sweepTree(root: string, log: FileAccessLog, options: WalkOptions = {}): SweepResult {
  const files: TreeFile[] = walkTree(root, options);
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
    const suppressed = isTestPath(file.path);
    const found = suppressed ? [] : signalsIn(file.path, source);
    signals.push(...found);
    dispositions.push({
      path: file.path,
      language,
      bytes,
      lines: source.split("\n").length,
      outcome: "read",
      signals: found.length,
      ...(suppressed ? { suppressed: "test-path" as const } : {}),
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
