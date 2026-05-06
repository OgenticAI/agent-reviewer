/**
 * End-to-end test of the review pipeline with mocked dependencies.
 *
 * This is the integration test that proves OGE-338's "byte-identical comment
 * across runs on the same SHA" guarantee end-to-end, not just at the renderer.
 * The model is pinned to a deterministic stub; real Octokit / Anthropic /
 * Linear clients aren't touched.
 *
 * If you change `runReview()`'s contract (added side effects, changed the
 * order of dependency calls), these tests will catch it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runReview, ReviewSkippedError } from "../../src/review.js";
import type {
  GithubReader,
  LinearClient,
  RunReviewArgs,
  VerdictModel,
} from "../../src/review.js";
import type { LinearTicketContext, PrContext } from "../../src/schema/event.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const PR1_BODY = readFileSync(join(FIXTURES, "pr-1.md"), "utf8");

const FROZEN_TIME = "2026-04-27T08:30:00.000Z";

// ─── Builders ────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<PrContext> = {}): PrContext {
  return {
    owner: "OgenticAI",
    repo: "ogentic-shield",
    number: 1,
    headSha: "f6299112233aabbccdd",
    headRef: "david/oge-308-309-redaction-api",
    title: "feat(redaction): add Shield.redact() / Shield.unredact() (OGE-308, OGE-309)",
    body: PR1_BODY,
    author: "davidoladeji-ogenticai",
    createdAt: "2026-04-27T08:00:00.000Z",
    ...overrides,
  };
}

function makeTicket(overrides: Partial<LinearTicketContext> = {}): LinearTicketContext {
  return {
    identifier: "OGE-308",
    id: "abc-123",
    title: "Redaction wrapper: redact() + unredact() API",
    description: "Add category-aware redaction…",
    status: "In Review",
    url: "https://linear.app/ogenticai/issue/OGE-308",
    ...overrides,
  };
}

function makeGithub(pr: PrContext, diff: string): GithubReader {
  return {
    getPr: async () => pr,
    getDiff: async () => diff,
  };
}

function makeLinear(ticket: LinearTicketContext): LinearClient {
  return { getIssue: async () => ticket };
}

function makeModel(json: string): VerdictModel {
  return { produce: async () => json };
}

const SAMPLE_VERDICT_JSON = JSON.stringify({
  items: [
    {
      id: 1,
      itemText:
        '`from ogentic_shield import Shield; s = Shield(profiles=["shield-finance"]); s.redact("...")` works',
      status: "PASS",
      rationale:
        "Public API exposes Shield.redact() with the documented signature; verified by tests/test_redaction.py::test_finance_round_trip_preserves_dollar_amounts.",
      evidenceRefs: [
        { kind: "file", path: "src/ogentic_shield/redaction.py" },
        {
          kind: "test",
          path: "tests/test_redaction.py",
          name: "TestRoundTripPerProfile::test_finance_round_trip_preserves_dollar_amounts",
        },
      ],
    },
    {
      id: 2,
      itemText: "Numbers/dollar amounts visibly preserved in the redacted output for finance",
      status: "PASS",
      rationale:
        "DEFAULT_REDACT_CATEGORIES excludes amounts; test_finance_default_does_not_redact_dollar_amounts asserts $5M remains in the output.",
      evidenceRefs: [
        {
          kind: "test",
          path: "tests/test_redaction.py",
          name: "TestDetectionVsRedaction::test_finance_default_does_not_redact_dollar_amounts",
        },
      ],
    },
    {
      id: 3,
      itemText: "`Shield.unredact(response, mapping)` exactly reverses round-trip",
      status: "PASS",
      rationale:
        "Round-trip tests across all three profiles (finance/legal/therapy) assert restored == original; mapping is sufficient.",
      evidenceRefs: [{ kind: "file", path: "tests/test_redaction.py" }],
    },
    {
      id: 4,
      itemText: 'README "Redaction" section renders cleanly on GitHub',
      status: "UNVERIFIABLE",
      rationale:
        "Visual claim — cannot confirm rendered appearance from the diff alone. Requires a human to view the README on github.com.",
      evidenceRefs: [],
    },
  ],
  summary:
    "Redaction core delivered with strong test coverage; README rendering needs human eyes.",
});

const FROZEN_NOW = () => FROZEN_TIME;

const SHARED_DIFF = "diff --git a/src/foo b/src/foo\n+ added line\n";

function buildArgs(overrides: Partial<RunReviewArgs> = {}): RunReviewArgs {
  return {
    pr: { owner: "OgenticAI", repo: "ogentic-shield", number: 1 },
    github: makeGithub(makePr(), SHARED_DIFF),
    linear: makeLinear(makeTicket()),
    model: makeModel(SAMPLE_VERDICT_JSON),
    now: FROZEN_NOW,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runReview (end-to-end)", () => {
  it("produces a verdict that round-trips through the renderer", async () => {
    const result = await runReview(buildArgs());
    expect(result.verdict.items).toHaveLength(4);
    expect(result.verdict.ticketId).toBe("OGE-308");
    expect(result.verdict.prRef).toBe("OgenticAI/ogentic-shield#1");
    expect(result.verdict.headSha).toBe("f6299112233aabbccdd");
    expect(result.verdict.reviewerVersion).toBe("v1");
    expect(result.body.startsWith("<!-- ogenticai-reviewer-v1 -->")).toBe(true);
  });

  it("derives the right OverallStatus from the items", async () => {
    const result = await runReview(buildArgs());
    // 3 PASS + 1 UNVERIFIABLE → HUMAN_REVIEW
    expect(result.overall).toBe("HUMAN_REVIEW");
  });

  it("renders byte-identical comments across runs on the same SHA (idempotency)", async () => {
    // Same inputs, two runs — even with a different `now` (since generatedAt
    // is excluded from the rendered body, it must not perturb output).
    const a = await runReview(buildArgs({ now: () => "2026-04-27T08:30:00.000Z" }));
    const b = await runReview(buildArgs({ now: () => "2099-12-31T23:59:59.000Z" }));
    expect(a.body).toBe(b.body);
  });

  it("strips fenced JSON when the model returns ```json … ``` wrappers", async () => {
    const wrapped = "```json\n" + SAMPLE_VERDICT_JSON + "\n```";
    const result = await runReview(buildArgs({ model: makeModel(wrapped) }));
    expect(result.verdict.items).toHaveLength(4);
  });

  it("throws ReviewSkippedError when the PR has no Linear ticket id", async () => {
    const args = buildArgs({
      github: makeGithub(makePr({ headRef: "main", body: "no ticket here", title: "x" }), ""),
    });
    await expect(runReview(args)).rejects.toBeInstanceOf(ReviewSkippedError);
  });

  it("throws ReviewSkippedError when the PR has no UAT checklist", async () => {
    const args = buildArgs({
      github: makeGithub(
        makePr({ body: "## Summary\nSome work, no UAT block." }),
        "",
      ),
    });
    await expect(runReview(args)).rejects.toBeInstanceOf(ReviewSkippedError);
  });

  it("rejects malformed model output with a useful error", async () => {
    const args = buildArgs({ model: makeModel("not json at all") });
    await expect(runReview(args)).rejects.toThrow(/non-JSON/i);
  });

  it("validates verdicts against the zod schema (rejects bad statuses)", async () => {
    const bogus = JSON.stringify({
      items: [
        { id: 1, itemText: "x", status: "MAYBE", rationale: "y", evidenceRefs: [] },
      ],
      summary: "x",
    });
    await expect(runReview(buildArgs({ model: makeModel(bogus) }))).rejects.toThrow();
  });

  it("calls each dependency exactly once (no chatty re-fetches)", async () => {
    let getPrCalls = 0;
    let getDiffCalls = 0;
    let getIssueCalls = 0;
    let modelCalls = 0;

    await runReview(
      buildArgs({
        github: {
          getPr: async () => {
            getPrCalls += 1;
            return makePr();
          },
          getDiff: async () => {
            getDiffCalls += 1;
            return SHARED_DIFF;
          },
        },
        linear: {
          getIssue: async () => {
            getIssueCalls += 1;
            return makeTicket();
          },
        },
        model: {
          produce: async () => {
            modelCalls += 1;
            return SAMPLE_VERDICT_JSON;
          },
        },
      }),
    );

    expect(getPrCalls).toBe(1);
    expect(getDiffCalls).toBe(1);
    expect(getIssueCalls).toBe(1);
    expect(modelCalls).toBe(1);
  });

  it("uses the FIRST resolved ticket as the primary (branch beats body)", async () => {
    // PR #1 body mentions both OGE-308 and OGE-309. Branch-name precedence
    // means OGE-308 wins.
    const result = await runReview(buildArgs());
    expect(result.verdict.ticketId).toBe("OGE-308");
  });

  it("preserves the per-item order from the parser into the verdict", async () => {
    const result = await runReview(buildArgs());
    expect(result.verdict.items.map((it) => it.id)).toEqual([1, 2, 3, 4]);
  });

  it("includes the JSON sidecar in the rendered body but NOT generatedAt", async () => {
    const result = await runReview(buildArgs());
    expect(result.body).toContain("Reviewer payload (JSON)");
    expect(result.body).not.toContain("generatedAt");
    // The verdict object itself still carries the timestamp for downstream
    // consumers (Linear writeback in OGE-339, Check output in OGE-340).
    expect(result.verdict.generatedAt).toBe(FROZEN_TIME);
  });
});
