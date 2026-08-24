import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source files must be text (OGE-2424 prep).
 *
 * `src/prompt/diff-pack.ts` carried two RAW NUL BYTES. They were deliberate —
 * a sentinel in the glob-to-regex conversion, where `**` is swapped for a
 * character that cannot appear in a path, then swapped back after `*` has been
 * handled — but they were written as literal bytes rather than the `\0` escape.
 *
 * The behaviour was correct and its tests passed. The damage was to tooling:
 * a single NUL makes `file(1)` report "data" and makes grep treat the file as
 * binary and skip it silently. That file was invisible to every codebase search
 * in this repo, including our own `read_file`/grep tool loop — a reviewer cannot
 * report on a file its search never returns, and it would have reported nothing
 * rather than an error.
 *
 * The escape is identical to the compiler and visible to everything else.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("source hygiene", () => {
  it("no tracked source file contains a raw NUL byte", () => {
    const offenders: string[] = [];
    for (const file of [join(ROOT, "src"), join(ROOT, "tests")].flatMap((d) => sourceFiles(d))) {
      if (readFileSync(file).includes(0x00)) offenders.push(file.replace(ROOT, ""));
    }

    // Write the sentinel as "\0", not as the byte itself. Same value, and the
    // file stays greppable.
    expect(offenders).toEqual([]);
  });

  it("the glob sentinel still round-trips, which is what the NUL was for", async () => {
    const { matchesGlob } = await import("../src/prompt/diff-pack.js");

    // `**` spans separators, `*` does not — the distinction the sentinel exists
    // to preserve while both replacements run over the same string.
    expect(matchesGlob("src/deep/nested/a.ts", "src/**")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);

    // A literal NUL in the input must not be treated as a wildcard by the
    // second replacement — the sentinel is an implementation detail, not syntax.
    expect(matchesGlob("src/\0/a.ts", "src/*.ts")).toBe(false);
  });
});
