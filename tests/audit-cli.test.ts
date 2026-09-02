import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStartedBy } from "../src/audit-cli.js";

/**
 * resolveStartedBy — who to attribute an audit's subject event to (OGE-2563).
 *
 * Runs a real `git config --global user.email` against a scratch HOME rather
 * than mocking child_process: the property under test is "does this actually
 * read the machine's git identity", and a mock of execFile could drift from
 * what git really does (a renamed flag, a changed exit code on 'not set')
 * without the test noticing.
 */
describe("resolveStartedBy", () => {
  it("an explicit --started-by always wins, without touching git", async () => {
    // No HOME override — if this fell through to git, either it would
    // return this machine's real identity (still wrong: the explicit value
    // must win) or throw in a sandboxed env with none configured. Passing a
    // deliberately garbage env home proves the git path was never taken.
    const result = await resolveStartedBy("dennis@ogenticai.com", { HOME: "/nonexistent" });
    expect(result).toBe("dennis@ogenticai.com");
  });

  it("falls back to the machine's global git identity when unset", async () => {
    const home = mkdtempSync(join(tmpdir(), "audit-cli-test-"));
    try {
      writeFileSync(join(home, ".gitconfig"), "[user]\n\temail = twin-david@ogenticai.com\n");
      const result = await resolveStartedBy(undefined, { HOME: home });
      expect(result).toBe("twin-david@ogenticai.com");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves to null, not a throw, when no identity is configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "audit-cli-test-"));
    try {
      // No .gitconfig written — `git config --global user.email` exits
      // non-zero with nothing set, which is the exact case this must
      // survive without failing the audit over a byline.
      await expect(resolveStartedBy(undefined, { HOME: home })).resolves.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves to null when git itself is not on PATH", async () => {
    const result = await resolveStartedBy(undefined, { HOME: "/nonexistent", PATH: "" });
    expect(result).toBeNull();
  });
});
