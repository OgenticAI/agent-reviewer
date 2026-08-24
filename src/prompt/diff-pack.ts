/**
 * Token-budgeted diff assembly (OGE-1581) with function-boundary hunk
 * expansion (OGE-1591).
 *
 * Until now the whole raw diff went into the prompt untruncated, on an
 * explicit bet recorded in `prompt/review.ts`: *"If we ever hit a giant PR,
 * the model will surface that as UNVERIFIABLE rather than hallucinating
 * PASS."* The research says that bet is wrong twice over. A large PR either
 * overflows the context (a failed run gating a merge) or crowds out the
 * checklist, CI summary, and tool results — and SWE-agent's ablations show
 * dumping full content actively *degrades* answer quality, it is not merely
 * more expensive.
 *
 * The counter-intuitive finding from the competitive sweep is how little
 * context the good tools actually ship: Qodo compresses deterministically at
 * prompt-build time and runs no agentic loop at all for its core flows, and
 * Aider's default repo-map budget is 1k tokens. Both treat context assembly as
 * an engineering problem to be solved *before* the model call, not delegated
 * to the model afterwards.
 *
 * ── The rule that makes truncation safe ─────────────────────────────────────
 *
 * Anything dropped is named. A file that did not fit is listed by path under
 * an explicit header, so the model either fetches it with `read_file` or punts
 * with a concrete reason ("the change in X was not shown"). What it must never
 * do is silently miss a file and report PASS — which is exactly what an
 * unannounced truncation would cause.
 */

import { estimateTokens } from "../engine/tokens.js";

// Re-exported: this module was the canonical import site before the estimate
// moved into the engine, and several call sites still read better from here.
export { estimateTokens };


/**
 * Default budget for the diff section.
 *
 * Deliberately a fraction of the context window, not most of it: the checklist,
 * ticket, CI summary, repo map, and every tool result have to fit alongside it,
 * and those are the inputs that actually settle items.
 */
export const DEFAULT_DIFF_TOKEN_BUDGET = 24_000;

/**
 * Reserve held back from the budget (Qodo uses a comparable soft/hard buffer
 * pair). Estimation is approximate, so packing right up to the line reliably
 * overshoots on real input.
 */
const BUDGET_SAFETY_MARGIN = 0.9;

/** Dynamic-context defaults, mirroring Qodo's names for searchability. */
export const MAX_EXTRA_LINES_BEFORE_DYNAMIC_CONTEXT = 8;
export const PATCH_EXTRA_LINES_BEFORE = 3;
export const PATCH_EXTRA_LINES_AFTER = 1;

/** Expansion is pointless for prose and would just spend budget. */
const NO_EXPAND_EXTENSIONS = [".md", ".txt", ".rst", ".json", ".lock"];

/** Paths whose diffs are noise: machine-written, and never what a UAT item means. */
const GENERATED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /\.min\.(js|css)$/,
  /\.(snap|pb\.go|generated\.ts)$/,
];

/** Marker convention: a file declaring itself machine-written. */
const GENERATED_CONTENT_MARKER = /@generated\b/;

export interface FilePatch {
  path: string;
  /** The full `diff --git ...` block for this file. */
  patch: string;
  /** Added-line count, used to prioritise additions over deletions. */
  additions: number;
  deletions: number;
}

export interface SkippedFile {
  path: string;
  reason: "generated" | "excluded" | "token-budget";
}

export interface PackedDiff {
  /** The diff text to put in the prompt. */
  text: string;
  includedFiles: string[];
  skippedFiles: SkippedFile[];
  /** True when anything was left out, so callers can surface it. */
  truncated: boolean;
}

export interface PackDiffOptions {
  tokenBudget?: number;
  /** Repo-relative globs to drop entirely (simple `*` / `**` support). */
  excludeGlobs?: string[];
  /**
   * Checklist item texts. Files whose paths share a stem with an item pack
   * first — the diff most likely to settle a criterion should never be the
   * part that gets dropped.
   */
  checklistTexts?: string[];
  /**
   * Reads a repo file, for function-boundary expansion (OGE-1591). Omitted
   * disables expansion — keeping this module pure and testable without a
   * checkout.
   */
  readFile?: (path: string) => string | null;
  /** Master switch for expansion, mirroring Qodo's `allow_dynamic_context`. */
  allowDynamicContext?: boolean;
  /**
   * Paths the triage pre-pass flagged as investigation targets (OGE-1595).
   * These sort ahead of checklist-stem relevance, so the files the cheap model
   * said the hard items depend on are the ones that survive the token budget.
   */
  priorityPaths?: string[];
  /**
   * Hunk-expansion tuning (OGE-1591), mirroring Qodo's option names so the
   * docs are searchable. Omitted values use the module defaults.
   */
  maxExtraLinesBefore?: number;
  patchExtraLinesBefore?: number;
}


/** Split a unified diff into per-file patches. */
export function splitDiff(diff: string): FilePatch[] {
  if (!diff.trim()) return [];
  const blocks = diff.split(/^(?=diff --git )/m).filter((b) => b.trim().length > 0);
  return blocks.map((patch) => {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(patch);
    // Prefer the b/ path: for a rename, that is where the code now lives.
    const path = header?.[2] ?? header?.[1] ?? "unknown";
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    return { path, patch, additions, deletions };
  });
}

/** Minimal glob matcher — `**` spans separators, `*` does not. */
export function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isGenerated(file: FilePatch): boolean {
  if (GENERATED_PATH_PATTERNS.some((re) => re.test(file.path))) return true;
  // Only inspect added lines: a diff that *removes* an @generated marker
  // shouldn't classify the file as generated.
  return file.patch
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .some((l) => GENERATED_CONTENT_MARKER.test(l));
}

/** Stems from checklist text, for lexical relevance. */
function stemsFrom(texts: string[]): Set<string> {
  const stems = new Set<string>();
  for (const text of texts) {
    for (const word of text.split(/\W+/)) {
      if (word.length >= 5) stems.add(word.toLowerCase());
    }
  }
  return stems;
}

function relevanceScore(path: string, stems: Set<string>): number {
  const lower = path.toLowerCase();
  let score = 0;
  for (const stem of stems) {
    if (lower.includes(stem)) score += 1;
  }
  return score;
}

/**
 * Expand a hunk's leading context to its enclosing function or class
 * (OGE-1591).
 *
 * Qodo's approach, and the reason it is worth having: without it the model
 * spends capped tool-loop iterations on `read_file` calls that only recover
 * the function a hunk sits in. A regex/indentation scan gets most of that for
 * free at prompt-build time — deliberately no tree-sitter, so this ships
 * independently of the repo-map work.
 */
export function expandHunkStart(
  fileLines: string[],
  hunkStartLine: number,
  maxScan = MAX_EXTRA_LINES_BEFORE_DYNAMIC_CONTEXT,
  extraBefore = PATCH_EXTRA_LINES_BEFORE,
): number {
  const DEFINITION = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|const\s+\w+\s*=\s*(?:async\s*)?\(|interface|type\s+\w+\s*=)/;
  const firstIdx = Math.max(0, hunkStartLine - 1);
  for (let i = firstIdx; i >= Math.max(0, firstIdx - maxScan); i--) {
    if (DEFINITION.test(fileLines[i] ?? "")) return i + 1; // 1-based
  }
  // No boundary within reach — fall back to a fixed lead-in rather than
  // scanning the whole file, which would defeat the point of a budget.
  return Math.max(1, hunkStartLine - extraBefore);
}

function shouldExpand(path: string): boolean {
  return !NO_EXPAND_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * Add expanded leading context to each hunk of a patch, as comment-prefixed
 * lines so the result is still a readable diff.
 *
 * Returns the patch unchanged when there is no file content to expand from —
 * expansion is a nicety, never a correctness requirement.
 */
export function expandPatchContext(
  file: FilePatch,
  readFile: (p: string) => string | null,
  opts: { maxExtraLinesBefore?: number; patchExtraLinesBefore?: number } = {},
): string {
  if (!shouldExpand(file.path)) return file.patch;
  const content = readFile(file.path);
  if (!content) return file.patch;
  const fileLines = content.split(/\r?\n/);

  return file.patch.replace(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/gm, (hunkHeader, newStart) => {
    const start = Number(newStart);
    if (!Number.isFinite(start) || start <= 1) return hunkHeader;
    const from = expandHunkStart(
      fileLines,
      start,
      opts.maxExtraLinesBefore ?? MAX_EXTRA_LINES_BEFORE_DYNAMIC_CONTEXT,
      opts.patchExtraLinesBefore ?? PATCH_EXTRA_LINES_BEFORE,
    );
    if (from >= start) return hunkHeader;
    const lead = fileLines
      .slice(from - 1, start - 1)
      .map((l) => ` ${l}`)
      .join("\n");
    return `${hunkHeader}\n${lead}`;
  });
}

/**
 * Pack a diff to fit a token budget, dropping the least relevant files last
 * and naming everything dropped.
 */
export function packDiff(diff: string, options: PackDiffOptions = {}): PackedDiff {
  const budget = Math.floor((options.tokenBudget ?? DEFAULT_DIFF_TOKEN_BUDGET) * BUDGET_SAFETY_MARGIN);
  const files = splitDiff(diff);
  const skipped: SkippedFile[] = [];

  const candidates: FilePatch[] = [];
  for (const file of files) {
    if (options.excludeGlobs?.some((g) => matchesGlob(file.path, g))) {
      skipped.push({ path: file.path, reason: "excluded" });
      continue;
    }
    if (isGenerated(file)) {
      skipped.push({ path: file.path, reason: "generated" });
      continue;
    }
    candidates.push(file);
  }

  // Expand before measuring, so the budget accounts for the real payload.
  const expanded = new Map<string, string>();
  if (options.allowDynamicContext !== false && options.readFile) {
    for (const file of candidates) {
      expanded.set(
        file.path,
        expandPatchContext(file, options.readFile, {
          ...(options.maxExtraLinesBefore !== undefined
            ? { maxExtraLinesBefore: options.maxExtraLinesBefore }
            : {}),
          ...(options.patchExtraLinesBefore !== undefined
            ? { patchExtraLinesBefore: options.patchExtraLinesBefore }
            : {}),
        }),
      );
    }
  }
  const patchFor = (f: FilePatch) => expanded.get(f.path) ?? f.patch;

  const stems = stemsFrom(options.checklistTexts ?? []);
  const priority = new Set(options.priorityPaths ?? []);
  const ordered = [...candidates].sort((a, b) => {
    // Triage-flagged investigation targets win outright (OGE-1595): the cheap
    // model already decided these are where the hard items live.
    const pri = (priority.has(b.path) ? 1 : 0) - (priority.has(a.path) ? 1 : 0);
    if (pri !== 0) return pri;
    const rel = relevanceScore(b.path, stems) - relevanceScore(a.path, stems);
    if (rel !== 0) return rel;
    // Then additions-heavy patches: new behaviour is what a UAT item asserts,
    // deletions rarely settle one.
    const add = b.additions - a.additions;
    if (add !== 0) return add;
    return patchFor(a).length - patchFor(b).length;
  });

  const included: string[] = [];
  const parts: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const patch = patchFor(file);
    const cost = estimateTokens(patch);
    if (used + cost > budget && included.length > 0) {
      skipped.push({ path: file.path, reason: "token-budget" });
      continue;
    }
    // The first file always goes in even if oversized: an empty diff section
    // is strictly less useful than one large patch.
    parts.push(patch);
    included.push(file.path);
    used += cost;
  }

  const budgetSkipped = skipped.filter((s) => s.reason === "token-budget");
  const notInlined =
    budgetSkipped.length > 0
      ? [
          ``,
          `Not inlined (token budget) — retrievable via read_file:`,
          ...budgetSkipped.map((s) => `  ${s.path}`),
        ].join("\n")
      : "";

  return {
    text: parts.join("\n") + notInlined,
    includedFiles: included,
    skippedFiles: skipped,
    truncated: skipped.length > 0,
  };
}
