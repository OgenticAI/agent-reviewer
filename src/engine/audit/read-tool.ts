/**
 * The file-reading tool the investigation stage hands the model.
 *
 * This is the only way source reaches the model during an audit, which makes it
 * the only place two separate obligations can be met at once:
 *
 *   CONTAINMENT — the tree came from a client. A path that leaves it is not a
 *   file we may read, whether it arrived as `../../.ssh/id_rsa`, an absolute
 *   path, or a symlink pointing out of the tree. Symlinks are resolved before
 *   the check, because a link is exactly how a hostile tree escapes a check
 *   done on the spelling of a path.
 *
 *   COVERAGE — every attempt is recorded, successful or not. Coverage in the
 *   report is computed from this log, so a read that happens without a record
 *   silently understates the review, and a record without a read overstates it.
 *   `render.ts` refuses a report whose coverage says nothing was opened, which
 *   is the failure this log exists to make impossible.
 *
 * Lines come back numbered because a claim without a line number cannot be
 * verified: `verify.ts` re-reads the cited line and checks the quote still
 * appears there. Handing the model unnumbered text and then demanding line
 * citations would be asking it to guess, and it would.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { FileAccessLog } from "./inventory.js";
import type { ReviewTool, ToolResult } from "../tools/registry.js";

/**
 * Biggest file handed to the model, in bytes.
 *
 * A generated bundle or a checked-in lockfile can be megabytes, and spending a
 * whole context window on one tells the reader nothing. The file is recorded
 * `too-large` rather than dropped silently, so it appears in the report's
 * "could not read" list instead of quietly counting as covered.
 */
export const MAX_READ_BYTES = 256 * 1024;

/** Where a read attempt ended up. Mirrors `AccessOutcome`. */
export interface ReadOutcome {
  outcome: "read" | "denied" | "missing" | "too-large" | "escaped";
  /** Numbered text, when the read succeeded. */
  text?: string;
  /** Why it did not, when it did not. */
  reason?: string;
}

/** `1\tconst x = 1` — the form the verifier's line lookup expects. */
export function numberLines(source: string): string {
  return source
    .split("\n")
    .map((line, index) => `${index + 1}\t${line}`)
    .join("\n");
}

/**
 * Read one repo-relative path, or explain why not.
 *
 * Never throws. A tool that throws mid-loop loses the run; a tool that returns
 * a reason lets the model pick a different file and carry on, which is what a
 * person would do.
 */
export function readWithinTree(root: string, requested: string): ReadOutcome {
  const realRoot = realpathSync(resolve(root));

  // Rejected on spelling first, before touching the filesystem: an absolute
  // path or a `..` segment is a refusal we can make without a syscall, and
  // without the ambiguity of a path that does not happen to exist today.
  if (isAbsolute(requested) || /^[a-zA-Z]:[\\/]/.test(requested)) {
    return { outcome: "escaped", reason: "absolute paths are not readable; use a repo-relative path" };
  }
  if (requested.split(/[\\/]/).includes("..")) {
    return { outcome: "escaped", reason: "path leaves the subject tree" };
  }

  const full = join(realRoot, requested);

  let real: string;
  try {
    real = realpathSync(full);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { outcome: "missing", reason: "no such file in the subject" };
    return { outcome: "denied", reason: `could not be opened (${code ?? "unknown"})` };
  }

  // The check that a symlink cannot defeat, because it runs on the resolved
  // target rather than the requested spelling.
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { outcome: "escaped", reason: "path resolves outside the subject tree" };
  }

  let size: number;
  try {
    const stat = statSync(real);
    if (stat.isDirectory()) return { outcome: "denied", reason: "that is a directory, not a file" };
    size = stat.size;
  } catch {
    return { outcome: "denied", reason: "could not be stat'd" };
  }

  if (size > MAX_READ_BYTES) {
    return {
      outcome: "too-large",
      reason: `${size} bytes exceeds the ${MAX_READ_BYTES}-byte limit; it is recorded as not covered`,
    };
  }

  try {
    return { outcome: "read", text: numberLines(readFileSync(real, "utf8")) };
  } catch {
    return { outcome: "denied", reason: "could not be decoded as text" };
  }
}

export interface ReadToolOptions {
  /** The acquired tree. Nothing outside it is readable. */
  root: string;
  /** Every attempt lands here; the report's coverage is computed from it. */
  log: FileAccessLog;
}

/**
 * Build the tool, bound to one tree and one log.
 *
 * Bound rather than parameterised so there is no call path that reads a file
 * without recording it — the log is not an argument the caller may forget.
 */
export function makeReadTool(options: ReadToolOptions): ReviewTool {
  return {
    definition: {
      name: "read_file",
      description:
        "Read a file from the codebase under review. Paths are repo-relative. " +
        "Returns the file with line numbers, which you must use when citing evidence.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path, e.g. src/server/auth.ts" },
        },
        required: ["path"],
      },
    },

    async execute(input: unknown): Promise<ToolResult> {
      const path = (input as { path?: unknown })?.path;
      if (typeof path !== "string" || path.trim() === "") {
        return { content: "read_file needs a repo-relative `path`.", isError: true };
      }

      const result = readWithinTree(options.root, path);
      options.log.record(path, result.outcome);

      if (result.outcome === "read") {
        return { content: `${path}\n\n${result.text}` };
      }
      return { content: `${path}: ${result.reason}`, isError: true };
    },
  };
}
