import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildInventory,
  computeCoverage,
  topLevelArea,
  writeInventory,
  FileAccessLog,
  TeeAccessLog,
  COVERAGE_CAVEAT,
  type Inventory,
} from "../../src/engine/audit/inventory.js";
import { makeRepoTools } from "../../src/engine/tools/repo.js";
import { AUDIT_ARTIFACTS, runDirWithin, type TreeFile } from "../../src/engine/audit/tree.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "inventory-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function plantCodebase(root: string): void {
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });

  writeFileSync(join(root, "src", "app.ts"), "const a = 1;\n");
  writeFileSync(join(root, "src", "auth", "session.ts"), "export const s = 1;\n");
  writeFileSync(join(root, "src", "auth", "tokens.ts"), "export const t = 1;\n");
  writeFileSync(join(root, "docs", "README.md"), "# hi\n");
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
}

function file(path: string, language = "typescript"): TreeFile {
  return { path, language, bytes: 10, loc: 1, sha256: `sha-${path}` };
}

function inventoryOf(files: TreeFile[]): Inventory {
  return { files, excluded: ["node_modules"], builtAt: "2026-08-24T00:00:00.000Z" };
}

describe("the inventory", () => {
  it("lists every file with path, language, bytes and sha256", () => {
    plantCodebase(scratch);
    const inventory = buildInventory(scratch);
    const app = inventory.files.find((f) => f.path === "src/app.ts");

    expect(app).toBeDefined();
    expect(app?.language).toBe("typescript");
    expect(app?.bytes).toBeGreaterThan(0);
    expect(app?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes identical content identically and different content differently", () => {
    writeFileSync(join(scratch, "a.ts"), "same\n");
    writeFileSync(join(scratch, "b.ts"), "same\n");
    writeFileSync(join(scratch, "c.ts"), "different\n");

    const byPath = new Map(buildInventory(scratch).files.map((f) => [f.path, f.sha256]));
    expect(byPath.get("a.ts")).toBe(byPath.get("b.ts"));
    expect(byPath.get("a.ts")).not.toBe(byPath.get("c.ts"));
  });

  // A denominator that silently omits things is not a denominator.
  it("records what it excluded rather than dropping it", () => {
    plantCodebase(scratch);
    const inventory = buildInventory(scratch);

    expect(inventory.excluded).toContain("node_modules");
    expect(inventory.files.some((f) => f.path.startsWith("node_modules/"))).toBe(false);
  });

  // The run's own artifacts sit inside the tree under the default --out, and
  // were counted in the denominator as if they were the subject's. They leave
  // it, and the report is told, rather than a coverage ratio over files the
  // audit wrote itself.
  describe("the run's own artifacts", () => {
    it("leaves them out of the denominator when the run directory is the tree", () => {
      plantCodebase(scratch);
      const before = buildInventory(scratch).files.length;
      for (const name of AUDIT_ARTIFACTS) writeFileSync(join(scratch, name), "{}\n");
      const inventory = buildInventory(scratch, scratch);
      expect(inventory.files.length).toBe(before);
      expect(inventory.files.some((f) => AUDIT_ARTIFACTS.has(f.path))).toBe(false);
    });

    it("names the exclusion rather than dropping it silently", () => {
      plantCodebase(scratch);
      const named = buildInventory(scratch, scratch).excluded.filter((e) => /artifacts/.test(e));
      expect(named).toHaveLength(1);
      for (const name of AUDIT_ARTIFACTS) expect(named[0]).toContain(name);
      expect(buildInventory(scratch).excluded.some((e) => /artifacts/.test(e))).toBe(false);
    });

    it("counts a same-named file elsewhere in the tree as the subject's", () => {
      plantCodebase(scratch);
      writeFileSync(join(scratch, "src", "findings.json"), "[]\n");
      const paths = buildInventory(scratch, scratch).files.map((f) => f.path);
      expect(paths).toContain("src/findings.json");
    });

    it("resolves the run directory relative to the tree, or to nothing when outside it", () => {
      expect(runDirWithin(scratch, scratch)).toBe("");
      expect(runDirWithin(scratch, join(scratch, ".audit"))).toBe(".audit");
      expect(runDirWithin(scratch, join(scratch, "a", "b"))).toBe("a/b");
      expect(runDirWithin(scratch, join(scratch, ".."))).toBeNull();
      expect(runDirWithin(scratch, join(scratch, "..", "sibling"))).toBeNull();
      expect(runDirWithin(scratch, undefined)).toBeNull();
    });
  });

  it("writes inventory.json", () => {
    plantCodebase(scratch);
    const path = writeInventory(scratch, buildInventory(scratch));
    const written = JSON.parse(readFileSync(path, "utf8"));

    expect(written.files.length).toBeGreaterThan(0);
    expect(written.excluded).toContain("node_modules");
  });

  it("refuses to follow a symlink out of the tree", () => {
    plantCodebase(scratch);
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.ts"), "const secret = 1;\n");
    symlinkSync(outside, join(scratch, "escape"));

    try {
      const paths = buildInventory(scratch).files.map((f) => f.path);
      expect(paths.some((p) => p.includes("secret"))).toBe(false);
      expect(paths.some((p) => p.startsWith("escape"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the access log", () => {
  it("records reads and failures alike", () => {
    const log = new FileAccessLog();
    log.record("src/app.ts", "read");
    log.record("src/missing.ts", "missing");
    log.record(".env", "denied");

    expect([...log.opened()]).toEqual(["src/app.ts"]);
    expect(log.failed()).toEqual([".env", "src/missing.ts"]);
    expect(log.all()).toHaveLength(3);
  });

  // A file read on the second attempt was read. The earlier miss must not
  // leave it sitting in the unreadable list.
  it("does not report a path as failed once it has been read", () => {
    const log = new FileAccessLog();
    log.record("src/app.ts", "too-large");
    log.record("src/app.ts", "read");

    expect([...log.opened()]).toEqual(["src/app.ts"]);
    expect(log.failed()).toEqual([]);
  });

  it("writes the log for the run record", () => {
    const log = new FileAccessLog();
    log.record("src/app.ts", "read");
    const written = JSON.parse(readFileSync(log.writeTo(scratch), "utf8"));

    expect(written[0].path).toBe("src/app.ts");
    expect(written[0].outcome).toBe("read");
    expect(written[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // The render stage recomputes coverage from this file. If it does not
  // round-trip, coverage silently reads as zero — which the renderer now
  // refuses, but the cheaper place to catch it is here.
  it("round-trips, so a later stage sees the same coverage", () => {
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    log.record("src/b.ts", "denied");
    log.writeTo(scratch);

    const reloaded = FileAccessLog.load(scratch);
    expect([...reloaded.opened()]).toEqual(["src/a.ts"]);
    expect(reloaded.failed()).toEqual(["src/b.ts"]);
  });

  it("throws rather than returning an empty log when the file is absent", () => {
    expect(() => FileAccessLog.load(join(scratch, "nowhere"))).toThrow();
  });
});

describe("coverage", () => {
  it("is the share of inventory files actually opened", () => {
    const inventory = inventoryOf([file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts")]);
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    log.record("src/b.ts", "read");

    const coverage = computeCoverage(inventory, log);
    expect(coverage).toMatchObject({ opened: 2, total: 4, share: 0.5 });
  });

  it("breaks down by language and by top-level area", () => {
    const inventory = inventoryOf([
      file("src/a.ts", "typescript"),
      file("src/b.ts", "typescript"),
      file("docs/x.md", "markdown"),
    ]);
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");

    const coverage = computeCoverage(inventory, log);
    expect(coverage.byLanguage.typescript).toMatchObject({ opened: 1, total: 2, share: 0.5 });
    expect(coverage.byLanguage.markdown).toMatchObject({ opened: 0, total: 1, share: 0 });
    expect(coverage.byArea.src).toMatchObject({ opened: 1, total: 2 });
    expect(coverage.byArea.docs).toMatchObject({ opened: 0, total: 1 });
  });

  // "We could not read this" and "we read this" must never collapse into the
  // same number — the same reason `parsed: false` exists on the analyzer side.
  it("does not count an unreadable file as covered, and names it", () => {
    const inventory = inventoryOf([file("src/a.ts"), file("src/huge.ts")]);
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    log.record("src/huge.ts", "too-large");

    const coverage = computeCoverage(inventory, log);
    expect(coverage.opened).toBe(1);
    expect(coverage.unreadable).toEqual(["src/huge.ts"]);
  });

  it("ignores reads of paths that are not in the inventory", () => {
    const inventory = inventoryOf([file("src/a.ts")]);
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    log.record("node_modules/left-pad/index.js", "read"); // excluded from the denominator

    expect(computeCoverage(inventory, log).opened).toBe(1);
  });

  it("reports zero rather than dividing by an empty inventory", () => {
    expect(computeCoverage(inventoryOf([]), new FileAccessLog())).toMatchObject({
      opened: 0,
      total: 0,
      share: 0,
    });
  });

  // The single most likely way this work gets misread.
  it("carries the file-coverage-is-not-defect-coverage caveat with the figure", () => {
    const coverage = computeCoverage(inventoryOf([file("src/a.ts")]), new FileAccessLog());
    expect(coverage.caveat).toBe(COVERAGE_CAVEAT);
    expect(coverage.caveat).toMatch(/not defect coverage/);
  });

  it.each([
    ["src/auth/session.ts", "src"],
    ["README.md", "(root)"],
    ["docs/a/b/c.md", "docs"],
  ])("puts %s under %s", (path, area) => {
    expect(topLevelArea(path)).toBe(area);
  });
});

describe("the tool loop feeds the log", () => {
  /** Drive the real read_file tool the way the model would. */
  async function read(tools: ReturnType<typeof makeRepoTools>, path: string, extra = {}) {
    const tool = tools.find((t) => t.definition.name === "read_file");
    return tool!.execute({ path, ...extra });
  }

  it("records a successful read", async () => {
    plantCodebase(scratch);
    const log = new FileAccessLog();
    await read(makeRepoTools(scratch, log), "src/app.ts");

    expect([...log.opened()]).toEqual(["src/app.ts"]);
  });

  it("records a read that failed because the file is not there", async () => {
    plantCodebase(scratch);
    const log = new FileAccessLog();
    const result = await read(makeRepoTools(scratch, log), "src/nope.ts");

    expect(result.isError).toBe(true);
    expect(log.failed()).toEqual(["src/nope.ts"]);
  });

  it("records an attempt to escape the root, and still refuses it", async () => {
    plantCodebase(scratch);
    const log = new FileAccessLog();
    const result = await read(makeRepoTools(scratch, log), "../../../etc/passwd");

    expect(result.isError).toBe(true);
    expect(log.all().map((r) => r.outcome)).toContain("escaped");
  });

  // Opening the file is not the same as seeing its contents.
  it("does not count a read whose window fell past the end of the file", async () => {
    plantCodebase(scratch);
    const log = new FileAccessLog();
    const result = await read(makeRepoTools(scratch, log), "src/app.ts", { start_line: 9000 });

    expect(result.isError).toBe(true);
    expect([...log.opened()]).toEqual([]);
  });

  it("leaves the pull-request path untouched when no recorder is passed", async () => {
    plantCodebase(scratch);
    const result = await read(makeRepoTools(scratch), "src/app.ts");
    expect(result.isError).toBeFalsy();
  });

  it("produces real coverage from a real run", async () => {
    plantCodebase(scratch);
    const log = new FileAccessLog();
    const tools = makeRepoTools(scratch, log);

    await read(tools, "src/app.ts");
    await read(tools, "src/auth/session.ts");
    await read(tools, "src/auth/nope.ts");

    const coverage = computeCoverage(buildInventory(scratch), log);
    expect(coverage.total).toBe(4); // app, session, tokens, README — node_modules excluded
    expect(coverage.opened).toBe(2);
    expect(coverage.share).toBe(0.5);
    expect(coverage.unreadable).toEqual(["src/auth/nope.ts"]);
  });
});

/**
 * TeeAccessLog: the model's own reads, beside the run's ledger.
 *
 * With the sweep running first, "files the model opened" reported from the
 * ledger became "every file in the tree" whatever the model had read. The tee
 * keeps the ledger whole for coverage and gives the stage its own count.
 */
describe("TeeAccessLog", () => {
  it("records every outcome into both logs", () => {
    const ledger = new FileAccessLog();
    const tee = new TeeAccessLog(ledger);
    tee.record("src/a.ts", "read");
    tee.record("src/gone.ts", "missing");
    expect(ledger.all().map((r) => [r.path, r.outcome])).toEqual(tee.all().map((r) => [r.path, r.outcome]));
    expect(ledger.failed()).toEqual(tee.failed());
  });

  it("counts only its own reads, while the ledger holds the union", () => {
    const ledger = new FileAccessLog();
    ledger.record("src/swept.ts", "read");
    ledger.record("src/both.ts", "read");
    const tee = new TeeAccessLog(ledger);
    tee.record("src/both.ts", "read");
    tee.record("src/model-only.ts", "read");

    expect(tee.opened()).toEqual(new Set(["src/both.ts", "src/model-only.ts"]));
    expect(ledger.opened()).toEqual(new Set(["src/swept.ts", "src/both.ts", "src/model-only.ts"]));
    expect(tee.opened().size).toBeLessThan(ledger.opened().size);
  });

  it("is a FileAccessLog, so the read tool cannot tell the difference", () => {
    expect(new TeeAccessLog(new FileAccessLog())).toBeInstanceOf(FileAccessLog);
  });
});
