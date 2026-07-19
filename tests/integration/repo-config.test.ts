/**
 * Per-repo config, end-to-end through `runReview` (OGE-1585).
 *
 * The property this file exists to pin: **config is read from the default
 * branch and from nowhere else.** `.agent-reviewer.yml` sets `fail_on` and
 * `override_policy` — both decide whether the PR merges. If the loader ever
 * fell back to the PR head, a contributor could disarm their own merge gate in
 * the same commit the gate is judging, and nothing else in the suite would
 * notice. The reader below fails loudly if any ref other than the default
 * branch is requested.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runReview } from "../../src/review.js";
import type {
  GithubReader,
  LinearClient,
  RunReviewArgs,
  VerdictModel,
} from "../../src/review.js";
import type { RefFileReader } from "../../src/config.js";
import type { LinearTicketContext, PrContext } from "../../src/schema/event.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const PR1_BODY = readFileSync(join(FIXTURES, "pr-1.md"), "utf8");

const DEFAULT_BRANCH = "main";
const HEAD_REF = "david/oge-308-309-redaction-api";

function makePr(overrides: Partial<PrContext> = {}): PrContext {
  return {
    owner: "OgenticAI",
    repo: "ogentic-shield",
    number: 1,
    headSha: "f6299112233aabbccdd",
    headRef: HEAD_REF,
    title: "feat(redaction): add Shield.redact() / Shield.unredact()",
    body: PR1_BODY,
    author: "davidoladeji-ogenticai",
    createdAt: "2026-04-27T08:00:00.000Z",
    defaultBranch: DEFAULT_BRANCH,
    ...overrides,
  };
}

const TICKET: LinearTicketContext = {
  identifier: "OGE-308",
  id: "abc-123",
  title: "Redaction wrapper",
  description: "Add category-aware redaction…",
  status: "In Review",
  url: "https://linear.app/ogenticai/issue/OGE-308",
};

const DIFF = [
  "diff --git a/src/ogentic_shield/redaction.py b/src/ogentic_shield/redaction.py",
  "@@ -1,2 +1,3 @@",
  "+def redact(text): ...",
  "diff --git a/README.md b/README.md",
  "@@ -1,2 +1,3 @@",
  "+## Redaction",
  "",
].join("\n");

const VERDICT_JSON = JSON.stringify({
  items: [1, 2, 3, 4].map((id) => ({
    id,
    itemText: `item ${id}`,
    status: "PASS",
    rationale: "delivered",
    evidenceRefs: [],
  })),
  summary: "fine",
});

/**
 * A reader that throws on any ref other than the default branch.
 *
 * This is the assertion, not a convenience — a silent fallback to the PR head
 * would otherwise look exactly like a passing test.
 */
function makeReader(files: Record<string, string>): RefFileReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readAtRef(path: string, ref: string) {
      if (ref !== DEFAULT_BRANCH) {
        throw new Error(
          `config must be read from the default branch only; got ref "${ref}" for ${path}`,
        );
      }
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

function buildArgs(overrides: Partial<RunReviewArgs> = {}): RunReviewArgs {
  const pr = makePr();
  const github: GithubReader = { getPr: async () => pr, getDiff: async () => DIFF };
  const linear: LinearClient = { getIssue: async () => TICKET };
  const model: VerdictModel = { produce: async () => VERDICT_JSON };
  return {
    pr: { owner: "OgenticAI", repo: "ogentic-shield", number: 1 },
    github,
    linear,
    model,
    now: () => "2026-04-27T08:30:00.000Z",
    ...overrides,
  };
}

/** Capture the prompt the model was handed. */
function capturingModel(): { model: VerdictModel; prompt: () => string } {
  let seen = "";
  return {
    model: {
      produce: async (req) => {
        seen = req.userPrompt;
        return VERDICT_JSON;
      },
    },
    prompt: () => seen,
  };
}

describe("per-repo config, end to end", () => {
  it("reads config only from the default branch, never the PR head", async () => {
    const reader = makeReader({
      ".agent-reviewer.yml": "exclude_globs: []\n",
      "CLAUDE.md": "Repo rule: migrations are snapshot-tested.",
    });
    // The reader throws on any other ref, so completing at all is the assertion.
    await runReview(buildArgs({ configReader: reader }));
    expect(reader.reads).toContain(".agent-reviewer.yml");
    expect(reader.reads).toContain("CLAUDE.md");
  });

  it("skips config entirely when the repo has no default branch recorded", async () => {
    const reader = makeReader({ ".agent-reviewer.yml": "exclude_globs: []\n" });
    const pr = makePr({ defaultBranch: undefined });
    const github: GithubReader = { getPr: async () => pr, getDiff: async () => DIFF };
    await runReview(buildArgs({ github, configReader: reader }));
    expect(reader.reads).toEqual([]);
  });

  it("injects AGENTS.md / CLAUDE.md content into the prompt", async () => {
    const { model, prompt } = capturingModel();
    const reader = makeReader({ "AGENTS.md": "Never trust the author's tick-marks." });
    await runReview(buildArgs({ model, configReader: reader }));
    expect(prompt()).toContain("Repo conventions (from the default branch)");
    expect(prompt()).toContain("Never trust the author's tick-marks.");
  });

  it("attaches a path instruction only when its glob matches a changed file", async () => {
    const { model, prompt } = capturingModel();
    const reader = makeReader({
      ".agent-reviewer.yml": [
        "path_instructions:",
        '  - glob: "src/**/*.py"',
        '    instructions: "Check the type stubs were regenerated."',
        '  - glob: "infra/**"',
        '    instructions: "Never applies to this PR."',
        "",
      ].join("\n"),
    });
    await runReview(buildArgs({ model, configReader: reader }));
    expect(prompt()).toContain("Check the type stubs were regenerated.");
    // The PR touches no infra/ file, so spending context on that rule would be
    // pure noise.
    expect(prompt()).not.toContain("Never applies to this PR.");
  });

  it("injects a recipe only when a checklist keyword triggers it", async () => {
    const { model, prompt } = capturingModel();
    const reader = makeReader({
      ".agent-reviewer.yml": [
        "recipes:",
        '  - triggers: ["README"]',
        '    instructions: "Rendering is checked by the docs job, not by eye."',
        '  - triggers: ["kubernetes"]',
        '    instructions: "Should not fire."',
        "",
      ].join("\n"),
    });
    await runReview(buildArgs({ model, configReader: reader }));
    // pr-1.md's checklist has a README item; it has nothing about kubernetes.
    expect(prompt()).toContain("Rendering is checked by the docs job, not by eye.");
    expect(prompt()).not.toContain("Should not fire.");
  });

  it("applies exclude_globs to the packed diff", async () => {
    const { model, prompt } = capturingModel();
    const reader = makeReader({ ".agent-reviewer.yml": 'exclude_globs: ["README.md"]\n' });
    await runReview(buildArgs({ model, configReader: reader }));
    expect(prompt()).not.toContain("+## Redaction");
    // Excluded is not the same as absent: the model must still know the file
    // changed, or it will read silence as "unchanged" (OGE-1581).
    expect(prompt()).toContain("README.md");
  });

  it("produces a prompt with no guidance section when there is no config", async () => {
    const { model, prompt } = capturingModel();
    await runReview(buildArgs({ model }));
    expect(prompt()).not.toContain("Repo conventions");
  });

  it("survives a malformed config rather than failing the review", async () => {
    const { model, prompt } = capturingModel();
    const reader = makeReader({ ".agent-reviewer.yml": "path_instructions: [{glob: unclosed" });
    const result = await runReview(buildArgs({ model, configReader: reader }));
    expect(result.verdict.items).toHaveLength(4);
    expect(prompt()).not.toContain("Repo conventions");
  });

  it("changes the prompt hash when config changes, busting the cache", async () => {
    // Config is part of the prompt, so a repo that adds a rule must get a fresh
    // verdict rather than the cached one computed without it.
    const a = capturingModel();
    const b = capturingModel();
    await runReview(buildArgs({ model: a.model }));
    await runReview(
      buildArgs({
        model: b.model,
        configReader: makeReader({ "CLAUDE.md": "Repo rule: no raw SQL outside the data layer." }),
      }),
    );
    expect(a.prompt()).not.toBe(b.prompt());
  });
});
