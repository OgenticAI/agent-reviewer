/**
 * Renders a `ReviewVerdict` into the sticky PR comment.
 *
 * Idempotency invariants:
 *   - The first line is always `COMMENT_MARKER` so the upsert layer can find
 *     existing comments without fuzzy matching.
 *   - The body is deterministic given a verdict — same verdict object means
 *     byte-identical output. This is what makes the "sticky comment doesn't
 *     spam on each push" promise actually hold.
 *   - We do NOT include `generatedAt` in the rendered body for that reason.
 *     The timestamp lives in the JSON sidecar (`<details>` block) where it
 *     doesn't perturb the user-visible Markdown.
 */

import { COMMENT_MARKER } from "../version.js";
import type { ReviewVerdict, VerdictStatus } from "../schema/verdict.js";
import { overallStatus, type OverallStatus } from "../schema/verdict.js";

const STATUS_BADGE: Record<VerdictStatus, string> = {
  PASS: "✅ PASS",
  CODE_VERIFIED: "🟢 CODE VERIFIED",
  FAIL: "❌ FAIL",
  PARTIAL: "🟡 PARTIAL",
  UNVERIFIABLE: "🤔 UNVERIFIABLE",
};

const OVERALL_HEADLINE: Record<OverallStatus, string> = {
  PASS: "✅ All UAT items pass.",
  PASS_WITH_PARTIALS: "🟡 UAT passes with partials — read the partial rationales before merging.",
  NEEDS_WORK: "❌ UAT fails — at least one item is not delivered.",
  HUMAN_REVIEW: "🤔 UAT needs human review — at least one item can't be verified from the diff.",
};

export function renderStickyComment(
  verdict: ReviewVerdict,
  /**
   * Rendered "evidence outside this diff" section (OGE-1586). Supplied only
   * when inline comments are on and some findings couldn't be anchored — those
   * must never vanish, so they surface here instead. Omitted keeps the body
   * byte-identical, preserving the determinism contract for every other repo.
   */
  fallbackSection?: string | null,
): string {
  const overall = overallStatus(verdict);
  const lines: string[] = [];

  lines.push(COMMENT_MARKER);
  lines.push("");
  lines.push("## OgenticAI Reviewer — UAT verdict");
  lines.push("");
  lines.push(
    `**${verdict.ticketId}** · PR \`${verdict.prRef}\` @ \`${verdict.headSha.slice(0, 7)}\``,
  );
  lines.push("");
  lines.push(OVERALL_HEADLINE[overall]);
  lines.push("");

  if (verdict.summary.trim()) {
    lines.push(`> ${verdict.summary.trim()}`);
    lines.push("");
  }

  // The "When" column appears only once any item carried forward (OGE-1590),
  // so PRs that never went incremental keep a byte-identical 4-column table.
  const anyCarried = verdict.items.some((it) => it.verifiedAtSha);
  if (anyCarried) {
    lines.push("| # | Item | Verdict | When | Rationale |");
    lines.push("|---|------|---------|------|-----------|");
  } else {
    lines.push("| # | Item | Verdict | Rationale |");
    lines.push("|---|------|---------|-----------|");
  }
  for (const item of verdict.items) {
    const text = escapeTableCell(item.itemText);
    const rationale = escapeTableCell(item.rationale);
    if (anyCarried) {
      const when = item.verifiedAtSha
        ? `carried from \`${item.verifiedAtSha.slice(0, 7)}\``
        : "re-checked";
      lines.push(
        `| ${item.id} | ${text} | ${STATUS_BADGE[item.status]} | ${when} | ${rationale} |`,
      );
    } else {
      lines.push(`| ${item.id} | ${text} | ${STATUS_BADGE[item.status]} | ${rationale} |`);
    }
  }
  lines.push("");

  // Two-channel fallback (OGE-1586): findings that couldn't anchor inline.
  if (fallbackSection) {
    lines.push(fallbackSection);
    lines.push("");
  }

  // Evidence list, only when there's anything to show.
  const itemsWithEvidence = verdict.items.filter((it) => it.evidenceRefs.length > 0);
  if (itemsWithEvidence.length > 0) {
    lines.push("<details><summary>Evidence</summary>");
    lines.push("");
    for (const item of itemsWithEvidence) {
      lines.push(`**${item.id}.** ${escapeMarkdown(item.itemText)}`);
      for (const ref of item.evidenceRefs) {
        lines.push(`- ${formatEvidence(ref)}`);
      }
      lines.push("");
    }
    lines.push("</details>");
    lines.push("");
  }

  // JSON sidecar for downstream tooling (Linear writeback in OGE-339, the
  // merge-gate Check in OGE-340) and for the override flow.
  //
  // Strip `generatedAt` from the embedded JSON: it changes every run, and we
  // want the rendered comment body to be byte-identical for the same verdict
  // (same diff + same checklist) so the upserter no-ops instead of churning.
  // The timestamp lives in the GitHub Check output and the Linear comment
  // metadata — those are appropriate places for "when was this run" data.
  // The comment itself is identity-by-content.
  const { generatedAt: _generatedAt, ...verdictForBody } = verdict;
  lines.push("<details><summary>Reviewer payload (JSON)</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(verdictForBody, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push(
    `_OgenticAI Reviewer ${verdict.reviewerVersion} · This comment is updated in place on every push. Use \`/uat-override <reason>\` to override (maintainers only)._`,
  );

  return lines.join("\n");
}

function formatEvidence(ref: ReviewVerdict["items"][number]["evidenceRefs"][number]): string {
  switch (ref.kind) {
    case "file":
      return `\`${ref.path}\``;
    case "lines":
      return `\`${ref.path}\` lines ${ref.start}–${ref.end}`;
    case "test":
      return `\`${ref.path}\` :: \`${ref.name}\``;
    case "external":
      return ref.note ? `[${ref.note}](${ref.url})` : ref.url;
  }
}

/**
 * Make a string safe for inline placement in a GitHub Markdown table cell.
 * Pipes break the table; newlines collapse into <br>; other Markdown is fine.
 */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

function escapeMarkdown(s: string): string {
  return s.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}
