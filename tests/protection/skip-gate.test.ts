/**
 * Making a missing checklist actually block (OGE-1655, option 3).
 *
 * The bypass this closes, measured in production on `ogentic-shield#51`:
 *
 *     OgenticAI Reviewer / UAT: conclusion=skipped
 *     mergeState:               CLEAN
 *
 * A `skipped` conclusion satisfies a required status check, so in the five
 * repos that required the reviewer, omitting a `## UAT checklist` heading
 * merged clean with the check showing as satisfied.
 */

import { describe, expect, it } from "vitest";

import {
  decideSkipGate,
  isDocsFile,
  isDocsOnly,
  parseChecklistPolicy,
} from "../../src/pr/protection/skip-gate.js";

describe("isDocsFile", () => {
  it("treats prose, images and boilerplate as documentation", () => {
    for (const p of [
      "README.md", "docs/INSTALL.md", "guide.mdx", "notes.txt", "spec.rst",
      "LICENSE", "NOTICE", "CODEOWNERS", "docs/img/diagram.png",
      ".github/ISSUE_TEMPLATE/bug.md", ".github/PULL_REQUEST_TEMPLATE.md",
    ]) {
      expect(isDocsFile(p), p).toBe(true);
    }
  });

  it("treats a workflow file as CODE, not documentation", () => {
    // A workflow change can disable the very check under discussion, so it is
    // the last thing that should ride through on a docs carve-out.
    expect(isDocsFile(".github/workflows/ci.yml")).toBe(false);
    expect(isDocsFile(".github/actions/review/action.yml")).toBe(false);
  });

  it("treats config and source as code", () => {
    for (const p of ["src/index.ts", "package.json", "Dockerfile", "db/migrate.sql"]) {
      expect(isDocsFile(p), p).toBe(false);
    }
  });
});

describe("isDocsOnly", () => {
  it("is true only when every file is documentation", () => {
    expect(isDocsOnly(["README.md", "docs/a.md"])).toBe(true);
    expect(isDocsOnly(["README.md", "src/index.ts"])).toBe(false);
  });

  it("treats an EMPTY file list as not docs-only", () => {
    // We couldn't determine what changed. Guessing "harmless" on missing
    // information is how a gate quietly stops gating.
    expect(isDocsOnly([])).toBe(false);
  });
});

describe("parseChecklistPolicy", () => {
  it("defaults to off for anything unrecognised", () => {
    expect(parseChecklistPolicy(undefined)).toBe("off");
    expect(parseChecklistPolicy("")).toBe("off");
    expect(parseChecklistPolicy("yes")).toBe("off");
  });
  it("accepts code and always, case-insensitively", () => {
    expect(parseChecklistPolicy("code")).toBe("code");
    expect(parseChecklistPolicy("ALWAYS")).toBe("always");
  });
});

describe("decideSkipGate", () => {
  const code = ["src/index.ts"];
  const docs = ["README.md"];

  it("never blocks while enforcement is off — today's behaviour is preserved", () => {
    expect(decideSkipGate({ reason: "no-checklist", changedPaths: code, policy: "off" }).blocked).toBe(false);
  });

  it("BLOCKS a code PR with no checklist under `code`", () => {
    const d = decideSkipGate({ reason: "no-checklist", changedPaths: code, policy: "code" });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain("nothing was reviewed");
  });

  it("lets a docs-only PR through under `code`", () => {
    const d = decideSkipGate({ reason: "no-checklist", changedPaths: docs, policy: "code" });
    expect(d.blocked).toBe(false);
    expect(d.reason).toContain("docs-only");
  });

  it("blocks a docs PR under `always`", () => {
    expect(decideSkipGate({ reason: "no-checklist", changedPaths: docs, policy: "always" }).blocked).toBe(true);
  });

  it("blocks a mixed docs+code PR — one code file is enough", () => {
    const d = decideSkipGate({ reason: "no-checklist", changedPaths: [...docs, ...code], policy: "code" });
    expect(d.blocked).toBe(true);
  });

  it("never blocks for a missing TICKET, only a missing checklist", () => {
    // Dependency bumps, factory syncs and hotfixes legitimately carry no
    // ticket. Blocking those makes the reviewer an obstacle, not a gate.
    const d = decideSkipGate({ reason: "no-ticket", changedPaths: code, policy: "always" });
    expect(d.blocked).toBe(false);
    expect(d.reason).toContain("not gateable");
  });

  it("fails CLOSED when the changed-file list is unavailable", () => {
    // isDocsOnly([]) is false, so an API failure listing files blocks rather
    // than waving the PR through.
    const d = decideSkipGate({ reason: "no-checklist", changedPaths: [], policy: "code" });
    expect(d.blocked).toBe(true);
  });
});
