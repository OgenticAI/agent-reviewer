/**
 * Per-repo reviewer config (OGE-1585).
 *
 * The security-relevant property here is not in this file's code but in its
 * *caller*: config is read from the default branch, never the PR head, because
 * it sets `fail_on` and `override_policy`. Reading it from the PR would let a
 * contributor weaken the merge gate in the same commit the gate is judging.
 * These tests cover the parsing and matching; the branch choice is asserted in
 * the integration test.
 */

import { describe, expect, it } from "vitest";

import {
  clampGuidance,
  EMPTY_CONFIG,
  GUIDANCE_MAX_CHARS,
  isOverrideAllowed,
  matchingLearnedRules,
  matchingPathInstructions,
  parseReviewerConfig,
  triggeredRecipes,
} from "../src/config.js";

const SAMPLE = `
fail_on:
  - NEEDS_WORK
exclude_globs:
  - "generated/**"
path_instructions:
  - glob: "db/migrations/**"
    instructions: "Verify against the schema snapshot in db/schema.sql."
  - glob: "src/**/*.tsx"
    instructions: "Check loading and error states exist."
recipes:
  - triggers: ["migration", "schema"]
    instructions: "Migrations are verified by the snapshot test, not by running them."
override_policy:
  allowed_actors: ["davidoladeji-ogenticai"]
  allowed_teams: ["reviewers"]
`;

describe("parseReviewerConfig", () => {
  it("parses a full config", () => {
    const { config, error } = parseReviewerConfig(SAMPLE);
    expect(error).toBeUndefined();
    expect(config.fail_on).toEqual(["NEEDS_WORK"]);
    expect(config.path_instructions).toHaveLength(2);
    expect(config.recipes?.[0]!.triggers).toEqual(["migration", "schema"]);
  });

  it("returns the empty config for an empty file", () => {
    expect(parseReviewerConfig("").config).toEqual(EMPTY_CONFIG);
    expect(parseReviewerConfig("# just a comment\n").config).toEqual(EMPTY_CONFIG);
  });

  it("degrades to empty on malformed YAML rather than throwing", () => {
    // A broken config must not take down the review — it should just not apply.
    const { config, error } = parseReviewerConfig("path_instructions: [{glob: unclosed");
    expect(config).toEqual(EMPTY_CONFIG);
    expect(error).toMatch(/invalid YAML/);
  });

  it("degrades to empty when the shape is wrong, and says why", () => {
    const { config, error } = parseReviewerConfig("path_instructions:\n  - glob: 12\n");
    expect(config).toEqual(EMPTY_CONFIG);
    expect(error).toMatch(/schema/);
  });

  it("ignores unknown keys rather than rejecting the whole file", () => {
    // Forward compatibility: a repo on a newer config version should not lose
    // every setting because one key is unrecognised here.
    const { config, error } = parseReviewerConfig("fail_on: [NEEDS_WORK]\nfuture_key: yes\n");
    expect(error).toBeUndefined();
    expect(config.fail_on).toEqual(["NEEDS_WORK"]);
  });
});

describe("matchingPathInstructions", () => {
  const { config } = parseReviewerConfig(SAMPLE);

  it("attaches an instruction only to files its glob matches", () => {
    const matches = matchingPathInstructions(config, [
      "db/migrations/001_init.sql",
      "src/app/Page.tsx",
      "README.md",
    ]);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.files).toEqual(["db/migrations/001_init.sql"]);
  });

  it("returns nothing when no changed file matches", () => {
    expect(matchingPathInstructions(config, ["README.md"])).toEqual([]);
  });

  it("does not match across directory boundaries with a single star", () => {
    const { config: single } = parseReviewerConfig(
      'path_instructions:\n  - glob: "src/*.ts"\n    instructions: "x"\n',
    );
    expect(matchingPathInstructions(single, ["src/deep/a.ts"])).toEqual([]);
    expect(matchingPathInstructions(single, ["src/a.ts"])).toHaveLength(1);
  });
});

describe("triggeredRecipes", () => {
  const { config } = parseReviewerConfig(SAMPLE);

  it("fires when a trigger word appears in a checklist item", () => {
    expect(triggeredRecipes(config, ["The migration adds a column"])).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    expect(triggeredRecipes(config, ["SCHEMA snapshot updated"])).toHaveLength(1);
  });

  it("does not fire when no trigger appears", () => {
    expect(triggeredRecipes(config, ["`redact()` round-trips"])).toEqual([]);
  });
});

describe("matchingLearnedRules", () => {
  const { config } = parseReviewerConfig(
    [
      "learned_rules:",
      '  - trigger: "migration"',
      '    glob: "db/**"',
      '    instructions: "Verified by the snapshot job."',
      '    provenance: "OGE-1200 override on PR #48"',
      '  - trigger: "webhook"',
      '    instructions: "Covered by webhook_test.ts."',
      '    provenance: "OGE-1201 sub-issue resolved"',
      "",
    ].join("\n"),
  );

  it("fires an unscoped rule on a checklist keyword alone", () => {
    const rules = matchingLearnedRules(config, ["Webhook signature validated"], []);
    expect(rules.map((r) => r.trigger)).toEqual(["webhook"]);
  });

  it("requires BOTH the trigger and a matching file for a scoped rule", () => {
    const noFile = matchingLearnedRules(config, ["Migration applies cleanly"], ["src/app.ts"]);
    expect(noFile).toEqual([]);
    const withFile = matchingLearnedRules(
      config,
      ["Migration applies cleanly"],
      ["db/migrations/001.sql"],
    );
    expect(withFile.map((r) => r.trigger)).toEqual(["migration"]);
  });

  it("returns nothing when no rule triggers", () => {
    expect(matchingLearnedRules(config, ["Unrelated item"], ["src/app.ts"])).toEqual([]);
  });
});

describe("isOverrideAllowed", () => {
  const { config } = parseReviewerConfig(SAMPLE);

  it("allows a listed actor", () => {
    expect(isOverrideAllowed(config, "davidoladeji-ogenticai")).toBe(true);
  });

  it("is case-insensitive on the actor", () => {
    expect(isOverrideAllowed(config, "DavidOladeji-OgenticAI")).toBe(true);
  });

  it("allows a member of a listed team", () => {
    expect(isOverrideAllowed(config, "someone-else", ["reviewers"])).toBe(true);
  });

  it("denies an actor outside the policy", () => {
    expect(isOverrideAllowed(config, "random-contributor")).toBe(false);
  });

  it("allows everyone when no policy is configured — it narrows, never widens", () => {
    // The GitHub collaborator check still applies; both must pass.
    expect(isOverrideAllowed(EMPTY_CONFIG, "anyone")).toBe(true);
  });

  it("allows everyone when the policy lists nobody", () => {
    const { config: empty } = parseReviewerConfig("override_policy: {}\n");
    expect(isOverrideAllowed(empty, "anyone")).toBe(true);
  });
});

describe("clampGuidance", () => {
  it("passes short guidance through untouched", () => {
    expect(clampGuidance("be careful with migrations")).toBe("be careful with migrations");
  });

  it("truncates long guidance and says so", () => {
    // A long CLAUDE.md must not crowd out the diff it is meant to help review.
    const out = clampGuidance("x".repeat(GUIDANCE_MAX_CHARS + 500));
    expect(out).toMatch(/truncated at \d+ chars/);
    expect(out.length).toBeLessThan(GUIDANCE_MAX_CHARS + 100);
  });
});
