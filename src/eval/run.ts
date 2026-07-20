/**
 * The eval runner + CI gate (OGE-1589).
 *
 * Replays every committed fixture through `runReview()` and fails if any
 * verdict-label table regressed. Exact label matching on the sidecar shape —
 * no LLM judge in the gate (see `judge.ts` for why the judge path is optional
 * and separate).
 *
 * Two failure classes gate the build, both structural:
 *   1. **label flips** — any fixture whose produced table diverges from its
 *      archived expected table (gold self-validation),
 *   2. **punt-rate regression** — the aggregate UNVERIFIABLE share rose above
 *      the committed baseline by more than a small tolerance. A prompt change
 *      that makes the reviewer punt more is a regression even if no single
 *      fixture flips a hard label.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFixture, type ExpectedTable } from "./fixture.js";
import { replayFixture, replayFixtureWithTriage, type ReplayResult } from "./replay.js";

/** Punt-rate allowed to rise by this much vs baseline before the gate fails. */
export const PUNT_RATE_TOLERANCE = 0.02;

export interface EvalReport {
  total: number;
  matched: number;
  regressions: ReplayResult[];
  puntRate: number;
  baselinePuntRate: number;
  puntRegressed: boolean;
  passed: boolean;
}

/** Load and parse every `*.json` fixture in a directory. */
export function loadFixtures(dir: string) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "baseline.json")
    .sort()
    .map((f) => parseFixture(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

function puntRateOf(results: ReplayResult[]): number {
  const items = results.flatMap((r) => r.produced.items);
  if (items.length === 0) return 0;
  return items.filter((i) => i.status === "UNVERIFIABLE").length / items.length;
}

export async function runEval(args: {
  dir: string;
  baselinePuntRate: number;
  tolerance?: number;
}): Promise<EvalReport> {
  const fixtures = loadFixtures(args.dir);
  const results: ReplayResult[] = [];
  for (const fx of fixtures) results.push(await replayFixture(fx));

  const regressions = results.filter((r) => !r.matches);
  const puntRate = puntRateOf(results);
  const tolerance = args.tolerance ?? PUNT_RATE_TOLERANCE;
  const puntRegressed = puntRate > args.baselinePuntRate + tolerance;

  return {
    total: results.length,
    matched: results.length - regressions.length,
    regressions,
    puntRate,
    baselinePuntRate: args.baselinePuntRate,
    puntRegressed,
    passed: regressions.length === 0 && !puntRegressed,
  };
}

/**
 * Punt rate over a set of already-produced label tables.
 *
 * Shared by both arms of the triage dimension so the two numbers cannot drift
 * apart by being computed differently — the whole comparison rests on them
 * meaning exactly the same thing.
 */
function puntRateOfTables(tables: ExpectedTable[]): number {
  const items = tables.flatMap((t) => t.items);
  if (items.length === 0) return 0;
  return items.filter((i) => i.status === "UNVERIFIABLE").length / items.length;
}

export interface TriageDimensionReport {
  /** Fixtures carrying a `triageArm`, i.e. the ones actually compared. */
  compared: string[];
  /** Fixtures with no `triageArm` — excluded, and named so the gap is visible. */
  skipped: string[];
  /** Punt rate on the triage-off arm, over `compared` only. `null` if none. */
  puntRateOff: number | null;
  /** Punt rate on the triage-on arm, over `compared` only. `null` if none. */
  puntRateOn: number | null;
  /** on − off. Negative means triage reduced punting. `null` if none compared. */
  delta: number | null;
}

/**
 * Does the cheap triage pre-pass change how often we punt? (OGE-1606)
 *
 * The gate gets no say here — this reports, it never fails the build. Enabling
 * triage by default is a judgement about cost and punt rate together, and the
 * point of this dimension is to put a measured number under that judgement
 * instead of a guess.
 *
 * Both rates are computed over the COMPARED fixtures only. Averaging the
 * triage-off arm over every fixture while the on arm covers three would
 * compare two different populations and read as a triage effect.
 */
export async function runTriageDimension(args: {
  dir: string;
}): Promise<TriageDimensionReport> {
  const fixtures = loadFixtures(args.dir);
  const compared: string[] = [];
  const skipped: string[] = [];
  const offTables: ExpectedTable[] = [];
  const onTables: ExpectedTable[] = [];

  for (const fx of fixtures) {
    const on = await replayFixtureWithTriage(fx);
    if (!on) {
      skipped.push(fx.name);
      continue;
    }
    const off = await replayFixture(fx);
    compared.push(fx.name);
    offTables.push(off.produced);
    onTables.push(on);
  }

  if (compared.length === 0) {
    return { compared, skipped, puntRateOff: null, puntRateOn: null, delta: null };
  }
  const puntRateOff = puntRateOfTables(offTables);
  const puntRateOn = puntRateOfTables(onTables);
  return { compared, skipped, puntRateOff, puntRateOn, delta: puntRateOn - puntRateOff };
}

/** Human-readable dimension summary. Reports coverage, never hides it. */
export function formatTriageDimension(report: TriageDimensionReport): string {
  if (report.compared.length === 0) {
    return [
      "Triage dimension: NO DATA",
      `  0 of ${report.skipped.length} fixtures carry a triageArm — nothing was compared.`,
      "  This is not evidence that triage has no effect. Record a triageArm on a",
      "  fixture before reading anything into the punt rate.",
    ].join("\n");
  }
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const delta = report.delta!;
  const direction = delta < 0 ? "reduced" : delta > 0 ? "raised" : "did not change";
  const lines = [
    `Triage dimension: ${report.compared.length} fixture(s) compared`,
    `  punt rate off: ${pct(report.puntRateOff!)}`,
    `  punt rate on:  ${pct(report.puntRateOn!)}`,
    `  triage ${direction} punting by ${pct(Math.abs(delta))}`,
  ];
  if (report.skipped.length > 0) {
    lines.push(
      `  NOT compared (no triageArm): ${report.skipped.join(", ")}`,
      `  Coverage is ${report.compared.length}/${report.compared.length + report.skipped.length} — weigh the delta accordingly.`,
    );
  }
  return lines.join("\n");
}

/** Human-readable gate summary for CI logs. */
export function formatReport(report: EvalReport): string {
  const lines = [
    `Eval: ${report.matched}/${report.total} fixtures reproduced their verdict table`,
    `Punt rate: ${(report.puntRate * 100).toFixed(1)}% (baseline ${(report.baselinePuntRate * 100).toFixed(1)}%, tolerance ±${(PUNT_RATE_TOLERANCE * 100).toFixed(0)}%)`,
  ];
  for (const r of report.regressions) {
    for (const f of r.labelFlips) {
      lines.push(`  ✗ ${r.name}: item ${f.id} ${f.expected} → ${f.produced}`);
    }
    if (r.overallFlip) {
      lines.push(`  ✗ ${r.name}: overall ${r.expected.overall} → ${r.produced.overall}`);
    }
  }
  if (report.puntRegressed) {
    lines.push(`  ✗ punt rate regressed beyond tolerance`);
  }
  lines.push(report.passed ? "PASS" : "FAIL");
  return lines.join("\n");
}
