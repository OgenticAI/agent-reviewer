/**
 * The authoring guide and the linter must agree (OGE-1560).
 *
 * A guide whose own "after" examples get flagged is worse than no guide: it
 * teaches a rewrite and then punishes it, and the author has no way to tell
 * which of the two is wrong. These tests run the guide's examples through the
 * real linter so the two cannot drift apart silently.
 *
 * The factory's auto-appended compliance criteria get the same treatment. Per
 * `.claude/CLAUDE-FACTORY.md` §F2 those three lines are added to every ticket
 * on Shield/Audit repos and the Therapy vertical — if the linter started
 * flagging them, it would be nagging on the most compliance-sensitive PRs in
 * the fleet, every time.
 */

import { describe, expect, it } from "vitest";

import { lintChecklist } from "../../src/lint/checklist.js";
import { parseUatChecklist } from "../../src/parser/uat.js";

function lint(...items: string[]) {
  return lintChecklist(
    parseUatChecklist(["## UAT checklist", "", ...items.map((i) => `- [ ] ${i}`)].join("\n")),
  );
}

/** Every "✅ After" cell from docs/UAT-CRITERIA.md. */
const GUIDE_GOOD_EXAMPLES = [
  "The release workflow triggers on a `v*` tag",
  "`pyproject.toml` declares the 3.13 classifier and the `publish` job",
  "The publish workflow reads `PYPI_API_TOKEN` from secrets",
  "Shared-drive pagination is covered by `test_sync_paginates_shared_drives`",
  "The temporal filter uses `sourceModifiedAt`, covered by a fixture with out-of-order docs",
  "`shield.redact(text, profile)` returns `(redacted_text, token_mapping)`",
  "Round-trip covered by `test_round_trip` across all 3 profiles",
  "`redact_categories` defaults to identifying-only per profile",
  "The full suite passes on this commit",
];

/** Every "❌ Before" cell that the guide says should be rewritten. */
const GUIDE_BAD_EXAMPLES = [
  "Merge the PR once CI is green",
  "Push the v0.2.0 tag",
  "Package is published to PyPI",
  "Set up the `PYPI_API_TOKEN` secret",
  "Sync works against a real Google Drive account",
  "Query returns correct results on production data",
];

/** `.claude/CLAUDE-FACTORY.md` §F2 — auto-appended on Shield/Audit repos. */
const FACTORY_AUTO_CRITERIA = [
  "PHI / privilege / MNPI handling routes through Shield before any LLM call",
  "An audit event is emitted via Ogentic-Audit for every state change",
  "Tenant isolation verified by an explicit test",
];

describe("the guide's good examples survive the linter", () => {
  it.each(GUIDE_GOOD_EXAMPLES)("does not flag: %s", (item) => {
    expect(lint(item).findings).toHaveLength(0);
  });
});

describe("the guide's bad examples are actually caught", () => {
  it.each(GUIDE_BAD_EXAMPLES)("flags: %s", (item) => {
    // If one of these stops being flagged, the guide is teaching a rewrite the
    // linter no longer asks for.
    expect(lint(item).findings.length).toBeGreaterThan(0);
  });
});

describe("the factory's auto-appended compliance criteria", () => {
  it.each(FACTORY_AUTO_CRITERIA)("is never flagged: %s", (item) => {
    expect(lint(item).findings).toHaveLength(0);
  });

  it("passes clean as a complete checklist", () => {
    const result = lint(...FACTORY_AUTO_CRITERIA);
    expect(result.findings).toHaveLength(0);
    expect(result.nothingVerifiable).toBe(false);
  });
});

describe("the guide's [human] examples", () => {
  it.each([
    "[human] Clinician confirms the 15 PHI categories match HIPAA Safe Harbor",
    "[human] Design review: empty state matches the Figma spacing spec",
    "[human] A first-time contributor can follow README §Setup unaided",
  ])("is accepted without a finding: %s", (item) => {
    const result = lint(item);
    expect(result.findings).toHaveLength(0);
    expect(result.humanMarkedItems).toBe(1);
  });
});

describe("the guide's worked checklist", () => {
  it("passes the linter end to end", () => {
    const result = lint(
      "`shield.redact(text, profile)` returns `(redacted_text, token_mapping)`",
      "Round-trip covered by `test_round_trip` across all 3 profiles",
      "`redact_categories` defaults to identifying-only per profile",
      "The full suite passes on this commit",
      "[human] Clinician confirms the therapy categories match HIPAA Safe Harbor",
    );
    expect(result.findings).toHaveLength(0);
    expect(result.humanMarkedItems).toBe(1);
    expect(result.nothingVerifiable).toBe(false);
  });
});
