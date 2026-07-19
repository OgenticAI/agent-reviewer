/**
 * Normalising tool output before hashing it (OGE-1553).
 *
 * Two runs of the same CI job produce different text — different timestamps,
 * a different run id, different durations — while describing an identical
 * outcome. Hashing that raw means the hash never repeats, so a cache keyed on
 * it never hits and the whole exercise is pointless. Stripping the volatile
 * parts is the fiddly, load-bearing bit.
 *
 * The rule for what belongs here: a pattern is normalised only if changing it
 * cannot change a verdict. A timestamp can't. A test count absolutely can, so
 * digits in general are left alone — only digits in recognisably positional
 * contexts (a run id, a duration, a hex sha) are masked.
 *
 * Over-normalising is the dangerous direction: mask too much and two
 * genuinely different tool outputs collide, so the reviewer replays a stale
 * verdict against changed evidence. Under-normalising only costs a cache miss.
 * When unsure, leave it.
 */

/**
 * Patterns replaced with a fixed token before hashing.
 *
 * **Order matters, and one case is not obvious:** ANSI stripping must run
 * before duration masking. An ANSI reset is `ESC[0m`, and `0m` matches the
 * duration pattern — so with the other order `ESC[0m` normalises to `[<DUR>`,
 * leaving colour-coded CI logs with a stray bracket and a fake duration in
 * every line. Two runs still hash equal, so nothing breaks loudly; the output
 * is just quietly wrong.
 */
const VOLATILE_PATTERNS: Array<{ re: RegExp; token: string }> = [
  // ANSI colour codes from CI logs. MUST precede the duration pattern.
  // eslint-disable-next-line no-control-regex
  { re: /\x1b?\[[0-9;]*m/g, token: "" },
  // ISO-8601 timestamps: 2026-07-19T10:32:28.123Z
  { re: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, token: "<TS>" },
  // Clock times on their own: 10:32:28
  { re: /\b\d{2}:\d{2}:\d{2}\b/g, token: "<TIME>" },
  // Durations: "in 1.23s", "took 45ms", "(2m 3s)"
  { re: /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/gi, token: "<DUR>" },
  // Git SHAs, 7–40 hex chars
  { re: /\b[0-9a-f]{7,40}\b/gi, token: "<SHA>" },
  // GitHub run / job / check ids in URLs or key=value form
  { re: /\b(runs?|jobs?|check-runs?|actions)\/\d+/gi, token: "$1/<ID>" },
  { re: /\b(run_id|job_id|check_run_id|id)[=:]\s*\d+/gi, token: "$1=<ID>" },
  // Trailing whitespace and CRLF, which vary by runner
  { re: /[ \t]+$/gm, token: "" },
  { re: /\r\n/g, token: "\n" },
];

/**
 * Strip volatile substrings so two runs describing the same outcome normalise
 * to the same string.
 *
 * Note what is deliberately NOT normalised: bare integers. "225 tests passed"
 * and "226 tests passed" are different facts that can change a verdict, and
 * masking them would let the cache replay a stale verdict against a changed
 * test suite.
 */
export function normalizeToolOutput(raw: string): string {
  let out = raw;
  for (const { re, token } of VOLATILE_PATTERNS) {
    out = out.replace(re, token);
  }
  return out.trim();
}
