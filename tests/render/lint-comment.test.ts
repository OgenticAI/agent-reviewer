/**
 * Lint-comment rendering tests (OGE-1559).
 *
 * The two properties that matter:
 *   1. Silence on clean checklists — a linter that comments on every PR gets
 *      filtered out, and then it stops working on the PRs that need it.
 *   2. Byte-identical output for identical input, so `upsertStickyComment`
 *      no-ops instead of churning the comment on every push.
 */

import { describe, expect, it } from "vitest";

import { lintChecklist } from "../../src/lint/checklist.js";
import { parseUatChecklist } from "../../src/parser/uat.js";
import { renderLintComment } from "../../src/render/lint-comment.js";
import { LINT_COMMENT_MARKER, COMMENT_MARKER } from "../../src/version.js";

function render(...items: string[]): string | null {
  const body = ["## UAT checklist", "", ...items.map((i) => `- [ ] ${i}`)].join("\n");
  return renderLintComment(lintChecklist(parseUatChecklist(body)));
}

describe("renderLintComment", () => {
  it("returns null for a clean checklist — no comment at all", () => {
    expect(render("`redact()` round-trips, covered by `test_round_trip`")).toBeNull();
  });

  it("returns null when every flagged-looking item is [human]-marked", () => {
    expect(render("[human] Clinician sign-off on the mapping")).toBeNull();
  });

  it("returns null when there is no checklist", () => {
    expect(renderLintComment(lintChecklist(parseUatChecklist("## Summary\n\nnope")))).toBeNull();
  });

  it("starts with the lint marker, not the verdict marker", () => {
    const body = render("Merge the PR")!;
    expect(body.startsWith(LINT_COMMENT_MARKER)).toBe(true);
    expect(body.startsWith(COMMENT_MARKER)).toBe(false);
  });

  it("never claims to block the PR", () => {
    const body = render("Merge the PR")!.toLowerCase();
    expect(body).toContain("does not block");
    expect(body).not.toContain("blocking this pr");
  });

  it("quotes the offending item and gives a concrete rewrite", () => {
    const body = render("Push the v0.2.0 tag")!;
    expect(body).toContain("> Push the v0.2.0 tag");
    expect(body).toContain("release workflow");
  });

  it("leads with the whole-checklist framing when nothing is verifiable", () => {
    const body = render("Merge the PR", "Push the v0.2.0 tag", "Set up the PyPI token")!;
    expect(body).toContain("None of the 3 items");
    expect(body).toContain("release runbook");
  });

  it("uses the per-item framing when some items are fine", () => {
    const body = render("Merge the PR", "`redact()` round-trips across all profiles")!;
    expect(body).toContain("1 of 2 items");
    expect(body).not.toContain("None of the");
  });

  it("acknowledges already-marked [human] items instead of ignoring them", () => {
    const body = render("Merge the PR", "[human] Design sign-off", "`foo()` is covered")!;
    expect(body).toContain("1 item already marked");
  });

  it("documents the [human] escape hatch", () => {
    const body = render("Merge the PR")!;
    expect(body).toContain("[human]");
    expect(body).toContain("```markdown");
  });

  it("is byte-identical across repeated renders", () => {
    const items = ["Merge the PR", "TBD", "[human] Design sign-off", "Push the tag"];
    expect(render(...items)).toBe(render(...items));
  });

  it("renders one block per finding, in item order", () => {
    const body = render("Merge the PR", "TBD")!;
    expect(body.indexOf("**Item 1**")).toBeGreaterThan(-1);
    expect(body.indexOf("**Item 2**")).toBeGreaterThan(body.indexOf("**Item 1**"));
  });

  it("singularises correctly for a one-item problem", () => {
    const body = render("Merge the PR", "`foo()` is covered by a test")!;
    expect(body).not.toContain("1 items");
  });
});
