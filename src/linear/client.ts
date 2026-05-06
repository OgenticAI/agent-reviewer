/**
 * Live Linear GraphQL client — implements the `LinearClient` (read) and
 * `LinearWriter` (write) interfaces used by `runReview()` and `runWriteback()`.
 *
 * This file is the only one that talks to Linear over HTTP. Every other
 * module accepts the abstract interfaces, so unit + integration tests can
 * pass mocks. In CI the Action uses this client; in cowork sessions the
 * Claude Code plugin will eventually use the Linear MCP server instead
 * (out-of-scope for OGE-339; the abstract interfaces are the seam).
 */

import type { LinearTicketContext } from "../schema/event.js";
import type { LinearClient as LinearReader } from "../review.js";
import type {
  LinearComment,
  LinearIssueLite,
  LinearWorkflowState,
  LinearWriter,
} from "./writeback.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearGraphqlOptions {
  token: string;
  /** Optional fetch impl injection point (tests). */
  fetchImpl?: typeof fetch;
}

export class LinearGraphqlClient implements LinearReader, LinearWriter {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private viewerIdCache: string | undefined;

  constructor(opts: LinearGraphqlOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ─── Reader ───────────────────────────────────────────────────────────────

  async getIssue(identifier: string): Promise<LinearTicketContext> {
    const data = await this.gql<{
      issue: {
        id: string;
        identifier: string;
        title: string;
        description: string | null;
        url: string;
        state: { name: string; type: string };
        team: { id: string };
      } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          id identifier title description url
          state { name type }
          team { id }
        }
      }`,
      { id: identifier },
    );
    if (!data.issue) {
      throw new Error(`Linear ticket ${identifier} not found (or token lacks access)`);
    }
    return {
      identifier: data.issue.identifier,
      id: data.issue.id,
      title: data.issue.title,
      description: data.issue.description ?? "",
      status: data.issue.state.name,
      url: data.issue.url,
    };
  }

  /** Read the team id + current workflow state type for an issue — needed
   * by `runWriteback()` to decide on transitions. Not part of the
   * `LinearReader` interface used by review; exposed as a public helper. */
  async getIssueMeta(identifier: string): Promise<{
    id: string;
    teamId: string;
    currentStatusType: LinearWorkflowState["type"];
    url: string;
  }> {
    const data = await this.gql<{
      issue: {
        id: string;
        url: string;
        state: { type: LinearWorkflowState["type"] };
        team: { id: string };
      } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          id url
          state { type }
          team { id }
        }
      }`,
      { id: identifier },
    );
    if (!data.issue) throw new Error(`Linear ticket ${identifier} not found`);
    return {
      id: data.issue.id,
      teamId: data.issue.team.id,
      currentStatusType: data.issue.state.type,
      url: data.issue.url,
    };
  }

  // ─── Writer ───────────────────────────────────────────────────────────────

  async listOwnComments(issueId: string): Promise<LinearComment[]> {
    const viewerId = await this.getViewerId();
    const data = await this.gql<{
      issue: { comments: { nodes: Array<{ id: string; body: string; user: { id: string } | null }> } } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          comments(first: 50) {
            nodes { id body user { id } }
          }
        }
      }`,
      { id: issueId },
    );
    const nodes = data.issue?.comments.nodes ?? [];
    return nodes
      .filter((c) => c.user?.id === viewerId)
      .map((c) => ({ id: c.id, body: c.body }));
  }

  async createComment(args: { issueId: string; body: string }): Promise<LinearComment> {
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string; body: string } };
    }>(
      `mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success comment { id body }
        }
      }`,
      args,
    );
    if (!data.commentCreate.success) throw new Error("commentCreate failed");
    return { id: data.commentCreate.comment.id, body: data.commentCreate.comment.body };
  }

  async updateComment(args: { commentId: string; body: string }): Promise<LinearComment> {
    const data = await this.gql<{
      commentUpdate: { success: boolean; comment: { id: string; body: string } };
    }>(
      `mutation($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) {
          success comment { id body }
        }
      }`,
      { id: args.commentId, body: args.body },
    );
    if (!data.commentUpdate.success) throw new Error("commentUpdate failed");
    return { id: data.commentUpdate.comment.id, body: data.commentUpdate.comment.body };
  }

  async listTeamStatuses(teamId: string): Promise<LinearWorkflowState[]> {
    const data = await this.gql<{
      team: { states: { nodes: Array<{ id: string; name: string; type: LinearWorkflowState["type"] }> } } | null;
    }>(
      `query($id: String!) {
        team(id: $id) { states(first: 50) { nodes { id name type } } }
      }`,
      { id: teamId },
    );
    return data.team?.states.nodes ?? [];
  }

  async setIssueStatus(args: { issueId: string; stateId: string }): Promise<void> {
    const data = await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: args.issueId, stateId: args.stateId },
    );
    if (!data.issueUpdate.success) throw new Error("issueUpdate failed");
  }

  async listChildren(parentIssueId: string): Promise<LinearIssueLite[]> {
    const data = await this.gql<{
      issue: { children: { nodes: Array<{ id: string; identifier: string; title: string; url: string }> } } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          children(first: 100) { nodes { id identifier title url } }
        }
      }`,
      { id: parentIssueId },
    );
    return data.issue?.children.nodes ?? [];
  }

  /**
   * Find or create a label on `teamId` and add it to `issueId`. Used by the
   * override flow (OGE-340) to mark tickets that have had their UAT verdict
   * overridden — `uat-override` is the well-known label.
   *
   * Idempotent: if the label already exists on the issue, returns
   * `{ created: false }` without writing.
   */
  async upsertLabelOnIssue(args: {
    issueId: string;
    teamId: string;
    labelName: string;
  }): Promise<{ created: boolean }> {
    // 1) Find the label on the team's label list (or create it).
    const labelId = await this.findOrCreateTeamLabel({
      teamId: args.teamId,
      name: args.labelName,
    });

    // 2) Read existing labels on the issue; skip if already present.
    const existing = await this.gql<{
      issue: { labels: { nodes: Array<{ id: string }> } } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) { labels { nodes { id } } }
      }`,
      { id: args.issueId },
    );
    const present = (existing.issue?.labels.nodes ?? []).some((l) => l.id === labelId);
    if (present) return { created: false };

    // 3) Add the label by appending to the issue's labelIds. Linear's
    //    issueUpdate replaces the list, so we send the full union.
    const allIds = (existing.issue?.labels.nodes ?? []).map((l) => l.id).concat(labelId);
    await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
      }`,
      { id: args.issueId, labelIds: allIds },
    );
    return { created: true };
  }

  private async findOrCreateTeamLabel(args: {
    teamId: string;
    name: string;
  }): Promise<string> {
    const data = await this.gql<{
      team: { labels: { nodes: Array<{ id: string; name: string }> } } | null;
    }>(
      `query($id: String!) {
        team(id: $id) { labels(first: 100) { nodes { id name } } }
      }`,
      { id: args.teamId },
    );
    const existing = (data.team?.labels.nodes ?? []).find(
      (l) => l.name.toLowerCase() === args.name.toLowerCase(),
    );
    if (existing) return existing.id;
    const created = await this.gql<{
      issueLabelCreate: { success: boolean; issueLabel: { id: string } };
    }>(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { id } }
      }`,
      {
        input: { teamId: args.teamId, name: args.name, color: "#F59E0B" },
      },
    );
    if (!created.issueLabelCreate.success) {
      throw new Error(`Could not create Linear label "${args.name}"`);
    }
    return created.issueLabelCreate.issueLabel.id;
  }

  async createChildIssue(args: {
    parentId: string;
    teamId: string;
    title: string;
    description: string;
  }): Promise<LinearIssueLite> {
    const data = await this.gql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; title: string; url: string };
      };
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success issue { id identifier title url }
        }
      }`,
      {
        input: {
          parentId: args.parentId,
          teamId: args.teamId,
          title: args.title,
          description: args.description,
        },
      },
    );
    if (!data.issueCreate.success) throw new Error("issueCreate failed");
    return data.issueCreate.issue;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async getViewerId(): Promise<string> {
    if (this.viewerIdCache) return this.viewerIdCache;
    const data = await this.gql<{ viewer: { id: string } }>(`query { viewer { id } }`, {});
    this.viewerIdCache = data.viewer.id;
    return this.viewerIdCache;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const resp = await this.fetchImpl(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) {
      throw new Error(`Linear API ${resp.status}: ${await resp.text()}`);
    }
    const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `Linear API errors: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!json.data) throw new Error("Linear API returned no data");
    return json.data;
  }
}
