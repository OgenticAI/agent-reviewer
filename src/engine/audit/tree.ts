/**
 * Walking an acquired tree (OGE-2425).
 *
 * Split out from `acquire.ts` because the inventory stage (OGE-2426) needs the
 * same walk to build the coverage denominator. One traversal, one language
 * table, one definition of what counts as a source file — so `subject.json` and
 * the report's Coverage section can never disagree about how big the codebase
 * is.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Directories never worth walking. Same list as `tools/repo.ts` uses for the
 * model's file reads: if the reviewer will not read it, it does not belong in
 * the denominator either — counting `node_modules` would put coverage in the
 * single digits and mean nothing.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".venv",
  "__pycache__",
]);

/** Extension → language. Unrecognised extensions are counted, just not named. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".cs", "csharp"],
  [".py", "python"],
  [".rb", "ruby"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".swift", "swift"],
  [".php", "php"],
  [".sql", "sql"],
  [".sh", "shell"],
  [".css", "css"],
  [".scss", "css"],
  [".html", "html"],
  [".json", "json"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".md", "markdown"],
]);

export const UNKNOWN_LANGUAGE = "other";

export function languageOf(path: string): string {
  return LANGUAGE_BY_EXTENSION.get(extname(path).toLowerCase()) ?? UNKNOWN_LANGUAGE;
}

export interface TreeFile {
  /** Repo-relative, POSIX separators, so a subject read on any host matches. */
  path: string;
  language: string;
  bytes: number;
  /** Lines of text. `0` for a file we could not read as text. */
  loc: number;
  /** SHA-256 of the bytes, so a re-audit can tell a moved file from a changed one. */
  sha256: string;
}

/** What one read of a file tells us. Both facts come from the same buffer. */
interface FileFacts {
  loc: number;
  sha256: string;
}

const EMPTY_FILE: FileFacts = {
  loc: 0,
  // SHA-256 of zero bytes. Naming it beats hashing an empty buffer to rediscover it.
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

/**
 * Line count and digest, from a single read.
 *
 * A NUL byte means "not text", and OGE-2450 is why we take that seriously: a
 * binary counted as source would inflate the denominator with lines nobody can
 * review. It is still hashed and still counted as a file — it exists, it just
 * has no lines.
 */
function readFileFacts(absolutePath: string, bytes: number): FileFacts {
  if (bytes === 0) return EMPTY_FILE;

  const buffer = readFileSync(absolutePath);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (buffer.includes(0)) return { loc: 0, sha256 };

  const text = buffer.toString("utf8");
  const newlines = text.split("\n").length;
  return { loc: text.endsWith("\n") ? newlines - 1 : newlines, sha256 };
}

/**
 * Every file in the tree, with its size and line count.
 *
 * Symlinks are recorded by name but never followed: a link out of the tree
 * would count somebody else's code, and a link cycle would not terminate.
 */
export function walkTree(root: string): TreeFile[] {
  const files: TreeFile[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const { size } = statSync(absolute);
      files.push({
        path: relative(root, absolute).split(sep).join("/"),
        language: languageOf(entry.name),
        bytes: size,
        ...readFileFacts(absolute, size),
      });
    }
  };

  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface TreeSummary {
  files: number;
  loc: number;
  /**
   * Share of total lines per language, rounded to two places.
   *
   * A share rather than a count because it is what a reader acts on — "81%
   * C#" says which expertise the engagement needs. The counts stay available
   * on the `TreeFile[]` for anyone who needs them, and the rounding means the
   * shares will not always total exactly 1.
   */
  langs: Record<string, number>;
}

export function summariseTree(files: TreeFile[]): TreeSummary {
  const loc = files.reduce((total, file) => total + file.loc, 0);

  const linesByLanguage = new Map<string, number>();
  for (const file of files) {
    linesByLanguage.set(file.language, (linesByLanguage.get(file.language) ?? 0) + file.loc);
  }

  const langs: Record<string, number> = {};
  if (loc > 0) {
    for (const [language, lines] of linesByLanguage) {
      const share = Math.round((lines / loc) * 100) / 100;
      if (share > 0) langs[language] = share;
    }
  }

  return { files: files.length, loc, langs };
}
