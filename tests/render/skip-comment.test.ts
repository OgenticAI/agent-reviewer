/**
 * The "not reviewed" notice (OGE-1655).
 *
 * The property under test: a skipped review must be **loud**. GitHub renders a
 * `skipped` Check in neutral grey next to the green ones, so a silent skip
 * reads as a pass — which made omitting a markdown heading a quiet bypass of
 * the merge gate. Measured at 56–75% of runs on the canary repo, so for most
 * PRs this comment is the reviewer's entire output.
 */

import { describe, expect, it } from "vitest";

import { classifySkip, renderSkipComment } from "../../src/render/skip-comment.js";
import { COMMENT_MARKER } from "../../src/version.js";

const NO_CHECKLIST =
  'No "## UAT checklist" block in the PR description. Skipping review — add a checklist or expect human review.';
const NO_TICKET =
  "No Linear ticket id found in branch / PR body / title. Skipping review — this PR doesn't follow the OGE-NNN convention.";

describe("classifySkip", () => {
  it("recognises a missing checklist", () => {
    expect(classifySkip(NO_CHECKLIST)).toBe("no-checklist");
  });

  it("recognises a missing ticket", () => {
    expect(classifySkip(NO_TICKET)).toBe("no-ticket");
  });

  it("falls back to unknown rather than mislabelling", () => {
    expect(classifySkip("something else entirely")).toBe("unknown");
  });
});

describe("renderSkipComment", () => {
  it("says plainly that no review happened", () => {
    const body = renderSkipComment({ reason: "no-checklist", message: NO_CHECKLIST });
    expect(body).toContain("not reviewed");
    expect(body).toContain("**No UAT verdict was produced for this PR.**");
  });

  it("warns that the skipped check is not a pass", () => {
    // This is the whole point — grey reads as fine at a glance.
    const body = renderSkipComment({ reason: "no-checklist", message: NO_CHECKLIST });
    expect(body).toMatch(/looks[\s\S]*similar to a pass. It is not one/);
  });

  it("names the exact heading, and the near-misses that fail", () => {
    // The real incident used `## Reviewer checklist`.
    const body = renderSkipComment({ reason: "no-checklist", message: NO_CHECKLIST });
    expect(body).toContain("`## UAT checklist`");
    expect(body).toContain("## Reviewer checklist");
  });

  it("tells the author to PUSH — editing the body does not re-trigger", () => {
    // Without this, the obvious fix appears not to work and the author gives up.
    for (const reason of ["no-checklist", "no-ticket"] as const) {
      const body = renderSkipComment({ reason, message: "x" });
      expect(body).toMatch(/Push a commit/);
      expect(body).toMatch(/will _not_ re-run/);
    }
  });

  it("gives ticket-specific remedy for a missing ticket", () => {
    const body = renderSkipComment({ reason: "no-ticket", message: NO_TICKET });
    expect(body).toContain("OGE-NNN".replace("NNN", "123").slice(0, 3)); // OGE
    expect(body).toContain("Copy branch name");
  });

  it("quotes the reviewer's own message so the comment cannot drift from the cause", () => {
    const body = renderSkipComment({ reason: "no-checklist", message: NO_CHECKLIST });
    expect(body).toContain(NO_CHECKLIST);
  });

  it("carries the sticky marker so a later verdict REPLACES it", () => {
    // Not a second comment alongside the verdict — the same sticky slot.
    const body = renderSkipComment({ reason: "unknown", message: "x" });
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it("is deterministic — same skip, byte-identical body", () => {
    const a = renderSkipComment({ reason: "no-checklist", message: NO_CHECKLIST });
    const b = renderSkipComment({ reason: "no-checklist", message: NO_CHECKLIST });
    expect(a).toBe(b);
  });
});
