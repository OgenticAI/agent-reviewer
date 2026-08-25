/**
 * Recall calibration for audit mode (OGE-2433).
 *
 * The number the commercial argument rests on, and the one nobody publishes.
 *
 * Precision on curated corpora is solved and therefore worthless as a claim:
 * Corgea benchmarked twelve models on 1,913 ground-truth vulnerabilities and all
 * twelve landed between 94.8% and 96.8%. In the same benchmark recall tops out
 * at 40%. The industry markets precision because precision is the number it can
 * win on. This measures the other one.
 *
 * ── The label is asserted, never judged ─────────────────────────────────────
 *
 * `inject.ts` mints ground truth by deterministically corrupting a clean
 * fixture, and its design note is the reason it counts: no model sits in the
 * labelling path. This extends that from diff-scoped defects to repo-scoped
 * ones — write known defects into a fixture tree, run the audit, count how many
 * come back — and keeps the same rule. Every defect below is a literal string
 * replacement with a recorded line. Nothing about the label is inferred.
 *
 * ── Why this can only work on a shared engine ───────────────────────────────
 *
 * The audit runs on the same engine as the pull-request reviewer, so every PR
 * merged generates calibration data about the thing being sold. A standalone
 * audit tool would be a system we assert quality about and never measure —
 * which is the exact failure this product is sold against.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { AuditFinding } from "../engine/audit/finding.js";

export type DefectClass = "logic" | "config" | "missing-authorisation";

export interface AuditDefect {
  id: string;
  class: DefectClass;
  /** Repo-relative file to corrupt. */
  path: string;
  /** Exact text to find. A defect that does not apply is a defect we do not count. */
  find: string;
  /** What to put there instead. */
  replace: string;
  /** What a review ought to say about it, for the operator reading the report. */
  expect: string;
}

/**
 * Injected defects, as literal replacements.
 *
 * Deliberately not generated. A generated corruption would need something to
 * decide what counts as broken, and the moment that something is a model the
 * ground truth stops being ground truth.
 */
export const DEFECT_CATALOGUE: readonly AuditDefect[] = [
  {
    id: "logic-inverted-guard",
    class: "logic",
    path: "src/engine/audit/read-tool.ts",
    find: 'if (real !== realRoot && !real.startsWith(realRoot + sep)) {',
    replace: 'if (real !== realRoot && real.startsWith(realRoot + sep)) {',
    expect: "The containment check is inverted — it refuses paths inside the tree and admits paths outside it.",
  },
  {
    id: "logic-off-by-one-cap",
    class: "logic",
    path: "src/engine/audit/telemetry.ts",
    find: "if (masked.length <= MAX_LOG_CHARS) return masked;",
    replace: "if (masked.length <= MAX_LOG_CHARS * 100) return masked;",
    expect: "The log cap is a hundred times its stated value, so file contents fit in a log line.",
  },
  {
    id: "config-mask-disabled",
    class: "config",
    path: "src/engine/audit/telemetry.ts",
    find: "export const MAX_LOG_CHARS = 500;",
    replace: "export const MAX_LOG_CHARS = 5_000_000;",
    expect: "The cap that makes logs not-a-transcript is effectively removed.",
  },
  {
    id: "config-verifier-floor-lowered",
    class: "config",
    path: "src/engine/audit/verify.ts",
    find: "export const MIN_VERIFIERS = 2;",
    replace: "export const MIN_VERIFIERS = 1;",
    expect: "A single verifier can now mark a claim verified, so nothing is adversarially checked.",
  },
  {
    id: "authz-render-gate-removed",
    class: "missing-authorisation",
    path: "src/engine/audit/render.ts",
    find: "    if (released) throw new RenderRefused(mask.detail);",
    replace: "    if (false) throw new RenderRefused(mask.detail);",
    expect: "A released report is no longer refused when masking altered it, so a secret can ship.",
  },
  {
    id: "authz-coverage-gate-removed",
    class: "missing-authorisation",
    path: "src/engine/audit/render.ts",
    find: "  if (unreal) throw new RenderRefused(unreal);",
    replace: "  if (false) throw new RenderRefused(unreal);",
    expect: "A report claiming 0% coverage is no longer refused.",
  },
];

export interface InjectedDefect extends AuditDefect {
  /** 1-based line where the replacement landed. The match window centres here. */
  line: number;
}

export interface InjectionResult {
  injected: InjectedDefect[];
  /**
   * Defects whose `find` text was not present.
   *
   * Reported, never skipped silently. A defect that did not apply is one we
   * cannot expect the audit to find, and counting it against recall would
   * understate the engine; counting it as found would flatter it. Neither — it
   * leaves the denominator.
   */
  notApplied: Array<{ id: string; reason: string }>;
}

/**
 * Corrupt a tree in place.
 *
 * The caller is expected to hand over a throwaway copy. This does not take one
 * itself: a function that silently copies a tree is a function that eventually
 * copies the wrong one.
 */
export function injectIntoTree(tree: string, defects: readonly AuditDefect[] = DEFECT_CATALOGUE): InjectionResult {
  const injected: InjectedDefect[] = [];
  const notApplied: InjectionResult["notApplied"] = [];

  for (const defect of defects) {
    const full = join(tree, defect.path);
    if (!existsSync(full)) {
      notApplied.push({ id: defect.id, reason: `${defect.path} is not in this tree` });
      continue;
    }

    const source = readFileSync(full, "utf8");
    const at = source.indexOf(defect.find);
    if (at === -1) {
      notApplied.push({ id: defect.id, reason: `the text to corrupt is no longer in ${defect.path}` });
      continue;
    }
    // A second occurrence means the anchor is ambiguous and the recorded line
    // would be a guess. Ambiguous ground truth is not ground truth.
    if (source.indexOf(defect.find, at + 1) !== -1) {
      notApplied.push({ id: defect.id, reason: `the anchor appears more than once in ${defect.path}` });
      continue;
    }

    const line = source.slice(0, at).split("\n").length;
    writeFileSync(full, source.slice(0, at) + defect.replace + source.slice(at + defect.find.length));
    injected.push({ ...defect, line });
  }

  return { injected, notApplied };
}

/* ── Matching, structurally ───────────────────────────────────────────────── */

/**
 * How far from the corrupted line a finding may cite and still count.
 *
 * A review that spots an inverted guard often cites the function around it
 * rather than the exact line, so an exact-line rule would score real catches as
 * misses. Ten lines is close enough that the finding is plainly about the same
 * code, and tight enough that an unrelated finding in the same file does not
 * qualify.
 */
export const MATCH_WINDOW_LINES = 10;

export type MatchKind = "found" | "same-file-only" | "missed";

export interface DefectMatch {
  defect: InjectedDefect;
  kind: MatchKind;
  /** The finding that matched, when one did. */
  findingId?: string;
  confidence?: string;
  severity?: string;
}

/**
 * Did the audit find each injected defect?
 *
 * Three outcomes, not two. `same-file-only` is a finding that cites the right
 * file at the wrong place — it might be about the defect described vaguely, or
 * about something else entirely in the same file, and from the data alone those
 * are not separable. Counting it as found would inflate recall by exactly the
 * amount we are least entitled to; counting it as missed would understate. So
 * it is its own number, and the headline is computed without it.
 */
export function matchDefects(
  injected: readonly InjectedDefect[],
  findings: readonly AuditFinding[],
): DefectMatch[] {
  return injected.map((defect) => {
    let sameFile: AuditFinding | null = null;

    for (const finding of findings) {
      for (const ref of finding.evidence) {
        if (!pathsMatch(ref.path, defect.path)) continue;

        if (ref.line !== undefined && Math.abs(ref.line - defect.line) <= MATCH_WINDOW_LINES) {
          return {
            defect,
            kind: "found",
            findingId: finding.id,
            confidence: finding.confidence,
            severity: finding.severity,
          };
        }
        sameFile ??= finding;
      }
    }

    if (sameFile) {
      return {
        defect,
        kind: "same-file-only",
        findingId: sameFile.id,
        confidence: sameFile.confidence,
        severity: sameFile.severity,
      };
    }
    return { defect, kind: "missed" };
  });
}

/** Loose in the same way `outcomes.ts` is: either path may be the longer form. */
function pathsMatch(a: string, b: string): boolean {
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/* ── The number ───────────────────────────────────────────────────────────── */

export interface RecallReport {
  injected: number;
  found: number;
  /** found / injected. The headline, and the one that may be bad. */
  recall: number;
  sameFileOnly: number;
  /** An upper bound: recall if every same-file match were really a catch. */
  recallUpperBound: number;
  byClass: Record<string, { injected: number; found: number; recall: number }>;
  /** Of the defects found, what confidence did the engine end up asserting? */
  byConfidence: Record<string, number>;
  notApplied: number;
}

export function recallReport(matches: DefectMatch[], notApplied = 0): RecallReport {
  const injected = matches.length;
  const found = matches.filter((m) => m.kind === "found").length;
  const sameFileOnly = matches.filter((m) => m.kind === "same-file-only").length;

  const byClass: RecallReport["byClass"] = {};
  for (const match of matches) {
    const bucket = (byClass[match.defect.class] ??= { injected: 0, found: 0, recall: 0 });
    bucket.injected += 1;
    if (match.kind === "found") bucket.found += 1;
  }
  for (const bucket of Object.values(byClass)) {
    bucket.recall = bucket.injected === 0 ? 0 : bucket.found / bucket.injected;
  }

  const byConfidence: Record<string, number> = {};
  for (const match of matches.filter((m) => m.kind === "found")) {
    const key = match.confidence ?? "unknown";
    byConfidence[key] = (byConfidence[key] ?? 0) + 1;
  }

  return {
    injected,
    found,
    recall: injected === 0 ? 0 : found / injected,
    sameFileOnly,
    recallUpperBound: injected === 0 ? 0 : (found + sameFileOnly) / injected,
    byClass,
    byConfidence,
    notApplied,
  };
}

/* ── Persistence, so drift is visible ─────────────────────────────────────── */

export interface RecallRun extends RecallReport {
  at: string;
  /** The revision the fixture tree was at before corruption. */
  subjectRev: string | null;
}

export const RECALL_LOG = "recall.jsonl";

/**
 * Append one run.
 *
 * Append-only, one JSON object per line. A single "current recall" figure that
 * gets overwritten hides the thing worth watching, which is whether the number
 * moves when the engine changes.
 */
export function appendRecallRun(dir: string, run: RecallRun): void {
  appendFileSync(join(dir, RECALL_LOG), `${JSON.stringify(run)}\n`);
}

export function readRecallRuns(dir: string): RecallRun[] {
  const path = join(dir, RECALL_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RecallRun];
      } catch {
        return [];
      }
    });
}

/**
 * The paragraph a report template cites.
 *
 * Published beside coverage and saying plainly that the two are different
 * numbers — file coverage is the share of files opened, and recall is the share
 * of known defects found. Conflating them is the single most flattering mistake
 * available in this document.
 */
export function renderRecall(report: RecallReport): string[] {
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  const lines = [
    `Measured recall: ${report.found} of ${report.injected} known defects found (${pct(report.recall)}).`,
    "",
    "This is defect recall, not file coverage. File coverage is the share of files this",
    "review opened; recall is the share of deliberately planted defects it reported. A",
    "high coverage figure alongside a low recall figure is not a contradiction — it is",
    "the normal shape of the problem, and the reason both are printed.",
    "",
  ];

  const classes = Object.entries(report.byClass).sort(([a], [b]) => a.localeCompare(b));
  if (classes.length > 0) {
    lines.push("By defect class:", "");
    for (const [name, bucket] of classes) {
      lines.push(`  ${name}: ${bucket.found}/${bucket.injected} (${pct(bucket.recall)})`);
    }
    lines.push("");
  }

  const confidences = Object.entries(report.byConfidence).sort(([a], [b]) => a.localeCompare(b));
  if (confidences.length > 0) {
    lines.push("Of those found, the confidence the engine settled on:", "");
    for (const [name, count] of confidences) lines.push(`  ${name}: ${count}`);
    lines.push("");
  }

  if (report.sameFileOnly > 0) {
    lines.push(
      `${report.sameFileOnly} further defect(s) had a finding citing the right file at the wrong`,
      `place. Those are NOT counted as found: from the data alone a vague hit and an`,
      `unrelated finding in the same file are not separable. If every one were a real`,
      `catch, recall would be ${pct(report.recallUpperBound)} — an upper bound, not a result.`,
      "",
    );
  }

  if (report.notApplied > 0) {
    lines.push(
      `${report.notApplied} defect(s) in the catalogue could not be planted in this tree.`,
      `Those left the denominator entirely rather than counting either way — recall above`,
      `is over what was actually planted.`,
      "",
    );
  }

  return lines;
}
