/**
 * `/uat-override <reason>` slash command — orchestrator.
 *
 * Triggered when a maintainer comments `/uat-override <reason>` on a PR. The
 * agent verifies the commenter's permission, flips the GitHub Check to
 * `success`, posts an audit comment on the linked Linear ticket, and labels
 * the ticket `uat-override`.
 *
 * Like `runReview()` and `runWriteback()`, this is a pure orchestrator with
 * injected dependencies for testability. The CLI's `override-pr` subcommand
 * and the `override` Action both call straight through.
 *
 * Audit invariant: every override creates a Linear comment crediting the
 * commenter and quoting the reason — that's the auditable trail OGE-340
 * requires. Privacy invariant unchanged: the comment carries the reason
 * the commenter typed (which they intend to be public) and a link back to
 * the PR; nothing else.
 */

import type { LinearWriter } from "./linear/writeback.js";
import { LINEAR_COMMENT_MARKER } from "./linear/render-comment.js";

// ─── Parsing ─────────────────────────────────────────────────────────────────

// Match `/uat-override <reason>` on a single line. The reason is everything
// after the first space up to (but not including) the line terminator. We
// deliberately use `[^\n]` rather than `.` (which doesn't match newlines, but
// also wouldn't include carriage returns on CRLF input) and don't use `s` flag
// — multi-line reasons would muddle the audit log.
const OVERRIDE_RE = /^[ \t]*\/uat-override(?:[ \t]+([^\r\n]+))?[ \t]*$/m;

export interface OverrideRequest {
  reason: string;
}

/**
 * Extract `/uat-override <reason>` from a PR comment body. Returns null if
 * the comment isn't an override invocation. The reason is trimmed; an empty
 * reason is rejected (we want a paper trail, not a magic word).
 */
export function parseOverrideComment(body: string): OverrideRequest | null {
  const match = OVERRIDE_RE.exec(body);
  if (!match) return null;
  const reason = (match[1] ?? "").trim();
  if (!reason) return null;
  return { reason };
}

// ─── Permission gate ─────────────────────────────────────────────────────────

/**
 * GitHub returns one of: `none | read | triage | write | maintain | admin`.
 * We accept write/maintain/admin — anyone with merge rights.
 */
const ALLOWED_PERMISSIONS = new Set<string>(["write", "maintain", "admin"]);

export interface PermissionChecker {
  /** Returns the GitHub-API permission level string for `username` on this repo. */
  getCollaboratorPermission(username: string): Promise<string>;
}

export async function isMaintainer(
  checker: PermissionChecker,
  username: string,
): Promise<boolean> {
  const level = await checker.getCollaboratorPermission(username);
  return ALLOWED_PERMISSIONS.has(level);
}

// ─── Override application ───────────────────────────────────────────────────

export interface OverrideContext {
  /** Repo + PR + commenter coordinates from the GitHub event. */
  pr: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
    htmlUrl: string;
  };
  commenter: string;
  /** ID of the Linear ticket to post the audit comment on (e.g. "OGE-308"). */
  ticketId: string;
  /** Linear's internal UUID + team id for the ticket — needed for label upsert. */
  ticketUuid: string;
  ticketTeamId: string;
}

export interface OverrideClients {
  permissions: PermissionChecker;
  /** Sets the `OgenticAI Reviewer / UAT` Check on the PR's head_sha to success. */
  check: CheckPublisher;
  /** Posts the audit comment on Linear + adds the `uat-override` label. */
  linear: LinearOverrideWriter;
  /** Replies to the PR comment confirming the override (so the user gets feedback). */
  pr: PrReplyWriter;
}

export interface CheckPublisher {
  publish(args: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
    conclusion: "success" | "neutral" | "failure" | "skipped";
    title: string;
    summary: string;
  }): Promise<void>;
}

export interface PrReplyWriter {
  reply(args: { owner: string; repo: string; issueNumber: number; body: string }): Promise<void>;
}

/**
 * Slim subset of `LinearWriter` needed for the override audit trail. Reuses
 * the writer type alongside two extras for label upsert.
 */
export type LinearOverrideWriter = Pick<LinearWriter, "createComment"> & {
  upsertLabelOnIssue(args: {
    issueId: string;
    teamId: string;
    labelName: string;
  }): Promise<{ created: boolean }>;
};

export interface ApplyOverrideArgs {
  request: OverrideRequest;
  context: OverrideContext;
  clients: OverrideClients;
}

export interface ApplyOverrideResult {
  /** Steps the agent took, in order. Used by tests + the CLI's audit log. */
  steps: Array<{ step: string; status: "ok" | "error"; message?: string }>;
}

/** The check name we publish — keep in sync with `.github/actions/review/action.yml`. */
export const CHECK_NAME = "OgenticAI Reviewer / UAT";

/** The Linear label we add to the ticket. */
export const OVERRIDE_LABEL = "uat-override";

/**
 * Apply an already-validated override request: flip the Check, post the
 * Linear comment, label the ticket, reply to the commenter on the PR.
 *
 * Each step is wrapped so a single failure doesn't abort the others (mirrors
 * `runWriteback()`'s discipline).
 */
export async function applyOverride(args: ApplyOverrideArgs): Promise<ApplyOverrideResult> {
  const { request, context, clients } = args;
  const result: ApplyOverrideResult = { steps: [] };

  // 1) Flip the GitHub Check to success with an annotation noting the override.
  await safeStep(result.steps, "check", async () => {
    await clients.check.publish({
      owner: context.pr.owner,
      repo: context.pr.repo,
      headSha: context.pr.headSha,
      name: CHECK_NAME,
      conclusion: "success",
      title: `UAT overridden by @${context.commenter}`,
      summary:
        `Override reason: ${request.reason}\n\n` +
        `_Originally failing UAT items remain in the sticky review comment for the audit trail; ` +
        `the override unblocks merge but does not delete the verdict._`,
    });
  });

  // 2) Audit comment on the Linear ticket.
  const linearBody = renderOverrideComment({
    commenter: context.commenter,
    reason: request.reason,
    pr: context.pr,
    ticketId: context.ticketId,
  });
  await safeStep(result.steps, "linear:comment", async () => {
    await clients.linear.createComment({ issueId: context.ticketUuid, body: linearBody });
  });

  // 3) Label the ticket `uat-override` (auto-creates the label on the team if missing).
  await safeStep(result.steps, "linear:label", async () => {
    await clients.linear.upsertLabelOnIssue({
      issueId: context.ticketUuid,
      teamId: context.ticketTeamId,
      labelName: OVERRIDE_LABEL,
    });
  });

  // 4) PR reply confirming the override (UX: user gets visible feedback on their slash command).
  await safeStep(result.steps, "pr:reply", async () => {
    await clients.pr.reply({
      owner: context.pr.owner,
      repo: context.pr.repo,
      issueNumber: context.pr.number,
      body:
        `${LINEAR_COMMENT_MARKER}\n\n` + // re-use the marker so we don't churn — match-by-prefix
        `:white_check_mark: UAT override applied by @${context.commenter}.\n\n` +
        `> ${request.reason}\n\n` +
        `The \`${CHECK_NAME}\` check is now set to success. The Linear ticket \`${context.ticketId}\` ` +
        `has been labelled \`${OVERRIDE_LABEL}\` for audit.`,
    });
  });

  return result;
}

// ─── Audit comment renderer ──────────────────────────────────────────────────

export function renderOverrideComment(args: {
  commenter: string;
  reason: string;
  pr: { owner: string; repo: string; number: number; htmlUrl: string };
  ticketId: string;
}): string {
  return [
    `${LINEAR_COMMENT_MARKER}`,
    ``,
    `**UAT override** applied by @${args.commenter} on [${args.pr.owner}/${args.pr.repo}#${args.pr.number}](${args.pr.htmlUrl}).`,
    ``,
    `**Reason:** ${args.reason}`,
    ``,
    `The \`OgenticAI Reviewer / UAT\` Check has been flipped to success on this PR. ` +
      `The original UAT verdict is preserved in the sticky PR comment — overrides unblock merge ` +
      `but do not erase the audit trail.`,
    ``,
    `---`,
    `_Auto-generated by **OgenticAI Reviewer** · do not edit_`,
  ].join("\n");
}

// ─── failure-safety helper ───────────────────────────────────────────────────

async function safeStep(
  sink: ApplyOverrideResult["steps"],
  step: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    sink.push({ step, status: "ok" });
  } catch (err) {
    sink.push({
      step,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
