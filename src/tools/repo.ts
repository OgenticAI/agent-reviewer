/**
 * Read-only access to the checked-out repo (OGE-1555).
 *
 * The repo is **already on disk and completely unused**: `self-review.yml`
 * runs `actions/checkout@v5` before invoking the action, and `runReview` never
 * touches the filesystem — it only ever sends the diff. Three verdicts named
 * this as their sole blocker:
 *
 *   OGE-1111: "consistency with orgs-list cannot be confirmed without seeing
 *              the orgs-list implementation."
 *   OGE-1172: "item 7 is unverifiable because the tool code is not in the diff."
 *   OGE-460:  "item 4 requires Zashboard integration code not present in this PR."
 *
 * That count understates it. Repo access raises rationale quality on *every*
 * verdict — it is only *named* when it happens to be the sole blocker.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *
 * These tools are driven by model output, and the model's input includes a
 * PR-authored diff and PR-authored checklist text. Treat every path as
 * hostile. The reviewer's process holds ANTHROPIC_API_KEY, LINEAR_API_TOKEN,
 * and a GitHub App private key; a traversal bug here reads them out.
 *
 * The containment rule: every path is resolved to its real location on disk
 * (following symlinks) and must still sit inside the repo root. `..`,
 * absolute paths, and symlinks pointing outside all fail the same check. This
 * is enforced in one place — `resolveWithinRoot` — so there is a single thing
 * to audit.
 *
 * Read-only by construction: no tool here writes, deletes, or executes. Code
 * execution against PR-authored content belongs in a separate secretless job
 * (OGE-1557), never in this process.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ReviewTool, ToolResult } from "./registry.js";

/** Directories never worth reading and expensive to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

/**
 * Paths refused even though they sit inside the repo root.
 *
 * Containment stops a traversal *out* of the checkout. It does nothing about
 * secrets committed *inside* it, and those are common: a `.env` a contributor
 * added by mistake, `.git/config` carrying a token in a remote URL, a stray
 * `id_rsa` in a fixtures directory. The reviewer pastes tool output into a
 * public PR comment, so reading one is a disclosure, not just a read.
 *
 * Deny-list before allow-list, and matched on the repo-relative path so a
 * nested `config/.env.production` is caught as readily as a root `.env`.
 */
const DENIED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env($|\.|\/)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)[^/]*\.pem$/i,
  /(^|\/)[^/]*\.p12$/i,
  /(^|\/)[^/]*\.pfx$/i,
  /(^|\/)credentials$/i,
];

export class PathDeniedError extends Error {
  constructor(requested: string) {
    super(
      `Refusing to read ${requested}: it matches the secrets deny-list ` +
        `(.env, .git, keys, credentials). Tool output is pasted into a public ` +
        `PR comment, so this file is off limits even though it is in the repo.`,
    );
    this.name = "PathDeniedError";
  }
}

/** True when a repo-relative path is on the deny-list. */
export function isDeniedPath(relPath: string): boolean {
  const normalized = relPath.split(sep).join("/");
  return DENIED_PATH_PATTERNS.some((re) => re.test(normalized));
}

/** Caps, so one tool call can't blow the context budget. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST_RESULTS = 200;
const MAX_SEARCH_MATCHES = 100;
const MAX_WALK_FILES = 20_000;

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path is outside the repository: ${requested}`);
    this.name = "PathEscapeError";
  }
}

/**
 * Resolve a model-supplied path against the repo root, or throw.
 *
 * Uses `realpathSync` so a symlink pointing outside the root is caught by the
 * same check as a `..` — resolving lexically only would let `link -> /etc`
 * through. Missing files are resolved lexically (there is nothing to follow),
 * which is safe because the containment check still runs.
 */
export function resolveWithinRoot(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new PathEscapeError(String(requested));
  }
  const realRoot = realpathSync(root);
  const candidate = isAbsolute(requested) ? requested : join(realRoot, requested);

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    resolved = resolve(candidate); // not on disk yet — lexical is fine, check still applies
  }

  const rel = relative(realRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(requested);
  }
  // Containment passed — now refuse secrets that live legitimately inside the
  // checkout. Both the requested path and its resolved location are checked,
  // so a symlink `notes.md -> .env` inside the repo is caught too.
  if (isDeniedPath(rel) || isDeniedPath(requested)) {
    throw new PathDeniedError(requested);
  }
  return resolved;
}

function walk(root: string, onFile: (abs: string) => void, rootForDeny: string = root): void {
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip rather than fail the whole call
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        if (++seen > MAX_WALK_FILES) return;
        const abs = join(dir, entry.name);
        // Denied files are skipped during walks too — otherwise search_repo
        // would happily print the contents of a .env it was never allowed to
        // open directly.
        if (isDeniedPath(relative(rootForDeny, abs))) continue;
        onFile(abs);
      }
    }
  }
}

function asString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function ok(content: string): ToolResult {
  return { content };
}
function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Build the read-only repo toolset rooted at `root`.
 *
 * `root` is the checkout directory — in the Action, the consumer repo's
 * working directory.
 */
export function makeRepoTools(root: string): ReviewTool[] {
  return [readFileTool(root), searchRepoTool(root), listFilesTool(root)];
}

function readFileTool(root: string): ReviewTool {
  return {
    definition: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the repository being reviewed. Use this when a UAT item " +
        "depends on code the diff does not show — a caller, an existing implementation, a " +
        "config file. Paths are relative to the repo root.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path, e.g. src/redaction.py" },
          start_line: { type: "integer", description: "1-based first line (optional)" },
          end_line: { type: "integer", description: "1-based last line (optional)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(input) {
      const path = asString(input, "path");
      if (!path) return err("read_file requires a non-empty `path`.");

      let abs: string;
      try {
        abs = resolveWithinRoot(root, path);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      let stat;
      try {
        stat = statSync(abs);
      } catch {
        return err(`No such file: ${path}`);
      }
      if (stat.isDirectory()) return err(`${path} is a directory — use list_files.`);
      if (stat.size > MAX_FILE_BYTES) {
        return err(
          `${path} is ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit. ` +
            `Use start_line/end_line to read a range.`,
        );
      }

      const lines = readFileSync(abs, "utf8").split(/\r?\n/);
      const raw = input as Record<string, unknown>;
      const start = typeof raw.start_line === "number" ? Math.max(1, raw.start_line) : 1;
      const end = typeof raw.end_line === "number" ? Math.min(lines.length, raw.end_line) : lines.length;
      if (start > lines.length) {
        return err(`${path} has ${lines.length} lines; start_line ${start} is past the end.`);
      }

      const slice = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}\t${line}`)
        .join("\n");
      return ok(slice);
    },
  };
}

function searchRepoTool(root: string): ReviewTool {
  return {
    definition: {
      name: "search_repo",
      description:
        "Search the repository for a JavaScript regular expression and return matching lines " +
        "with their file and line number. Use this to check whether something exists outside " +
        "the diff — a call site, a test, a config key.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          path_prefix: {
            type: "string",
            description: "Optional repo-relative directory to limit the search to",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    async execute(input) {
      const pattern = asString(input, "pattern");
      if (!pattern) return err("search_repo requires a non-empty `pattern`.");

      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return err(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }

      const prefix = asString(input, "path_prefix");
      let base: string;
      try {
        base = prefix ? resolveWithinRoot(root, prefix) : realpathSync(root);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      const matches: string[] = [];
      let truncated = false;
      walk(base, (abs) => {
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          return;
        }
        let content: string;
        try {
          if (statSync(abs).size > MAX_FILE_BYTES) return;
          content = readFileSync(abs, "utf8");
        } catch {
          return; // binary or unreadable — not an error, just not searchable
        }
        const rel = relative(realpathSync(root), abs).split(sep).join("/");
        content.split(/\r?\n/).forEach((line, i) => {
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true;
            return;
          }
          if (re.test(line)) matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }, realpathSync(root));

      if (matches.length === 0) return ok(`No matches for /${pattern}/.`);
      const note = truncated ? `\n… truncated at ${MAX_SEARCH_MATCHES} matches` : "";
      return ok(matches.join("\n") + note);
    },
  };
}

function listFilesTool(root: string): ReviewTool {
  return {
    definition: {
      name: "list_files",
      description:
        "List repository file paths, optionally under a directory. Use this to discover what " +
        "exists before reading — e.g. whether a tests/ directory covers a module.",
      input_schema: {
        type: "object",
        properties: {
          path_prefix: { type: "string", description: "Optional repo-relative directory" },
        },
        additionalProperties: false,
      },
    },
    async execute(input) {
      const prefix = asString(input, "path_prefix");
      let base: string;
      try {
        base = prefix ? resolveWithinRoot(root, prefix) : realpathSync(root);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }

      const realRoot = realpathSync(root);
      const files: string[] = [];
      let truncated = false;
      walk(base, (abs) => {
        if (files.length >= MAX_LIST_RESULTS) {
          truncated = true;
          return;
        }
        files.push(relative(realRoot, abs).split(sep).join("/"));
      }, realRoot);

      if (files.length === 0) return ok("No files found.");
      files.sort();
      const note = truncated ? `\n… truncated at ${MAX_LIST_RESULTS} files` : "";
      return ok(files.join("\n") + note);
    },
  };
}
