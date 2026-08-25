import { describe, it, expect } from "vitest";

import {
  assessCategory,
  assessMaturity,
  CATEGORIES,
  isJudgement,
  maturityCaveat,
  renderTargets,
  unmappedQuestions,
  type QuestionOutcome,
} from "../../src/engine/audit/maturity.js";
import { loadQuestionSet } from "../../src/engine/audit/questions.js";
import type { AuditFinding } from "../../src/engine/audit/finding.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const REV = "a3f91c2";

function finding(id: string, over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id,
    path: "src/a.ts",
    message: "m",
    severity: "warning",
    source: "audit",
    confidence: "verified",
    evidence: [{ path: "src/a.ts", rev: REV, line: 1 }],
    verifiers: 2,
    refutations: 0,
    ...over,
  };
}

const answered = (...ids: string[]): QuestionOutcome[] =>
  ids.map((id) => ({ id, answered: true }));
const asked = (...ids: string[]): QuestionOutcome[] =>
  ids.map((id) => ({ id, answered: false }));

const ACCESS = CATEGORIES[0]!; // three questions

/* ── The trap the decision creates ────────────────────────────────────────── */

describe("a category nothing looked at", () => {
  // Rating on findings alone means no findings rates well — and a category
  // nothing reached also has no findings. Without this the section rewards us
  // for not looking, invisibly to the reader and flatteringly to us.
  it("is Not Assessed, never a grade", () => {
    const a = assessCategory(ACCESS, [], asked(...ACCESS.questions));
    expect(a.rating).toBe("Not Assessed");
    expect(isJudgement(a.rating)).toBe(false);
  });

  it("is Not Applicable when no question in the run covers it at all", () => {
    const a = assessCategory(ACCESS, [], answered("something-else"));
    expect(a.rating).toBe("Not Applicable");
    expect(isJudgement(a.rating)).toBe(false);
  });

  it.each(["Not Assessed", "Not Applicable"] as const)(
    "%s is not a judgement",
    (rating) => {
      expect(isJudgement(rating)).toBe(false);
    },
  );

  it.each(["Weak", "Moderate", "Satisfactory", "Strong"] as const)(
    "%s is a judgement",
    (rating) => {
      expect(isJudgement(rating)).toBe(true);
    },
  );
});

/* ── Strong is the only rating that claims an absence ─────────────────────── */

describe("Strong has to be earned by asking everything", () => {
  it("is given when every question was answered and nothing was found", () => {
    const a = assessCategory(ACCESS, [], answered(...ACCESS.questions));
    expect(a.rating).toBe("Strong");
    expect(a.answered).toBe(3);
    expect(a.asked).toBe(3);
  });

  // The most important negative case: two of three questions answered, nothing
  // found. That is not evidence of strength, it is evidence of two questions.
  it("is NOT given when only some questions were answered", () => {
    const outcomes = [
      ...answered("authn-completeness", "tenancy-isolation"),
      ...asked("unauthenticated-side-effects"),
    ];
    const a = assessCategory(ACCESS, [], outcomes);

    expect(a.rating).toBe("Satisfactory");
    expect(a.answered).toBe(2);
    expect(a.asked).toBe(3);
  });
});

/* ── Severity decides, confidence never does ──────────────────────────────── */

describe("the rating comes from severity alone", () => {
  it.each([
    ["error", "Weak"],
    ["warning", "Moderate"],
    ["info", "Satisfactory"],
  ] as const)("a %s finding rates the category %s", (severity, rating) => {
    const a = assessCategory(
      ACCESS,
      [finding("authn-completeness-aaaaaaaa", { severity })],
      answered(...ACCESS.questions),
    );
    expect(a.rating).toBe(rating);
  });

  // The whole reason this module exists rather than being folded into severity:
  // ranking a category lower because we are less sure would reintroduce the
  // confidence-into-severity coupling one level up.
  it.each(["verified", "inferred", "not-determinable"] as const)(
    "a %s finding rates the same as any other of its severity",
    (confidence) => {
      const a = assessCategory(
        ACCESS,
        [
          finding("authn-completeness-aaaaaaaa", {
            severity: "error",
            confidence,
          }),
        ],
        answered(...ACCESS.questions),
      );
      expect(a.rating).toBe("Weak");
    },
  );

  it("takes the worst severity in the category, not the most common", () => {
    const a = assessCategory(
      ACCESS,
      [
        finding("authn-completeness-aaaaaaaa", { severity: "info" }),
        finding("tenancy-isolation-bbbbbbbb", { severity: "info" }),
        finding("unauthenticated-side-effects-cccccccc", { severity: "error" }),
      ],
      answered(...ACCESS.questions),
    );
    expect(a.rating).toBe("Weak");
  });

  it("counts only findings from its own questions", () => {
    const a = assessCategory(
      ACCESS,
      [finding("observability-dddddddd", { severity: "error" })],
      answered(...ACCESS.questions),
    );
    expect(a.findings).toBe(0);
    expect(a.rating).toBe("Strong");
  });
});

/* ── The mapping ──────────────────────────────────────────────────────────── */

describe("categories cover the taxonomy", () => {
  // A question nobody mapped would rate no category, and its findings would
  // vanish from this section without anything saying so.
  it("every baseline question belongs to a category", () => {
    const path = fileURLToPath(
      new URL("../../questions/taxonomy.yml", import.meta.url),
    );
    const set = loadQuestionSet(path);
    expect(unmappedQuestions(set.questions)).toEqual([]);
  });

  it("no category is empty, so none is rated on nothing", () => {
    for (const category of CATEGORIES) {
      expect(category.questions.length).toBeGreaterThan(0);
    }
  });

  it("no question is claimed by two categories", () => {
    const all = CATEGORIES.flatMap((c) => c.questions);
    expect(new Set(all).size).toBe(all.length);
  });

  it("assesses every category on every run", () => {
    expect(assessMaturity([], asked("authn-completeness")).length).toBe(
      CATEGORIES.length,
    );
  });

  // An empty run record is not "these categories do not apply" — it is "we have
  // no record". The renderer omits the whole section rather than printing seven
  // rows of Not Applicable, which would read as a judgement.
  it("the renderer omits the table entirely when the run record names no questions", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../../src/engine/audit/render.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/questionOutcomes\.length === 0/);
  });
});

/* ── The caveat under the table ───────────────────────────────────────────── */

describe("what the table says about itself", () => {
  it("names how many categories were not assessed", () => {
    // Every question asked, none answered — the shape of a run whose
    // investigation failed, which is where this warning matters most.
    const allAsked = asked(...CATEGORIES.flatMap((c) => c.questions));
    const caveat = maturityCaveat(assessMaturity([], allAsked));

    expect(caveat).toMatch(/7 categories were not assessed/);
    expect(caveat).toMatch(/not a passing grade/);
  });

  it("names how many ratings rest on some of their questions", () => {
    const outcomes = [
      ...answered("authn-completeness"),
      ...asked("tenancy-isolation", "unauthenticated-side-effects"),
    ];
    expect(maturityCaveat([assessCategory(ACCESS, [], outcomes)])).toMatch(
      /rests on some of its questions/,
    );
  });

  it("always says a rating is not a score", () => {
    expect(
      maturityCaveat(assessMaturity([], asked("authn-completeness"))),
    ).toMatch(/not a score/);
  });
});

/* ── Targets ──────────────────────────────────────────────────────────────── */

describe("Targets", () => {
  const base = {
    origin: "bitbucket.org/acme/acme-web-app",
    name: "acme-web-app",
    rev: "a3f91c2",
    revProvenance: "clone — full history available",
    files: 1000,
    loc: 120000,
    excluded: ["node_modules", "dist"],
  };

  it("names the subject, its origin and its revision", () => {
    const out = renderTargets(base).join("\n");
    expect(out).toContain("acme-web-app");
    expect(out).toContain("bitbucket.org/acme/acme-web-app");
    expect(out).toContain("a3f91c2");
  });

  // A subject with no revision cannot be re-audited against the same code. That
  // is a property of the engagement, not a gap in this section.
  it("says plainly when there is no revision, and what that costs", () => {
    const out = renderTargets({
      ...base,
      rev: null,
      revProvenance: "archive carries no history",
    }).join("\n");
    expect(out).toMatch(/none recorded/);
    expect(out).toMatch(/cannot be repeated/);
    expect(out).toMatch(/cannot be diffed/);
  });

  // node_modules being excluded is the difference between a coverage figure
  // that means something and one that does not.
  it("names the exclusions and what they do to coverage", () => {
    const out = renderTargets(base).join("\n");
    expect(out).toContain("node_modules");
    expect(out).toMatch(/never candidates for review/);
    expect(out).toMatch(/not of everything on disk/);
  });

  it("omits the exclusions section rather than printing an empty one", () => {
    expect(renderTargets({ ...base, excluded: [] }).join("\n")).not.toMatch(
      /Excluded from the walk/,
    );
  });
});

/* ── The caveat has to read as English ────────────────────────────────────── */

describe("singular and plural", () => {
  it("reads correctly for one unassessed category", () => {
    const outcomes = [
      ...answered(
        "authn-completeness",
        "tenancy-isolation",
        "unauthenticated-side-effects",
      ),
      ...asked("observability"),
    ];
    const caveat = maturityCaveat(assessMaturity([], outcomes));

    expect(caveat).toMatch(
      /1 category was not assessed — no question in this run reached it\./,
    );
    expect(caveat).not.toMatch(/reached them/);
  });

  it("reads correctly for one thin rating", () => {
    const outcomes = [
      ...answered("authn-completeness"),
      ...asked("tenancy-isolation", "unauthenticated-side-effects"),
    ];
    const caveat = maturityCaveat([assessCategory(ACCESS, [], outcomes)]);

    expect(caveat).toMatch(/1 rated category rests on some of its questions/);
    expect(caveat).not.toMatch(/some of their/);
  });

  it("reads correctly for several", () => {
    const caveat = maturityCaveat(
      assessMaturity([], asked(...CATEGORIES.flatMap((c) => c.questions))),
    );
    expect(caveat).toMatch(
      /7 categories were not assessed — no question in this run reached them\./,
    );
  });
});
