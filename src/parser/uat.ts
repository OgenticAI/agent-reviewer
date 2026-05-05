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

export interface UatItem {
  /** Stable position-based ID within the checklist (1-based). */
  id: number;
  /** Verbatim item text (no leading `- [ ]`, no trailing whitespace). */
  text: string;
  /** True if the box was ticked in the source markdown (`[x]` or `[X]`). */
  checked: boolean;
  /** 1-based source line number — useful for error messages and round-tripping. */
  line: number;
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
    const text = (match[2] ?? "").trim();
    if (!text) continue; // skip empty items defensively

    position += 1;
    items.push({
      id: position,
      text,
      checked: checkChar !== " ",
      line: i + 1, // 1-based for human-readable output
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
