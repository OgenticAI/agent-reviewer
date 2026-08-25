import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What the consumed Action actually loads.
 *
 * `.github/actions/review` is pinned at `@v2` by roughly twenty repositories.
 * It runs `npm ci --omit=dev=false` against this package.json and then invokes
 * the review entrypoint — so anything that entrypoint can reach, and every
 * dependency this package declares, lands in someone else's CI.
 *
 * The audit engine is an internal tool. It is a separate `bin`, the Action
 * never invokes it, and it must stay that way. That separation is currently a
 * fact about how the imports happen to fall, and a fact nothing enforces is a
 * fact that decays — the same reasoning as the engine boundary test.
 *
 * If you are here because this failed: the audit reached the Action's runtime.
 * The fix is not an exception. It is that the shared thing belongs in
 * `src/engine/`, which both halves may use, rather than being imported across.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACTION_ENTRY = join(ROOT, "src", "cli.ts");

/** Every relative `from "..."` specifier in a file, resolved to a real path. */
function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );

  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) => {
      // Source is written with `.js` specifiers under NodeNext; the file on
      // disk is `.ts`.
      const asTs = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      return existsSync(asTs) ? asTs : resolve(dirname(file), spec);
    })
    .filter((path) => existsSync(path));
}

/** Everything the entrypoint can reach, transitively. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    queue.push(...localImports(file));
  }

  seen.delete(entry);
  return seen;
}

describe("the audit engine stays out of the consumed Action", () => {
  const reachable = [...reachableFrom(ACTION_ENTRY)].map((path) =>
    path.slice(ROOT.length).replace(/\\/g, "/"),
  );

  it("the review entrypoint cannot reach the audit engine", () => {
    const audit = reachable.filter((path) => path.startsWith("src/engine/audit/"));
    expect(audit).toEqual([]);
  });

  it("the review entrypoint cannot reach the audit CLI or its model wiring", () => {
    const audit = reachable.filter((path) => /^src\/audit-/.test(path));
    expect(audit).toEqual([]);
  });

  // Proves the traversal actually walks the graph. Without this, a resolver bug
  // that silently returned nothing would make both checks above pass forever —
  // which is the shape of green check this repo keeps finding in itself.
  it("reaches the review orchestration it is supposed to reach", () => {
    expect(reachable).toContain("src/review.ts");
    expect(reachable.length).toBeGreaterThan(10);
  });
});

describe("what consumers are made to install", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const declared = { ...pkg.dependencies, ...pkg.devDependencies };

  /**
   * The Action runs `npm ci --omit=dev=false`, so devDependencies install too.
   * A local path or a git URL resolves on the machine that wrote it and fails
   * in every consumer's CI — and `agent-reviewer` is public while several
   * OgenticAI packages are not, so "it works here" is not evidence.
   */
  it("declares no dependency that only resolves on our own machines", () => {
    const unresolvable = Object.entries(declared)
      .filter(([, spec]) => /^(file:|link:|git\+|https?:|\.\.?\/)/.test(spec))
      .map(([name, spec]) => `${name}@${spec}`);

    expect(unresolvable).toEqual([]);
  });

  // A private package would make every consumer's `npm ci` demand credentials
  // they have no reason to hold.
  it("declares no package from a private OgenticAI scope", () => {
    const privateScoped = Object.keys(declared).filter((name) => name.startsWith("@ogenticai/"));
    expect(privateScoped).toEqual([]);
  });
});
