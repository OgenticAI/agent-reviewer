/**
 * Verdict reuse across runs (OGE-1566).
 *
 * The property that matters most here is the *negative* one: every ambiguous
 * or malformed input must miss the cache, because a miss costs a re-run while
 * a false hit posts a stale verdict against changed inputs.
 */

import { describe, expect, it } from "vitest";

import { renderStickyComment } from "../../src/render/comment.js";
import { ReviewVerdict } from "../../src/schema/verdict.js";
import {
  hashPrompt,
  isCacheHit,
  parseVerdictFromStickyBody,
} from "../../src/cache/verdict-cache.js";

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return ReviewVerdict.parse({
    schemaVersion: 1,
    reviewerVersion: "v2",
    ticketId: "OGE-308",
    prRef: "OgenticAI/ogentic-shield#1",
    headSha: "f6299112233aabbccdd",
    items: [
      {
        id: 1,
        itemText: "redact() round-trips",
        status: "PASS",
        rationale: "covered by test_round_trip",
        evidenceRefs: [],
      },
    ],
    summary: "ok",
    generatedAt: "2026-04-27T08:30:00.000Z",
    promptHash: "a".repeat(64),
    ...overrides,
  });
}

describe("hashPrompt", () => {
  it("is stable for the same prompt", () => {
    expect(hashPrompt("hello")).toBe(hashPrompt("hello"));
  });

  it("changes when a single byte changes", () => {
    // This is the whole point: a PR-body edit that adds a UAT item produces a
    // different prompt with no new commit, and must not reuse the old verdict.
    expect(hashPrompt("hello")).not.toBe(hashPrompt("hellp"));
  });
});

describe("parseVerdictFromStickyBody", () => {
  it("round-trips a verdict through the rendered sticky comment", () => {
    const verdict = makeVerdict();
    const recovered = parseVerdictFromStickyBody(renderStickyComment(verdict));
    expect(recovered).not.toBeNull();
    expect(recovered!.headSha).toBe(verdict.headSha);
    expect(recovered!.promptHash).toBe(verdict.promptHash);
    expect(recovered!.items).toHaveLength(1);
  });

  it("returns null when the body has no JSON sidecar", () => {
    expect(parseVerdictFromStickyBody("just a comment")).toBeNull();
  });

  it("returns null on malformed JSON rather than throwing", () => {
    expect(parseVerdictFromStickyBody("```json\n{not json\n```")).toBeNull();
  });

  it("returns null when the payload no longer matches the schema", () => {
    expect(parseVerdictFromStickyBody('```json\n{"schemaVersion": 99}\n```')).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseVerdictFromStickyBody("```json\n[1,2,3]\n```")).toBeNull();
  });
});

describe("isCacheHit", () => {
  const base = {
    headSha: "f6299112233aabbccdd",
    promptHash: "a".repeat(64),
    reviewerVersion: "v2",
  };

  it("hits when SHA, prompt hash, and reviewer version all match", () => {
    expect(isCacheHit({ cached: makeVerdict(), ...base })).toBe(true);
  });

  it("misses when there is no cached verdict", () => {
    expect(isCacheHit({ cached: null, ...base })).toBe(false);
  });

  it("misses on a new commit", () => {
    expect(isCacheHit({ cached: makeVerdict({ headSha: "deadbeef000" }), ...base })).toBe(false);
  });

  it("misses when the prompt changed at the same SHA", () => {
    // The PR description was edited — same code, different checklist.
    expect(isCacheHit({ cached: makeVerdict({ promptHash: "b".repeat(64) }), ...base })).toBe(
      false,
    );
  });

  it("misses when the reviewer version changed", () => {
    // Bumping REVIEWER_VERSION must invalidate every cached verdict, or a
    // reworded prompt gets masked by stale hits.
    expect(isCacheHit({ cached: makeVerdict({ reviewerVersion: "v3" }), ...base })).toBe(false);
  });

  it("misses on a verdict written before promptHash existed", () => {
    expect(isCacheHit({ cached: makeVerdict({ promptHash: undefined }), ...base })).toBe(false);
  });
});
