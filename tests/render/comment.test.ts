import { describe, expect, it } from "vitest";

import { renderStickyComment } from "../../src/render/comment.js";
import type { ReviewVerdict } from "../../src/schema/verdict.js";
import { COMMENT_MARKER, REVIEWER_VERSION } from "../../src/version.js";

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    schemaVersion: 1,
    reviewerVersion: REVIEWER_VERSION,
    ticketId: "OGE-308",
    prRef: "OgenticAI/ogentic-shield#1",
    headSha: "f6299112233aabbccdd",
    items: [
      {
        id: 1,
        itemText: "Shield.redact() returns (text, mapping)",
        status: "PASS",
        rationale: "Implemented in src/redaction.py and exercised by tests/test_redaction.py.",
        evidenceRefs: [
          { kind: "file", path: "src/redaction.py" },
          {
            kind: "test",
            path: "tests/test_redaction.py",
            name: "TestRoundTripPerProfile::test_finance_round_trip_preserves_dollar_amounts",
          },
        ],
      },
      {
        id: 2,
        itemText: "Numbers preserved in finance redaction",
        status: "PARTIAL",
        rationale: "Dollar amounts pass; ratios untested.",
        evidenceRefs: [],
      },
    ],
    summary: "Redaction core looks solid; one partial item flagged.",
    generatedAt: "2026-04-27T08:30:14.000Z",
    ...overrides,
  };
}

describe("renderStickyComment", () => {
  it("starts with the sticky marker on the first line", () => {
    const out = renderStickyComment(makeVerdict());
    expect(out.startsWith(COMMENT_MARKER + "\n")).toBe(true);
  });

  it("is byte-identical for the same verdict (idempotency)", () => {
    const v = makeVerdict();
    expect(renderStickyComment(v)).toBe(renderStickyComment(v));
  });

  it("does NOT include the generatedAt timestamp in the rendered body header", () => {
    // Timestamp lives only inside the JSON sidecar — it must not perturb the
    // human-visible Markdown body, otherwise sticky comments would 'churn'
    // on every push.
    const a = renderStickyComment(makeVerdict({ generatedAt: "2026-04-27T08:30:14.000Z" }));
    const b = renderStickyComment(makeVerdict({ generatedAt: "2099-12-31T23:59:59.000Z" }));
    // Strip the JSON sidecar block before comparing
    const stripJson = (s: string) => s.replace(/```json[\s\S]*?```/, "");
    expect(stripJson(a)).toBe(stripJson(b));
  });

  it("renders the per-item verdict table", () => {
    const out = renderStickyComment(makeVerdict());
    expect(out).toContain("| # | Item | Verdict | Rationale |");
    expect(out).toContain("✅ PASS");
    expect(out).toContain("🟡 PARTIAL");
  });

  it("escapes pipes in rationales so the table doesn't break", () => {
    const out = renderStickyComment(
      makeVerdict({
        items: [
          {
            id: 1,
            itemText: "x | y | z",
            status: "PASS",
            rationale: "uses |grep| and |awk|",
            evidenceRefs: [],
          },
        ],
      }),
    );
    expect(out).toContain("x \\| y \\| z");
    expect(out).toContain("uses \\|grep\\| and \\|awk\\|");
  });

  it("collapses newlines in rationales to <br>", () => {
    const out = renderStickyComment(
      makeVerdict({
        items: [
          {
            id: 1,
            itemText: "x",
            status: "PASS",
            rationale: "line one\nline two",
            evidenceRefs: [],
          },
        ],
      }),
    );
    expect(out).toContain("line one<br>line two");
  });

  it("includes the JSON payload sidecar with the full verdict", () => {
    const out = renderStickyComment(makeVerdict());
    const jsonMatch = out.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]!);
    expect(parsed.ticketId).toBe("OGE-308");
    expect(parsed.items).toHaveLength(2);
  });

  it("only shows the Evidence block when at least one item has evidence", () => {
    const withEvidence = renderStickyComment(makeVerdict());
    expect(withEvidence).toContain("<summary>Evidence</summary>");

    const withoutEvidence = renderStickyComment(
      makeVerdict({
        items: [
          {
            id: 1,
            itemText: "x",
            status: "UNVERIFIABLE",
            rationale: "y",
            evidenceRefs: [],
          },
        ],
      }),
    );
    expect(withoutEvidence).not.toContain("<summary>Evidence</summary>");
  });

  it("picks the right overall headline for each combination", () => {
    const allPass = renderStickyComment(
      makeVerdict({
        items: [
          { id: 1, itemText: "a", status: "PASS", rationale: "ok", evidenceRefs: [] },
        ],
      }),
    );
    expect(allPass).toContain("✅ All UAT items pass.");

    const oneFail = renderStickyComment(
      makeVerdict({
        items: [
          { id: 1, itemText: "a", status: "PASS", rationale: "ok", evidenceRefs: [] },
          { id: 2, itemText: "b", status: "FAIL", rationale: "broken", evidenceRefs: [] },
        ],
      }),
    );
    expect(oneFail).toContain("❌ UAT fails");

    const oneUnverifiable = renderStickyComment(
      makeVerdict({
        items: [
          {
            id: 1,
            itemText: "a",
            status: "UNVERIFIABLE",
            rationale: "visual",
            evidenceRefs: [],
          },
        ],
      }),
    );
    expect(oneUnverifiable).toContain("🤔 UAT needs human review");
  });

  it("notes the override command in the footer", () => {
    expect(renderStickyComment(makeVerdict())).toContain("/uat-override");
  });
});
