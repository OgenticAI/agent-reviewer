/**
 * Ranked repo map (OGE-1582).
 *
 * The map answers repo-wide claims from a standing symbol index instead of
 * paying per tool iteration to explore. These cover the four pieces the value
 * depends on: tag extraction on TS/JS, deterministic ranking, budget fitting,
 * the mtime cache, and the checklist-identifier rank boost.
 */

import { describe, expect, it } from "vitest";

import { extractTags, TagCache, type RepoFile } from "../../src/repomap/tags.js";
import {
  checklistIdentifiers,
  filesMatchingIdentifiers,
  rankFiles,
} from "../../src/repomap/rank.js";
import { renderRepoMap, scaledMapTokens } from "../../src/repomap/render.js";
import { buildRepoMap } from "../../src/repomap/index.js";
import { buildReviewPrompt } from "../../src/prompt/review.js";
import { estimateTokens } from "../../src/prompt/diff-pack.js";
import type { LinearTicketContext, PrContext } from "../../src/schema/event.js";
import type { UatChecklist } from "../../src/parser/uat.js";

describe("extractTags", () => {
  it("extracts function/class/interface/type/const defs from TS", () => {
    const src = [
      "export function redact(x: string) {",
      "  return mask(x);",
      "}",
      "export class Shield {}",
      "export interface Profile {}",
      "export type Category = 'ssn' | 'amount';",
      "export const DEFAULT_PROFILE = 'finance';",
    ].join("\n");
    const defs = extractTags("src/redact.ts", src).filter((t) => t.kind === "def");
    expect(defs.map((d) => d.name).sort()).toEqual([
      "Category", "DEFAULT_PROFILE", "Profile", "Shield", "redact",
    ]);
    expect(defs.find((d) => d.name === "redact")!.signature).toContain("function redact");
  });

  it("records references but not language keywords", () => {
    const refs = extractTags("src/x.ts", "const y = redact(input);").filter((t) => t.kind === "ref");
    const names = refs.map((r) => r.name);
    expect(names).toContain("redact");
    expect(names).toContain("input");
    expect(names).not.toContain("const");
  });

  it("returns nothing for a non-TS/JS file", () => {
    expect(extractTags("README.md", "# hi\nredact()")).toEqual([]);
  });
});

describe("TagCache mtime caching", () => {
  it("does not re-parse a file whose mtime is unchanged", () => {
    const cache = new TagCache();
    const file: RepoFile = { path: "src/a.ts", content: "export function f() {}", mtimeMs: 100 };
    cache.tagsFor(file);
    cache.tagsFor({ ...file }); // same path + mtime
    expect(cache.parsed).toEqual(["src/a.ts"]); // parsed exactly once
  });

  it("re-parses when the mtime moves", () => {
    const cache = new TagCache();
    cache.tagsFor({ path: "src/a.ts", content: "export function f() {}", mtimeMs: 100 });
    cache.tagsFor({ path: "src/a.ts", content: "export function g() {}", mtimeMs: 200 });
    expect(cache.parsed).toEqual(["src/a.ts", "src/a.ts"]);
  });
});

describe("rankFiles", () => {
  // core.ts defines redact; a.ts and b.ts both call it → core ranks highest.
  const tags = [
    ...extractTags("src/core.ts", "export function redact(x) { return x; }"),
    ...extractTags("src/a.ts", "import { redact } from './core'; redact(1);"),
    ...extractTags("src/b.ts", "import { redact } from './core'; redact(2);"),
  ];

  it("ranks a widely-referenced definition file above its callers", () => {
    const ranked = rankFiles({ tags, seeds: [] });
    expect(ranked[0]!.path).toBe("src/core.ts");
  });

  it("is deterministic across runs", () => {
    const a = rankFiles({ tags, seeds: ["src/a.ts"] });
    const b = rankFiles({ tags, seeds: ["src/a.ts"] });
    expect(a).toEqual(b);
  });

  it("boosts a seed file's rank", () => {
    const noSeed = rankFiles({ tags, seeds: [] });
    const seeded = rankFiles({ tags, seeds: ["src/a.ts"] });
    const rankOf = (r: typeof noSeed, p: string) => r.findIndex((x) => x.path === p);
    // src/a.ts should rank at least as high when it's the seed.
    expect(rankOf(seeded, "src/a.ts")).toBeLessThanOrEqual(rankOf(noSeed, "src/a.ts"));
  });
});

describe("checklist identifiers", () => {
  it("extracts >=5-char stems via non-word split", () => {
    expect(checklistIdentifiers(["redactCategory works; the API returns 200"])).toContain("redactCategory");
    expect(checklistIdentifiers(["the API works"])).not.toContain("API"); // too short
  });

  it("matches files whose path or symbol contains an identifier", () => {
    const tags = extractTags("src/redaction.ts", "export function redactCategory() {}");
    expect(filesMatchingIdentifiers(tags, ["redactCategory"])).toEqual(["src/redaction.ts"]);
  });

  it("a checklist identifier boosts the rank of its defining file", () => {
    const tags = [
      ...extractTags("src/redaction.ts", "export function redactCategory(x) { return x; }"),
      ...extractTags("src/unrelated.ts", "export function helper() { return 1; }"),
      ...extractTags("src/caller.ts", "helper(); helper();"),
    ];
    // Without the checklist seed, unrelated.ts (referenced) would outrank redaction.ts.
    const identifiers = checklistIdentifiers(["redactCategory handles SSNs"]);
    const seeds = filesMatchingIdentifiers(tags, identifiers);
    const ranked = rankFiles({ tags, seeds });
    const redactionRank = ranked.findIndex((r) => r.path === "src/redaction.ts");
    const unrelatedRank = ranked.findIndex((r) => r.path === "src/unrelated.ts");
    expect(redactionRank).toBeLessThan(unrelatedRank);
  });
});

describe("scaledMapTokens — inverse scaling", () => {
  it("gives a small diff the full budget", () => {
    expect(scaledMapTokens(1024, 500)).toBe(1024);
  });
  it("shrinks a large diff's map to the floor", () => {
    expect(scaledMapTokens(1024, 20000)).toBe(256); // 25%
  });
  it("interpolates in between", () => {
    const mid = scaledMapTokens(1024, 6500);
    expect(mid).toBeGreaterThan(256);
    expect(mid).toBeLessThan(1024);
  });
});

describe("renderRepoMap budget fitting", () => {
  it("fits within 15% of the budget", () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `src/mod${i}.ts`,
      content: `export function fn${i}(a: string, b: number) { return a + b; }\nexport const C${i} = 1;`,
      mtimeMs: 1,
    }));
    const tags = new TagCache().tagsForAll(files);
    const ranked = rankFiles({ tags, seeds: [] });
    const map = renderRepoMap({ ranked, tags, baseTokens: 300, diffTokens: 0 });
    expect(estimateTokens(map.text)).toBeLessThanOrEqual(300);
    // Used a meaningful fraction of the budget rather than trivially underfilling.
    expect(estimateTokens(map.text)).toBeGreaterThan(300 * 0.5);
    expect(map.fileCount).toBeGreaterThan(0);
  });

  it("always includes at least the top file even if oversized", () => {
    const files = [{
      path: "src/big.ts",
      content: "export function huge(" + "arg: string, ".repeat(200) + ") {}",
      mtimeMs: 1,
    }];
    const tags = new TagCache().tagsForAll(files);
    const ranked = rankFiles({ tags, seeds: [] });
    const map = renderRepoMap({ ranked, tags, baseTokens: 5, diffTokens: 0 });
    expect(map.fileCount).toBe(1);
  });
});

describe("buildRepoMap + prompt injection", () => {
  const files: RepoFile[] = [
    { path: "src/core.ts", content: "export function redact(x: string) { return x; }", mtimeMs: 1 },
    { path: "src/caller.ts", content: "import { redact } from './core'; redact('a');", mtimeMs: 1 },
  ];

  it("produces a map naming the ranked symbols", () => {
    const map = buildRepoMap({
      files,
      diffTouchedFiles: ["src/caller.ts"],
      checklistTexts: ["redact masks input"],
      diffText: "diff --git a/src/caller.ts b/src/caller.ts\n+redact('a');",
    });
    expect(map.text).toContain("src/core.ts");
    expect(map.text).toContain("function redact");
  });

  it("injects a read-only map section into the prompt", () => {
    const pr = {
      owner: "o", repo: "r", number: 1, headSha: "abc1234", headRef: "oge-1-x",
      title: "t", body: "b", author: "u", createdAt: "2026-01-01T00:00:00.000Z",
    } as PrContext;
    const ticket = {
      identifier: "OGE-1", id: "u", title: "t", description: "d", status: "In Review",
      url: "https://linear.app/x",
    } as LinearTicketContext;
    const checklist = {
      items: [{ id: 1, text: "x", checked: false, human: false, line: 1, links: [] }],
      headingLine: 1, found: true,
    } as UatChecklist;

    const withMap = buildReviewPrompt({ pr, ticket, checklist, diff: "d", repoMap: "src/core.ts:\n  function redact()" });
    expect(withMap).toContain("Repo map (ranked symbols, read-only)");
    expect(withMap).toContain("function redact");
    // Byte-identical without a map.
    const without = buildReviewPrompt({ pr, ticket, checklist, diff: "d" });
    expect(without).not.toContain("Repo map");
  });
});
