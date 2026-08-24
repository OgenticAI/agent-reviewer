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

/**
 * ── Why the second test below exists ────────────────────────────────────────
 *
 * This repository is PUBLIC. It publishes a consumed GitHub Action, so that is
 * not going to change.
 *
 * Audit-mode work is done against client codebases, and the natural way to write
 * a test for it is to reach for the engagement actually in front of you. Three
 * merged pull requests did exactly that before anyone checked the repository's
 * visibility, putting a client's name, their private repository path, their
 * codebase size and a claim about their dependency-advisory count on the public
 * internet. None of it was source, secrets or PHI. All of it was material we had
 * no authorisation to publish.
 *
 * A denylist of client names would have to contain the client names, in a public
 * file, which defeats itself. So this is a POSITIVE ALLOWLIST: fixtures may name
 * hosts and organisations that are ours or that are reserved for documentation,
 * and nothing else. A real engagement fails the build; `acme` passes.
 *
 * When you hit this: the fix is a placeholder, never an addition to the list.
 * The list grows only for a new documentation-reserved name.
 */

/** Organisations a fixture may name. Ours, plus the documentation reservations. */
const ALLOWED_ORGS = new Set([
  "ogenticai", // our own
  "acme", // the conventional stand-in
  "example",
  "octocat", // GitHub's own documentation account
  "actions", // first-party actions
  "trailofbits", // cited in comments as published prior art
]);

const GIT_HOSTS = ["github.com", "bitbucket.org", "gitlab.com"];

/**
 * Organisations named in repo-shaped references — `host/org/repo`.
 *
 * Requiring the trailing repo segment is what separates a real reference from
 * a documentation link like `github.com/en/actions`, which names no one.
 */
function referencedOrgs(text: string): string[] {
  const orgs: string[] = [];
  for (const host of GIT_HOSTS) {
    const escaped = host.replace(/\./g, "\\.");
    const pattern = new RegExp(`${escaped}[/:]([A-Za-z0-9._-]{2,})/([A-Za-z0-9._-]{2,})`, "g");
    for (const match of text.matchAll(pattern)) {
      const org = match[1];
      if (org) orgs.push(org);
    }
  }
  return orgs;
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

  it("names no organisation outside the allowlist — this repository is public", () => {
    const offenders: string[] = [];

    // Scoped to the audit engine and its tests: that is the code written
    // against real client codebases, and the only place a fixture is likely to
    // be reached for from the engagement on the desk. The pull-request path
    // legitimately cites documentation URLs.
    const watched = [join(ROOT, "src", "engine", "audit"), join(ROOT, "tests", "engine")];

    for (const file of watched.flatMap((d) => sourceFiles(d))) {
      for (const org of referencedOrgs(readFileSync(file, "utf8"))) {
        if (!ALLOWED_ORGS.has(org.toLowerCase())) {
          offenders.push(`${file.replace(ROOT, "")} -> ${org}`);
        }
      }
    }

    // If this fails, replace the name with a placeholder. Do not add a real
    // engagement to ALLOWED_ORGS — the list is for stand-ins, not exceptions.
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
