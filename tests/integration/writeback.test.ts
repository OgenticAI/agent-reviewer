/**
 * Integration tests for `runWriteback()` — the Linear-side half of OGE-339.
 *
 * The real Linear GraphQL client is replaced with a mock that records every
 * write. Tests assert the orchestrator's behaviour: idempotent comment
 * upsert, correct status transitions, child-issue dedup, and failure-safety
 * (one bad write doesn't kill the others).
 */

import { describe, expect, it } from "vitest";

import { runWriteback, pickStatusTransition } from "../../src/linear/writeback.js";
import type {
  LinearComment,
  LinearIssueLite,
  LinearWorkflowState,
  LinearWriter,
} from "../../src/linear/writeback.js";
import type { ReviewVerdict } from "../../src/schema/verdict.js";
import { LINEAR_COMMENT_MARKER } from "../../src/linear/render-comment.js";
import { REVIEWER_VERSION } from "../../src/version.js";

// ─── Mock LinearWriter ───────────────────────────────────────────────────────

interface MockState {
  ownComments: LinearComment[];
  states: LinearWorkflowState[];
  children: LinearIssueLite[];
  /** Captured calls for assertions. */
  calls: {
    listOwnComments: number;
    createComment: Array<{ issueId: string; body: string }>;
    updateComment: Array<{ commentId: string; body: string }>;
    listTeamStatuses: number;
    setIssueStatus: Array<{ issueId: string; stateId: string }>;
    listChildren: number;
    createChildIssue: Array<{ parentId: string; teamId: string; title: string; description: string }>;
  };
  /** Optional per-step error injection. */
  failOn?: keyof MockState["calls"];
}

function makeWriter(state: MockState): LinearWriter {
  const fail = (step: keyof MockState["calls"]) => {
    if (state.failOn === step) throw new Error(`mock failure on ${step}`);
  };
  return {
    async listOwnComments() {
      fail("listOwnComments");
      state.calls.listOwnComments++;
      return state.ownComments;
    },
    async createComment(args) {
      fail("createComment");
      state.calls.createComment.push(args);
      const c = { id: `c${state.ownComments.length + 1}`, body: args.body };
      state.ownComments.push(c);
      return c;
    },
    async updateComment(args) {
      fail("updateComment");
      state.calls.updateComment.push(args);
      const existing = state.ownComments.find((c) => c.id === args.commentId);
      if (existing) existing.body = args.body;
      return { id: args.commentId, body: args.body };
    },
    async listTeamStatuses() {
      fail("listTeamStatuses");
      state.calls.listTeamStatuses++;
      return state.states;
    },
    async setIssueStatus(args) {
      fail("setIssueStatus");
      state.calls.setIssueStatus.push(args);
    },
    async listChildren() {
      fail("listChildren");
      state.calls.listChildren++;
      return state.children;
    },
    async createChildIssue(args) {
      fail("createChildIssue");
      state.calls.createChildIssue.push(args);
      const id = `child-${state.children.length + 1}`;
      const issue = {
        id,
        identifier: `OGE-${1000 + state.children.length}`,
        title: args.title,
        url: `https://linear.app/ogenticai/issue/${id}`,
      };
      state.children.push(issue);
      return issue;
    },
  };
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    ownComments: [],
    states: [
      { id: "s-backlog", name: "Backlog", type: "backlog" },
      { id: "s-todo", name: "Todo", type: "unstarted" },
      { id: "s-review", name: "In Review", type: "started" },
      { id: "s-merge", name: "Ready to Merge", type: "started" },
      { id: "s-done", name: "Done", type: "completed" },
    ],
    children: [],
    calls: {
      listOwnComments: 0,
      createComment: [],
      updateComment: [],
      listTeamStatuses: 0,
      setIssueStatus: [],
      listChildren: 0,
      createChildIssue: [],
    },
    ...overrides,
  };
}

// ─── Verdict factory ─────────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    schemaVersion: 1,
    reviewerVersion: REVIEWER_VERSION,
    ticketId: "OGE-308",
    prRef: "OgenticAI/ogentic-shield#1",
    headSha: "abc1234",
    items: [
      { id: 1, itemText: "redact() works", status: "PASS", rationale: "ok", evidenceRefs: [] },
      { id: 2, itemText: "amounts preserved", status: "PASS", rationale: "ok", evidenceRefs: [] },
    ],
    summary: "All clear.",
    generatedAt: "2026-04-27T08:30:00.000Z",
    ...overrides,
  };
}

const TICKET = {
  id: "issue-1",
  identifier: "OGE-308",
  teamId: "team-oge",
  url: "https://linear.app/ogenticai/issue/OGE-308",
  currentStatusType: "started" as const,
};

const PR = {
  url: "https://github.com/OgenticAI/ogentic-shield/pull/1",
  ref: "OgenticAI/ogentic-shield#1",
};

// ─── pickStatusTransition (pure rules) ───────────────────────────────────────

describe("pickStatusTransition", () => {
  it("Backlog → In Review on PR open regardless of overall", () => {
    expect(
      pickStatusTransition({ currentType: "backlog", overall: "NEEDS_WORK", ciGreen: false }),
    ).toEqual({ targetName: "In Review" });
    expect(
      pickStatusTransition({ currentType: "unstarted", overall: "PASS", ciGreen: true }),
    ).toEqual({ targetName: "In Review" });
  });

  it("In Review → Ready to Merge only when overall PASSes AND CI green", () => {
    expect(
      pickStatusTransition({ currentType: "started", overall: "PASS", ciGreen: true }),
    ).toEqual({ targetName: "Ready to Merge" });
    expect(
      pickStatusTransition({
        currentType: "started",
        overall: "PASS_WITH_PARTIALS",
        ciGreen: true,
      }),
    ).toEqual({ targetName: "Ready to Merge" });
  });

  it("In Review with CI red is a no-op (we never auto-promote on uncertainty)", () => {
    expect(
      pickStatusTransition({ currentType: "started", overall: "PASS", ciGreen: false }),
    ).toBeNull();
  });

  it("In Review with NEEDS_WORK or HUMAN_REVIEW is a no-op", () => {
    expect(
      pickStatusTransition({ currentType: "started", overall: "NEEDS_WORK", ciGreen: true }),
    ).toBeNull();
    expect(
      pickStatusTransition({ currentType: "started", overall: "HUMAN_REVIEW", ciGreen: true }),
    ).toBeNull();
  });

  it("Done / completed / canceled tickets are never touched", () => {
    expect(
      pickStatusTransition({ currentType: "completed", overall: "NEEDS_WORK", ciGreen: false }),
    ).toBeNull();
    expect(
      pickStatusTransition({ currentType: "canceled", overall: "PASS", ciGreen: true }),
    ).toBeNull();
  });
});

// ─── runWriteback orchestrator ───────────────────────────────────────────────

describe("runWriteback", () => {
  describe("comment upsert", () => {
    it("creates a new comment when none exists", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      expect(plan.comment.action).toBe("create");
      expect(state.calls.createComment).toHaveLength(1);
      expect(state.calls.createComment[0]?.body.startsWith(LINEAR_COMMENT_MARKER)).toBe(true);
    });

    it("updates the existing bot comment when body differs", async () => {
      const state = freshState({
        ownComments: [{ id: "c-old", body: `${LINEAR_COMMENT_MARKER}\nstale body` }],
      });
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      expect(plan.comment.action).toBe("update");
      expect(plan.comment.commentId).toBe("c-old");
      expect(state.calls.createComment).toHaveLength(0);
      expect(state.calls.updateComment).toHaveLength(1);
    });

    it("no-ops when the existing comment body is byte-identical", async () => {
      const verdict = makeVerdict();
      // Run once to capture what the body would be.
      const stateA = freshState();
      await runWriteback({
        writer: makeWriter(stateA),
        verdict,
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      const renderedBody = stateA.ownComments[0]!.body;

      // Now pre-populate a comment with that body and re-run — should no-op.
      const stateB = freshState({
        ownComments: [{ id: "c-existing", body: renderedBody }],
      });
      const plan = await runWriteback({
        writer: makeWriter(stateB),
        verdict,
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      expect(plan.comment.action).toBe("noop");
      expect(stateB.calls.createComment).toHaveLength(0);
      expect(stateB.calls.updateComment).toHaveLength(0);
    });

    it("ignores non-bot comments when finding the sticky one", async () => {
      // listOwnComments only returns the bot's; comments from humans never appear.
      const state = freshState({ ownComments: [] });
      await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      // We created a fresh comment because there was no own-comment to update.
      expect(state.calls.createComment).toHaveLength(1);
    });
  });

  describe("status transition", () => {
    it("transitions Backlog → In Review on first sight", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: { ...TICKET, currentStatusType: "backlog" },
        pr: PR,
        ciGreen: false,
      });
      expect(plan.status.action).toBe("transition");
      expect(plan.status.to).toBe("In Review");
      expect(state.calls.setIssueStatus[0]?.stateId).toBe("s-review");
    });

    it("transitions In Review → Ready to Merge on PASS + CI green", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      expect(plan.status.action).toBe("transition");
      expect(plan.status.to).toBe("Ready to Merge");
      expect(state.calls.setIssueStatus[0]?.stateId).toBe("s-merge");
    });

    it("does NOT transition when CI is red, even on PASS", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      expect(plan.status.action).toBe("noop");
      expect(state.calls.setIssueStatus).toHaveLength(0);
    });

    it("gracefully no-ops when target status doesn't exist on the team", async () => {
      // Drop "Ready to Merge" from the team's states.
      const state = freshState({
        states: [
          { id: "s-backlog", name: "Backlog", type: "backlog" },
          { id: "s-review", name: "In Review", type: "started" },
        ],
      });
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict(),
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
      });
      expect(plan.status.action).toBe("noop");
      expect(plan.status.skipReason).toContain("not found");
      expect(state.calls.setIssueStatus).toHaveLength(0);
    });
  });

  describe("child-issue creation", () => {
    it("creates a child for each FAIL or PARTIAL item", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            { id: 1, itemText: "redact() works", status: "PASS", rationale: "ok", evidenceRefs: [] },
            {
              id: 2,
              itemText: "amounts preserved",
              status: "FAIL",
              rationale: "USD strings still get masked in the finance profile",
              evidenceRefs: [],
            },
            {
              id: 3,
              itemText: "round-trip exact",
              status: "PARTIAL",
              rationale: "passes for finance but partial for therapy",
              evidenceRefs: [],
            },
            {
              id: 4,
              itemText: "renders cleanly",
              status: "UNVERIFIABLE",
              rationale: "visual",
              evidenceRefs: [],
            },
          ],
        }),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      // 1 FAIL + 1 PARTIAL → 2 children
      expect(plan.children).toHaveLength(2);
      expect(plan.children.every((c) => c.action === "create")).toBe(true);
      expect(state.calls.createChildIssue).toHaveLength(2);
      expect(state.calls.createChildIssue[0]?.title).toMatch(/^Fix UAT: /);
    });

    it("promotes still-UNVERIFIABLE items to children only at merge (OGE-1592)", async () => {
      const items = [
        { id: 1, itemText: "redact() works", status: "PASS" as const, rationale: "ok", evidenceRefs: [] },
        {
          id: 2,
          itemText: "renders cleanly on GitHub",
          status: "UNVERIFIABLE" as const,
          rationale: "visual claim, needs a person",
          evidenceRefs: [],
        },
      ];

      // Pre-merge: a punt is a live question, not a follow-up. No child.
      const pre = freshState();
      const prePlan = await runWriteback({
        writer: makeWriter(pre),
        verdict: makeVerdict({ items }),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      expect(prePlan.children).toHaveLength(0);
      expect(pre.calls.createChildIssue).toHaveLength(0);

      // At merge: the question shipped unanswered — file it so it isn't lost.
      const post = freshState();
      const postPlan = await runWriteback({
        writer: makeWriter(post),
        verdict: makeVerdict({ items }),
        ticket: TICKET,
        pr: PR,
        ciGreen: true,
        merged: true,
      });
      expect(postPlan.children).toHaveLength(1);
      expect(post.calls.createChildIssue[0]?.title).toMatch(/renders cleanly/);
    });

    it("does not duplicate a child when one with the same title already exists", async () => {
      const state = freshState({
        children: [
          {
            id: "preexisting",
            identifier: "OGE-9999",
            title: "Fix UAT: amounts preserved",
            url: "x",
          },
        ],
      });
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            {
              id: 1,
              itemText: "amounts preserved",
              status: "FAIL",
              rationale: "regression",
              evidenceRefs: [],
            },
          ],
        }),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      expect(plan.children).toHaveLength(1);
      expect(plan.children[0]?.action).toBe("noop");
      expect(plan.children[0]?.skipReason).toMatch(/already exists/i);
      expect(state.calls.createChildIssue).toHaveLength(0);
    });

    it("truncates very long item text in the child title (under 80 chars)", async () => {
      const longText = "a".repeat(200);
      const state = freshState();
      await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            { id: 1, itemText: longText, status: "FAIL", rationale: "x", evidenceRefs: [] },
          ],
        }),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      const title = state.calls.createChildIssue[0]!.title;
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title).toMatch(/^Fix UAT: /);
      expect(title.endsWith("…")).toBe(true);
    });

    it("strips Markdown decoration from the title (cleaner reading in Linear)", async () => {
      const state = freshState();
      await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            {
              id: 1,
              itemText: "`Shield.unredact()` round-trips [docs](url)",
              status: "FAIL",
              rationale: "x",
              evidenceRefs: [],
            },
          ],
        }),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      const title = state.calls.createChildIssue[0]!.title;
      expect(title).toBe("Fix UAT: Shield.unredact() round-trips docs");
    });

    it("creates no children when verdict has only PASS / UNVERIFIABLE", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            { id: 1, itemText: "x", status: "PASS", rationale: "y", evidenceRefs: [] },
            { id: 2, itemText: "y", status: "UNVERIFIABLE", rationale: "z", evidenceRefs: [] },
          ],
        }),
        ticket: TICKET,
        pr: PR,
        ciGreen: false,
      });
      expect(plan.children).toHaveLength(0);
      expect(state.calls.createChildIssue).toHaveLength(0);
    });
  });

  describe("failure-safety", () => {
    it("a failed status transition does not abort comment / children writes", async () => {
      // Use a Backlog ticket so the transition Backlog→In Review actually fires
      // (and thus setIssueStatus is called and can fail). FAIL verdict gives us
      // a child issue to assert against on the same run.
      const state = freshState({ failOn: "setIssueStatus" });
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            { id: 1, itemText: "x", status: "FAIL", rationale: "y", evidenceRefs: [] },
          ],
        }),
        ticket: { ...TICKET, currentStatusType: "backlog" },
        pr: PR,
        ciGreen: false,
      });
      expect(plan.errors.some((e) => e.step === "status")).toBe(true);
      expect(plan.comment.action).toBe("create");
      expect(plan.children[0]?.action).toBe("create");
    });

    it("a failed createComment does not abort status / children writes", async () => {
      const state = freshState({ failOn: "createComment" });
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            { id: 1, itemText: "x", status: "FAIL", rationale: "y", evidenceRefs: [] },
          ],
        }),
        ticket: { ...TICKET, currentStatusType: "backlog" },
        pr: PR,
        ciGreen: false,
      });
      expect(plan.errors.some((e) => e.step === "comment")).toBe(true);
      expect(plan.status.action).toBe("transition");
      expect(plan.children[0]?.action).toBe("create");
    });
  });

  describe("dry-run", () => {
    it("plans actions without calling any mutation methods", async () => {
      const state = freshState();
      const plan = await runWriteback({
        writer: makeWriter(state),
        verdict: makeVerdict({
          items: [
            { id: 1, itemText: "x", status: "FAIL", rationale: "y", evidenceRefs: [] },
          ],
        }),
        ticket: { ...TICKET, currentStatusType: "backlog" },
        pr: PR,
        ciGreen: false,
        dryRun: true,
      });
      expect(plan.comment.action).toBe("create");
      expect(plan.status).toEqual({ action: "transition", to: "In Review" });
      expect(plan.children[0]?.action).toBe("create");
      // Nothing actually called
      expect(state.calls.createComment).toHaveLength(0);
      expect(state.calls.setIssueStatus).toHaveLength(0);
      expect(state.calls.createChildIssue).toHaveLength(0);
    });
  });
});
