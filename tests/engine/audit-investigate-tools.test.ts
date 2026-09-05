import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeInvestigateTools } from "../../src/engine/audit/read-tool.js";
import { FileAccessLog } from "../../src/engine/audit/inventory.js";
import type { ReviewTool } from "../../src/engine/tools/registry.js";

/* ── The investigator's tools, and what each puts in the ledger ────────────── */

/**
 * Coverage is computed from the access log, so what a tool records decides
 * what the report says was read. These pin the rule in `makeRepoSearchTools`:
 * a listing shows names and records nothing; a search returned a line from a
 * file and records that file; a search that showed nothing records nothing.
 */

let root: string;
let log: FileAccessLog;
let byName: Record<string, ReviewTool>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "investigate-tools-"));
  mkdirSync(join(root, "src", "orders"), { recursive: true });
  writeFileSync(join(root, "src", "orders", "OrderService.cs"), "public class OrderService {\n  public Order GetOrderById(string id) => _store.GetItemByIdAsync<Order>(id);\n}\n");
  writeFileSync(join(root, "src", "orders", "OrderDto.cs"), "public record OrderDto(string Id);\n");
  writeFileSync(join(root, "src", "index.ts"), "export const app = 1;\n");
  log = new FileAccessLog();
  byName = Object.fromEntries(
    makeInvestigateTools({ root, log }).map((tool) => [tool.definition.name, tool]),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the toolset", () => {
  it("is read_file, search_repo and list_files, and nothing else", () => {
    expect(Object.keys(byName).sort()).toEqual(["list_files", "read_file", "search_repo"]);
  });

  it("keeps the audit's own reader, which numbers every line of a whole file", async () => {
    const result = await byName["read_file"]!.execute({ path: "src/orders/OrderService.cs" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("2\t  public Order GetOrderById");
  });
});

describe("what a search records", () => {
  it("records each file it returned a line from as read, and only those", async () => {
    const result = await byName["search_repo"]!.execute({ pattern: "GetOrderById" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("src/orders/OrderService.cs:2");
    expect([...log.opened()]).toEqual(["src/orders/OrderService.cs"]);
  });

  it("records a file once however many of its lines matched", async () => {
    await byName["search_repo"]!.execute({ pattern: "Order" });

    const records = log.all().filter((r) => r.path === "src/orders/OrderService.cs");
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("read");
  });

  it("records nothing when nothing matched", async () => {
    const result = await byName["search_repo"]!.execute({ pattern: "zzznothing" });

    expect(result.content).toMatch(/No matches/);
    expect(log.all()).toEqual([]);
  });

  // A refused search returns none of the lines it matched, so the model saw
  // nothing from those files. Recording them would count reads that did not
  // happen, which is the overstatement the ledger exists to prevent.
  it("records nothing when it refused for matching too much", async () => {
    mkdirSync(join(root, "big"));
    writeFileSync(join(root, "big", "many.txt"), "needle\n".repeat(500));

    const result = await byName["search_repo"]!.execute({ pattern: "needle" });

    expect(result.isError).toBe(true);
    expect(log.all()).toEqual([]);
  });
});

describe("what a listing records", () => {
  it("nothing: a path the model has seen the name of is not a file it has read", async () => {
    const result = await byName["list_files"]!.execute({ path_prefix: "src" });

    expect(result.content).toContain("src/orders/OrderService.cs");
    expect(log.all()).toEqual([]);
  });
});

describe("one ledger for all three", () => {
  it("shows a file once whether it was searched or read", async () => {
    await byName["search_repo"]!.execute({ pattern: "GetOrderById" });
    await byName["read_file"]!.execute({ path: "src/orders/OrderService.cs" });
    await byName["list_files"]!.execute({});

    expect([...log.opened()]).toEqual(["src/orders/OrderService.cs"]);
    // Two records, both reads, one path: the search and the read each logged.
    expect(log.all().map((r) => r.outcome)).toEqual(["read", "read"]);
  });
});
