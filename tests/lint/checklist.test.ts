/**
 * UAT-checklist linter tests (OGE-1559).
 *
 * Fixtures are built by running real PR-body markdown through
 * `parseUatChecklist`, not by hand-constructing `UatItem`s — the marker
 * stripping and the linter have to agree, and hand-built fixtures let them
 * drift silently.
 *
 * The headline cases are drawn from actual punted verdicts: OGE-588 (8 items,
 * all post-merge operator actions), OGE-458 (placeholder checklist), OGE-355
 * (clinician sign-off), OGE-728 (real Drive accounts).
 */

import { describe, expect, it } from "vitest";

import { lintChecklist } from "../../src/lint/checklist.js";
import { parseUatChecklist } from "../../src/parser/uat.js";

function lint(body: string) {
  return lintChecklist(parseUatChecklist(body));
}

function checklist(...items: string[]): string {
  return ["## UAT checklist", "", ...items.map((i) => `- [ ] ${i}`), ""].join("\n");
}

describe("lintChecklist — post-merge actions", () => {
  it("flags merging the PR", () => {
    const result = lint(checklist("Merge the PR once CI is green"));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe("post-merge");
  });

  it("flags work explicitly scoped to after the merge", () => {
    const result = lint(checklist("After merge, confirm the docs site rebuilds"));
    expect(result.findings[0]!.kind).toBe("post-merge");
  });

  it("flags tag pushes and release cuts", () => {
    expect(lint(checklist("Push the v0.2.0 tag")).findings[0]!.kind).toBe("post-merge");
    expect(lint(checklist("Cut a release from main")).findings[0]!.kind).toBe("post-merge");
  });

  it("flags registry publication", () => {
    const result = lint(checklist("Package is published to PyPI and installable"));
    expect(result.findings[0]!.kind).toBe("post-merge");
  });

  it("flags production deploys", () => {
    const result = lint(checklist("Deployed to production without errors"));
    expect(result.findings[0]!.kind).toBe("post-merge");
  });

  it("does NOT flag asserting the release automation exists", () => {
    // The suggested rewrite must survive its own linter, or the advice is a lie.
    const result = lint(checklist("The release workflow triggers on a `v*` tag"));
    expect(result.findings).toHaveLength(0);
  });
});

describe("lintChecklist — operator actions", () => {
  it("flags secret and token setup", () => {
    const result = lint(checklist("Set up the PYPI_API_TOKEN secret in org settings"));
    expect(result.findings[0]!.kind).toBe("operator-action");
  });

  it("flags branch-protection configuration", () => {
    const result = lint(checklist("Configure branch protection to require the check"));
    expect(result.findings[0]!.kind).toBe("operator-action");
  });

  it("flags cross-platform install testing", () => {
    const result = lint(checklist("pip install works on macOS and Windows"));
    expect(result.findings[0]!.kind).toBe("operator-action");
  });

  it("does NOT flag asserting the workflow reads a secret", () => {
    const result = lint(checklist("The publish workflow reads PYPI_API_TOKEN from secrets"));
    expect(result.findings).toHaveLength(0);
  });
});

describe("lintChecklist — production credentials", () => {
  it("flags real third-party accounts (OGE-728 shape)", () => {
    const result = lint(checklist("Sync works against a real Google Drive account"));
    expect(result.findings[0]!.kind).toBe("prod-credentials");
  });

  it("flags assertions against production data", () => {
    const result = lint(checklist("Query returns correct results on production data"));
    expect(result.findings[0]!.kind).toBe("prod-credentials");
  });
});

describe("lintChecklist — subjective criteria", () => {
  it("flags human sign-off (OGE-355 shape)", () => {
    const result = lint(checklist("Clinician sign-off on the DSM-5 category mapping"));
    expect(result.findings[0]!.kind).toBe("subjective");
  });

  it("flags documentation-clarity claims (OGE-322 shape)", () => {
    const result = lint(checklist("The README is clear for a first-time contributor"));
    expect(result.findings[0]!.kind).toBe("subjective");
  });

  it("flags visual design judgment", () => {
    const result = lint(checklist("The dashboard looks right on a retina display"));
    expect(result.findings[0]!.kind).toBe("subjective");
  });

  it("does NOT flag 'renders cleanly on GitHub' — that's mechanically checkable", () => {
    // OGE-1556 verifies this via the markdown-render API. Flagging it as
    // subjective would push authors to mark it [human] and lose the check.
    const result = lint(checklist('README "Redaction" section renders cleanly on GitHub'));
    expect(result.findings).toHaveLength(0);
  });
});

describe("lintChecklist — placeholders", () => {
  it("flags bare placeholder text (OGE-458 shape)", () => {
    for (const text of ["TBD", "TODO", "placeholder", "N/A", "..."]) {
      const result = lint(checklist(text));
      expect(result.findings[0]?.kind, `expected placeholder for ${text}`).toBe("placeholder");
    }
  });

  it("flags vacuous criteria", () => {
    expect(lint(checklist("It works")).findings[0]!.kind).toBe("placeholder");
    expect(lint(checklist("Works as expected")).findings[0]!.kind).toBe("placeholder");
  });

  it("measures length on prose, not markdown syntax", () => {
    // Backticks and link syntax shouldn't inflate a short item past the floor.
    const result = lint(checklist("`[x](y)`"));
    expect(result.findings[0]!.kind).toBe("placeholder");
  });

  it("reports only the placeholder finding, not a stack of others", () => {
    const result = lint(checklist("TBD"));
    expect(result.findings).toHaveLength(1);
  });
});

describe("lintChecklist — [human] marked items", () => {
  it("never flags an item the author already marked [human]", () => {
    const result = lint(checklist("[human] Clinician sign-off on the category mapping"));
    expect(result.findings).toHaveLength(0);
    expect(result.humanMarkedItems).toBe(1);
  });

  it("accepts the bold form authors reach for", () => {
    const result = lint(checklist("**[human]** Clinician sign-off on the mapping"));
    expect(result.findings).toHaveLength(0);
    expect(result.humanMarkedItems).toBe(1);
  });

  it("is case-insensitive", () => {
    const result = lint(checklist("[HUMAN] Design review of the empty state"));
    expect(result.findings).toHaveLength(0);
  });

  it("does not treat a mid-sentence [human] as a marker", () => {
    const result = lint(checklist("Escalates to a [human] reviewer when confidence is low"));
    expect(result.humanMarkedItems).toBe(0);
  });
});

describe("lintChecklist — whole-checklist signals", () => {
  it("sets nothingVerifiable on the OGE-588 shape (all items post-merge)", () => {
    const result = lint(
      checklist(
        "Merge the PR",
        "Set up the PyPI API token",
        "Push the v0.2.0 tag",
        "Package is published to PyPI",
      ),
    );
    expect(result.nothingVerifiable).toBe(true);
    expect(result.flaggedItems).toBe(4);
  });

  it("counts [human] items toward nothingVerifiable", () => {
    // A checklist of nothing but declared-human items is also a checklist the
    // reviewer can't act on — the author should know that.
    const result = lint(checklist("[human] Clinician sign-off", "Merge the PR"));
    expect(result.nothingVerifiable).toBe(true);
  });

  it("stays false when at least one item is checkable", () => {
    const result = lint(checklist("Merge the PR", "`redact()` round-trips across all profiles"));
    expect(result.nothingVerifiable).toBe(false);
    expect(result.flaggedItems).toBe(1);
  });

  it("counts an item once even when it trips several rules", () => {
    const result = lint(checklist("After merge, publish to PyPI from a real account"));
    expect(result.flaggedItems).toBe(1);
    expect(result.findings.length).toBeGreaterThan(1);
    // ...but never twice for the same kind.
    const kinds = result.findings.map((f) => f.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("returns nothing for a well-written checklist", () => {
    const result = lint(
      checklist(
        "`shield.redact(text, profile)` returns `(redacted_text, token_mapping)`",
        "Round-trip covered by `test_round_trip` across all 3 profiles",
        "`redact_categories` defaults to identifying-only per profile",
      ),
    );
    expect(result.findings).toHaveLength(0);
    expect(result.nothingVerifiable).toBe(false);
  });

  it("handles an absent checklist without inventing findings", () => {
    const result = lint("## Summary\n\nNo checklist here.\n");
    expect(result.findings).toHaveLength(0);
    expect(result.totalItems).toBe(0);
    expect(result.nothingVerifiable).toBe(false);
  });
});

describe("lintChecklist — determinism", () => {
  it("produces identical findings across repeated runs", () => {
    const body = checklist("Merge the PR", "TBD", "[human] Design sign-off", "Push the tag");
    expect(JSON.stringify(lint(body))).toBe(JSON.stringify(lint(body)));
  });

  it("orders findings by item id", () => {
    const result = lint(checklist("Valid `foo()` behaviour is covered", "Merge the PR", "TBD"));
    const ids = result.findings.map((f) => f.itemId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
