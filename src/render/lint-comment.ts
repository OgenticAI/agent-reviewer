/**
 * Renders the UAT-checklist linter's advisory comment (OGE-1559).
 *
 * Tone matters here more than usual. This comment fires on PRs where the
 * author did the work and wrote a checklist in good faith — it is telling them
 * their criteria are aimed at the wrong verifier, which is easy to read as
 * pedantry. So: lead with what's fine, be specific about what isn't, always
 * give a concrete rewrite, and never imply the PR is blocked. It isn't.
 *
 * Idempotency: same `LintResult` → byte-identical body, same discipline as
 * `renderStickyComment`. No timestamps, no counters that drift. That's what
 * lets `upsertStickyComment` no-op instead of churning on every push.
 */

import { LINT_COMMENT_MARKER } from "../version.js";
import type { LintFinding, LintFindingKind, LintResult } from "../lint/checklist.js";

const KIND_LABEL: Record<LintFindingKind, string> = {
  placeholder: "no checkable criterion",
  "post-merge": "happens after merge",
  "operator-action": "operator setup",
  "prod-credentials": "needs live credentials",
  subjective: "needs human judgment",
};

/**
 * Returns the rendered comment body, or `null` when there's nothing worth
 * saying. Returning null (rather than a cheerful "all good!" comment) is
 * deliberate — a linter that comments on every clean PR trains people to
 * filter it out, and then it stops working on the PRs that need it.
 */
export function renderLintComment(result: LintResult): string | null {
  if (result.findings.length === 0) return null;

  const lines: string[] = [];
  lines.push(LINT_COMMENT_MARKER);
  lines.push("");
  lines.push("## UAT checklist — a few items can't be checked pre-merge");
  lines.push("");
  lines.push(headline(result));
  lines.push("");
  lines.push(
    "**This does not block your PR.** It's a heads-up that the reviewer will " +
      "return `UNVERIFIABLE` on the items below no matter what the diff contains, " +
      "because nothing in a pre-merge diff can satisfy them.",
  );
  lines.push("");

  for (const finding of result.findings) {
    lines.push(...renderFinding(finding));
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Criteria that genuinely need a person — sign-off, design judgment, docs " +
      "clarity — are fine to keep. Mark them `[human]` and they'll stop counting " +
      "against the merge gate:",
  );
  lines.push("");
  lines.push("```markdown");
  lines.push("- [ ] [human] Clinician confirms the PHI categories match DSM-5 practice");
  lines.push("```");
  lines.push("");
  lines.push(
    "Rule of thumb: **a criterion should name an observable artifact that " +
      "exists at merge time** — a function, a test, a config key, a documented " +
      "behaviour.",
  );

  return lines.join("\n");
}

function headline(result: LintResult): string {
  const { flaggedItems, totalItems, humanMarkedItems, nothingVerifiable } = result;

  if (nothingVerifiable) {
    // The OGE-588 shape. Lead with the whole-checklist framing, because
    // item-by-item advice misses the point when none of it is checkable.
    return (
      `**None of the ${plural(totalItems, "item")} in this checklist can be verified ` +
      `from the diff.** This usually means the checklist is a release runbook rather ` +
      `than a set of acceptance criteria — worth rewriting before the reviewer runs, ` +
      `or it'll come back with an empty table.`
    );
  }

  const marked =
    humanMarkedItems > 0
      ? ` (${plural(humanMarkedItems, "item")} already marked \`[human]\` — those are fine)`
      : "";
  return `${flaggedItems} of ${totalItems} items need a rewrite${marked}.`;
}

function renderFinding(finding: LintFinding): string[] {
  return [
    `**Item ${finding.itemId}** · _${KIND_LABEL[finding.kind]}_`,
    "",
    `> ${finding.itemText}`,
    "",
    `${finding.message} ${finding.suggestion}`,
    "",
  ];
}

function plural(n: number, _noun: "item"): string {
  return n === 1 ? "1 item" : `${n} items`;
}
