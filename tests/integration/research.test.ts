/**
 * Research end-to-end through `runReview` (OGE-1566).
 *
 * The unit tests cover gating, trace parsing, and caching in isolation. These
 * cover the wiring that can only go wrong once the pieces are connected: what
 * policy the model actually receives, which citations survive into the
 * verdict, and whether a cache hit really skips the model call.
 *
 * No network and no API key — the model is a stub that records what it was
 * asked and replays canned JSON.
 */

import { describe, expect, it } from "vitest";

import { runReview } from "../../src/review.js";
import type {
  GithubReader,
  LinearClient,
  VerdictModel,
  VerdictModelRequest,
} from "../../src/review.js";
import type { ResearchPolicy } from "../../src/research/policy.js";
import type { ResearchTrace } from "../../src/research/trace.js";
import type { LinearTicketContext, PrContext } from "../../src/schema/event.js";
import { ReviewVerdict } from "../../src/schema/verdict.js";
import { hashPrompt } from "../../src/cache/verdict-cache.js";

const FROZEN_TIME = "2026-04-27T08:30:00.000Z";
const HEAD_SHA = "f6299112233aabbccdd";

const PR_BODY = [
  "Closes [OGE-308](https://linear.app/ogenticai/issue/OGE-308).",
  "",
  "## UAT checklist",
  "",
  "- [ ] `redact()` round-trips across all three profiles",
  "- [ ] [human] Clinician confirms the PHI categories match DSM-5 practice",
  "",
].join("\n");

function makePr(overrides: Partial<PrContext> = {}): PrContext {
  return {
    owner: "OgenticAI",
    repo: "ogentic-shield",
    number: 1,
    headSha: HEAD_SHA,
    headRef: "david/oge-308-redaction",
    title: "feat(redaction): categories (OGE-308)",
    body: PR_BODY,
    author: "davidoladeji-ogenticai",
    createdAt: "2026-04-27T08:00:00.000Z",
    ...overrides,
  };
}

const TICKET: LinearTicketContext = {
  identifier: "OGE-308",
  id: "abc-123",
  title: "Redaction categories",
  description: "Add DSM-5-aligned PHI categories",
  status: "In Review",
  url: "https://linear.app/ogenticai/issue/OGE-308",
};

const GITHUB: GithubReader = {
  getPr: async () => makePr(),
  getDiff: async () => "diff --git a/x b/x\n+categories\n",
};
const LINEAR: LinearClient = { getIssue: async () => TICKET };

/** Verdict JSON where the `[human]` item (id 2) cites two external sources. */
function verdictJson(humanEvidenceUrls: string[]): string {
  return JSON.stringify({
    items: [
      {
        id: 1,
        itemText: "`redact()` round-trips across all three profiles",
        status: "PASS",
        rationale: "Covered by test_round_trip.",
        evidenceRefs: [{ kind: "external", url: "https://github.com/OgenticAI/x/pull/1" }],
      },
      {
        id: 2,
        itemText: "Clinician confirms the PHI categories match DSM-5 practice",
        status: "UNVERIFIABLE",
        rationale: "14 of 15 categories map to Safe Harbor identifiers; InsuranceId does not.",
        evidenceRefs: humanEvidenceUrls.map((url) => ({ kind: "external", url, note: "source" })),
      },
    ],
    summary: "One item needs clinician sign-off.",
  });
}

/** A model stub that records the request and replays canned output. */
function recordingModel(json: string, trace?: ResearchTrace) {
  const seen: VerdictModelRequest[] = [];
  let calls = 0;
  const model: VerdictModel = {
    produce: async (req) => {
      seen.push(req);
      calls += 1;
      return trace ? { text: json, trace } : json;
    },
  };
  return {
    model,
    seen,
    get calls() {
      return calls;
    },
  };
}

function run(args: {
  model: VerdictModel;
  researchEnabled?: boolean;
  cachedVerdict?: ReviewVerdict | null;
}) {
  return runReview({
    pr: { owner: "OgenticAI", repo: "ogentic-shield", number: 1 },
    github: GITHUB,
    linear: LINEAR,
    now: () => FROZEN_TIME,
    ...args,
  });
}

describe("research policy reaching the model", () => {
  it("sends a disabled policy when the repo hasn't opted in", async () => {
    const rec = recordingModel(verdictJson([]));
    await run({ model: rec.model, researchEnabled: false });
    expect(rec.seen[0]!.research.enabled).toBe(false);
    // The model layer branches on this to omit the tools array entirely.
    expect(rec.seen[0]!.research.allowedDomains).toEqual([]);
  });

  it("enables research when the repo opted in and a [human] item exists", async () => {
    const rec = recordingModel(verdictJson([]));
    await run({ model: rec.model, researchEnabled: true });
    expect(rec.seen[0]!.research.enabled).toBe(true);
    expect(rec.seen[0]!.research.allowedDomains).toContain("hhs.gov");
  });

  it("reports why research was on or off", async () => {
    const rec = recordingModel(verdictJson([]));
    const result = await run({ model: rec.model, researchEnabled: false });
    expect(result.researchReason).toMatch(/default off/);
  });

  it("puts the search instructions in the prompt only when enabled", async () => {
    const off = recordingModel(verdictJson([]));
    await run({ model: off.model, researchEnabled: false });
    expect(off.seen[0]!.userPrompt).not.toContain("web_search");

    const on = recordingModel(verdictJson([]));
    await run({ model: on.model, researchEnabled: true });
    expect(on.seen[0]!.userPrompt).toContain("web_search");
    expect(on.seen[0]!.userPrompt).toContain("never paste code");
  });
});

describe("citation gate", () => {
  const trace = (urls: string[]): ResearchTrace => ({
    queries: ["HIPAA Safe Harbor identifiers"],
    citedUrls: urls,
    errors: [],
  });

  it("keeps a citation that a search actually returned", async () => {
    const url = "https://hhs.gov/hipaa/safe-harbor";
    const rec = recordingModel(verdictJson([url]), trace([url]));
    const result = await run({ model: rec.model, researchEnabled: true });
    expect(result.verdict.items[1]!.evidenceRefs).toHaveLength(1);
  });

  it("drops a citation the model invented", async () => {
    // The failure this exists to stop: a real-looking government URL lending
    // false authority to a half-remembered claim.
    const rec = recordingModel(
      verdictJson(["https://hhs.gov/totally-made-up"]),
      trace(["https://hhs.gov/hipaa/safe-harbor"]),
    );
    const result = await run({ model: rec.model, researchEnabled: true });
    expect(result.verdict.items[1]!.evidenceRefs).toHaveLength(0);
  });

  it("keeps the sourced citation and drops the invented one in the same item", async () => {
    const real = "https://hhs.gov/hipaa/safe-harbor";
    const rec = recordingModel(verdictJson([real, "https://cms.gov/invented"]), trace([real]));
    const result = await run({ model: rec.model, researchEnabled: true });
    const refs = result.verdict.items[1]!.evidenceRefs;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ url: real });
  });

  it("leaves non-[human] items alone — they cite the diff and ticket legitimately", async () => {
    const rec = recordingModel(verdictJson([]), trace([]));
    const result = await run({ model: rec.model, researchEnabled: true });
    // Item 1 cites a GitHub URL that no search returned; it must survive.
    expect(result.verdict.items[0]!.evidenceRefs).toHaveLength(1);
  });

  it("leaves [human] citations alone when research never ran", async () => {
    // With no result set there is nothing to check against — filtering here
    // would silently gut evidence on every repo that never opted in.
    const rec = recordingModel(verdictJson(["https://hhs.gov/anything"]));
    const result = await run({ model: rec.model, researchEnabled: false });
    expect(result.verdict.items[1]!.evidenceRefs).toHaveLength(1);
  });

  it("never lets research upgrade a [human] item past UNVERIFIABLE", async () => {
    const url = "https://hhs.gov/hipaa/safe-harbor";
    const rec = recordingModel(verdictJson([url]), trace([url]));
    const result = await run({ model: rec.model, researchEnabled: true });
    expect(result.verdict.items[1]!.status).toBe("UNVERIFIABLE");
    expect(result.overall).toBe("PASS"); // [human] items excluded from the roll-up
  });

  it("surfaces the trace for audit logging", async () => {
    const rec = recordingModel(verdictJson([]), trace(["https://hhs.gov/x"]));
    const result = await run({ model: rec.model, researchEnabled: true });
    expect(result.researchTrace.queries).toEqual(["HIPAA Safe Harbor identifiers"]);
  });
});

describe("verdict cache", () => {
  async function verdictFor(researchEnabled: boolean): Promise<ReviewVerdict> {
    const rec = recordingModel(verdictJson([]));
    const result = await run({ model: rec.model, researchEnabled });
    return result.verdict;
  }

  it("stamps a prompt hash onto every verdict", async () => {
    const verdict = await verdictFor(false);
    expect(verdict.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips the model call entirely on a cache hit", async () => {
    const cached = await verdictFor(false);
    const rec = recordingModel(verdictJson([]));
    const result = await run({ model: rec.model, researchEnabled: false, cachedVerdict: cached });
    expect(result.cached).toBe(true);
    expect(rec.calls).toBe(0);
  });

  it("re-runs when the cached verdict is from a different SHA", async () => {
    const cached = await verdictFor(false);
    const stale = { ...cached, headSha: "0000000000" };
    const rec = recordingModel(verdictJson([]));
    const result = await run({ model: rec.model, researchEnabled: false, cachedVerdict: stale });
    expect(result.cached).toBe(false);
    expect(rec.calls).toBe(1);
  });

  it("re-runs when the prompt changed at the same SHA", async () => {
    const cached = await verdictFor(false);
    const edited = { ...cached, promptHash: hashPrompt("a different prompt") };
    const rec = recordingModel(verdictJson([]));
    const result = await run({ model: rec.model, researchEnabled: false, cachedVerdict: edited });
    expect(result.cached).toBe(false);
  });

  it("re-runs when research was toggled on, since that changes the prompt", async () => {
    // Same code, same checklist — but the model is now being given different
    // grounding rules, so the old verdict is not a valid stand-in.
    const cached = await verdictFor(false);
    const rec = recordingModel(verdictJson([]));
    const result = await run({ model: rec.model, researchEnabled: true, cachedVerdict: cached });
    expect(result.cached).toBe(false);
  });

  it("renders a byte-identical comment from a cache hit", async () => {
    const cached = await verdictFor(false);
    const fresh = await run({ model: recordingModel(verdictJson([])).model });
    const hit = await run({ model: recordingModel(verdictJson([])).model, cachedVerdict: cached });
    expect(hit.body).toBe(fresh.body);
  });
});
