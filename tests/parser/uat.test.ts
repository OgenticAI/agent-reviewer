import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseUatChecklist, summarizeChecklist } from "../../src/parser/uat.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

describe("parseUatChecklist", () => {
  describe("real PR fixtures (ogentic-shield)", () => {
    it("extracts the UAT block from PR #1 (redaction API)", () => {
      const result = parseUatChecklist(readFixture("pr-1.md"));
      expect(result.found).toBe(true);
      expect(result.items).toHaveLength(4);

      // The four UAT items from OGE-308 + OGE-309
      expect(result.items[0]?.text).toContain('s.redact("...")');
      expect(result.items[1]?.text).toContain("dollar amounts visibly preserved");
      expect(result.items[2]?.text).toContain("Shield.unredact(response, mapping)");
      expect(result.items[3]?.text).toContain("README");

      // All four start unchecked — none of these have been verified yet
      for (const item of result.items) {
        expect(item.checked).toBe(false);
      }

      // Acceptance-criteria checkboxes (which ARE checked) must NOT bleed in
      const allText = result.items.map((it) => it.text).join("\n");
      expect(allText).not.toContain("redact_categories` parameter");
    });

    it("extracts the UAT block from PR #2 (audit emission)", () => {
      const result = parseUatChecklist(readFixture("pr-2.md"));
      expect(result.found).toBe(true);
      expect(result.items).toHaveLength(5);

      expect(result.items[0]?.text).toContain("FileAuditBackend");
      expect(result.items[1]?.text).toContain("Each line is valid JSON");
      expect(result.items[2]?.text).toContain("shield.redact");
      expect(result.items[3]?.text).toContain("backend that raises");
      expect(result.items[4]?.text).toContain("FileAuditBackend");

      for (const item of result.items) {
        expect(item.checked).toBe(false);
      }
    });
  });

  describe("structural rules", () => {
    it("returns found=false when there is no UAT heading", () => {
      const result = parseUatChecklist("# Just a regular doc\n- [ ] not a UAT item\n");
      expect(result.found).toBe(false);
      expect(result.items).toHaveLength(0);
    });

    it("ignores task items in earlier sections (e.g. ## Acceptance criteria)", () => {
      const md = [
        "## Acceptance criteria",
        "- [x] earlier item",
        "",
        "## UAT checklist",
        "- [ ] real UAT item",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.text).toBe("real UAT item");
    });

    it("stops at the next h2 heading", () => {
      const md = [
        "## UAT checklist",
        "- [ ] one",
        "- [ ] two",
        "",
        "## Notes",
        "- [ ] not in UAT",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items.map((i) => i.text)).toEqual(["one", "two"]);
    });

    it("does NOT stop at h3 headings inside the block", () => {
      const md = [
        "## UAT checklist",
        "- [ ] before sub-section",
        "",
        "### Sub-section",
        "- [ ] after sub-section",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items).toHaveLength(2);
    });

    it("ignores task items inside fenced code blocks", () => {
      const md = [
        "## UAT checklist",
        "- [ ] real one",
        "",
        "```md",
        "- [ ] example in code",
        "```",
        "",
        "- [ ] real two",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items.map((i) => i.text)).toEqual(["real one", "real two"]);
    });

    it("treats x and X equivalently as checked", () => {
      const md = ["## UAT checklist", "- [x] lowercase", "- [X] uppercase", "- [ ] blank"].join(
        "\n",
      );
      const result = parseUatChecklist(md);
      expect(result.items[0]?.checked).toBe(true);
      expect(result.items[1]?.checked).toBe(true);
      expect(result.items[2]?.checked).toBe(false);
    });

    it("preserves item text verbatim including code spans and links", () => {
      const md = ["## UAT checklist", "- [ ] `npm install` then [docs](https://example.com)"].join(
        "\n",
      );
      const result = parseUatChecklist(md);
      expect(result.items[0]?.text).toBe("`npm install` then [docs](https://example.com)");
    });

    it("assigns 1-based ids in source order", () => {
      const md = ["## UAT checklist", "- [ ] a", "- [ ] b", "- [x] c"].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items.map((i) => i.id)).toEqual([1, 2, 3]);
    });

    it("records the source line for each item", () => {
      const md = ["", "## UAT checklist", "", "- [ ] first", "", "- [x] second"].join("\n");
      const result = parseUatChecklist(md);
      expect(result.headingLine).toBe(2);
      expect(result.items[0]?.line).toBe(4);
      expect(result.items[1]?.line).toBe(6);
    });

    it("survives Windows (CRLF) line endings", () => {
      const md = "## UAT checklist\r\n- [ ] one\r\n- [x] two\r\n";
      const result = parseUatChecklist(md);
      expect(result.items).toHaveLength(2);
      expect(result.items[1]?.checked).toBe(true);
    });

    it("only takes the first UAT block when multiple exist", () => {
      const md = [
        "## UAT checklist",
        "- [ ] first block item",
        "",
        "## Other",
        "",
        "## UAT checklist",
        "- [ ] second block item",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.text).toBe("first block item");
    });

    it("ignores empty-text items defensively", () => {
      const md = ["## UAT checklist", "- [ ] ", "- [ ] real"].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.text).toBe("real");
    });
  });

  describe("link extraction (OGE-365)", () => {
    it("classifies an inline-markdown PR issue-comment link", () => {
      const md = [
        "## UAT checklist",
        "- [x] verified in [comment](https://github.com/OgenticAI/ogentic-shield/pull/4#issuecomment-4392720381)",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links).toEqual([
        {
          kind: "pr-comment-issue",
          url: "https://github.com/OgenticAI/ogentic-shield/pull/4#issuecomment-4392720381",
          owner: "OgenticAI",
          repo: "ogentic-shield",
          prNumber: 4,
          commentId: 4392720381,
        },
      ]);
    });

    it("classifies a bare PR issue-comment link", () => {
      const md = [
        "## UAT checklist",
        "- [x] see https://github.com/OgenticAI/agent-reviewer/pull/13#issuecomment-12345.",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links).toHaveLength(1);
      expect(result.items[0]?.links[0]).toMatchObject({
        kind: "pr-comment-issue",
        owner: "OgenticAI",
        repo: "agent-reviewer",
        prNumber: 13,
        commentId: 12345,
      });
      // Trailing punctuation stripped
      expect(result.items[0]?.links[0]?.url.endsWith("12345")).toBe(true);
    });

    it("classifies a review-comment link (#discussion_rNNN, no hyphen)", () => {
      const md = [
        "## UAT checklist",
        "- [x] verified in [review](https://github.com/o/r/pull/9#discussion_r987654)",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links[0]).toEqual({
        kind: "pr-comment-review",
        url: "https://github.com/o/r/pull/9#discussion_r987654",
        owner: "o",
        repo: "r",
        prNumber: 9,
        commentId: 987654,
      });
    });

    it("captures cross-PR same-owner URLs with their OWN prNumber (orchestrator filters, not parser)", () => {
      const md = [
        "## UAT checklist",
        "- [x] see [other PR](https://github.com/OgenticAI/ogentic-shield/pull/99#issuecomment-1)",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links[0]).toMatchObject({
        kind: "pr-comment-issue",
        prNumber: 99,
        commentId: 1,
      });
    });

    it("classifies non-comment github URLs as 'other'", () => {
      const md = [
        "## UAT checklist",
        "- [ ] see [README](https://github.com/OgenticAI/agent-reviewer/blob/main/README.md)",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links[0]).toEqual({
        kind: "other",
        url: "https://github.com/OgenticAI/agent-reviewer/blob/main/README.md",
      });
    });

    it("classifies external (non-github) URLs as 'other'", () => {
      const md = [
        "## UAT checklist",
        "- [ ] see [blog post](https://example.com/post)",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links[0]).toEqual({
        kind: "other",
        url: "https://example.com/post",
      });
    });

    it("collapses duplicate URLs (inline + bare) to a single link", () => {
      const md = [
        "## UAT checklist",
        "- [x] see [comment](https://github.com/o/r/pull/1#issuecomment-99) — also https://github.com/o/r/pull/1#issuecomment-99",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links).toHaveLength(1);
    });

    it("captures multiple distinct links in source order", () => {
      const md = [
        "## UAT checklist",
        "- [x] [a](https://github.com/o/r/pull/1#issuecomment-1) and [b](https://github.com/o/r/pull/1#discussion_r2) and [c](https://example.com)",
      ].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links.map((l) => l.kind)).toEqual([
        "pr-comment-issue",
        "pr-comment-review",
        "other",
      ]);
    });

    it("returns links: [] when there is no URL in the item text", () => {
      const md = ["## UAT checklist", "- [ ] no link here"].join("\n");
      const result = parseUatChecklist(md);
      expect(result.items[0]?.links).toEqual([]);
    });
  });

  describe("summarizeChecklist", () => {
    it("counts checked vs unchecked correctly", () => {
      const md = ["## UAT checklist", "- [x] done", "- [x] also done", "- [ ] pending"].join("\n");
      const summary = summarizeChecklist(parseUatChecklist(md));
      expect(summary).toEqual({ total: 3, checked: 2, unchecked: 1 });
    });

    it("returns zeros for an empty / missing checklist", () => {
      const summary = summarizeChecklist(parseUatChecklist("no checklist here"));
      expect(summary).toEqual({ total: 0, checked: 0, unchecked: 0 });
    });
  });

  // OGE-1559: criteria that genuinely need a person are declared up front so
  // they stop counting against the merge gate.
  describe("[human] marker", () => {
    function firstItem(itemLine: string) {
      return parseUatChecklist(["## UAT checklist", itemLine].join("\n")).items[0];
    }

    it("sets human=true and strips the marker from the text", () => {
      const item = firstItem("- [ ] [human] Clinician sign-off on the mapping");
      expect(item?.human).toBe(true);
      expect(item?.text).toBe("Clinician sign-off on the mapping");
    });

    it("accepts the bold form", () => {
      const item = firstItem("- [ ] **[human]** Design review of the empty state");
      expect(item?.human).toBe(true);
      expect(item?.text).toBe("Design review of the empty state");
    });

    it("is case-insensitive and tolerates a trailing colon", () => {
      expect(firstItem("- [ ] [HUMAN] Legal review")?.human).toBe(true);
      expect(firstItem("- [ ] [Human]: Legal review")?.human).toBe(true);
      expect(firstItem("- [ ] [Human]: Legal review")?.text).toBe("Legal review");
    });

    it("defaults human=false on a normal item", () => {
      const item = firstItem("- [ ] `redact()` round-trips across all profiles");
      expect(item?.human).toBe(false);
      expect(item?.text).toBe("`redact()` round-trips across all profiles");
    });

    it("ignores a mid-sentence [human] — that's prose, not a declaration", () => {
      const item = firstItem("- [ ] Escalates to a [human] reviewer when confidence is low");
      expect(item?.human).toBe(false);
      expect(item?.text).toBe("Escalates to a [human] reviewer when confidence is low");
    });

    it("skips an item that is nothing but a marker", () => {
      const result = parseUatChecklist(["## UAT checklist", "- [ ] [human]"].join("\n"));
      expect(result.items).toHaveLength(0);
    });

    it("composes with checked state and link extraction", () => {
      const item = firstItem(
        "- [x] [human] Verified in https://github.com/o/r/pull/1#issuecomment-5",
      );
      expect(item?.human).toBe(true);
      expect(item?.checked).toBe(true);
      expect(item?.links).toHaveLength(1);
    });

    it("keeps ids positional when a marker-only item is skipped", () => {
      const result = parseUatChecklist(
        ["## UAT checklist", "- [ ] [human]", "- [ ] real criterion here"].join("\n"),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe(1);
    });
  });
});
