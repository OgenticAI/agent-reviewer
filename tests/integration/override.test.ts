/**
 * Tests for the /uat-override flow (OGE-340):
 *   - parseOverrideComment: regex parser robustness
 *   - isMaintainer: permission gate
 *   - applyOverride: end-to-end (Check + Linear comment + label + PR reply)
 *
 * No real network. The Action's bash glue + the CLI's argv parsing are
 * thin enough to skip; everything that could realistically break is here.
 */

import { describe, expect, it } from "vitest";

import {
  applyOverride,
  CHECK_NAME,
  isMaintainer,
  isOverrideAuthorized,
  OVERRIDE_LABEL,
  parseOverrideComment,
  type CheckPublisher,
  type LinearOverrideWriter,
  type PermissionChecker,
  type PrReplyWriter,
} from "../../src/override.js";
import { parseReviewerConfig } from "../../src/config.js";

// ─── Mock builders ───────────────────────────────────────────────────────────

interface MockState {
  checkPublishes: Array<Parameters<CheckPublisher["publish"]>[0]>;
  linearComments: Array<{ issueId: string; body: string }>;
  linearLabels: Array<{ issueId: string; teamId: string; labelName: string }>;
  prReplies: Array<{ owner: string; repo: string; issueNumber: number; body: string }>;
  /** Optional injected failure on a specific clients[step]. */
  failOn?: "check" | "linear:comment" | "linear:label" | "pr:reply";
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    checkPublishes: [],
    linearComments: [],
    linearLabels: [],
    prReplies: [],
    ...overrides,
  };
}

function makeClients(state: MockState): {
  permissions: PermissionChecker;
  check: CheckPublisher;
  linear: LinearOverrideWriter;
  pr: PrReplyWriter;
} {
  return {
    permissions: { async getCollaboratorPermission() { return "admin"; } },
    check: {
      async publish(args) {
        if (state.failOn === "check") throw new Error("check publish failed");
        state.checkPublishes.push(args);
      },
    },
    linear: {
      async createComment(args) {
        if (state.failOn === "linear:comment") throw new Error("comment failed");
        state.linearComments.push(args);
        return { id: `c-${state.linearComments.length}`, body: args.body };
      },
      async upsertLabelOnIssue(args) {
        if (state.failOn === "linear:label") throw new Error("label failed");
        state.linearLabels.push(args);
        return { created: true };
      },
    },
    pr: {
      async reply(args) {
        if (state.failOn === "pr:reply") throw new Error("pr reply failed");
        state.prReplies.push(args);
      },
    },
  };
}

const CONTEXT = {
  pr: {
    owner: "OgenticAI",
    repo: "ogentic-shield",
    number: 1,
    headSha: "abc1234",
    htmlUrl: "https://github.com/OgenticAI/ogentic-shield/pull/1",
  },
  commenter: "davidoladeji-ogenticai",
  ticketId: "OGE-308",
  ticketUuid: "issue-uuid-1",
  ticketTeamId: "team-oge",
};

// ─── parseOverrideComment ────────────────────────────────────────────────────

describe("parseOverrideComment", () => {
  it("parses a simple /uat-override line", () => {
    expect(parseOverrideComment("/uat-override known-flake; merging anyway")).toEqual({
      reason: "known-flake; merging anyway",
    });
  });

  it("trims surrounding whitespace and CRLF in the reason", () => {
    expect(parseOverrideComment("  /uat-override   testing the override path  \n")).toEqual({
      reason: "testing the override path",
    });
  });

  it("matches when the directive appears on its own line within a longer comment", () => {
    const body = ["Some preamble.", "", "/uat-override visual rendering is fine", "", "thx"].join(
      "\n",
    );
    expect(parseOverrideComment(body)).toEqual({
      reason: "visual rendering is fine",
    });
  });

  it("rejects an empty reason — the audit trail needs a reason", () => {
    expect(parseOverrideComment("/uat-override")).toBeNull();
    expect(parseOverrideComment("/uat-override   ")).toBeNull();
    expect(parseOverrideComment("/uat-override\n")).toBeNull();
  });

  it("returns null when the comment doesn't contain the directive", () => {
    expect(parseOverrideComment("LGTM")).toBeNull();
    expect(parseOverrideComment("uat-override no slash")).toBeNull();
    // Random Markdown that mentions the string without the leading slash:
    expect(parseOverrideComment("we discussed `/uat-override` policy")).toBeNull();
  });

  it("captures multi-word reasons including punctuation", () => {
    expect(
      parseOverrideComment("/uat-override #4 is a visual claim — verified by hand"),
    ).toEqual({ reason: "#4 is a visual claim — verified by hand" });
  });
});

// ─── isMaintainer ────────────────────────────────────────────────────────────

describe("isMaintainer", () => {
  function checkerReturning(level: string): PermissionChecker {
    return { async getCollaboratorPermission() { return level; } };
  }

  it.each([
    ["admin", true],
    ["maintain", true],
    ["write", true],
    ["triage", false],
    ["read", false],
    ["none", false],
  ])("level=%s → maintainer=%s", async (level, expected) => {
    expect(await isMaintainer(checkerReturning(level), "x")).toBe(expected);
  });
});

// ─── isOverrideAuthorized (config-aware gate, OGE-1585) ──────────────────────

describe("isOverrideAuthorized", () => {
  function checkerReturning(level: string): PermissionChecker {
    return { async getCollaboratorPermission() { return level; } };
  }
  const admin = checkerReturning("admin");
  const reader = checkerReturning("read");

  const { config: POLICY } = parseReviewerConfig(
    'override_policy:\n  allowed_actors: ["release-captain"]\n',
  );

  it("allows a maintainer when the repo sets no policy", async () => {
    const r = await isOverrideAuthorized({ checker: admin, username: "anyone" });
    expect(r.allowed).toBe(true);
  });

  it("rejects an actor outside override_policy even with admin rights", async () => {
    const r = await isOverrideAuthorized({
      checker: admin,
      username: "someone-else",
      config: POLICY,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/override_policy/);
  });

  it("allows a listed actor who is also a maintainer", async () => {
    const r = await isOverrideAuthorized({
      checker: admin,
      username: "release-captain",
      config: POLICY,
    });
    expect(r.allowed).toBe(true);
  });

  it("never lets the policy grant rights GitHub would refuse", async () => {
    // The policy narrows the collaborator gate; it is not a second way in.
    const r = await isOverrideAuthorized({
      checker: reader,
      username: "release-captain",
      config: POLICY,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/maintainer/);
  });
});

// ─── applyOverride orchestrator ──────────────────────────────────────────────

describe("applyOverride", () => {
  it("publishes a success Check with the right name + override metadata", async () => {
    const state = freshState();
    const result = await applyOverride({
      request: { reason: "known visual regression" },
      context: CONTEXT,
      clients: makeClients(state),
    });

    expect(state.checkPublishes).toHaveLength(1);
    const check = state.checkPublishes[0]!;
    expect(check.name).toBe(CHECK_NAME);
    expect(check.conclusion).toBe("success");
    expect(check.headSha).toBe("abc1234");
    expect(check.title).toContain("@davidoladeji-ogenticai");
    expect(check.summary).toContain("known visual regression");
    expect(result.steps.find((s) => s.step === "check")?.status).toBe("ok");
  });

  it("posts an audit comment on the Linear ticket crediting the commenter", async () => {
    const state = freshState();
    await applyOverride({
      request: { reason: "tested locally" },
      context: CONTEXT,
      clients: makeClients(state),
    });
    expect(state.linearComments).toHaveLength(1);
    const comment = state.linearComments[0]!;
    expect(comment.issueId).toBe("issue-uuid-1");
    expect(comment.body).toContain("@davidoladeji-ogenticai");
    expect(comment.body).toContain("tested locally");
    expect(comment.body).toContain("OgenticAI/ogentic-shield#1");
  });

  it("adds the uat-override label to the Linear ticket", async () => {
    const state = freshState();
    await applyOverride({
      request: { reason: "x" },
      context: CONTEXT,
      clients: makeClients(state),
    });
    expect(state.linearLabels).toEqual([
      { issueId: "issue-uuid-1", teamId: "team-oge", labelName: OVERRIDE_LABEL },
    ]);
  });

  it("replies on the PR confirming the override", async () => {
    const state = freshState();
    await applyOverride({
      request: { reason: "spot-check passed" },
      context: CONTEXT,
      clients: makeClients(state),
    });
    expect(state.prReplies).toHaveLength(1);
    const reply = state.prReplies[0]!;
    expect(reply.body).toContain(":white_check_mark:");
    expect(reply.body).toContain("@davidoladeji-ogenticai");
    expect(reply.body).toContain("spot-check passed");
    expect(reply.body).toContain("OGE-308");
    expect(reply.body).toContain(OVERRIDE_LABEL);
  });

  describe("failure-safety (single failed step doesn't abort others)", () => {
    it("Check publish fails → still posts Linear comment + label + PR reply", async () => {
      const state = freshState({ failOn: "check" });
      const result = await applyOverride({
        request: { reason: "x" },
        context: CONTEXT,
        clients: makeClients(state),
      });
      expect(result.steps.find((s) => s.step === "check")?.status).toBe("error");
      expect(state.linearComments).toHaveLength(1);
      expect(state.linearLabels).toHaveLength(1);
      expect(state.prReplies).toHaveLength(1);
    });

    it("Linear comment fails → still publishes Check + label + PR reply", async () => {
      const state = freshState({ failOn: "linear:comment" });
      const result = await applyOverride({
        request: { reason: "x" },
        context: CONTEXT,
        clients: makeClients(state),
      });
      expect(result.steps.find((s) => s.step === "linear:comment")?.status).toBe("error");
      expect(state.checkPublishes).toHaveLength(1);
      expect(state.linearLabels).toHaveLength(1);
      expect(state.prReplies).toHaveLength(1);
    });

    it("PR reply fails → Check + Linear writes still landed", async () => {
      const state = freshState({ failOn: "pr:reply" });
      const result = await applyOverride({
        request: { reason: "x" },
        context: CONTEXT,
        clients: makeClients(state),
      });
      expect(result.steps.find((s) => s.step === "pr:reply")?.status).toBe("error");
      expect(state.checkPublishes).toHaveLength(1);
      expect(state.linearComments).toHaveLength(1);
      expect(state.linearLabels).toHaveLength(1);
    });
  });
});
