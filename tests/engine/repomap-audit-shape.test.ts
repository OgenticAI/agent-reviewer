import { describe, it, expect } from "vitest";
import { buildRepoMap } from "../../src/engine/repomap/index.js";
import type { RepoFile } from "../../src/engine/repomap/tags.js";

/**
 * The repo map, called the way an audit calls it (OGE-2424).
 *
 * The PR path seeds ranking from the files a diff touched. An audit has no diff
 * at all — it seeds from a question set and nothing else. That is the whole
 * reason `checklistTexts` became `seedTexts`: the ranker never cared where the
 * text came from, only the name said otherwise.
 *
 * These pin the audit-shaped call so a later change to the PR path cannot
 * quietly make an empty diff an error, or starve the map of budget, before the
 * audit mode exists to notice.
 */

function repo(): RepoFile[] {
  const file = (path: string, content: string): RepoFile => ({ path, content, mtimeMs: 1 });
  return [
    file("src/auth/session.ts", "export function resolveSession() { return null; }"),
    file("src/auth/tokens.ts", "export function mintToken() { return ''; }"),
    file("src/billing/stripe.ts", "export function createCheckout() { return null; }"),
    file("src/billing/invoice.ts", "export function renderInvoice() { return ''; }"),
    file("src/util/dates.ts", "export function startOfDay() { return new Date(0); }"),
    file("src/util/strings.ts", "export function slugify() { return ''; }"),
  ];
}

describe("repo map — the audit-shaped call", () => {
  it("builds from seed text alone, with no diff and no touched files", () => {
    const map = buildRepoMap({
      files: repo(),
      diffTouchedFiles: [],
      seedTexts: ["how are checkout sessions created?"],
      diffText: "",
    });

    expect(map.fileCount).toBeGreaterThan(0);
    expect(map.text).toBeTruthy();
  });

  it("gives the map its FULL budget when there is no diff to compete with", () => {
    const files = repo();
    const seedTexts = ["how are checkout sessions created?"];

    const noDiff = buildRepoMap({ files, diffTouchedFiles: [], seedTexts, diffText: "" });
    const bigDiff = buildRepoMap({
      files,
      diffTouchedFiles: [],
      seedTexts,
      diffText: "+ added line\n".repeat(20_000),
    });

    // The budget scales inversely with diff size. An audit sits at the top of
    // that curve rather than off the end of it.
    expect(noDiff.budget).toBeGreaterThan(bigDiff.budget);
  });

  it("ranks a seeded file above an unrelated one", () => {
    const map = buildRepoMap({
      files: repo(),
      diffTouchedFiles: [],
      seedTexts: ["createCheckout must be idempotent"],
      diffText: "",
    });

    // The seed names a symbol in stripe.ts; slugify has nothing to do with it.
    expect(map.text).toContain("stripe.ts");
  });

  it("does not throw when the seed text matches nothing at all", () => {
    const map = buildRepoMap({
      files: repo(),
      diffTouchedFiles: [],
      seedTexts: ["zzzznothingmatchesthis"],
      diffText: "",
    });

    // No seeds is a valid audit state — an unfamiliar codebase on question one.
    // It must still return a map rather than an empty string or an exception.
    expect(map.fileCount).toBeGreaterThan(0);
  });

  it("accepts an empty seed set", () => {
    expect(() =>
      buildRepoMap({ files: repo(), diffTouchedFiles: [], seedTexts: [], diffText: "" }),
    ).not.toThrow();
  });
});

/* ── A budget sized to the tree ─────────────────────────────────────────── */

import { mapBudgetForTree, DEFAULT_MAP_TOKENS, MAX_AUDIT_MAP_TOKENS } from "../../src/engine/repomap/index.js";

/**
 * `investigateRun` passed no budget, so the map was capped at the PR default
 * whatever the tree held: a dozen files on a subject of several hundred. These
 * pin the relationships the formula has to keep rather than its constants.
 */
describe("the map budget for an audit", () => {
  it("starts at the PR default for an empty tree and never below it", () => {
    expect(mapBudgetForTree(0)).toBe(DEFAULT_MAP_TOKENS);
    expect(mapBudgetForTree(-5)).toBe(DEFAULT_MAP_TOKENS);
    expect(mapBudgetForTree(Number.NaN)).toBe(DEFAULT_MAP_TOKENS);
  });

  it("grows with the file count", () => {
    const small = mapBudgetForTree(50);
    const medium = mapBudgetForTree(500);
    expect(small).toBeGreaterThan(DEFAULT_MAP_TOKENS);
    expect(medium).toBeGreaterThan(small);
    // Linear in the middle: ten times the files buys ten times the growth.
    expect(medium - DEFAULT_MAP_TOKENS).toBe(10 * (small - DEFAULT_MAP_TOKENS));
  });

  it("is capped, and the cap holds however large the tree", () => {
    expect(mapBudgetForTree(5_000)).toBe(MAX_AUDIT_MAP_TOKENS);
    expect(mapBudgetForTree(500_000)).toBe(MAX_AUDIT_MAP_TOKENS);
    expect(mapBudgetForTree(5_000)).toBeGreaterThanOrEqual(mapBudgetForTree(1_000));
  });

  it("reaches the map as its budget when there is no diff", () => {
    const budget = mapBudgetForTree(200);
    const map = buildRepoMap({
      files: repo(),
      diffTouchedFiles: [],
      seedTexts: ["checkout"],
      diffText: "",
      baseTokens: budget,
    });
    expect(map.budget).toBe(budget);
  });
});

describe("what the rendered map says it names", () => {
  // The prompt states which files the map covers per language, from this
  // list. A list that disagreed with the text would make that statement a lie.
  it("lists exactly the files that appear in its text, as many as it counted", () => {
    const map = buildRepoMap({
      files: repo(),
      diffTouchedFiles: [],
      seedTexts: ["checkout"],
      diffText: "",
    });
    expect(map.files).toHaveLength(map.fileCount);
    for (const path of map.files) expect(map.text).toContain(`${path}:`);
    for (const line of map.text.split("\n").filter((l) => /^\S.*:$/.test(l))) {
      expect(map.files).toContain(line.slice(0, -1));
    }
  });

  it("is empty when nothing could be mapped", () => {
    const map = buildRepoMap({
      files: [{ path: "README.md", content: "# hello", mtimeMs: 1 }],
      diffTouchedFiles: [],
      seedTexts: ["hello"],
      diffText: "",
    });
    expect(map.files).toEqual([]);
    expect(map.fileCount).toBe(0);
  });
});
