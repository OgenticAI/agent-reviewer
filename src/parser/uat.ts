/**
 * Parser for the OgenticAI PR UAT-checklist convention.
 *
 * Convention (validated against ogentic-shield PR #1 and PR #2):
 *
 *     ## UAT checklist
 *
 *     - [ ] item one
 *     - [x] item two
 *     - [ ] item three with `code` and [a link](https://example.com)
 *
 *     ## Some other section
 *
 * Rules:
 * - The block starts at the first `## UAT checklist` heading (case-sensitive on
 *   "UAT", lenient on the rest of the line — trailing whitespace OK).
 * - It ends at the next `^## ` (h2) heading or `^# ` (h1) heading, or end of file.
 * - Items are GitHub-flavored task list items: `^[ \t]*-[ \t]+\[([ xX])\][ \t]+TEXT$`.
 * - Empty bracket = unchecked (`[ ]`); `x`/`X` = checked.
 * - Lines that aren't task-list items inside the block (prose, sub-bullets,
 *   code fences) are ignored — they don't terminate the block.
 *
 * The parser intentionally does NOT trust the "checked" state for verdict
 * purposes — humans tick boxes optimistically. The reviewer agent decides
 * PASS/FAIL/PARTIAL/UNVERIFIABLE from the diff. The `checked` field is kept
 * because Ticket 4's merge gate uses it as one input.
 */

/**
 * A link extracted from a UAT item's text. Used by the reviewer to look up
 * author-attested verification comments — see OGE-365. The parser captures
 * links from any GitHub PR (regardless of whether it's the current PR); the
 * orchestrator does the same-PR equality check before fetching, so the parser
 * stays a pure function of the markdown.
 */
export type UatItemLink =
  | {
      kind: "pr-comment-issue";
      url: string;
      owner: string;
      repo: string;
      prNumber: number;
      commentId: number;
    }
  | {
      kind: "pr-comment-review";
      url: string;
      owner: string;
      repo: string;
      prNumber: number;
      commentId: number;
    }
  | { kind: "other"; url: string };

export interface UatItem {
  /** Stable position-based ID within the checklist (1-based). */
  id: number;
  /**
   * Item text with the leading `[human]` marker (if any) stripped, and no
   * trailing whitespace. This is what the model sees and echoes back as
   * `itemText` — the marker is metadata, not part of the criterion.
   */
  text: string;
  /** True if the box was ticked in the source markdown (`[x]` or `[X]`). */
  checked: boolean;
  /**
   * True when the item opened with a `[human]` marker (OGE-1559 / OGE-1560).
   *
   * The convention: criteria that genuinely need a person — clinician
   * sign-off, "the docs read clearly", visual design judgment — are declared
   * up front rather than silently punted. Declaring one is good practice, not
   * a failure, so `overallStatus` excludes human items from the
   * `HUMAN_REVIEW` calculation. See `src/schema/verdict.ts`.
   */
  human: boolean;
  /** 1-based source line number — useful for error messages and round-tripping. */
  line: number;
  /**
   * URLs extracted from the item text. Empty when the item has no links.
   * GitHub PR-comment URLs (issue comments and review comments) are typed
   * separately so the orchestrator can route them to the right Octokit call.
   */
  links: UatItemLink[];
}

export interface UatChecklist {
  items: UatItem[];
  /** Source line where `## UAT checklist` was found (1-based), or null. */
  headingLine: number | null;
  /** Whether the parser saw a `## UAT checklist` heading at all. */
  found: boolean;
}

/**
 * Whether a line opens or closes a fenced code block. We use this to skip
 * lines inside fences so a `- [ ] thing` example in a code block doesn't get
 * picked up as a real task-list item.
 */
const FENCE_RE = /^[ \t]*(?:```|~~~)/;

/** Heading at the beginning of a line: `# ` or `## ` (only h1/h2 terminate). */
const TERMINATING_HEADING_RE = /^#{1,2}[ \t]+/;

/** Matches the `## UAT checklist` heading itself, leniently. */
const UAT_HEADING_RE = /^##[ \t]+UAT[ \t]+checklist[ \t]*$/;

/** GitHub task-list item: bullet, brackets, text. */
const TASK_ITEM_RE = /^[ \t]*-[ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/;

/**
 * The `[human]` marker, at the start of an item's text (OGE-1559 / OGE-1560).
 *
 * Case-insensitive, and tolerant of the bold form authors reach for
 * (`**[human]**`) because GitHub renders a bare `[human]` in dimmed link-ish
 * styling and people work around it. Both forms mean the same thing.
 *
 * Anchored to the start deliberately: a mid-sentence "[human]" is almost
 * always prose ("escalate to a [human] reviewer"), not a declaration.
 */
const HUMAN_MARKER_RE = /^(?:\*\*)?\[human\](?:\*\*)?[ \t]*:?[ \t]*/i;

/**
 * Greedy URL extractor — captures bare URLs and URLs inside markdown link
 * syntax. Dedup happens in `extractLinks` via a Set keyed on the cleaned URL.
 * The character class excludes whitespace and the closing punctuation
 * ` ) ] > ` so URLs inside `[label](url)` and `<url>` are captured cleanly.
 */
const URL_RE = /https?:\/\/[^\s)\]>]+/g;

/**
 * GitHub PR issue-comment URL — what `#issuecomment-{id}` resolves to. This
 * is the canonical "comment on a PR" URL that the GitHub UI's "Copy link"
 * button emits.
 */
const ISSUE_COMMENT_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)#issuecomment-(\d+)$/;

/**
 * GitHub PR review-comment URL — `#discussion_r{id}` (no hyphen between `r`
 * and the digits, despite some docs implying otherwise). Used by the
 * "Copy link" button on review comments left on a specific line of a diff.
 */
const REVIEW_COMMENT_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)#discussion_r(\d+)$/;

/**
 * Extract URLs from a UAT item's text and classify each as a same-PR comment
 * link or "other". Order is preserved by first occurrence; duplicates are
 * collapsed. Trailing punctuation (`.`, `,`, `;`, `:`, `!`, `?`) is trimmed
 * because authors often write `... see [comment](url).` and the dot isn't
 * part of the URL.
 */
function extractLinks(text: string): UatItemLink[] {
  const seen = new Set<string>();
  const out: UatItemLink[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(classifyLink(url));
  }
  return out;
}

function classifyLink(url: string): UatItemLink {
  const issue = ISSUE_COMMENT_RE.exec(url);
  if (issue) {
    return {
      kind: "pr-comment-issue",
      url,
      owner: issue[1]!,
      repo: issue[2]!,
      prNumber: Number(issue[3]!),
      commentId: Number(issue[4]!),
    };
  }
  const review = REVIEW_COMMENT_RE.exec(url);
  if (review) {
    return {
      kind: "pr-comment-review",
      url,
      owner: review[1]!,
      repo: review[2]!,
      prNumber: Number(review[3]!),
      commentId: Number(review[4]!),
    };
  }
  return { kind: "other", url };
}

export function parseUatChecklist(markdown: string): UatChecklist {
  const lines = markdown.split(/\r?\n/);

  // 1) Find the `## UAT checklist` heading. There may be multiple checklists in
  //    the wild (e.g. someone copy-pasted) — we take the first one and stop.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (UAT_HEADING_RE.test(lines[i] ?? "")) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return { items: [], headingLine: null, found: false };
  }

  // 2) Scan from the line after the heading until the next h1/h2 or EOF.
  //    Track fence state to ignore items inside code blocks.
  const items: UatItem[] = [];
  let inFence = false;
  let position = 0;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // h1/h2 terminates the block. Other heading levels (### etc.) don't —
    // they're sub-sections within the UAT block and get skipped over.
    if (TERMINATING_HEADING_RE.test(line) && !UAT_HEADING_RE.test(line)) {
      break;
    }

    const match = TASK_ITEM_RE.exec(line);
    if (!match) continue;

    const checkChar = match[1] ?? " ";
    const rawText = (match[2] ?? "").trim();
    if (!rawText) continue; // skip empty items defensively

    // Strip the `[human]` marker before anything else sees the text, so the
    // model never has to reason about the annotation and `itemText` round-trips
    // cleanly through the verdict schema.
    const human = HUMAN_MARKER_RE.test(rawText);
    const text = human ? rawText.replace(HUMAN_MARKER_RE, "").trim() : rawText;
    if (!text) continue; // `- [ ] [human]` with no criterion is not an item

    position += 1;
    items.push({
      id: position,
      text,
      checked: checkChar !== " ",
      human,
      line: i + 1, // 1-based for human-readable output
      links: extractLinks(text),
    });
  }

  return { items, headingLine: start + 1, found: true };
}

/**
 * Convenience: how many items fall in each state. The verdict-rendering layer
 * uses this for the per-PR summary line.
 */
export function summarizeChecklist(c: UatChecklist): {
  total: number;
  checked: number;
  unchecked: number;
} {
  const total = c.items.length;
  const checked = c.items.filter((it) => it.checked).length;
  return { total, checked, unchecked: total - checked };
}
