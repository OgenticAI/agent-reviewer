/**
 * Rendering ingested findings as an "established facts" prompt section
 * (OGE-1588).
 *
 * These are facts the analyzer already computed deterministically, so the model
 * is told plainly not to re-litigate them. The section states two things per
 * job that the tool-loop log-tail path could never state cleanly:
 *   - the findings, mapped to files, and
 *   - the VERIFIED ABSENCE of findings ("eslint ran and reported nothing"),
 *     which is a positive fact the model must not mistake for "unknown".
 *
 * Every message is still sanitized and the whole block fenced (OGE-1579): an
 * analyzer message can echo attacker-controlled source text, so a finding is
 * untrusted content like any other tool output.
 */

import { fenceUntrusted, sanitizeUntrusted } from "../tools/sanitize.js";
import type { Finding, JobFindings } from "./schema.js";

function renderFinding(f: Finding): string {
  const loc = f.position ? `:${f.position.line}${f.position.column ? `:${f.position.column}` : ""}` : "";
  const code = f.code ? ` [${f.code}]` : "";
  return `- ${f.severity.toUpperCase()} ${f.path}${loc}${code} — ${f.message}`;
}

/**
 * Build the established-facts section, or null when there is nothing recognized.
 *
 * Returns null (rather than an empty section) when no job produced parseable
 * output — a repo whose CI emits nothing we recognize sees a byte-identical
 * prompt, so this is a pure no-op there.
 */
export function renderFindingsSection(jobs: JobFindings[]): string | null {
  const recognized = jobs.filter((j) => j.parsed);
  if (recognized.length === 0) return null;

  const lines: string[] = [
    `## Established facts from analyzers (do not re-derive)`,
    ``,
    `These come from analyzer output CI already produced. Treat them as settled:`,
    `do not re-investigate a fact stated here, and map each to the checklist`,
    `items it bears on. A job listed as "reported no findings" ran clean — that`,
    `is a positive result, not missing evidence.`,
    ``,
  ];

  for (const job of recognized) {
    if (job.findings.length === 0) {
      lines.push(`### ${job.job} — reported no findings`, ``);
      continue;
    }
    lines.push(`### ${job.job} — ${job.findings.length} finding(s)`, ``);
    for (const f of job.findings) lines.push(renderFinding(f));
    lines.push(``);
  }

  return fenceUntrusted(sanitizeUntrusted(lines.join("\n")), { source: "analyzer-findings" });
}
