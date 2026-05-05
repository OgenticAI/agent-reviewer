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
});
