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

import { CONFIG_PATH, isOverrideAllowed, type ReviewerConfig } from "./config.js";
import type { LinearWriter } from "./pr/linear/writeback.js";
import { LINEAR_COMMENT_MARKER } from "./pr/linear/render-comment.js";

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

/**
 * The full override gate: GitHub write access AND the repo's `override_policy`
 * (OGE-1585). Both must pass.
 *
 * The policy can only narrow — a repo that lists nobody, or has no config at
 * all, falls back to the collaborator check alone. It is never a way to grant
 * override rights to someone GitHub would refuse.
 *
 * The policy is read from the default branch, so it cannot be widened from the
 * PR conversation surface or from the PR's own commits.
 */
export async function isOverrideAuthorized(args: {
  checker: PermissionChecker;
  username: string;
  config?: ReviewerConfig;
  /** Team slugs the user belongs to, if the caller resolved them. */
  teams?: string[];
}): Promise<{ allowed: boolean; reason?: string }> {
  if (!(await isMaintainer(args.checker, args.username))) {
    return { allowed: false, reason: "not a maintainer on this repo" };
  }
  if (args.config && !isOverrideAllowed(args.config, args.username, args.teams ?? [])) {
    return { allowed: false, reason: `not listed in \`override_policy\` in ${CONFIG_PATH}` };
  }
  return { allowed: true };
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
  /**
   * The verdict being overridden (OGE-1592). Supplied so the audit trail names
   * WHICH items were force-passed, not just that an override happened.
   *
   * Without this, "resolved by override" is indistinguishable from "the
   * reviewer was right and someone fixed it" in the outcome data — and those
   * two mean opposite things about whether the reviewer is working.
   */
  verdict?: { items: Array<{ id: number; itemText: string; status: string }> };
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
  /**
   * Item ids the override force-passed — everything not already settled
   * positively. Feeds `computeOutcomes()` so these are labelled `overridden`
   * rather than counted as the reviewer being agreed with.
   */
  overriddenItemIds: number[];
}

/** Statuses that were blocking the merge, and so are what an override passes. */
const BLOCKING_STATUSES = new Set<string>(["FAIL", "PARTIAL", "UNVERIFIABLE"]);

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
  const overriddenItems = forcePassedItems(context.verdict);
  const result: ApplyOverrideResult = {
    steps: [],
    overriddenItemIds: overriddenItems.map((i) => i.id),
  };

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
    overriddenItems,
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

/**
 * Items an override actually force-passes.
 *
 * Items already at PASS or CODE_VERIFIED were not blocking anything, so
 * labelling them "overridden" would inflate the override rate with items
 * nobody overrode.
 */
export function forcePassedItems(
  verdict: OverrideContext["verdict"],
): Array<{ id: number; itemText: string; status: string }> {
  return (verdict?.items ?? []).filter((i) => BLOCKING_STATUSES.has(i.status));
}

export function renderOverrideComment(args: {
  commenter: string;
  reason: string;
  pr: { owner: string; repo: string; number: number; htmlUrl: string };
  ticketId: string;
  overriddenItems?: Array<{ id: number; itemText: string; status: string }>;
}): string {
  const itemLines =
    args.overriddenItems && args.overriddenItems.length > 0
      ? [
          ``,
          `**Force-passed items:**`,
          ...args.overriddenItems.map((i) => `- ${i.id}. ${i.itemText} — was \`${i.status}\``),
        ]
      : [];
  return [
    `${LINEAR_COMMENT_MARKER}`,
    ``,
    `**UAT override** applied by @${args.commenter} on [${args.pr.owner}/${args.pr.repo}#${args.pr.number}](${args.pr.htmlUrl}).`,
    ``,
    `**Reason:** ${args.reason}`,
    ...itemLines,
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
