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

import { parseFixture } from "./fixture.js";
import { replayFixture, type ReplayResult } from "./replay.js";

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
