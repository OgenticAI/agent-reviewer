/**
 * Inline evidence anchoring (OGE-1586).
 *
 * Two properties under test: the diff position map only marks lines GitHub will
 * actually accept as anchors (added + context, never deleted), and the split is
 * lossless — every FAIL/PARTIAL lands in exactly one of the inline or fallback
 * channels, never dropped.
 */

import { describe, expect, it } from "vitest";

import {
  buildPositionMap,
  inlineMarker,
  parseInlineMarker,
  renderFallbackSection,
  splitFindings,
} from "../../src/render/inline.js";
import type { ItemVerdict } from "../../src/schema/verdict.js";

const DIFF = [
  "diff --git a/src/redact.ts b/src/redact.ts",
  "--- a/src/redact.ts",
  "+++ b/src/redact.ts",
  "@@ -10,3 +10,4 @@ function redact() {",
  " const a = 1;", // context → new line 10
  "-const removed = 2;", // deleted → not anchorable
  "+const added = 3;", // added → new line 11
  "+const also = 4;", // added → new line 12
  " return a;", // context → new line 13
].join("\n");

function item(id: number, status: ItemVerdict["status"], refs: ItemVerdict["evidenceRefs"]): ItemVerdict {
  return { id, itemText: `item ${id}`, status, rationale: "r", evidenceRefs: refs } as ItemVerdict;
}

describe("buildPositionMap", () => {
  const map = buildPositionMap(DIFF);

  it("anchors added and context lines on the new file", () => {
    const anchorable = map.get("src/redact.ts")!;
    expect(anchorable.has(10)).toBe(true); // context
    expect(anchorable.has(11)).toBe(true); // added
    expect(anchorable.has(12)).toBe(true); // added
    expect(anchorable.has(13)).toBe(true); // context
  });

  it("does not anchor a line outside any hunk", () => {
    expect(map.get("src/redact.ts")!.has(99)).toBe(false);
  });

  it("returns an empty map for an empty diff", () => {
    expect(buildPositionMap("").size).toBe(0);
  });
});

describe("splitFindings", () => {
  const map = buildPositionMap(DIFF);
  const render = (it: ItemVerdict, line: number) => `${it.status} at ${line}: ${it.itemText}`;

  it("anchors a FAIL whose cited lines land in the diff", () => {
    const { inline, unanchored } = splitFindings(
      [item(1, "FAIL", [{ kind: "lines", path: "src/redact.ts", start: 11, end: 12 }])],
      map,
      render,
    );
    expect(unanchored).toEqual([]);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ path: "src/redact.ts", line: 11, itemId: 1, status: "FAIL" });
    expect(inline[0]!.body).toContain(inlineMarker(1));
  });

  it("routes a finding whose cited lines are outside the diff to the fallback", () => {
    const { inline, unanchored } = splitFindings(
      [item(2, "PARTIAL", [{ kind: "lines", path: "src/redact.ts", start: 90, end: 95 }])],
      map,
      render,
    );
    expect(inline).toEqual([]);
    expect(unanchored[0]).toMatchObject({ itemId: 2, reason: "cited lines are outside this diff" });
  });

  it("routes a finding with no line-level evidence to the fallback", () => {
    const { unanchored } = splitFindings(
      [item(3, "FAIL", [{ kind: "file", path: "src/redact.ts" }])],
      map,
      render,
    );
    expect(unanchored[0]!.reason).toBe("no line-level evidence to anchor to");
  });

  it("ignores PASS / CODE_VERIFIED — they need no fix pointer", () => {
    const { inline, unanchored } = splitFindings(
      [
        item(4, "PASS", [{ kind: "lines", path: "src/redact.ts", start: 11, end: 11 }]),
        item(5, "CODE_VERIFIED", [{ kind: "lines", path: "src/redact.ts", start: 11, end: 11 }]),
      ],
      map,
      render,
    );
    expect(inline).toEqual([]);
    expect(unanchored).toEqual([]);
  });

  it("never drops a FAIL/PARTIAL — every one lands in exactly one channel", () => {
    const items = [
      item(1, "FAIL", [{ kind: "lines", path: "src/redact.ts", start: 11, end: 11 }]),
      item(2, "PARTIAL", [{ kind: "lines", path: "src/redact.ts", start: 90, end: 90 }]),
      item(3, "FAIL", [{ kind: "file", path: "src/redact.ts" }]),
    ];
    const { inline, unanchored } = splitFindings(items, map, render);
    expect(inline.length + unanchored.length).toBe(3);
  });
});

describe("markers", () => {
  it("round-trips the item id", () => {
    expect(parseInlineMarker(inlineMarker(7))).toBe(7);
  });
  it("returns null for a comment without our marker", () => {
    expect(parseInlineMarker("just a human comment")).toBeNull();
  });
});

describe("renderFallbackSection", () => {
  it("renders the out-of-diff section for unanchored findings", () => {
    const section = renderFallbackSection([
      { itemId: 2, status: "PARTIAL", itemText: "backfill covers rows", reason: "cited lines are outside this diff" },
    ])!;
    expect(section).toContain("Evidence outside this diff");
    expect(section).toContain("**PARTIAL** item 2: backfill covers rows");
  });

  it("returns null when nothing is unanchored", () => {
    expect(renderFallbackSection([])).toBeNull();
  });
});
