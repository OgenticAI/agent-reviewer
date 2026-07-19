/**
 * Committable suggestion blocks (OGE-1596).
 *
 * The certainty gate is the design: a one-click suggestion is only offered for
 * a small, contiguous, high-confidence FAIL fix whose every replaced line is
 * anchorable in the diff. Everything else falls through to the draft-PR path,
 * unchanged. A wrong one-click apply is worse than none.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPositionMap, splitFindings, renderInlineFindingBody } from "../../src/render/inline.js";
import {
  attachSuggestions,
  renderSuggestionBlock,
  suggestionEligibility,
} from "../../src/render/suggestion.js";
import type { ItemVerdict } from "../../src/schema/verdict.js";

// A diff that makes lines 10–13 of src/x.ts anchorable.
const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -10,2 +10,4 @@",
  " const a = 1;", // 10 context
  "+const bad = 2;", // 11 added
  "+const also = 3;", // 12 added
  " return a;", // 13 context
].join("\n");

const MAP = buildPositionMap(DIFF);

function failItem(over: Partial<ItemVerdict> = {}): ItemVerdict {
  return {
    id: 1,
    itemText: "uses the right constant",
    status: "FAIL",
    rationale: "wrong literal",
    evidenceRefs: [{ kind: "lines", path: "src/x.ts", start: 11, end: 11 }],
    autoPatchable: true,
    confidence: 0.95,
    suggestedFix: { path: "src/x.ts", startLine: 11, endLine: 11, replacement: "const good = 2;" },
    ...over,
  } as ItemVerdict;
}

describe("suggestionEligibility", () => {
  it("accepts a small, certain, in-diff FAIL fix", () => {
    expect(suggestionEligibility(failItem(), MAP).eligible).toBe(true);
  });

  it("rejects a non-FAIL item", () => {
    expect(suggestionEligibility(failItem({ status: "PARTIAL" }), MAP).eligible).toBe(false);
  });

  it("rejects an item that isn't autoPatchable", () => {
    expect(suggestionEligibility(failItem({ autoPatchable: false }), MAP).eligible).toBe(false);
  });

  it("rejects low confidence", () => {
    expect(suggestionEligibility(failItem({ confidence: 0.5 }), MAP).eligible).toBe(false);
  });

  it("rejects a fix spanning a line outside the diff", () => {
    const item = failItem({
      suggestedFix: { path: "src/x.ts", startLine: 11, endLine: 20, replacement: "x" },
    });
    expect(suggestionEligibility(item, MAP).reason).toMatch(/not anchorable|more than/);
  });

  it("rejects a fix in a file the diff didn't touch", () => {
    const item = failItem({
      suggestedFix: { path: "src/other.ts", startLine: 1, endLine: 1, replacement: "x" },
    });
    expect(suggestionEligibility(item, MAP).reason).toBe("file not in diff");
  });
});

describe("attachSuggestions", () => {
  it("upgrades an eligible item to a suggestion comment and reports its id", () => {
    const split = splitFindings([failItem()], MAP, renderInlineFindingBody);
    const { split: out, suggestedItemIds } = attachSuggestions({
      split,
      items: [failItem()],
      positionMap: MAP,
    });
    expect(suggestedItemIds).toEqual([1]);
    expect(out.inline).toHaveLength(1);
    expect(out.inline[0]!.body).toContain("```suggestion");
    expect(out.inline[0]!.line).toBe(11);
  });

  it("leaves ineligible items on their existing rung, untouched", () => {
    // Multi-hunk / low-confidence → no suggestion, draft-PR path unchanged.
    const item = failItem({ confidence: 0.4 });
    const split = splitFindings([item], MAP, renderInlineFindingBody);
    const { split: out, suggestedItemIds } = attachSuggestions({ split, items: [item], positionMap: MAP });
    expect(suggestedItemIds).toEqual([]);
    expect(out.inline[0]!.body).not.toContain("```suggestion");
  });

  it("rescues an eligible item whose evidence was out-of-diff but whose fix anchors", () => {
    // Evidence points outside the diff (line 90) so splitFindings routes it to
    // the fallback — but the FIX is in-diff, so it should still get a suggestion.
    const item = failItem({
      evidenceRefs: [{ kind: "lines", path: "src/x.ts", start: 90, end: 90 }],
    });
    const split = splitFindings([item], MAP, renderInlineFindingBody);
    expect(split.unanchored).toHaveLength(1);
    const { split: out, suggestedItemIds } = attachSuggestions({ split, items: [item], positionMap: MAP });
    expect(suggestedItemIds).toEqual([1]);
    expect(out.unanchored).toHaveLength(0);
    expect(out.inline).toHaveLength(1);
  });
});

describe("renderSuggestionBlock applied with git", () => {
  it("produces a block whose body, patched in, applies cleanly under git", () => {
    // GitHub replaces the anchored line(s) with the block body verbatim. We
    // build the equivalent patch and prove `git apply` accepts it — a broken or
    // mis-fenced suggestion would fail to apply.
    const dir = mkdtempSync(join(tmpdir(), "sugg-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const original = ["const a = 1;", "const bad = 2;", "return a;"].join("\n") + "\n";
    writeFileSync(join(dir, "x.ts"), original);
    execFileSync("git", ["add", "x.ts"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });

    const body = renderSuggestionBlock("const good = 2;")
      .replace(/^```suggestion\n/, "")
      .replace(/\n```$/, "");

    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const bad = 2;",
      `+${body}`,
      " return a;",
      "",
    ].join("\n");
    writeFileSync(join(dir, "s.patch"), patch);

    // --check: applies cleanly, no corruption. Throws (non-zero) if it doesn't.
    expect(() =>
      execFileSync("git", ["apply", "--check", "s.patch"], { cwd: dir }),
    ).not.toThrow();
    execFileSync("git", ["apply", "s.patch"], { cwd: dir });
    expect(readFileSync(join(dir, "x.ts"), "utf8")).toContain("const good = 2;");
  });
});
