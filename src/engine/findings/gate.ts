/**
 * The deterministic findings gate (OGE-1588).
 *
 * reviewdog's decoupled pattern: report everything, gate selectively. The
 * model's verdict and the analyzer gate are independent — a real `error`-level
 * finding fails the Check regardless of what the LLM concluded, because "tsc
 * reported 3 errors" is not a matter of opinion the model gets to overrule.
 *
 * Pure and independent of any verdict on purpose. It lives beside the branch-
 * protection merge logic in `src/protection/` because both answer the same
 * question — "may this merge?" — from non-LLM signals; this one from analyzer
 * severity, that one from GitHub's protection config.
 */

import type { Finding, FindingSeverity, JobFindings } from "../findings/schema.js";
import { severityAtLeast } from "../findings/schema.js";

/**
 * The severity at or above which findings fail the Check.
 *
 * `off` disables the gate entirely (findings still reach the prompt as
 * context) — the default, so ingestion changes nothing about merge behaviour
 * until a repo opts in via `findings_fail_level`.
 */
export type FindingsFailLevel = "off" | "error" | "warning" | "info";

export interface FindingsGateResult {
  /** True when the gate should fail the Check. */
  failed: boolean;
  /** The findings at or above the threshold, for the failure message. */
  offending: Finding[];
  /** Human-readable one-liner for the Check summary. */
  reason: string;
}

export function gateFindings(
  jobs: JobFindings[],
  failLevel: FindingsFailLevel,
): FindingsGateResult {
  if (failLevel === "off") {
    return { failed: false, offending: [], reason: "findings gate disabled" };
  }
  const threshold = failLevel as FindingSeverity;
  const offending = jobs
    .flatMap((j) => j.findings)
    .filter((f) => severityAtLeast(f.severity, threshold));

  if (offending.length === 0) {
    return {
      failed: false,
      offending: [],
      reason: `no findings at or above ${failLevel}`,
    };
  }
  const bySource = new Map<string, number>();
  for (const f of offending) bySource.set(f.source, (bySource.get(f.source) ?? 0) + 1);
  const breakdown = [...bySource.entries()].map(([s, n]) => `${n} from ${s}`).join(", ");
  return {
    failed: true,
    offending,
    reason: `${offending.length} finding(s) at or above ${failLevel} (${breakdown})`,
  };
}

/** Parse the `findings_fail_level` action input; unknown values disable the gate. */
export function parseFailLevel(raw: string | undefined): FindingsFailLevel {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "error" || v === "warning" || v === "info" ? v : "off";
}
