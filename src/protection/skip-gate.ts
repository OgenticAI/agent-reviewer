/**
 * Make a missing checklist actually block a code PR (OGE-1655, option 3).
 *
 * ── Why option 2 was not enough ─────────────────────────────────────────────
 *
 * The obvious first step was `fail_on: NEEDS_WORK` — block when a verdict says
 * FAIL. It does nothing here, because in the bypass case **there is no
 * verdict**. The reviewer never ran.
 *
 * Measured in production on `ogentic-shield#51`:
 *
 *     OgenticAI Reviewer / UAT: conclusion=skipped
 *     mergeState:               CLEAN
 *
 * A `skipped` conclusion **satisfies a required status check**. So in the five
 * repos that explicitly require the reviewer, omitting a `## UAT checklist`
 * heading merges anyway — with the check showing as satisfied. Combined with a
 * 56–75% skip rate, the gate was bypassed on most PRs in exactly the repos
 * that opted into it.
 *
 * This module is what turns that skip into a failure.
 *
 * ── The docs-only carve-out, defined ────────────────────────────────────────
 *
 * OGE-1655 requires that a docs-only PR is not blocked for lacking a checklist.
 * "Touches code" is easy to say and easy to get wrong, so the rule is stated
 * explicitly and errs toward requiring review:
 *
 *   A PR is docs-only when EVERY changed file is documentation.
 *
 * Anything not on the list counts as code — including `.github/workflows/**`,
 * which is emphatically not documentation: a workflow change can disable the
 * very check under discussion. One unmatched file is enough to require a
 * checklist, because the failure mode we care about is a code change sneaking
 * through inside a docs-shaped PR, not the reverse.
 */

/** Paths treated as documentation. Everything else is code. */
export const DOCS_PATTERNS: readonly RegExp[] = [
  /\.md$/i,
  /\.mdx$/i,
  /\.txt$/i,
  /\.rst$/i,
  /^docs\//i,
  /^\.github\/ISSUE_TEMPLATE\//i,
  /^\.github\/PULL_REQUEST_TEMPLATE/i,
  /^LICENSE$/,
  /^NOTICE$/,
  /^CODEOWNERS$/,
  /\.(png|jpe?g|gif|svg|webp)$/i,
];

export function isDocsFile(path: string): boolean {
  return DOCS_PATTERNS.some((re) => re.test(path));
}

/**
 * Whether every changed file is documentation.
 *
 * An empty file list is NOT docs-only. We couldn't determine what changed, and
 * guessing "harmless" on missing information is how a gate quietly stops
 * gating — the exact failure this ticket exists to close.
 */
export function isDocsOnly(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every(isDocsFile);
}

/**
 * How strictly a missing checklist is enforced.
 *
 * - `off`     — today's behaviour: skip stays a `skipped` check (advisory).
 * - `code`    — a skip blocks unless the PR is docs-only. The recommended step.
 * - `always`  — a skip always blocks, docs included.
 */
export type ChecklistPolicy = "off" | "code" | "always";

export function parseChecklistPolicy(raw: string | undefined): ChecklistPolicy {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "code" || v === "always" ? v : "off";
}

export interface SkipGateDecision {
  /** True when this skip should fail the Check rather than report `skipped`. */
  blocked: boolean;
  reason: string;
}

/**
 * Decide whether a skipped review should block the merge.
 *
 * Only a **missing checklist** is gateable. A missing Linear ticket is
 * deliberately never blocked here: plenty of legitimate PRs (dependency bumps,
 * factory syncs, hotfixes) carry no ticket, and blocking those would make the
 * reviewer an obstacle rather than a gate. That is a separate policy question
 * from "this PR claims acceptance criteria and nobody checked them".
 */
export function decideSkipGate(args: {
  /** Which precondition failed — see `render/skip-comment.ts`. */
  reason: "no-ticket" | "no-checklist" | "unknown";
  /** Repo-relative paths changed by the PR. */
  changedPaths: readonly string[];
  policy: ChecklistPolicy;
}): SkipGateDecision {
  if (args.policy === "off") {
    return { blocked: false, reason: "checklist enforcement is off" };
  }
  if (args.reason !== "no-checklist") {
    return {
      blocked: false,
      reason: `skip reason "${args.reason}" is not gateable — only a missing checklist blocks`,
    };
  }
  if (args.policy === "code" && isDocsOnly(args.changedPaths)) {
    return { blocked: false, reason: "docs-only PR — a checklist is not required" };
  }
  const codeFiles = args.changedPaths.filter((p) => !isDocsFile(p));
  return {
    blocked: true,
    reason:
      `this PR changes ${codeFiles.length} non-documentation file(s) and has no ` +
      `\`## UAT checklist\`, so nothing was reviewed`,
  };
}
