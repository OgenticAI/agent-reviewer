/**
 * Normalized analyzer/test findings (OGE-1588).
 *
 * The model currently re-derives lint and test facts by reading 12KB CI-log
 * tails inside the capped tool loop, and mechanical items ("lint passes", "no
 * new type errors", "tests cover the flag") punt or mis-resolve because a log
 * tail is a lossy, adversarial way to learn a fact something already computed
 * exactly. This is the deterministic path: parse the analyzer's own structured
 * output once, hand the model established facts, and let it annotate rather
 * than hunt. reviewbot's entire architecture is "linters find, the LLM
 * annotates"; CodeRabbit fans analyzers out *before* the prompt.
 *
 * The `Finding` shape is reviewdog's RDFormat (`reviewdog.proto`) — the one
 * schema every analyzer adapter in that ecosystem already normalizes to, so
 * adopting it means our adapters look like everyone else's and nothing here is
 * novel enough to get subtly wrong.
 *
 * ── The non-negotiable security rule ────────────────────────────────────────
 *
 * We PARSE analyzer output. We never EXECUTE an analyzer config from the PR.
 * The Kudelski RCE on CodeRabbit came through executing a PR-supplied
 * `.rubocop.yml`. Every adapter here takes text that CI already produced and
 * turns it into data; none of them runs a tool, reads a PR-supplied config, or
 * shells out. That is the whole reason this adds no attack surface.
 */

/** reviewdog severity levels, lowercased. `unknown` when the source omits it. */
export type FindingSeverity = "error" | "warning" | "info" | "unknown";

/** A position in a file. 1-based line, matching every analyzer's convention. */
export interface FindingPosition {
  line: number;
  column?: number;
}

/** reviewdog's RDFormat `Diagnostic`, trimmed to what we render + gate on. */
export interface Finding {
  /** Repo-relative path the finding is about. */
  path: string;
  /** Where in the file, when the source gives a location. */
  position?: FindingPosition;
  /** The analyzer's message, verbatim (still sanitized before it reaches the prompt). */
  message: string;
  severity: FindingSeverity;
  /** Which analyzer produced it, e.g. "eslint", "tsc", "junit". */
  source: string;
  /** Rule/code id when present, e.g. "no-unused-vars", "TS2345". */
  code?: string;
}

/**
 * The result of ingesting one CI job's output.
 *
 * `findings: []` with `parsed: true` is a POSITIVE fact — the analyzer ran and
 * reported nothing — and the prompt states it as such. That distinction is the
 * point: "eslint ran clean" and "we couldn't tell what eslint did" must never
 * collapse into the same silence, because the model reads absence as green.
 */
export interface JobFindings {
  /** The CI job / analyzer name this came from. */
  job: string;
  /** True when we recognized and parsed the output; false when we couldn't. */
  parsed: boolean;
  findings: Finding[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
  unknown: 0,
};

/** Whether `a` is at least as severe as `b`. */
export function severityAtLeast(a: FindingSeverity, b: FindingSeverity): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
}

export function normalizeSeverity(raw: string | number | undefined | null): FindingSeverity {
  if (typeof raw === "number") {
    // eslint's numeric severity: 2 = error, 1 = warning.
    if (raw >= 2) return "error";
    if (raw === 1) return "warning";
    return "info";
  }
  const s = (raw ?? "").toString().trim().toLowerCase();
  if (["error", "fatal", "failure", "failed"].includes(s)) return "error";
  if (["warning", "warn"].includes(s)) return "warning";
  if (["info", "information", "note", "notice", "convention"].includes(s)) return "info";
  return "unknown";
}
