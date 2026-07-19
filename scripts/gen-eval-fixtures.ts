#!/usr/bin/env node
/**
 * Fixture generator for the offline eval harness (OGE-1589).
 *
 * Writes the committed `eval/fixtures/*.json`. The gold discipline
 * (SWE-bench): `expected` is not hand-authored — it is whatever the real
 * pipeline actually produces on the fixture's recorded input. That way a
 * fixture can never claim an expected table the pipeline was never going to
 * emit, and gold mode is meaningful.
 *
 * Regenerate with:  npx tsx scripts/gen-eval-fixtures.ts
 *
 * The fixtures cover every verdict class as a known-good control, then defect
 * injection mints a labeled FAIL per class. Fixtures stay in-repo but are
 * synthetic — no real customer diffs — so there is no contamination risk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { replayFixture, tableOf } from "../src/eval/replay.js";
import { runReview } from "../src/review.js";
import { injectDefect } from "../src/eval/inject.js";
import type { EvalFixture } from "../src/eval/fixture.js";

const OUT_DIR = join(import.meta.dirname, "..", "eval", "fixtures");

interface Spec {
  name: string;
  description: string;
  ticket: string;
  items: Array<{ text: string; status: string; rationale: string }>;
  /** Item id to inject a FAIL against, if this spec should spawn an injected sibling. */
  injectTarget?: number;
}

const SPECS: Spec[] = [
  {
    name: "pass-clean-redaction",
    description: "All items delivered — a clean PASS control.",
    ticket: "OGE-1001",
    items: [
      { text: "redact() masks SSNs", status: "PASS", rationale: "src/redact.ts masks SSN via the finance profile." },
      { text: "unredact() reverses the round-trip", status: "PASS", rationale: "Round-trip test asserts restored == original." },
    ],
    injectTarget: 1,
  },
  {
    name: "code-verified-endpoint",
    description: "Code plainly delivers but runtime proof is missing — CODE_VERIFIED.",
    ticket: "OGE-1002",
    items: [
      { text: "POST /webhooks validates the signature", status: "CODE_VERIFIED", rationale: "Signature check present; end-to-end needs a running server." },
      { text: "handler returns 401 on bad signature", status: "PASS", rationale: "Explicit 401 branch with a unit test." },
    ],
    injectTarget: 1,
  },
  {
    name: "partial-migration",
    description: "One item partially done — PASS_WITH_PARTIALS.",
    ticket: "OGE-1003",
    items: [
      { text: "migration adds the column", status: "PASS", rationale: "ALTER TABLE present in db/migrations." },
      { text: "backfill covers existing rows", status: "PARTIAL", rationale: "Backfill covers new rows only; historical rows unhandled." },
    ],
    injectTarget: 2,
  },
  {
    name: "unverifiable-visual",
    description: "A genuinely visual claim — HUMAN_REVIEW.",
    ticket: "OGE-1004",
    items: [
      { text: "README renders cleanly on GitHub", status: "UNVERIFIABLE", rationale: "Visual claim; cannot confirm rendered appearance from the diff." },
      { text: "README documents the flag", status: "PASS", rationale: "The flag is documented in the added section." },
    ],
    injectTarget: 2,
  },
  {
    name: "pass-config-loader",
    description: "Config loader delivered — PASS control.",
    ticket: "OGE-1005",
    items: [
      { text: "config loads from the default branch", status: "PASS", rationale: "loadRepoConfig reads at the default-branch ref." },
      { text: "malformed config degrades to empty", status: "PASS", rationale: "parseReviewerConfig returns EMPTY_CONFIG on error." },
    ],
  },
  {
    name: "pass-metrics-block",
    description: "Metrics rendering delivered — PASS control.",
    ticket: "OGE-1006",
    items: [
      { text: "metrics block round-trips", status: "PASS", rationale: "parseMetricsBlock(render(m)) === m in tests." },
      { text: "punt rate excludes [human] items", status: "PASS", rationale: "verifiableItems excludes humanMarked." },
    ],
  },
];

function bodyFor(spec: Spec): string {
  const lines = ["## Summary", "", `Implements ${spec.ticket}.`, "", "## UAT checklist", ""];
  for (const it of spec.items) lines.push(`- [ ] ${it.text}`);
  return lines.join("\n");
}

function modelResponseFor(spec: Spec): string {
  return JSON.stringify({
    items: spec.items.map((it, i) => ({
      id: i + 1,
      itemText: it.text,
      status: it.status,
      rationale: it.rationale,
      evidenceRefs: [],
    })),
    summary: spec.description,
  });
}

function baseFixture(spec: Spec): EvalFixture {
  const shaStub = `sha${spec.ticket.replace(/\D/g, "")}`;
  return {
    name: spec.name,
    description: spec.description,
    origin: "snapshot",
    pr: {
      owner: "OgenticAI",
      repo: "agent-reviewer",
      number: 1000 + SPECS.indexOf(spec),
      headSha: shaStub,
      headRef: `david/${spec.ticket.toLowerCase()}-${spec.name}`,
      title: `feat(${spec.ticket}): ${spec.description}`,
      body: bodyFor(spec),
      author: "davidoladeji-ogenticai",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ticket: {
      identifier: spec.ticket,
      id: `uuid-${spec.ticket}`,
      title: spec.description,
      description: `Ticket ${spec.ticket}: ${spec.description}`,
      status: "In Review",
      url: `https://linear.app/ogenticai/issue/${spec.ticket}`,
    },
    diff: `diff --git a/src/${spec.name}.ts b/src/${spec.name}.ts\n@@ -1,1 +1,2 @@\n+// change for ${spec.ticket}\n`,
    modelResponse: modelResponseFor(spec),
    // Placeholder — overwritten below with the pipeline's actual output.
    expected: { items: [], overall: "PASS" },
  };
}

/** Set `expected` to what the pipeline actually produces (gold discipline). */
async function withGoldExpected(fx: EvalFixture): Promise<EvalFixture> {
  const result = await runReview({
    pr: { owner: fx.pr.owner, repo: fx.pr.repo, number: fx.pr.number },
    github: { getPr: async () => ({ ...fx.pr }), getDiff: async () => fx.diff },
    linear: { getIssue: async () => ({ ...fx.ticket }) },
    model: { produce: async () => fx.modelResponse },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { ...fx, expected: tableOf(result.verdict) };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const all: EvalFixture[] = [];

  for (const spec of SPECS) {
    const base = await withGoldExpected(baseFixture(spec));
    all.push(base);
    if (spec.injectTarget !== undefined) {
      const injected = await withGoldExpected(injectDefect({ base, targetItemId: spec.injectTarget }));
      all.push(injected);
    }
  }

  for (const fx of all) {
    // Self-check: every fixture must reproduce its own expected table.
    const replay = await replayFixture(fx);
    if (!replay.matches) {
      throw new Error(`fixture ${fx.name} does not reproduce its expected table — generation bug`);
    }
    writeFileSync(join(OUT_DIR, `${fx.name}.json`), JSON.stringify(fx, null, 2) + "\n", "utf8");
  }

  // Baseline punt rate over the whole set, for the CI gate.
  const items = all.flatMap((f) => f.expected.items);
  const puntRate = items.filter((i) => i.status === "UNVERIFIABLE").length / items.length;
  writeFileSync(
    join(OUT_DIR, "baseline.json"),
    JSON.stringify({ puntRate, fixtures: all.length, generatedFrom: "scripts/gen-eval-fixtures.ts" }, null, 2) + "\n",
    "utf8",
  );

  console.error(`Wrote ${all.length} fixtures + baseline (punt rate ${(puntRate * 100).toFixed(1)}%) to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
