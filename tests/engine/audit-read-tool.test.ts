import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeReadTool, readWithinTree, numberLines, MAX_READ_BYTES } from "../../src/engine/audit/read-tool.js";
import { FileAccessLog } from "../../src/engine/audit/inventory.js";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "read-tool-"));
  root = join(base, "tree");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "const a = 1;\nconst b = 2;\n");
  writeFileSync(join(outside, "secret.txt"), "PRIVATE");
});
afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("numbering lines", () => {
  // verify.ts re-reads a cited line and checks the quote is still on it. A model
  // handed unnumbered text and asked for line citations would guess.
  it("numbers from 1, tab-separated", () => {
    expect(numberLines("first\nsecond")).toBe("1\tfirst\n2\tsecond");
  });

  it("handles an empty file without inventing a line", () => {
    expect(numberLines("")).toBe("1\t");
  });
});

describe("containment", () => {
  it("reads a file inside the tree", () => {
    const result = readWithinTree(root, "src/app.ts");
    expect(result.outcome).toBe("read");
    expect(result.text).toContain("1\tconst a = 1;");
  });

  it.each(["../outside/secret.txt", "src/../../outside/secret.txt"])(
    "refuses the traversal %s",
    (path) => {
      expect(readWithinTree(root, path).outcome).toBe("escaped");
    },
  );

  it("refuses an absolute path", () => {
    expect(readWithinTree(root, join(outside, "secret.txt")).outcome).toBe("escaped");
  });

  // The check runs on the resolved target, because a symlink is exactly how a
  // hostile tree defeats a check done on the spelling of a path.
  it("refuses a symlink pointing out of the tree", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.ts"));
    const result = readWithinTree(root, "src/link.ts");
    expect(result.outcome).toBe("escaped");
    expect(result.text).toBeUndefined();
  });

  it("follows a symlink that stays inside the tree", () => {
    symlinkSync(join(root, "src", "app.ts"), join(root, "src", "alias.ts"));
    expect(readWithinTree(root, "src/alias.ts").outcome).toBe("read");
  });

  it("reports a missing file as missing, not as an escape", () => {
    expect(readWithinTree(root, "src/nope.ts").outcome).toBe("missing");
  });

  it("refuses a directory rather than returning its listing", () => {
    expect(readWithinTree(root, "src").outcome).toBe("denied");
  });

  // Recorded rather than dropped, so it lands in the report's "could not read"
  // list instead of quietly counting as covered.
  it("refuses a file over the size cap and says so", () => {
    writeFileSync(join(root, "big.json"), "x".repeat(MAX_READ_BYTES + 1));
    const result = readWithinTree(root, "big.json");
    expect(result.outcome).toBe("too-large");
    expect(result.reason).toMatch(/not covered/);
  });

  it("never throws, whatever it is handed", () => {
    for (const path of ["", "   ", "\u0000bad", "a".repeat(5000)]) {
      expect(() => readWithinTree(root, path)).not.toThrow();
    }
  });
});

describe("the tool, bound to a tree and a log", () => {
  it("records a successful read so coverage counts it", async () => {
    const log = new FileAccessLog();
    const tool = makeReadTool({ root, log });

    const result = await tool.execute({ path: "src/app.ts" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("const a = 1;");
    expect([...log.opened()]).toEqual(["src/app.ts"]);
  });

  // A refusal that is not recorded overstates coverage: the file looks
  // untouched rather than attempted-and-failed.
  it.each([
    ["../outside/secret.txt", "escaped"],
    ["src/nope.ts", "missing"],
  ])("records the failed attempt on %s", async (path, outcome) => {
    const log = new FileAccessLog();
    const result = await makeReadTool({ root, log }).execute({ path });

    expect(result.isError).toBe(true);
    expect(log.opened().size).toBe(0);
    expect(log.all().map((r) => r.outcome)).toEqual([outcome]);
  });

  it("never leaks the content of a file outside the tree", async () => {
    const log = new FileAccessLog();
    const result = await makeReadTool({ root, log }).execute({ path: "../outside/secret.txt" });
    expect(result.content).not.toContain("PRIVATE");
  });

  it("returns an error rather than throwing on a malformed call", async () => {
    const tool = makeReadTool({ root, log: new FileAccessLog() });
    for (const input of [{}, { path: 42 }, { path: "" }, null]) {
      const result = await tool.execute(input);
      expect(result.isError).toBe(true);
    }
  });

  it("advertises that citations must use the line numbers it returns", () => {
    const tool = makeReadTool({ root, log: new FileAccessLog() });
    expect(tool.definition.description).toMatch(/line numbers/);
    expect(tool.definition.name).toBe("read_file");
  });
});
