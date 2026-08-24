/**
 * Linear writeback — close the loop back to the ticket.
 *
 * After `runReview()` produces a verdict and the sticky PR comment is upserted,
 * `runWriteback()` does three things on the linked Linear ticket:
 *
 *   1. Upsert a single summary comment (find by marker line, update or create).
 *   2. Transition status:
 *      - Backlog/Todo → "In Review" on first sight of an open PR (idempotent).
 *      - "In Review" → "Ready to Merge" when overall is PASS / PASS_WITH_PARTIALS
 *        AND CI is green (the caller passes `ciGreen`).
 *      - Other transitions are left alone — humans drive them.
 *   3. For each FAIL or PARTIAL item: open a child issue under the parent
 *      with a stable title (idempotent — skip if a child with the same title
 *      already exists).
 *
 * Privacy invariant: nothing in this module ever stores raw PR text or
 * entity content outside Linear's own surface. Comments contain only the
 * verdict summary + per-item rationales (which are model output, not raw
 * input). Child-issue bodies link back to the PR rather than embedding diff
 * content. Mirrors the discipline in `ogentic-shield/audit.py::safe_emit`.
 *
 * Failure-safety: each step is wrapped so a single failed write doesn't
 * abort the others. The whole writeback also returns a structured result
 * so the caller (CLI / Action) can decide how to surface partial success.
 */

import type { ReviewVerdict } from "../../schema/verdict.js";
import { overallStatus, type OverallStatus } from "../../schema/verdict.js";
import { renderLinearComment, LINEAR_COMMENT_MARKER } from "./render-comment.js";

// ─── Linear surface the writer needs ─────────────────────────────────────────

/** A subset of the Linear API surface, swappable between GraphQL and MCP. */
export interface LinearWriter {
  /** Find existing comments authored by the bot account on the given issue. */
  listOwnComments(issueId: string): Promise<LinearComment[]>;
  createComment(args: { issueId: string; body: string }): Promise<LinearComment>;
  updateComment(args: { commentId: string; body: string }): Promise<LinearComment>;

  /** Read the workflow states defined on the issue's team. */
  listTeamStatuses(teamId: string): Promise<LinearWorkflowState[]>;
  /** Patch the issue's `stateId`. No-op-safe at the API layer. */
  setIssueStatus(args: { issueId: string; stateId: string }): Promise<void>;

  /** List children of an issue — used for idempotent child-issue creation. */
  listChildren(parentIssueId: string): Promise<LinearIssueLite[]>;
  createChildIssue(args: {
    parentId: string;
    teamId: string;
    title: string;
    description: string;
  }): Promise<LinearIssueLite>;
}

export interface LinearComment {
  id: string;
  body: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  /** Linear groups workflow states into types: backlog | unstarted | started | completed | canceled | triage. */
  type: "backlog" | "unstarted" | "started" | "completed" | "canceled" | "triage";
}

export interface LinearIssueLite {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface RunWritebackArgs {
  /**
   * Run telemetry for the metrics block (OGE-1562). Optional so existing
   * callers and test mocks keep compiling; absent means a cache-less,
   * tool-less run.
   */
  metrics?: {
    toolCalls?: number;
    researchQueries?: number;
    cached?: boolean;
    degraded?: string;
    /** Punt counts around adjudication (OGE-1587). */
    puntsBefore?: number;
    puntsAfter?: number;
    /** Outcome rates vs the previous verdict (OGE-1592). */
    outcomes?: { actedOnRate: number | null; overrideRate: number | null };
  };
  writer: LinearWriter;
  /** Verdict produced by `runReview()`. */
  verdict: ReviewVerdict;
  /** Linear ticket internal id (UUID), team id, and a friendly URL for back-links. */
  ticket: { id: string; identifier: string; teamId: string; url: string; currentStatusType: LinearWorkflowState["type"] };
  /** GitHub PR coordinates so child issues + comments link back. */
  pr: { url: string; ref: string };
  /** Whether CI is green at the moment writeback runs. Drives the
   * "In Review → Ready to Merge" transition. False is safe; the agent
   * never auto-promotes to Ready to Merge if CI is unknown. */
  ciGreen: boolean;
  /**
   * Suppress all Linear writes; only return the planned actions. Used by
   * the CLI's dry-run mode and by tests that want to assert intent without
   * mutating Linear state.
   */
  dryRun?: boolean;
  /**
   * Whether the PR has merged (OGE-1592). Merge is what turns a still-open
   * punt into a shipped-unanswered question, so it is what promotes
   * UNVERIFIABLE items into follow-up child issues.
   */
  merged?: boolean;
}

export interface WritebackPlan {
  comment: { action: "create" | "update" | "noop"; commentId?: string };
  status: {
    action: "transition" | "noop";
    /** Target state name when action is "transition". */
    to?: string;
    /** Reason the transition was skipped (when action is "noop"). */
    skipReason?: string;
  };
  children: Array<{
    action: "create" | "noop";
    title: string;
    skipReason?: string;
    issueIdentifier?: string;
  }>;
  errors: Array<{ step: string; message: string }>;
}

export async function runWriteback(args: RunWritebackArgs): Promise<WritebackPlan> {
  const plan: WritebackPlan = {
    comment: { action: "noop" },
    status: { action: "noop" },
    children: [],
    errors: [],
  };
  const overall = overallStatus(args.verdict);

  // 1) Comment upsert ---------------------------------------------------------
  const commentBody = renderLinearComment({
    ...(args.metrics ? { metrics: args.metrics } : {}),
    verdict: args.verdict,
    prUrl: args.pr.url,
    overall,
  });
  await safeStep(plan.errors, "comment", async () => {
    if (args.dryRun) {
      plan.comment = { action: "create" };
      return;
    }
    const existing = await args.writer.listOwnComments(args.ticket.id);
    const existingMatch = existing.find((c) => c.body.startsWith(LINEAR_COMMENT_MARKER));
    if (existingMatch && existingMatch.body === commentBody) {
      plan.comment = { action: "noop", commentId: existingMatch.id };
      return;
    }
    if (existingMatch) {
      const updated = await args.writer.updateComment({
        commentId: existingMatch.id,
        body: commentBody,
      });
      plan.comment = { action: "update", commentId: updated.id };
      return;
    }
    const created = await args.writer.createComment({
      issueId: args.ticket.id,
      body: commentBody,
    });
    plan.comment = { action: "create", commentId: created.id };
  });

  // 2) Status transition ------------------------------------------------------
  await safeStep(plan.errors, "status", async () => {
    const transition = pickStatusTransition({
      currentType: args.ticket.currentStatusType,
      overall,
      ciGreen: args.ciGreen,
    });
    if (!transition) {
      plan.status = { action: "noop", skipReason: "no transition rule matched current state" };
      return;
    }
    plan.status = { action: "transition", to: transition.targetName };
    if (args.dryRun) return;

    const states = await args.writer.listTeamStatuses(args.ticket.teamId);
    const target = states.find(
      (s) => s.name.toLowerCase() === transition.targetName.toLowerCase(),
    );
    if (!target) {
      // "Ready to Merge" may not exist yet on the team. Don't fail — log a
      // skip; one-time setup script (`scripts/install-linear-statuses.ts`)
      // creates it. v1 advisory rollout can run without this status.
      plan.status = {
        action: "noop",
        skipReason: `target status "${transition.targetName}" not found on team`,
      };
      return;
    }
    await args.writer.setIssueStatus({ issueId: args.ticket.id, stateId: target.id });
  });

  // 3) Child issues for FAIL / PARTIAL items ---------------------------------
  //
  // At merge, still-UNVERIFIABLE items join them (OGE-1592). Before merge a
  // punt is a live question and filing a ticket for it would be noise on every
  // push; once the PR lands, that question shipped unanswered and nothing else
  // in the system would ever ask it again. `[human]` items are included
  // deliberately — merging means the code went out without the sign-off its
  // author said it needed, which is exactly the follow-up worth owning.
  const followUps = args.verdict.items.filter(
    (it) =>
      it.status === "FAIL" ||
      it.status === "PARTIAL" ||
      (args.merged === true && it.status === "UNVERIFIABLE"),
  );
  if (followUps.length > 0) {
    const existingChildren = args.dryRun
      ? []
      : await safeRead(plan.errors, "children:list", () =>
          args.writer.listChildren(args.ticket.id),
        );

    for (const item of followUps) {
      const title = makeChildTitle(item.itemText);
      const description = makeChildBody({
        prUrl: args.pr.url,
        prRef: args.pr.ref,
        item,
        ticketIdentifier: args.ticket.identifier,
      });
      const dup = (existingChildren ?? []).find(
        (c) => c.title.trim() === title.trim(),
      );
      if (dup) {
        plan.children.push({
          action: "noop",
          title,
          skipReason: "child with same title already exists",
          issueIdentifier: dup.identifier,
        });
        continue;
      }
      if (args.dryRun) {
        plan.children.push({ action: "create", title });
        continue;
      }
      await safeStep(plan.errors, `children:create:${title.slice(0, 32)}`, async () => {
        const created = await args.writer.createChildIssue({
          parentId: args.ticket.id,
          teamId: args.ticket.teamId,
          title,
          description,
        });
        plan.children.push({
          action: "create",
          title,
          issueIdentifier: created.identifier,
        });
      });
    }
  }

  return plan;
}

// ─── Status transition rules ─────────────────────────────────────────────────

interface TransitionRule {
  targetName: string;
}

/**
 * Pure function — easy to test. The caller (the agent) sees the current
 * Linear status type, the overall verdict, and CI signal. Returns the next
 * status name, or null when no transition applies.
 *
 * Rules:
 *   - From `backlog` or `unstarted` (Backlog / Todo): always transition to
 *     "In Review" once a PR exists. The verdict shape doesn't matter — the
 *     ticket is being worked on.
 *   - From `started` ("In Review"): transition to "Ready to Merge" only when
 *     overall is PASS or PASS_WITH_PARTIALS AND CI is green.
 *   - From any other status type (`completed`, `canceled`, etc.): leave alone.
 */
export function pickStatusTransition(args: {
  currentType: LinearWorkflowState["type"];
  overall: OverallStatus;
  ciGreen: boolean;
}): TransitionRule | null {
  if (args.currentType === "backlog" || args.currentType === "unstarted") {
    return { targetName: "In Review" };
  }
  if (args.currentType === "started") {
    if ((args.overall === "PASS" || args.overall === "PASS_WITH_PARTIALS") && args.ciGreen) {
      return { targetName: "Ready to Merge" };
    }
  }
  return null;
}

// ─── Child issue formatting ──────────────────────────────────────────────────

const MAX_TITLE_LEN = 80;
const TITLE_PREFIX = "Fix UAT: ";

export function makeChildTitle(itemText: string): string {
  // Strip Markdown decoration so the Linear title reads cleanly. We don't
  // need to preserve formatting in titles — full text lives in the body.
  const plain = itemText
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const room = MAX_TITLE_LEN - TITLE_PREFIX.length;
  const truncated = plain.length > room ? plain.slice(0, room - 1).trimEnd() + "…" : plain;
  return TITLE_PREFIX + truncated;
}

function makeChildBody(args: {
  prUrl: string;
  prRef: string;
  ticketIdentifier: string;
  item: ReviewVerdict["items"][number];
}): string {
  return [
    `Auto-filed by **OgenticAI Reviewer** from [${args.prRef}](${args.prUrl}).`,
    ``,
    `**Parent:** ${args.ticketIdentifier}`,
    `**Verdict:** ${args.item.status}`,
    ``,
    `**UAT item:**`,
    `> ${args.item.itemText}`,
    ``,
    `**Reviewer rationale:**`,
    `> ${args.item.rationale}`,
    ``,
    `Close this ticket once the underlying gap is fixed in a follow-up PR.`,
    ``,
    `<!-- ogenticai-reviewer-child-v1 -->`,
  ].join("\n");
}

// ─── Failure-safety helpers ──────────────────────────────────────────────────

async function safeStep(
  sink: WritebackPlan["errors"],
  step: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    sink.push({ step, message: err instanceof Error ? err.message : String(err) });
  }
}

async function safeRead<T>(
  sink: WritebackPlan["errors"],
  step: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    sink.push({ step, message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
