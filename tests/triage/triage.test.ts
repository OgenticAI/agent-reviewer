/**
 * Cheap-model pre-review triage (OGE-1595).
 *
 * The load-bearing property is **fail-open**: triage is an optimization, never
 * a gate. Any error — API failure, malformed JSON, dropped items — must fall
 * back to today's uniform "every item needs tools" behaviour, so triage can
 * make the review cheaper but never wrong.
 */

import { describe, expect, it } from "vitest";

import {
  buildTriagePrompt,
  priorityFilesFrom,
  runTriage,
  TriageResult,
  uniformTriage,
  type TriageModel,
} from "../../src/triage/triage.js";

const CHECKLIST = [
  { id: 1, text: "migration adds the column" },
  { id: 2, text: "README renders cleanly" },
];
const FILES = ["db/migrations/001.sql", "README.md"];

function model(response: string | (() => Promise<string>)): TriageModel {
  return { triage: typeof response === "string" ? async () => response : response };
}

describe("runTriage", () => {
  it("parses a well-formed triage response", async () => {
    const resp = JSON.stringify({
      items: [
        { id: 1, routing: "needs_tools", suggestedFiles: ["db/migrations/001.sql"] },
        { id: 2, routing: "trivial", suggestedFiles: [] },
      ],
    });
    const result = await runTriage({ model: model(resp), checklist: CHECKLIST, changedFiles: FILES });
    expect(result.items[0]!.routing).toBe("needs_tools");
    expect(result.items[1]!.routing).toBe("trivial");
  });

  it("tolerates a fenced JSON reply", async () => {
    const resp = "```json\n" + JSON.stringify({ items: [{ id: 1, routing: "trivial", suggestedFiles: [] }, { id: 2, routing: "untouched", suggestedFiles: [] }] }) + "\n```";
    const result = await runTriage({ model: model(resp), checklist: CHECKLIST, changedFiles: FILES });
    expect(result.items).toHaveLength(2);
  });

  it("fails open to uniform routing on an API error", async () => {
    const result = await runTriage({
      model: model(async () => { throw new Error("503"); }),
      checklist: CHECKLIST,
      changedFiles: FILES,
    });
    expect(result.items.every((i) => i.routing === "needs_tools")).toBe(true);
  });

  it("fails open on malformed JSON", async () => {
    const result = await runTriage({ model: model("not json at all"), checklist: CHECKLIST, changedFiles: FILES });
    expect(result.items.every((i) => i.routing === "needs_tools")).toBe(true);
  });

  it("normalizes a dropped item back to needs_tools rather than losing it", async () => {
    // Model only routed item 1; item 2 must still appear, defaulted.
    const resp = JSON.stringify({ items: [{ id: 1, routing: "trivial", suggestedFiles: [] }] });
    const result = await runTriage({ model: model(resp), checklist: CHECKLIST, changedFiles: FILES });
    expect(result.items.map((i) => i.id)).toEqual([1, 2]);
    expect(result.items[1]!.routing).toBe("needs_tools");
  });

  it("ignores an item id the model invented", async () => {
    const resp = JSON.stringify({
      items: [
        { id: 1, routing: "trivial", suggestedFiles: [] },
        { id: 2, routing: "trivial", suggestedFiles: [] },
        { id: 99, routing: "trivial", suggestedFiles: [] },
      ],
    });
    const result = await runTriage({ model: model(resp), checklist: CHECKLIST, changedFiles: FILES });
    expect(result.items.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe("priorityFilesFrom", () => {
  it("collects suggested files from needs_tools items only", () => {
    const result: TriageResult = {
      items: [
        { id: 1, routing: "needs_tools", suggestedFiles: ["src/a.ts", "src/b.ts"] },
        { id: 2, routing: "trivial", suggestedFiles: ["src/ignored.ts"] },
      ],
    };
    expect(priorityFilesFrom(result).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("sidecar round-trip", () => {
  it("survives JSON serialization intact", () => {
    const result = uniformTriage([1, 2, 3]);
    const round = TriageResult.parse(JSON.parse(JSON.stringify(result)));
    expect(round).toEqual(result);
  });
});

describe("buildTriagePrompt", () => {
  it("includes the checklist and file list but not a full diff", () => {
    const prompt = buildTriagePrompt({ checklist: CHECKLIST, changedFiles: FILES });
    expect(prompt).toContain("migration adds the column");
    expect(prompt).toContain("db/migrations/001.sql");
    expect(prompt).not.toContain("@@"); // no diff hunks
  });
});
