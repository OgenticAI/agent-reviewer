/**
 * Read-only repo tools (OGE-1555).
 *
 * The security tests carry most of the weight here. These tools are driven by
 * model output, and the model's input includes a PR-authored diff — so every
 * path is hostile input. The reviewer's process holds an Anthropic key, a
 * Linear token, and a GitHub App private key; a traversal bug reads them out.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isDeniedPath,
  makeRepoTools,
  PathDeniedError,
  PathEscapeError,
  resolveWithinRoot,
} from "../../src/tools/repo.js";
import type { ReviewTool } from "../../src/tools/registry.js";

let root: string;
let outside: string;
let tools: Record<string, ReviewTool>;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "reviewer-repo-"));
  root = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(root, "src", "redaction.ts"), "export const A = 1;\nexport const B = 2;\n");
  writeFileSync(join(root, "README.md"), "# Title\ncall redactText here\n");
  writeFileSync(join(root, "node_modules", "junk", "big.js"), "redactText\n");
  writeFileSync(join(outside, "secret.env"), "ANTHROPIC_API_KEY=sk-leak\n");
  writeFileSync(join(root, ".env"), "LINEAR_API_TOKEN=lin_in_repo_leak\n");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", ".env.production"), "STRIPE_KEY=sk_live_leak\n");
  writeFileSync(join(root, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  symlinkSync(join(outside, "secret.env"), join(root, "escape-link"));

  tools = Object.fromEntries(makeRepoTools(root).map((t) => [t.definition.name, t]));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveWithinRoot — containment", () => {
  it("accepts a plain repo-relative path", () => {
    expect(resolveWithinRoot(root, "src/redaction.ts")).toContain("redaction.ts");
  });

  it("rejects traversal with ..", () => {
    expect(() => resolveWithinRoot(root, "../outside/secret.env")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects a symlink pointing outside the root", () => {
    // Lexical resolution alone would let this through — this is why the
    // implementation calls realpathSync rather than just path.resolve.
    expect(() => resolveWithinRoot(root, "escape-link")).toThrow(PathEscapeError);
  });

  it("rejects the root itself", () => {
    expect(() => resolveWithinRoot(root, ".")).toThrow(PathEscapeError);
  });

  it("rejects an empty path", () => {
    expect(() => resolveWithinRoot(root, "")).toThrow(PathEscapeError);
  });
});

describe("read_file", () => {
  it("reads a file with 1-based line numbers", async () => {
    const r = await tools.read_file!.execute({ path: "src/redaction.ts" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("1\texport const A = 1;");
    expect(r.content).toContain("2\texport const B = 2;");
  });

  it("honours a line range", async () => {
    const r = await tools.read_file!.execute({ path: "src/redaction.ts", start_line: 2, end_line: 2 });
    expect(r.content).toBe("2\texport const B = 2;");
  });

  it("refuses to escape the repo", async () => {
    const r = await tools.read_file!.execute({ path: "../outside/secret.env" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/outside the repository/);
    expect(r.content).not.toContain("sk-leak");
  });

  it("refuses a symlink out of the repo", async () => {
    const r = await tools.read_file!.execute({ path: "escape-link" });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("sk-leak");
  });

  it("returns an error result for a missing file rather than throwing", async () => {
    const r = await tools.read_file!.execute({ path: "src/nope.ts" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/No such file/);
  });

  it("rejects a directory with a pointer to the right tool", async () => {
    const r = await tools.read_file!.execute({ path: "src" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/use list_files/);
  });

  it("validates its own input", async () => {
    expect((await tools.read_file!.execute({})).isError).toBe(true);
    expect((await tools.read_file!.execute({ path: 42 })).isError).toBe(true);
    expect((await tools.read_file!.execute(null)).isError).toBe(true);
  });
});

describe("search_repo", () => {
  it("finds matches with file and line number", async () => {
    const r = await tools.search_repo!.execute({ pattern: "redactText" });
    expect(r.content).toMatch(/README\.md:2/);
  });

  it("skips node_modules", async () => {
    const r = await tools.search_repo!.execute({ pattern: "redactText" });
    expect(r.content).not.toContain("node_modules");
  });

  it("reports no matches plainly", async () => {
    const r = await tools.search_repo!.execute({ pattern: "zzz_not_present" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/No matches/);
  });

  it("returns an error for an invalid regex instead of throwing", async () => {
    const r = await tools.search_repo!.execute({ pattern: "([" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Invalid regular expression/);
  });

  it("refuses a path_prefix that escapes the repo", async () => {
    const r = await tools.search_repo!.execute({ pattern: "KEY", path_prefix: "../outside" });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("sk-leak");
  });
});

describe("list_files", () => {
  it("lists repo-relative paths", async () => {
    const r = await tools.list_files!.execute({});
    expect(r.content).toContain("src/redaction.ts");
    expect(r.content).toContain("README.md");
  });

  it("excludes node_modules", async () => {
    const r = await tools.list_files!.execute({});
    expect(r.content).not.toContain("node_modules");
  });

  it("scopes to a prefix", async () => {
    const r = await tools.list_files!.execute({ path_prefix: "src" });
    expect(r.content).toContain("src/redaction.ts");
    expect(r.content).not.toContain("README.md");
  });

  it("refuses a prefix that escapes the repo", async () => {
    const r = await tools.list_files!.execute({ path_prefix: "../outside" });
    expect(r.isError).toBe(true);
  });

  it("sorts output so repeated calls are stable", async () => {
    const a = await tools.list_files!.execute({});
    const b = await tools.list_files!.execute({});
    expect(a.content).toBe(b.content);
  });
});

describe("tool surface", () => {
  it("exposes exactly the three read-only tools", () => {
    expect(Object.keys(tools).sort()).toEqual(["list_files", "read_file", "search_repo"]);
  });

  it("declares no write, delete, or execute capability", () => {
    // Read-only by construction — the registry security note depends on this.
    for (const name of Object.keys(tools)) {
      expect(name).not.toMatch(/write|delete|exec|run|bash/i);
    }
  });
});

describe("secrets deny-list — files inside the repo", () => {
  // Containment stops traversal OUT of the checkout. It does nothing about
  // secrets committed INSIDE it, and tool output is pasted into a public PR
  // comment — so reading one is a disclosure, not just a read.
  it.each([".env", "config/.env.production", "deploy.pem", ".git/config"])(
    "refuses %s",
    (path) => {
      expect(() => resolveWithinRoot(root, path)).toThrow(PathDeniedError);
    },
  );

  it("read_file refuses a repo-local .env without leaking its contents", async () => {
    const r = await tools.read_file!.execute({ path: ".env" });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("lin_in_repo_leak");
    expect(r.content).toMatch(/deny-list/);
  });

  it("read_file refuses a nested .env.production", async () => {
    const r = await tools.read_file!.execute({ path: "config/.env.production" });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("sk_live_leak");
  });

  it("search_repo does not surface denied files", async () => {
    // Without a deny-check in the walk, search would happily print the
    // contents of a file read_file was never allowed to open.
    const r = await tools.search_repo!.execute({ pattern: "LINEAR_API_TOKEN|STRIPE_KEY" });
    expect(r.content).not.toContain("lin_in_repo_leak");
    expect(r.content).not.toContain("sk_live_leak");
  });

  it("list_files does not list denied files", async () => {
    const r = await tools.list_files!.execute({});
    expect(r.content).not.toContain(".env");
    expect(r.content).not.toContain("deploy.pem");
  });

  it("still allows ordinary files", () => {
    expect(isDeniedPath("src/redaction.ts")).toBe(false);
    expect(isDeniedPath("docs/environment.md")).toBe(false);
  });
});
