/**
 * Hermetic fixture replay (OGE-1589).
 *
 * Runs the real `runReview()` with every dependency served from a fixture — no
 * network, no checkout, no API key. The model is a stub that returns the
 * fixture's recorded response, so the whole pipeline is deterministic.
 *
 * **Gold mode** is SWE-bench's self-validation discipline: replay a known-good
 * fixture and demand the pipeline reproduce its archived verdict table exactly
 * before trusting any measurement of a candidate. If the harness can't
 * reproduce a verdict it already produced, no regression number it reports
 * means anything.
 */

import { runReview } from "../review.js";
import type { GithubReader, LinearClient, VerdictModel } from "../review.js";
import type { ReviewVerdict } from "../schema/verdict.js";
import { overallStatus } from "../schema/verdict.js";
import type { EvalFixture, ExpectedTable } from "./fixture.js";

/** The label table actually produced, in fixture-comparable shape. */
export function tableOf(verdict: ReviewVerdict): ExpectedTable {
  return {
    items: verdict.items.map((it) => ({ id: it.id, status: it.status })),
    overall: overallStatus(verdict),
  };
}

/** Deps that serve a single fixture. Pinned `now` keeps `generatedAt` stable. */
function depsFor(fixture: EvalFixture): {
  github: GithubReader;
  linear: LinearClient;
  model: VerdictModel;
} {
  return {
    github: {
      getPr: async () => ({ ...fixture.pr }),
      getDiff: async () => fixture.diff,
    },
    linear: { getIssue: async () => ({ ...fixture.ticket }) },
    model: { produce: async () => fixture.modelResponse },
  };
}

export interface ReplayResult {
  name: string;
  produced: ExpectedTable;
  expected: ExpectedTable;
  /** Per-item label mismatches, empty when the table reproduced exactly. */
  labelFlips: Array<{ id: number; expected: string; produced: string }>;
  overallFlip: boolean;
  /** True when produced === expected on every label and the overall. */
  matches: boolean;
}

export async function replayFixture(fixture: EvalFixture): Promise<ReplayResult> {
  const deps = depsFor(fixture);
  const result = await runReview({
    pr: { owner: fixture.pr.owner, repo: fixture.pr.repo, number: fixture.pr.number },
    github: deps.github,
    linear: deps.linear,
    model: deps.model,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const produced = tableOf(result.verdict);
  return compare(fixture.name, produced, fixture.expected);
}

/**
 * Replay a fixture's triage-ON arm (OGE-1606).
 *
 * Supplying `triageModel` is what turns the pre-pass on in `runReview` — there
 * is no boolean. Both stubs are served from the fixture's recorded `triageArm`,
 * so this stays as hermetic as the triage-off path.
 *
 * Returns the produced table only; this is a measurement path, not a gate. The
 * gold gate still runs on the triage-off arm alone, so a fixture cannot be made
 * to pass CI by recording a friendlier triage arm.
 */
export async function replayFixtureWithTriage(
  fixture: EvalFixture,
): Promise<ExpectedTable | null> {
  const arm = fixture.triageArm;
  if (!arm) return null;
  const deps = depsFor(fixture);
  const result = await runReview({
    pr: { owner: fixture.pr.owner, repo: fixture.pr.repo, number: fixture.pr.number },
    github: deps.github,
    linear: deps.linear,
    model: { produce: async () => arm.modelResponse },
    triageModel: { triage: async () => arm.triageResponse },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return tableOf(result.verdict);
}

export function compare(
  name: string,
  produced: ExpectedTable,
  expected: ExpectedTable,
): ReplayResult {
  const expectedById = new Map(expected.items.map((i) => [i.id, i.status]));
  const labelFlips: ReplayResult["labelFlips"] = [];
  for (const item of produced.items) {
    const want = expectedById.get(item.id);
    if (want !== undefined && want !== item.status) {
      labelFlips.push({ id: item.id, expected: want, produced: item.status });
    }
  }
  const overallFlip = produced.overall !== expected.overall;
  return {
    name,
    produced,
    expected,
    labelFlips,
    overallFlip,
    matches: labelFlips.length === 0 && !overallFlip,
  };
}
