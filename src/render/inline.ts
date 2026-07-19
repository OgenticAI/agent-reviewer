/**
 * Anchoring FAIL/PARTIAL evidence as inline review comments (OGE-1586).
 *
 * Verdicts live only in one top-level sticky comment, so an author reading a
 * FAIL has to hunt through the diff for the code behind it — friction that
 * costs trust — and un-anchored findings can't be tracked across PRs (Kodus
 * can't track a finding without a file anchor).
 *
 * ── The architecture the research corrected ─────────────────────────────────
 *
 * We assumed inline comments meant GitHub's formal review API. Anthropic
 * deliberately forbids that: claude-code-action cannot submit formal PR reviews
 * or approve PRs "for security reasons" — it posts each comment individually
 * via `pulls.createReviewComment`. So the single-Check architecture stands, and
 * inline comments are additive. `createReview`/approve is never called here; a
 * test asserts the type surface can't even reach it.
 *
 * ── Two channels, never drop ────────────────────────────────────────────────
 *
 * A finding whose evidence maps into the diff becomes an inline comment. One
 * whose evidence sits outside the diff (a cited file the PR didn't touch) can't
 * be anchored — so it goes into an "evidence outside this diff" section of the
 * sticky comment. reviewdog and danger converged on the same fallback: every
 * finding surfaces somewhere.
 */

import type { ItemVerdict } from "../schema/verdict.js";

/**
 * Map of (path, new-file line) → whether that line is present in the diff.
 *
 * GitHub anchors a review comment to a `line` on the head SHA, and only lines
 * that appear in the diff (added or context) are anchorable. We record exactly
 * those, per file, so a finding citing an unchanged line is routed to the
 * fallback rather than posted at a line GitHub will reject.
 */
export type DiffPositionMap = Map<string, Set<number>>;

interface FileHunks {
  path: string;
  /** New-file line numbers that are added or context (i.e. anchorable). */
  anchorable: Set<number>;
}

const FILE_HEADER = /^\+\+\+ b\/(.+)$/;
const OLD_FILE_HEADER = /^--- /;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Build the position map from a unified diff.
 *
 * Walks each hunk tracking the new-file line counter: `+` and context lines
 * advance it and are anchorable; `-` lines do not advance it (they don't exist
 * in the head file). This is reviewdog's `difflines` map in ~40 lines.
 */
export function buildPositionMap(diff: string): DiffPositionMap {
  const map: DiffPositionMap = new Map();
  let current: FileHunks | null = null;
  let newLine = 0;

  const flush = () => {
    if (current) map.set(current.path, current.anchorable);
  };

  for (const raw of diff.split("\n")) {
    const fileMatch = FILE_HEADER.exec(raw);
    if (fileMatch) {
      flush();
      current = { path: fileMatch[1]!, anchorable: new Set() };
      continue;
    }
    if (OLD_FILE_HEADER.test(raw) || raw.startsWith("diff --git")) continue;

    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (!current) continue;

    if (raw.startsWith("+")) {
      current.anchorable.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      // Deleted line — exists only in the old file, not anchorable on head.
    } else if (raw.startsWith(" ") || raw === "") {
      // Context line advances the new-file counter and is anchorable.
      current.anchorable.add(newLine);
      newLine += 1;
    }
  }
  flush();
  return map;
}

/** A finding ready to post inline, resolved to a concrete anchorable line. */
export interface InlineComment {
  path: string;
  line: number;
  itemId: number;
  status: ItemVerdict["status"];
  body: string;
}

/** A finding that couldn't be anchored — routed to the sticky fallback. */
export interface UnanchoredFinding {
  itemId: number;
  status: ItemVerdict["status"];
  itemText: string;
  /** Why it couldn't anchor, for the fallback section. */
  reason: string;
}

/** The marker embedded in every inline comment so re-runs can reconcile them. */
export const INLINE_MARKER_PREFIX = "<!-- ogenticai-reviewer-inline";

export function inlineMarker(itemId: number): string {
  return `${INLINE_MARKER_PREFIX} item=${itemId} -->`;
}

/** Parse the item id out of an inline comment body, or null. */
export function parseInlineMarker(body: string): number | null {
  const m = /<!-- ogenticai-reviewer-inline item=(\d+) -->/.exec(body);
  return m ? Number(m[1]) : null;
}

/** Statuses that get anchored inline. PASS/CODE_VERIFIED don't need a fix pointer. */
const ANCHORABLE_STATUSES = new Set(["FAIL", "PARTIAL"]);

/**
 * Pick the anchor line for an item from its `lines` evidence.
 *
 * Uses the first `lines` ref whose start is anchorable in the diff. Returns
 * null when the item has no line-level evidence in the diff — those are the
 * two-channel fallback cases, by design, not failures.
 */
function anchorLineFor(item: ItemVerdict, map: DiffPositionMap): number | null {
  for (const ref of item.evidenceRefs ?? []) {
    if (ref.kind !== "lines") continue;
    const anchorable = map.get(ref.path);
    if (!anchorable) continue;
    for (let ln = ref.start; ln <= ref.end; ln += 1) {
      if (anchorable.has(ln)) return ln;
    }
  }
  return null;
}

/** Anchor path for an item's first `lines` evidence ref, for the comment. */
function anchorPathFor(item: ItemVerdict): string | null {
  const ref = (item.evidenceRefs ?? []).find((r) => r.kind === "lines");
  return ref && ref.kind === "lines" ? ref.path : null;
}

export interface SplitFindings {
  inline: InlineComment[];
  unanchored: UnanchoredFinding[];
}

/**
 * Split FAIL/PARTIAL items into inline-anchorable and fallback.
 *
 * Never drops a finding: every FAIL/PARTIAL lands in exactly one of the two
 * channels. `renderBody` builds the comment body (so the suggestion-block
 * extension in OGE-1596 can wrap it without this module knowing).
 */
export function splitFindings(
  items: ItemVerdict[],
  positionMap: DiffPositionMap,
  renderBody: (item: ItemVerdict, line: number) => string,
): SplitFindings {
  const inline: InlineComment[] = [];
  const unanchored: UnanchoredFinding[] = [];

  for (const item of items) {
    if (!ANCHORABLE_STATUSES.has(item.status)) continue;
    const path = anchorPathFor(item);
    const line = path ? anchorLineFor(item, positionMap) : null;
    if (path && line !== null) {
      inline.push({
        path,
        line,
        itemId: item.id,
        status: item.status,
        body: `${inlineMarker(item.id)}\n${renderBody(item, line)}`,
      });
    } else {
      unanchored.push({
        itemId: item.id,
        status: item.status,
        itemText: item.itemText,
        reason: path
          ? "cited lines are outside this diff"
          : "no line-level evidence to anchor to",
      });
    }
  }
  return { inline, unanchored };
}

/**
 * Default body for an anchored finding.
 *
 * Kept small and factored out so OGE-1596's suggestion-block extension can wrap
 * or replace it without `splitFindings` knowing anything about suggestions.
 */
export function renderInlineFindingBody(item: ItemVerdict): string {
  return [`**${item.status}** — ${item.itemText}`, ``, item.rationale].join("\n");
}

/** Render the sticky-comment fallback section, or null when nothing is unanchored. */
export function renderFallbackSection(unanchored: UnanchoredFinding[]): string | null {
  if (unanchored.length === 0) return null;
  const lines = [
    `#### Evidence outside this diff`,
    ``,
    `These findings couldn't be anchored to a changed line, so they're listed here:`,
    ``,
  ];
  for (const f of unanchored) {
    lines.push(`- **${f.status}** item ${f.itemId}: ${f.itemText} _(${f.reason})_`);
  }
  return lines.join("\n");
}
