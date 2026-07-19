#!/usr/bin/env node
/**
 * Eval gate entrypoint (OGE-1589).
 *
 * Replays the committed fixtures and exits non-zero on any verdict-label
 * regression or a punt-rate regression beyond tolerance. Run by `eval.yml` on
 * changes to `src/prompt/**` or `src/version.ts`. No network, no API key.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runEval, formatReport } from "../src/eval/run.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "eval", "fixtures");

async function main(): Promise<void> {
  const baseline = JSON.parse(readFileSync(join(FIXTURE_DIR, "baseline.json"), "utf8")) as {
    puntRate: number;
  };
  const report = await runEval({ dir: FIXTURE_DIR, baselinePuntRate: baseline.puntRate });
  console.error(formatReport(report));
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
