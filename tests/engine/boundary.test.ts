import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The engine boundary (OGE-2424).
 *
 * `src/engine/` is the half of this repo that does not know what a pull request
 * is: rank a repository, ingest analyzer output, read files under a containment
 * rule. `src/pr/` is the half that does — Octokit, Linear, branch protection,
 * CI status.
 *
 * The audit mode (OGE-2429 onward) is a second consumer of the engine. It has no
 * diff, no ticket and no checklist, and it must never acquire one by accident
 * through an import that seemed harmless. A convention nothing enforces is a
 * convention that decays, so this is a test rather than a comment.
 *
 * If you are here because this test failed: the fix is almost never to add an
 * exception. It is that the thing you reached for belongs in the engine too, or
 * that the engine needs it passed in rather than fetched.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENGINE = join(ROOT, "src", "engine");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every `from "..."` specifier in a file. */
function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
}

describe("engine boundary", () => {
  const files = tsFiles(ENGINE);

  it("has files to check (a passing test over an empty set proves nothing)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("never imports the GitHub client", () => {
    const offenders = files
      .filter((f) => imports(f).some((s) => s.startsWith("@octokit")))
      .map((f) => f.replace(ROOT, ""));
    expect(offenders).toEqual([]);
  });

  it("never imports anything under src/pr/", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of imports(f)) {
        if (/(^|\/)pr\//.test(spec)) offenders.push(`${f.replace(ROOT, "")} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The engine may only reach OUT to other engine modules. Reaching back into
   * `src/` at large is how it would pick up the verdict schema, the prompt
   * builder, or the config loader — all of which are shaped by the PR path.
   */
  it("only reaches outward into other engine modules", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const spec of imports(f)) {
        if (!spec.startsWith(".")) continue; // node builtins and packages are fine
        const resolved = join(f, "..", spec);
        if (!resolved.startsWith(ENGINE)) offenders.push(`${f.replace(ROOT, "")} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
