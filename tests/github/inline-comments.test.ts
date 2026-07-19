/**
 * Inline comment reconciliation (OGE-1586).
 *
 * The idempotency property mirrors sticky.ts at the per-finding level, and the
 * security property is structural: the client surface has no way to submit a
 * formal review or approve — the thing Anthropic forbids claude-code-action
 * from doing. The last test asserts that at the type/shape level.
 */

import { describe, expect, it } from "vitest";

import {
  reconcileInlineComments,
  type InlineCommentClient,
} from "../../src/github/inline-comments.js";
import { inlineMarker, type InlineComment } from "../../src/render/inline.js";

interface State {
  comments: Array<{ id: number; body: string }>;
  created: string[];
  updated: number[];
  deleted: number[];
  nextId: number;
}

function makeClient(initial: Array<{ id: number; body: string }> = []): {
  client: InlineCommentClient;
  state: State;
} {
  const state: State = {
    comments: [...initial],
    created: [],
    updated: [],
    deleted: [],
    nextId: 100,
  };
  const client: InlineCommentClient = {
    async listReviewComments() {
      return state.comments;
    },
    async createReviewComment({ body }) {
      const id = state.nextId++;
      state.comments.push({ id, body });
      state.created.push(body);
      return { id };
    },
    async updateReviewComment({ commentId, body }) {
      state.updated.push(commentId);
      const c = state.comments.find((x) => x.id === commentId);
      if (c) c.body = body;
    },
    async deleteReviewComment({ commentId }) {
      state.deleted.push(commentId);
      state.comments = state.comments.filter((x) => x.id !== commentId);
    },
  };
  return { client, state };
}

function desired(itemId: number, line = 11): InlineComment {
  return {
    path: "src/redact.ts",
    line,
    itemId,
    status: "FAIL",
    body: `${inlineMarker(itemId)}\nFAIL: fix this`,
  };
}

const BASE = { owner: "o", repo: "r", pullNumber: 1, commitId: "sha" };

describe("reconcileInlineComments", () => {
  it("creates a comment for a new finding", async () => {
    const { client, state } = makeClient();
    const r = await reconcileInlineComments({ client, ...BASE, desired: [desired(1)] });
    expect(r.created).toBe(1);
    expect(state.created[0]).toContain(inlineMarker(1));
  });

  it("edits a matching-marker comment in place on re-run", async () => {
    const { client, state } = makeClient([{ id: 55, body: `${inlineMarker(1)}\nold body` }]);
    const r = await reconcileInlineComments({ client, ...BASE, desired: [desired(1)] });
    expect(r.updated).toBe(1);
    expect(r.created).toBe(0);
    expect(state.updated).toEqual([55]);
  });

  it("deletes a stale comment whose finding is gone", async () => {
    // Item 2 was flagged last run but isn't this run — its comment must go.
    const { client, state } = makeClient([
      { id: 55, body: `${inlineMarker(1)}\nx` },
      { id: 56, body: `${inlineMarker(2)}\ny` },
    ]);
    const r = await reconcileInlineComments({ client, ...BASE, desired: [desired(1)] });
    expect(r.deleted).toBe(1);
    expect(state.deleted).toEqual([56]);
  });

  it("never touches comments that aren't ours", async () => {
    const { client, state } = makeClient([{ id: 77, body: "a human review comment" }]);
    await reconcileInlineComments({ client, ...BASE, desired: [] });
    expect(state.deleted).toEqual([]);
    expect(state.updated).toEqual([]);
  });

  it("cannot submit a formal review or approve — the surface has no such method", () => {
    // The security boundary is that the type has no createReview/approve. If a
    // future edit adds one, this test is where the intent is recorded to fail.
    const { client } = makeClient();
    expect("createReview" in client).toBe(false);
    expect("submitReview" in client).toBe(false);
    expect(Object.keys(client).sort()).toEqual([
      "createReviewComment",
      "deleteReviewComment",
      "listReviewComments",
      "updateReviewComment",
    ]);
  });
});
