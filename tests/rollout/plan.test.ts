import { describe, expect, it } from "vitest";

import { planRollout, rolloutPrBody, type RolloutFile } from "../../src/rollout/plan.js";

const FILE_A: RolloutFile = {
  path: ".github/workflows/ogenticai-reviewer.yml",
  content: "name: A\non: pull_request\njobs: {}\n",
};
const FILE_B: RolloutFile = {
  path: ".github/workflows/uat-override.yml",
  content: "name: B\non: issue_comment\njobs: {}\n",
};

describe("planRollout", () => {
  it("includes every file when nothing is installed", () => {
    const plan = planRollout({
      desired: [FILE_A, FILE_B],
      currentContents: {
        [FILE_A.path]: null,
        [FILE_B.path]: null,
      },
    });
    expect(plan.files).toHaveLength(2);
    expect(plan.alreadyInstalled).toEqual([]);
    expect(plan.changed).toBe(true);
  });

  it("skips files that are byte-identical (already installed)", () => {
    const plan = planRollout({
      desired: [FILE_A, FILE_B],
      currentContents: {
        [FILE_A.path]: FILE_A.content,
        [FILE_B.path]: FILE_B.content,
      },
    });
    expect(plan.files).toEqual([]);
    expect(plan.alreadyInstalled).toEqual([FILE_A.path, FILE_B.path]);
    expect(plan.changed).toBe(false);
  });

  it("rewrites files whose content has drifted", () => {
    const plan = planRollout({
      desired: [FILE_A, FILE_B],
      currentContents: {
        [FILE_A.path]: "name: A\non: workflow_dispatch\njobs: {}\n",
        [FILE_B.path]: FILE_B.content,
      },
    });
    expect(plan.files).toEqual([FILE_A]);
    expect(plan.alreadyInstalled).toEqual([FILE_B.path]);
    expect(plan.changed).toBe(true);
  });

  it("treats CRLF line endings as equivalent to LF (no churn on Windows checkouts)", () => {
    const crlf = FILE_A.content.replace(/\n/g, "\r\n");
    const plan = planRollout({
      desired: [FILE_A],
      currentContents: { [FILE_A.path]: crlf },
    });
    expect(plan.changed).toBe(false);
  });

  it("treats trailing whitespace as equivalent (cosmetic-only diffs ignored)", () => {
    const trailingSpaces = FILE_A.content.replace(/^name: A$/m, "name: A   ");
    const plan = planRollout({
      desired: [FILE_A],
      currentContents: { [FILE_A.path]: trailingSpaces },
    });
    expect(plan.changed).toBe(false);
  });

  it("throws when current content is undefined for a desired file", () => {
    expect(() =>
      planRollout({
        desired: [FILE_A],
        currentContents: {},
      }),
    ).toThrow(/no current content provided/);
  });
});

describe("rolloutPrBody", () => {
  it("includes the repo slug, the App install URL, and the OGE-341 link", () => {
    const body = rolloutPrBody({
      repoSlug: "OgenticAI/ogentic-shield",
      appInstallUrl: "https://github.com/apps/ogenticai-reviewer/installations/new",
    });
    expect(body).toContain("OgenticAI/ogentic-shield");
    expect(body).toContain("https://github.com/apps/ogenticai-reviewer/installations/new");
    expect(body).toContain("OGE-341");
    expect(body).toContain("ogenticai-reviewer.yml");
    expect(body).toContain("uat-override.yml");
  });

  it("is byte-identical for the same args (idempotent PR updates)", () => {
    const args = {
      repoSlug: "OgenticAI/agent-sizer",
      appInstallUrl: "https://example.com",
    };
    expect(rolloutPrBody(args)).toBe(rolloutPrBody(args));
  });
});
