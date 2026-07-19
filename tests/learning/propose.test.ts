/**
 * The feedback loop (OGE-1594).
 *
 * The invariant these tests defend: **no LLM in the acceptance path.** Rule
 * text is the human's own words verbatim, triggers are literal strings,
 * acceptance is a git merge, and demotion comes from outcome telemetry. If any
 * future change routes a proposal through a model, `instructions` would stop
 * matching the input note byte-for-byte and these tests would fail.
 */

import { describe, expect, it } from "vitest";

import {
  deriveGlob,
  deriveTrigger,
  findDemotionCandidates,
  proposeRules,
  type LearningEvent,
} from "../../src/learning/propose.js";
import { renderLearnedRulesYaml, renderLearningPrBody } from "../../src/learning/patch.js";
import { parseReviewerConfig } from "../../src/config.js";
import type { OutcomeRow } from "../../src/metrics/outcomes.js";

describe("deriveTrigger", () => {
  it("picks the most specific (longest) non-stopword token", () => {
    expect(deriveTrigger("The migration adds a column")).toBe("migration");
  });

  it("returns null when the text is all stopwords", () => {
    expect(deriveTrigger("it works and renders cleanly")).toBeNull();
  });
});

describe("deriveGlob", () => {
  it("scopes to a single top-level directory when all paths agree", () => {
    expect(deriveGlob(["db/migrations/001.sql", "db/schema.sql"])).toBe("db/**");
  });

  it("stays unscoped when paths span directories — a wrong glob is worse", () => {
    expect(deriveGlob(["db/x.sql", "src/y.ts"])).toBeUndefined();
    expect(deriveGlob([])).toBeUndefined();
    expect(deriveGlob(undefined)).toBeUndefined();
  });
});

describe("proposeRules", () => {
  const events: LearningEvent[] = [
    {
      kind: "override",
      itemText: "Database migration applies cleanly",
      note: "Migrations are verified by the schema-snapshot job, not by running them.",
      source: "OGE-1200 override on PR #48",
      citedGlobs: ["db/migrations/001.sql"],
    },
    {
      kind: "subissue-resolved",
      itemText: "Webhook signature validated",
      note: "The signature check is covered by tests/webhook_test.ts::rejects_bad_sig.",
      source: "OGE-1201 sub-issue resolved",
    },
  ];

  it("turns each event into a rule using the human's words verbatim", () => {
    const proposals = proposeRules({ events, existing: [] });
    expect(proposals).toHaveLength(2);
    // Verbatim — no paraphrase, because paraphrasing means a model in the loop.
    expect(proposals[0]!.instructions).toBe(events[0]!.note);
    expect(proposals[0]!.trigger).toBe("migration");
    expect(proposals[0]!.glob).toBe("db/**");
    expect(proposals[0]!.provenance).toBe("OGE-1200 override on PR #48");
  });

  it("does not re-propose a rule whose trigger is already learned", () => {
    const proposals = proposeRules({
      events,
      existing: [
        { trigger: "migration", instructions: "x", provenance: "earlier" },
      ],
    });
    // The migration event is suppressed; only the second event survives, with
    // whatever trigger its text derives to.
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.trigger).toBe(deriveTrigger(events[1]!.itemText));
    expect(proposals[0]!.provenance).toBe("OGE-1201 sub-issue resolved");
  });

  it("skips an event whose text yields no usable trigger", () => {
    const proposals = proposeRules({
      events: [{ kind: "override", itemText: "it works", note: "n", source: "s" }],
      existing: [],
    });
    expect(proposals).toEqual([]);
  });
});

describe("findDemotionCandidates", () => {
  function row(overrides: Partial<OutcomeRow>): OutcomeRow {
    return {
      repo: "r",
      pr: 1,
      headSha: "sha",
      ticketId: "OGE-1",
      itemId: 1,
      itemText: "Accessibility audit passes",
      status: "PASS",
      previousStatus: "UNVERIFIABLE",
      outcome: "overridden",
      changedEvidencePaths: [],
      generatedAt: "2026-07-19T00:00:00.000Z",
      ...overrides,
    };
  }

  it("flags a class waved through repeatedly with no code change", () => {
    const rows = [row({}), row({ pr: 2 }), row({ pr: 3 })];
    const demotions = findDemotionCandidates(rows);
    expect(demotions).toHaveLength(1);
    expect(demotions[0]!.trigger).toBe("accessibility");
    expect(demotions[0]!.overriddenWithoutChange).toBe(3);
  });

  it("does not flag a class below the threshold", () => {
    expect(findDemotionCandidates([row({}), row({ pr: 2 })])).toEqual([]);
  });

  it("ignores overrides that came WITH a code change — those aren't noise", () => {
    // Overridden but the code was touched: the reviewer had a point, someone
    // fixed it AND waved it. Not a demotion signal.
    const rows = [
      row({ changedEvidencePaths: ["src/a11y.ts"] }),
      row({ pr: 2, changedEvidencePaths: ["src/a11y.ts"] }),
      row({ pr: 3, changedEvidencePaths: ["src/a11y.ts"] }),
    ];
    expect(findDemotionCandidates(rows)).toEqual([]);
  });

  it("ignores acted-on rows entirely", () => {
    const rows = [
      row({ outcome: "acted-on" }),
      row({ pr: 2, outcome: "acted-on" }),
      row({ pr: 3, outcome: "acted-on" }),
    ];
    expect(findDemotionCandidates(rows)).toEqual([]);
  });
});

describe("config patch rendering", () => {
  const proposals = proposeRules({
    events: [
      {
        kind: "override",
        itemText: "Database migration applies cleanly",
        note: "Migrations are verified by the schema-snapshot job.",
        source: "OGE-1200 override on PR #48",
        citedGlobs: ["db/migrations/001.sql"],
      },
    ],
    existing: [],
  });

  it("emits YAML that parses back into a valid learned_rules config", () => {
    const yaml = renderLearnedRulesYaml(proposals);
    const { config, error } = parseReviewerConfig(yaml);
    expect(error).toBeUndefined();
    expect(config.learned_rules).toHaveLength(1);
    expect(config.learned_rules![0]!.provenance).toBe("OGE-1200 override on PR #48");
    // rationale is for the PR body, not the persisted config
    expect(yaml).not.toContain("rationale");
  });

  it("emits nothing for an empty proposal set", () => {
    expect(renderLearnedRulesYaml([])).toBe("");
  });

  it("PR body leads with the trust model and cites provenance", () => {
    const body = renderLearningPrBody({
      proposals,
      demotions: [
        { trigger: "accessibility", overriddenWithoutChange: 4, sampleItemText: "a11y audit" },
      ],
    });
    expect(body).toContain("merging this PR is how you accept it");
    expect(body).toContain("OGE-1200 override on PR #48");
    expect(body).toContain("no rule was generated or scored by a model");
    // Demotions are a checklist the human owns, never auto-applied.
    expect(body).toContain("- [ ] `accessibility`");
  });
});
