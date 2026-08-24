/**
 * The coverage denominator (OGE-2426).
 *
 * We searched specifically for a published figure on what proportion of a
 * codebase a professional human review covers, and found none — from any
 * vendor, academic, journalistic or government source. Auditors state scope as
 * a *list of components looked at*, never as a percentage, and their reports
 * carry an explicit completeness disclaimer. Trail of Bits, in a delivered
 * client report: "the findings documented in this report should not be
 * considered a comprehensive list of security issues, flaws, or defects."
 *
 * The absence is the finding. We can state a ratio because we have the
 * denominator: every file in the tree, enumerated before the run starts.
 *
 * ── The thing this must never be read as ────────────────────────────────────
 *
 * File coverage is NOT defect coverage. Knowing we opened 71% of the files says
 * nothing about what fraction of the defects we found — the industry number for
 * that tops out near 40%. `COVERAGE_CAVEAT` travels with the figure so a
 * renderer cannot print one without the other.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SKIP_DIRS, walkTree, type TreeFile } from "./tree.js";

/**
 * Printed wherever a coverage figure is. Not decoration — the single most
 * likely way this work gets misread is someone quoting the ratio as though it
 * were the share of defects found.
 */
export const COVERAGE_CAVEAT =
  "This is file coverage: the share of files the run opened. It is not defect " +
  "coverage, and says nothing about what fraction of the defects in this codebase " +
  "were found.";

export interface Inventory {
  files: TreeFile[];
  /**
   * Directory names excluded from the walk, recorded rather than dropped.
   *
   * A denominator that silently omits things is not a denominator. Naming the
   * exclusions is what lets a reader judge whether the ratio means anything —
   * counting `node_modules` would put coverage in the single digits.
   */
  excluded: string[];
  builtAt: string;
}

export function buildInventory(root: string): Inventory {
  return {
    files: walkTree(root),
    excluded: [...SKIP_DIRS].sort(),
    builtAt: new Date().toISOString(),
  };
}

export function writeInventory(outDir: string, inventory: Inventory): string {
  const path = join(outDir, "inventory.json");
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`);
  return path;
}

/** The top-level directory a path sits under; `(root)` for a file at the top. */
export function topLevelArea(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

export interface CoverageSlice {
  opened: number;
  total: number;
  /** `opened / total`, rounded to two places. 0 when there is nothing to cover. */
  share: number;
}

export interface Coverage extends CoverageSlice {
  byLanguage: Record<string, CoverageSlice>;
  byArea: Record<string, CoverageSlice>;
  /** Paths the run tried to open and could not. Counted as not covered. */
  unreadable: string[];
  caveat: string;
}

function slice(opened: number, total: number): CoverageSlice {
  return { opened, total, share: total === 0 ? 0 : Math.round((opened / total) * 100) / 100 };
}

function tally(
  files: TreeFile[],
  openedPaths: ReadonlySet<string>,
  keyOf: (file: TreeFile) => string,
): Record<string, CoverageSlice> {
  const totals = new Map<string, { opened: number; total: number }>();

  for (const file of files) {
    const key = keyOf(file);
    const entry = totals.get(key) ?? { opened: 0, total: 0 };
    entry.total += 1;
    if (openedPaths.has(file.path)) entry.opened += 1;
    totals.set(key, entry);
  }

  const out: Record<string, CoverageSlice> = {};
  for (const [key, { opened, total }] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
    out[key] = slice(opened, total);
  }
  return out;
}

/**
 * Coverage, computed from the inventory and the access log.
 *
 * A file the run *tried* to open and could not is deliberately NOT counted as
 * covered. It is listed under `unreadable` instead — "we could not read this"
 * and "we read this" must never collapse into the same number, for the same
 * reason `parsed: false` exists on the analyzer side.
 */
export function computeCoverage(inventory: Inventory, log: FileAccessLog): Coverage {
  const openedPaths = log.opened();
  const openedInTree = inventory.files.filter((file) => openedPaths.has(file.path)).length;

  return {
    ...slice(openedInTree, inventory.files.length),
    byLanguage: tally(inventory.files, openedPaths, (file) => file.language),
    byArea: tally(inventory.files, openedPaths, (file) => topLevelArea(file.path)),
    unreadable: log.failed(),
    caveat: COVERAGE_CAVEAT,
  };
}

/* ── The access log ───────────────────────────────────────────────────────── */

export type AccessOutcome = "read" | "denied" | "missing" | "too-large" | "escaped";

export interface AccessRecord {
  path: string;
  outcome: AccessOutcome;
  at: string;
}

/**
 * Every attempt to open a file, successful or not.
 *
 * Recording the failures is the point. A run that asked for forty files and was
 * refused thirty of them has not covered forty, and the difference between "we
 * looked and found nothing" and "we could not look" is the difference between a
 * finding and a gap.
 */
export class FileAccessLog {
  private readonly records: AccessRecord[] = [];

  record(path: string, outcome: AccessOutcome): void {
    this.records.push({ path, outcome, at: new Date().toISOString() });
  }

  /** Distinct paths successfully read. */
  opened(): Set<string> {
    return new Set(this.records.filter((r) => r.outcome === "read").map((r) => r.path));
  }

  /** Distinct paths an attempt was made on but which could not be read. */
  failed(): string[] {
    const read = this.opened();
    const bad = this.records.filter((r) => r.outcome !== "read" && !read.has(r.path));
    return [...new Set(bad.map((r) => r.path))].sort();
  }

  all(): readonly AccessRecord[] {
    return this.records;
  }

  /**
   * Re-open a log a previous stage wrote.
   *
   * Coverage is computed from this file, so a later stage that cannot find it
   * has no honest coverage number to print — see the gate in `render.ts`.
   */
  static load(outDir: string): FileAccessLog {
    const log = new FileAccessLog();
    const records = JSON.parse(readFileSync(join(outDir, "access-log.json"), "utf8")) as AccessRecord[];
    log.records.push(...records);
    return log;
  }

  writeTo(outDir: string): string {
    const path = join(outDir, "access-log.json");
    writeFileSync(path, `${JSON.stringify(this.records, null, 2)}\n`);
    return path;
  }
}
