/**
 * Unit tests for `buildReviewPrompt` — focused on the OGE-365 changes:
 *   - The new "## Linked verification comments" section is only present when
 *     the orchestrator passed at least one linked comment.
 *   - Body truncation is reproducible at the documented character cap.
 *   - The softened tick-mark rule (which preserves the anti-rubber-stamp
 *     property) is present.
 *
 * Pinning the prompt text in tests is deliberate: changes to the prompt
 * shape are expected to bump REVIEWER_VERSION in src/version.ts (which
 * invalidates sticky comments under the old prompt). If a test here fails,
 * the right move is usually to bump the version and update the assertion.
 */

import { describe, expect, it } from "vitest";

import {
  buildReviewPrompt,
  LINKED_COMMENT_BODY_MAX_CHARS,
  type LinkedComment,
} from "../../src/prompt/review.js";
import type { LinearTicketContext, PrContext } from "../../src/schema/event.js";
import type { UatChecklist } from "../../src/parser/uat.js";

function makePr(): PrContext {
  return {
    owner: "OgenticAI",
    repo: "ogentic-shield",
    number: 4,
    headSha: "abc123",
    headRef: "david/oge-308-test",
    title: "feat: redaction API",
    body: "(unused by buildReviewPrompt; checklist is passed in directly)",
    author: "davidoladeji-ogenticai",
    createdAt: "2026-04-27T08:00:00.000Z",
  };
}

function makeTicket(): LinearTicketContext {
  return {
    identifier: "OGE-308",
    id: "abc-123",
    title: "Redaction API",
    description: "Add redact()/unredact()",
    status: "In Review",
    url: "https://linear.app/ogenticai/issue/OGE-308",
  };
}

function makeChecklist(items: Array<{ text: string; checked: boolean }>): UatChecklist {
  return {
    items: items.map((it, i) => ({
      id: i + 1,
      text: it.text,
      checked: it.checked,
      line: i + 1,
      links: [],
    })),
    headingLine: 1,
    found: true,
  };
}

const DIFF = "diff --git a/src/foo b/src/foo\n+ added line\n";

describe("buildReviewPrompt — OGE-365 linked verification comments", () => {
  it("omits the new section entirely when no linkedComments are passed", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "item one", checked: false }]),
      diff: DIFF,
    });
    expect(prompt).not.toContain("## Linked verification comments");
  });

  it("omits the new section when linkedComments is an empty array", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "item one", checked: false }]),
      diff: DIFF,
      linkedComments: [],
    });
    expect(prompt).not.toContain("## Linked verification comments");
  });

  it("renders the section with item id, URL, author, createdAt, and fenced body", () => {
    const linkedComment: LinkedComment = {
      itemId: 1,
      sourceUrl:
        "https://github.com/OgenticAI/ogentic-shield/pull/4#issuecomment-4392720381",
      author: "davidoladeji-ogenticai",
      createdAt: "2026-04-27T09:15:00.000Z",
      body: "Verified: pip install 'ogentic-shield[mcp]' resolved mcp 1.27.0",
      truncated: false,
    };
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "pip install works", checked: true }]),
      diff: DIFF,
      linkedComments: [linkedComment],
    });
    expect(prompt).toContain("## Linked verification comments");
    expect(prompt).toContain(
      "Item 1 → comment by @davidoladeji-ogenticai (2026-04-27T09:15:00.000Z)",
    );
    expect(prompt).toContain(
      "https://github.com/OgenticAI/ogentic-shield/pull/4#issuecomment-4392720381",
    );
    expect(prompt).toContain(
      "Verified: pip install 'ogentic-shield[mcp]' resolved mcp 1.27.0",
    );
  });

  it("renders multiple linked comments in the order provided", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([
        { text: "first", checked: true },
        { text: "second", checked: true },
      ]),
      diff: DIFF,
      linkedComments: [
        {
          itemId: 1,
          sourceUrl: "https://github.com/o/r/pull/1#issuecomment-1",
          author: "alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          body: "first verification",
          truncated: false,
        },
        {
          itemId: 2,
          sourceUrl: "https://github.com/o/r/pull/1#issuecomment-2",
          author: "bob",
          createdAt: "2026-01-02T00:00:00.000Z",
          body: "second verification",
          truncated: false,
        },
      ],
    });
    const firstIdx = prompt.indexOf("Item 1 → comment by @alice");
    const secondIdx = prompt.indexOf("Item 2 → comment by @bob");
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("includes the truncation marker when truncated=true", () => {
    const longBody = "x".repeat(LINKED_COMMENT_BODY_MAX_CHARS);
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "item", checked: true }]),
      diff: DIFF,
      linkedComments: [
        {
          itemId: 1,
          sourceUrl: "https://github.com/o/r/pull/1#issuecomment-1",
          author: "alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          body: longBody,
          truncated: true,
        },
      ],
    });
    expect(prompt).toContain("... [truncated]");
  });

  it("does NOT show the truncation marker when truncated=false", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "item", checked: true }]),
      diff: DIFF,
      linkedComments: [
        {
          itemId: 1,
          sourceUrl: "https://github.com/o/r/pull/1#issuecomment-1",
          author: "alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          body: "short body",
          truncated: false,
        },
      ],
    });
    expect(prompt).not.toContain("... [truncated]");
  });

  it("contains the anti-rubber-stamp guard wording", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "x", checked: false }]),
      diff: DIFF,
    });
    // Two load-bearing sentences from OGE-365: PARTIAL ceiling preserved + diff-PASS not constrained.
    expect(prompt).toContain(
      "Self-verification by the author cannot upgrade",
    );
    expect(prompt).toContain(
      "only the diff itself can produce PASS",
    );
  });

  it("contains the negative-path instruction (linked comment with no evidence stays UNVERIFIABLE)", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "x", checked: false }]),
      diff: DIFF,
    });
    expect(prompt).toContain('linked comment had no verification block');
  });

  it("places the new section BEFORE the diff so the model reads evidence first", () => {
    const prompt = buildReviewPrompt({
      pr: makePr(),
      ticket: makeTicket(),
      checklist: makeChecklist([{ text: "x", checked: true }]),
      diff: DIFF,
      linkedComments: [
        {
          itemId: 1,
          sourceUrl: "https://github.com/o/r/pull/1#issuecomment-1",
          author: "alice",
          createdAt: "2026-01-01T00:00:00.000Z",
          body: "evidence",
          truncated: false,
        },
      ],
    });
    const linkedIdx = prompt.indexOf("## Linked verification comments");
    const diffIdx = prompt.indexOf("## Diff to review");
    expect(linkedIdx).toBeGreaterThan(0);
    expect(diffIdx).toBeGreaterThan(linkedIdx);
  });
});
