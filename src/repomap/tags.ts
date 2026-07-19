/**
 * Def/ref tag extraction for the repo map (OGE-1582).
 *
 * The model starts blind: iteration 1 is typically `list_files` or a
 * speculative search, and with a 12-iteration cap that exploration overhead is
 * the difference between verifying and punting. Aider's lesson cuts against our
 * pull-per-fact design: push a ranked symbol map up front so a repo-wide claim
 * ("this function is called from Y", "every state change emits an audit event")
 * is answered without spending a single tool iteration.
 *
 * ── On the tree-sitter question ─────────────────────────────────────────────
 *
 * Aider extracts tags with tree-sitter + per-language `.scm` queries. This
 * implementation uses regex extraction for TS/JS instead. That is a deliberate
 * scope call: web-tree-sitter ships WASM grammars that must load at runtime,
 * which is a heavy and failure-prone dependency inside a GitHub Action, for a
 * bounded benefit — the value of this feature is the ranking, budgeting, and
 * injection, all of which are language-agnostic and sit downstream of a `Tag[]`.
 * The extractor is isolated behind `extractTags()` precisely so a tree-sitter
 * backend can replace it later without touching rank/render. Non-TS/JS files
 * contribute nothing today rather than erroring.
 */

/** A definition or reference of a symbol, with enough to rank and render it. */
export interface Tag {
  /** Repo-relative file path. */
  path: string;
  /** Symbol name. */
  name: string;
  kind: "def" | "ref";
  /** 1-based line of the def (defs only; refs carry the ref line). */
  line: number;
  /** Signature line for a def, trimmed — what `render` shows. Empty for refs. */
  signature: string;
}

const TS_JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Definition patterns for TS/JS. Each captures the symbol name in group 1. */
const DEF_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/,
  /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  // `export const foo =` / `export const foo: T =` — top-level bindings.
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
];

/** Keywords that look like identifiers but never count as references. */
const KEYWORDS = new Set([
  "if", "for", "while", "return", "const", "let", "var", "function", "class",
  "interface", "type", "enum", "import", "export", "from", "async", "await",
  "new", "this", "true", "false", "null", "undefined", "void", "typeof",
  "extends", "implements", "public", "private", "readonly", "static", "default",
  "else", "switch", "case", "break", "continue", "throw", "try", "catch",
]);

const IDENTIFIER = /\b([A-Za-z_$][\w$]{2,})\b/g;

/**
 * Extract def/ref tags from one file's source.
 *
 * Returns `[]` for anything that isn't TS/JS — the map is best-effort and a
 * language we can't parse simply contributes no symbols rather than failing.
 */
export function extractTags(path: string, source: string): Tag[] {
  if (!TS_JS_EXT.test(path)) return [];
  const tags: Tag[] = [];
  const definedNames = new Set<string>();
  const lines = source.split("\n");

  lines.forEach((line, i) => {
    for (const pattern of DEF_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        const name = m[1]!;
        definedNames.add(name);
        tags.push({ path, name, kind: "def", line: i + 1, signature: line.trim().slice(0, 200) });
        break; // one def per line
      }
    }
  });

  // References: identifiers that aren't the def keyword line. A ref to a symbol
  // defined elsewhere is what links two files in the rank graph.
  lines.forEach((line, i) => {
    for (const m of line.matchAll(IDENTIFIER)) {
      const name = m[1]!;
      if (KEYWORDS.has(name)) continue;
      tags.push({ path, name, kind: "ref", line: i + 1, signature: "" });
    }
  });

  return tags;
}

/** A source file for the map, with the mtime that keys the parse cache. */
export interface RepoFile {
  path: string;
  content: string;
  /** Modification time (ms). Same path + same mtime ⇒ cached tags reused. */
  mtimeMs: number;
}

/**
 * Tag extractor with an mtime-keyed cache (OGE-1582).
 *
 * Re-parsing every file on every review is the cost Aider's cache exists to
 * avoid; ours persists through `actions/cache` across runs. A file whose mtime
 * hasn't moved is never re-parsed — asserted by a test that fails if it is.
 */
export class TagCache {
  private cache = new Map<string, { mtimeMs: number; tags: Tag[] }>();
  /** Files actually parsed since construction — for the cache test. */
  readonly parsed: string[] = [];

  tagsFor(file: RepoFile): Tag[] {
    const hit = this.cache.get(file.path);
    if (hit && hit.mtimeMs === file.mtimeMs) return hit.tags;
    const tags = extractTags(file.path, file.content);
    this.cache.set(file.path, { mtimeMs: file.mtimeMs, tags });
    this.parsed.push(file.path);
    return tags;
  }

  tagsForAll(files: RepoFile[]): Tag[] {
    return files.flatMap((f) => this.tagsFor(f));
  }
}
