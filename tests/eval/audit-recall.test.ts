import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFECT_CATALOGUE,
  injectIntoTree,
  matchDefects,
  recallReport,
  renderRecall,
  appendRecallRun,
  readRecallRuns,
  MATCH_WINDOW_LINES,
  type AuditDefect,
  type InjectedDefect,
} from "../../src/eval/audit-recall.js";
import type { AuditFinding } from "../../src/engine/audit/finding.js";

const REV = "a3f91c2";
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "recall-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = join(scratch, "tree");
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const defect = (over: Partial<AuditDefect> = {}): AuditDefect => ({
  id: "d-1",
  class: "logic",
  path: "src/a.ts",
  find: "const guard = true;",
  replace: "const guard = false;",
  expect: "the guard is inverted",
  ...over,
});

function finding(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "q-aaaaaaaa",
    path: "src/a.ts",
    message: "m",
    severity: "error",
    source: "audit",
    confidence: "verified",
    evidence: [{ path: "src/a.ts", rev: REV, line: 3 }],
    verifiers: 2,
    refutations: 0,
    ...over,
  };
}

/* ── No model in the labelling path ───────────────────────────────────────── */

describe("ground truth is asserted, not judged", () => {
  // The whole harness is worthless if anything infers what counts as a defect.
  // Every entry is a literal string replacement with a recorded line.
  it("every catalogued defect is a literal replacement", () => {
    for (const d of DEFECT_CATALOGUE) {
      expect(typeof d.find).toBe("string");
      expect(typeof d.replace).toBe("string");
      expect(d.find.length).toBeGreaterThan(0);
      expect(d.find).not.toBe(d.replace);
    }
  });

  it("nothing in the harness reaches a model", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/eval/audit-recall.ts", import.meta.url)),
      "utf8",
    );
    for (const term of ["anthropic", "Anthropic", "InvestigateModel", "VerifierModel"]) {
      expect(src).not.toContain(term);
    }
  });

  it("covers at least three defect classes", () => {
    expect(new Set(DEFECT_CATALOGUE.map((d) => d.class)).size).toBeGreaterThanOrEqual(3);
  });

  it("records the line the corruption landed on", () => {
    const root = tree({ "src/a.ts": "one\ntwo\nconst guard = true;\nfour\n" });
    const { injected } = injectIntoTree(root, [defect()]);
    expect(injected[0]!.line).toBe(3);
  });

  it("actually corrupts the file", () => {
    const root = tree({ "src/a.ts": "const guard = true;\n" });
    injectIntoTree(root, [defect()]);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain("const guard = false;");
  });
});

/* ── A defect that cannot be planted leaves the denominator ───────────────── */

describe("defects that do not apply", () => {
  // Counting it against recall understates the engine; counting it as found
  // flatters it. Neither — it leaves the denominator, and says so.
  it("is reported rather than skipped silently", () => {
    const root = tree({ "src/a.ts": "something else entirely\n" });
    const { injected, notApplied } = injectIntoTree(root, [defect()]);

    expect(injected).toHaveLength(0);
    expect(notApplied[0]!.reason).toMatch(/no longer in/);
  });

  it("names a file that is not in the tree", () => {
    const root = tree({ "src/a.ts": "x\n" });
    const { notApplied } = injectIntoTree(root, [defect({ path: "src/absent.ts" })]);
    expect(notApplied[0]!.reason).toMatch(/not in this tree/);
  });

  // Ambiguous ground truth is not ground truth: the recorded line would be a
  // guess about which occurrence was corrupted.
  it("refuses an anchor that appears more than once", () => {
    const root = tree({ "src/a.ts": "const guard = true;\nconst guard = true;\n" });
    const { injected, notApplied } = injectIntoTree(root, [defect()]);

    expect(injected).toHaveLength(0);
    expect(notApplied[0]!.reason).toMatch(/more than once/);
  });
});

/* ── Matching ─────────────────────────────────────────────────────────────── */

const planted = (over: Partial<InjectedDefect> = {}): InjectedDefect => ({ ...defect(), line: 10, ...over });

describe("did the audit find it", () => {
  it("counts a finding citing the right file and line", () => {
    const [match] = matchDefects([planted()], [finding({ evidence: [{ path: "src/a.ts", rev: REV, line: 10 }] })]);
    expect(match!.kind).toBe("found");
    expect(match!.confidence).toBe("verified");
  });

  // A review that spots an inverted guard often cites the function around it
  // rather than the exact line.
  it("allows a finding within the window", () => {
    const near = 10 + MATCH_WINDOW_LINES;
    const [match] = matchDefects([planted()], [finding({ evidence: [{ path: "src/a.ts", rev: REV, line: near }] })]);
    expect(match!.kind).toBe("found");
  });

  it("counts nothing at all as missed", () => {
    expect(matchDefects([planted()], [])[0]!.kind).toBe("missed");
  });

  it("does not count a finding in a different file", () => {
    const [match] = matchDefects([planted()], [finding({ evidence: [{ path: "src/other.ts", rev: REV, line: 10 }] })]);
    expect(match!.kind).toBe("missed");
  });

  // The number we are least entitled to inflate. A finding citing the right
  // file at the wrong place might be a vague hit or an unrelated finding, and
  // from the data alone those are not separable.
  it("does not count a far-away finding in the same file as found", () => {
    const far = 10 + MATCH_WINDOW_LINES + 1;
    const [match] = matchDefects([planted()], [finding({ evidence: [{ path: "src/a.ts", rev: REV, line: far }] })]);
    expect(match!.kind).toBe("same-file-only");
  });

  it("treats a finding with no line as same-file-only, not found", () => {
    const [match] = matchDefects([planted()], [finding({ evidence: [{ path: "src/a.ts", rev: REV }] })]);
    expect(match!.kind).toBe("same-file-only");
  });
});

/* ── The number ───────────────────────────────────────────────────────────── */

describe("the recall figure", () => {
  const hit = (line: number) => finding({ evidence: [{ path: "src/a.ts", rev: REV, line }] });

  it("is found over injected", () => {
    const matches = matchDefects([planted({ id: "a" }), planted({ id: "b", line: 500 })], [hit(10)]);
    const report = recallReport(matches);

    expect(report.injected).toBe(2);
    expect(report.found).toBe(1);
    expect(report.recall).toBe(0.5);
  });

  // The point of the whole exercise is that this number is allowed to be bad.
  it("can be zero", () => {
    expect(recallReport(matchDefects([planted()], [])).recall).toBe(0);
  });

  it("breaks down by defect class", () => {
    const matches = matchDefects(
      [planted({ id: "a", class: "logic" }), planted({ id: "b", class: "config", line: 500 })],
      [hit(10)],
    );
    const report = recallReport(matches);

    expect(report.byClass["logic"]).toMatchObject({ injected: 1, found: 1, recall: 1 });
    expect(report.byClass["config"]).toMatchObject({ injected: 1, found: 0, recall: 0 });
  });

  it("breaks down by the confidence the engine settled on", () => {
    const matches = matchDefects([planted()], [finding({ confidence: "not-determinable", evidence: [{ path: "src/a.ts", rev: REV, line: 10 }] })]);
    expect(recallReport(matches).byConfidence["not-determinable"]).toBe(1);
  });

  // Stated as a bound, never folded into the headline.
  it("reports the same-file upper bound separately from recall", () => {
    const matches = matchDefects([planted()], [finding({ evidence: [{ path: "src/a.ts", rev: REV, line: 900 }] })]);
    const report = recallReport(matches);

    expect(report.recall).toBe(0);
    expect(report.sameFileOnly).toBe(1);
    expect(report.recallUpperBound).toBe(1);
  });
});

/* ── What a report may cite ───────────────────────────────────────────────── */

describe("the paragraph a report cites", () => {
  it("states recall and that it is not coverage", () => {
    const text = renderRecall(recallReport(matchDefects([planted()], []))).join("\n");
    expect(text).toMatch(/Measured recall: 0 of 1/);
    expect(text).toMatch(/not file coverage/);
    expect(text).toMatch(/share of files this/);
  });

  it("calls the upper bound a bound, not a result", () => {
    const matches = matchDefects([planted()], [finding({ evidence: [{ path: "src/a.ts", rev: REV, line: 900 }] })]);
    const text = renderRecall(recallReport(matches)).join("\n");

    expect(text).toMatch(/NOT counted as found/);
    expect(text).toMatch(/an upper bound, not a result/);
  });

  it("says when defects left the denominator", () => {
    const text = renderRecall(recallReport(matchDefects([planted()], []), 2)).join("\n");
    expect(text).toMatch(/2 defect\(s\) in the catalogue could not be planted/);
    expect(text).toMatch(/left the denominator/);
  });
});

/* ── Drift over time ──────────────────────────────────────────────────────── */

describe("runs persist so drift is visible", () => {
  // A single "current recall" that gets overwritten hides the thing worth
  // watching: whether the number moves when the engine changes.
  it("appends rather than overwrites", () => {
    const base = recallReport(matchDefects([planted()], []));
    appendRecallRun(scratch, { ...base, at: "2026-08-25T12:00:00.000Z", subjectRev: "r1" });
    appendRecallRun(scratch, { ...base, at: "2026-08-26T12:00:00.000Z", subjectRev: "r2" });

    const runs = readRecallRuns(scratch);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.subjectRev)).toEqual(["r1", "r2"]);
  });

  it("reads back nothing when nothing has run", () => {
    expect(readRecallRuns(scratch)).toEqual([]);
  });

  it("skips a corrupt line rather than losing the whole history", () => {
    const base = recallReport(matchDefects([planted()], []));
    appendRecallRun(scratch, { ...base, at: "2026-08-25T12:00:00.000Z", subjectRev: "r1" });
    writeFileSync(join(scratch, "recall.jsonl"), readFileSync(join(scratch, "recall.jsonl"), "utf8") + "{not json\n");

    expect(readRecallRuns(scratch)).toHaveLength(1);
  });
});
