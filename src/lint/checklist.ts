/**
 * UAT-checklist linter (OGE-1559).
 *
 * Why this exists: the reviewer punts to a human on ~88% of verdicts, and
 * roughly half of those punts are *correct*. The checklists are aimed at the
 * wrong verifier — they're written as post-deploy observational assertions for
 * a human operator, then handed to a process that runs pre-merge and can only
 * read a diff. OGE-588 is the canonical case: all 8 items were operator-side
 * post-merge actions (merge, PyPI token setup, tag push), so the verdict came
 * back with zero passing items and told the author nothing useful.
 *
 * This linter catches that at PR open/edit and says so plainly, instead of
 * letting the verdict pass produce a zero-pass table that reads like a failure.
 *
 * Design constraints:
 *   - **Deterministic and rule-based, no LLM call.** It runs on every PR open
 *     and edit, and the repo's determinism discipline (see src/review.ts) makes
 *     a nondeterministic advisory comment a churn liability. It also keeps this
 *     ticket independent of the tool-loop work in OGE-1552.
 *   - **Advisory, never blocking.** v1 posts a comment and nothing else. A
 *     linter that blocks merge on style grounds on day one gets overridden and
 *     then ignored.
 *   - **High precision over high recall.** A false positive on a legitimate
 *     criterion costs author trust, which is the only thing making this useful.
 *     When a pattern is ambiguous, leave it out. Recall can grow once the
 *     signal is trusted.
 */

import type { UatChecklist, UatItem } from "../parser/uat.js";

/**
 * What kind of problem an item has. Ordered roughly by how actionable the fix
 * is — `placeholder` means "write a real criterion", `subjective` means "add a
 * `[human]` marker", the rest mean "this belongs in a release runbook".
 */
export type LintFindingKind =
  | "placeholder"
  | "post-merge"
  | "operator-action"
  | "prod-credentials"
  | "subjective";

export interface LintFinding {
  /** 1-based UAT item id this finding applies to (matches `UatItem.id`). */
  itemId: number;
  /** Verbatim item text, for rendering the comment without re-lookup. */
  itemText: string;
  kind: LintFindingKind;
  /** One-sentence explanation, written to the author. */
  message: string;
  /** Concrete rewrite guidance. Rendered as the "try instead" line. */
  suggestion: string;
}

export interface LintResult {
  findings: LintFinding[];
  /** Total items in the checklist (including clean and `[human]`-marked ones). */
  totalItems: number;
  /** Items carrying an explicit `[human]` marker — declared, not flagged. */
  humanMarkedItems: number;
  /** Items with at least one finding. An item is counted once, not per-kind. */
  flaggedItems: number;
  /**
   * True when every item is either flagged or `[human]`-marked — i.e. the
   * verdict pass has nothing it can meaningfully check. This is the OGE-588
   * shape, and the comment leads with it because it's the case where the
   * author most needs to hear "rewrite the checklist", not "one item is odd".
   */
  nothingVerifiable: boolean;
}

/**
 * A rule is a pattern plus the copy we show when it hits. Kept as data rather
 * than code so the pattern list reads like a spec and stays reviewable.
 */
interface LintRule {
  kind: LintFindingKind;
  pattern: RegExp;
  message: string;
  suggestion: string;
}

/**
 * Actions the author or operator performs *after* this PR merges. These are
 * release-runbook steps, not acceptance criteria — nothing in the diff can
 * ever satisfy them, so they are guaranteed UNVERIFIABLE.
 *
 * Drawn from real punts: OGE-588 (merge, PyPI token setup, tag push),
 * OGE-438 (merge, tag, CI observation, PyPI checks, install tests).
 */
const POST_MERGE_RULES: LintRule[] = [
  {
    kind: "post-merge",
    pattern: /\b(?:merge|merging)\s+(?:the\s+|this\s+)?(?:pr|branch|it)\b/i,
    message: "Merging the PR is a step that happens after review, not a thing the PR delivers.",
    suggestion: "Drop this item — the merge itself is the gate, not a criterion.",
  },
  {
    kind: "post-merge",
    // "after merge", "after merging", "once merged", "after the PR is merged".
    pattern: /\b(?:after|once)\s+(?:the\s+)?(?:pr\s+)?(?:is\s+)?merg(?:e|ed|ing)\b|\bpost[- ]merge\b/i,
    message: "This item is explicitly scoped to after the merge, so no pre-merge check can satisfy it.",
    suggestion: "Move it to the ticket's release notes or a follow-up ticket.",
  },
  {
    kind: "post-merge",
    // Up to two intervening tokens so "push the v0.2.0 tag" and "cut a
    // release candidate" match, without letting the verb reach across a whole
    // sentence to a stray "release".
    pattern: /\b(?:push|cut|create|publish)(?:ed|ing)?\s+(?:(?:the|a)\s+)?(?:\S+\s+){0,2}(?:tag|release)\b/i,
    message: "Tagging and cutting a release happen after merge.",
    suggestion: "Assert the release *automation* exists instead — e.g. \"release workflow triggers on a v* tag\".",
  },
  {
    kind: "post-merge",
    pattern: /\b(?:publish|published|appears?|available|live)\b[^.]{0,40}\b(?:on|to)\s+(?:pypi|npm|crates\.io|the registry)\b/i,
    message: "Registry publication happens after merge, so the diff can't show it.",
    suggestion: "Assert the packaging config instead — e.g. \"pyproject.toml declares the 3.13 classifier\".",
  },
  {
    kind: "post-merge",
    pattern: /\bdeploy(?:ed|ing|ment)?\b[^.]{0,30}\b(?:to\s+)?(?:prod|production|staging)\b/i,
    message: "Deployment happens after merge.",
    suggestion: "Assert the deploy config or migration in the diff, and verify the rollout in the ticket.",
  },
];

/**
 * Infrastructure and account setup the operator does by hand. Same problem as
 * post-merge actions — real work, but not work this diff can evidence.
 */
const OPERATOR_RULES: LintRule[] = [
  {
    kind: "operator-action",
    pattern: /\b(?:set\s?up|configure|provision|rotate|register|enable)\b[^.]{0,40}\b(?:token|secret|api[- ]key|credential|iam|service account|webhook|branch protection|environment)\b/i,
    message: "Setting up secrets, roles, or protection rules is operator work outside the diff.",
    suggestion: "Assert what the code *expects* — e.g. \"the workflow reads PYPI_API_TOKEN from secrets\".",
  },
  {
    kind: "operator-action",
    pattern: /\b(?:install|installation|pip install|npm install)\b[^.]{0,40}\b(?:on|across|for)\b[^.]{0,30}\b(?:macos|windows|linux|platform|machine)\b/i,
    message: "Cross-platform install testing needs machines the reviewer doesn't have.",
    suggestion: "Assert the CI matrix covers those platforms, and let CI be the evidence.",
  },
];

/**
 * Items that need live third-party accounts or production data. Unlike the
 * categories above these are *sometimes* automatable — but doing so would mean
 * handing the reviewer production credentials, which is a security decision
 * rather than a capability upgrade. Flagging them pushes toward a rewrite or a
 * `[human]` marker. Drawn from OGE-728 and OGE-850.
 */
const PROD_CREDENTIAL_RULES: LintRule[] = [
  {
    kind: "prod-credentials",
    pattern: /\b(?:real|live|actual)\s+(?:\w+\s+){0,2}(?:account|credential|api\s?key|integration|tenant|customer)s?\b/i,
    message: "Verifying this needs live third-party accounts the reviewer has no credentials for.",
    suggestion: "Cover the logic with a recorded/mocked integration test, and mark the live check `[human]`.",
  },
  {
    kind: "prod-credentials",
    pattern: /\b(?:production|prod)\s+(?:data|traffic|environment|account|database)\b/i,
    message: "This asserts behaviour against production, which the reviewer can't reach pre-merge.",
    suggestion: "Split it: assert the code path in a test here, verify prod behaviour in the ticket after rollout.",
  },
];

/**
 * Criteria that need a person's judgment. These are *correct* punts — the fix
 * is to declare them with `[human]`, not to automate them. Drawn from OGE-322
 * ("documentation clarity requires human judgment") and OGE-355 ("clinician
 * sign-off").
 *
 * Deliberately narrow. "Renders cleanly on GitHub" is NOT here: that's
 * mechanically checkable via the markdown-render API (OGE-1556), and flagging
 * it as subjective would send authors the wrong way.
 */
const SUBJECTIVE_RULES: LintRule[] = [
  {
    kind: "subjective",
    pattern: /\bsign[- ]?off\b|\b(?:approved?|approval)\s+by\b|\b(?:clinician|counsel|legal|sme)\s+(?:review|approval|sign)/i,
    message: "Human sign-off can't be evidenced by a diff, and shouldn't be.",
    suggestion: "Keep it, but mark it `[human]` so it stops counting against the merge gate.",
  },
  {
    kind: "subjective",
    pattern: /\b(?:docs?|documentation|readme|guide|copy|wording|error message)\b[^.]{0,30}\b(?:is|are|reads?|feels?)\b[^.]{0,20}\b(?:clear|readable|understandable|helpful|obvious)\b/i,
    message: "Documentation clarity is a judgment call, not a checkable property.",
    suggestion: "Mark it `[human]`, or replace it with something concrete like \"README documents every public method\".",
  },
  {
    kind: "subjective",
    pattern: /\b(?:looks?|feels?)\s+(?:good|right|correct|polished)\b|\b(?:visually|aesthetically)\b|\bdesign\s+match(?:es)?\b/i,
    message: "Visual design judgment needs a person looking at it.",
    suggestion: "Mark it `[human]`, or pin it to something measurable (a specific token, spacing value, or contrast ratio).",
  },
];

/**
 * Placeholder text — the checklist was templated and never filled in. OGE-458
 * is the live example: the items had no relationship to the ticket at all.
 *
 * These are exact-ish shapes rather than fuzzy matches, because a false
 * positive here ("your criterion is meaningless") is the most annoying kind.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^(?:tbd|todo|t\.b\.d\.?|n\/a|na|xxx|placeholder|fill (?:this )?in|\.{2,}|-+|_+)$/i,
  /^(?:item|criterion|criteria|step|check)\s*\d*$/i,
  /^(?:it works?|works?|works? as expected|works? correctly|should work|no regressions?)$/i,
  /\blorem ipsum\b/i,
];

/** Below this many characters an item can't carry a real criterion. */
const MIN_MEANINGFUL_LENGTH = 12;

const ALL_RULES: LintRule[] = [
  ...POST_MERGE_RULES,
  ...OPERATOR_RULES,
  ...PROD_CREDENTIAL_RULES,
  ...SUBJECTIVE_RULES,
];

/**
 * Lint a parsed UAT checklist.
 *
 * Pure function of the checklist — same input, same findings, in a stable
 * order (by item id, then by rule declaration order). That stability is what
 * lets the comment upsert into place without churning on every push.
 *
 * Items carrying an explicit `[human]` marker are **never flagged**. The whole
 * point of the marker is that the author already made the call; re-flagging it
 * would punish exactly the behaviour we're trying to encourage.
 */
export function lintChecklist(checklist: UatChecklist): LintResult {
  const findings: LintFinding[] = [];

  for (const item of checklist.items) {
    if (item.human) continue;
    findings.push(...lintItem(item));
  }

  const flaggedIds = new Set(findings.map((f) => f.itemId));
  const humanMarkedItems = checklist.items.filter((it) => it.human).length;
  const totalItems = checklist.items.length;

  return {
    findings,
    totalItems,
    humanMarkedItems,
    flaggedItems: flaggedIds.size,
    // Only meaningful when there's a checklist at all — an empty checklist is
    // the "no UAT block" case, which the review pass already reports as skipped.
    nothingVerifiable:
      totalItems > 0 && flaggedIds.size + humanMarkedItems === totalItems,
  };
}

function lintItem(item: UatItem): LintFinding[] {
  const out: LintFinding[] = [];

  // Placeholder detection runs first and short-circuits: if the item has no
  // real content, telling the author it "needs a [human] marker" is noise.
  const placeholder = detectPlaceholder(item);
  if (placeholder) return [placeholder];

  for (const rule of ALL_RULES) {
    if (!rule.pattern.test(item.text)) continue;
    out.push({
      itemId: item.id,
      itemText: item.text,
      kind: rule.kind,
      message: rule.message,
      suggestion: rule.suggestion,
    });
  }

  // At most one finding per kind per item — the first matching rule in a
  // category wins. Stacking three near-identical "this is post-merge" notes on
  // one item makes the comment unreadable.
  return dedupeByKind(out);
}

function detectPlaceholder(item: UatItem): LintFinding | null {
  const stripped = stripMarkdown(item.text).trim();
  const isPlaceholder =
    stripped.length < MIN_MEANINGFUL_LENGTH ||
    PLACEHOLDER_PATTERNS.some((re) => re.test(stripped));
  if (!isPlaceholder) return null;
  return {
    itemId: item.id,
    itemText: item.text,
    kind: "placeholder",
    message: "This doesn't state a checkable criterion.",
    suggestion:
      "Name an observable artifact that exists at merge time — a function, a test, a config key, a documented behaviour.",
  };
}

/**
 * Strip inline markdown so length and placeholder checks see the prose, not
 * the syntax. `` `x` `` and `[a](b)` shouldn't make a two-word item look long.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → label
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ");
}

/** Keep the first finding of each kind, preserving order. */
function dedupeByKind(findings: LintFinding[]): LintFinding[] {
  const seen = new Set<LintFindingKind>();
  const out: LintFinding[] = [];
  for (const f of findings) {
    if (seen.has(f.kind)) continue;
    seen.add(f.kind);
    out.push(f);
  }
  return out;
}
