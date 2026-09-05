import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveStartedBy,
  writeLedger,
  ledgerPersister,
  keepingLedger,
  readSweep,
  readVerificationSummary,
  joinRun,
  investigateAccount,
  InvestigateRow,
} from "../src/audit-cli.js";
import { FileAccessLog } from "../src/engine/audit/inventory.js";
import { UsageMeter, buildUsageReport, DEFAULT_RATE_CARD } from "../src/engine/audit/usage.js";
import {
  AuditTelemetry,
  type AuditEvent,
  type AuditStage,
  type TelemetrySink,
} from "../src/engine/audit/telemetry.js";
import type { QuestionRunResult } from "../src/engine/audit/investigate.js";

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


/**
 * writeLedger — the run's coverage and spend, on disk at every stage boundary.
 *
 * The end-only write left a run that threw at the closure gate with no
 * access-log.json, and the renderer refused a coverage figure of zero. This
 * is the helper investigateRun now calls on the way out of each stage; the
 * stages themselves need a model, so what is tested is the write.
 */
describe("writeLedger", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ledger-test-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const usage = () => buildUsageReport(new UsageMeter(), "some-model", DEFAULT_RATE_CARD);

  it("puts both artifacts on disk where the renderer looks for them", () => {
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    const paths = writeLedger(scratch, log, usage());

    expect(paths.accessLogPath).toBe(join(scratch, "access-log.json"));
    expect(paths.usagePath).toBe(join(scratch, "usage.json"));
    expect(existsSync(paths.accessLogPath)).toBe(true);
    expect(existsSync(paths.usagePath)).toBe(true);
  });

  it("writes a log the next stage can load and continue", () => {
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    log.record("src/gone.ts", "missing");
    writeLedger(scratch, log, usage());

    const reloaded = FileAccessLog.load(scratch);
    expect(reloaded.opened()).toEqual(log.opened());
    expect(reloaded.failed()).toEqual(log.failed());
  });

  // Each call carries the latest state, so whichever stage a run dies in, what
  // is on disk is what had been read by then.
  it("replaces the previous write with the current state", () => {
    const log = new FileAccessLog();
    log.record("src/a.ts", "read");
    writeLedger(scratch, log, usage());
    const before = FileAccessLog.load(scratch).opened().size;

    log.record("src/b.ts", "read");
    writeLedger(scratch, log, usage());
    const after = FileAccessLog.load(scratch).opened().size;

    expect(after).toBe(before + 1);
  });

  it("writes the usage report as given, so a partial total is a partial total", () => {
    const report = usage();
    writeLedger(scratch, new FileAccessLog(), report);
    expect(JSON.parse(readFileSync(join(scratch, "usage.json"), "utf8"))).toEqual(report);
  });

  it("throws rather than pretending when the directory does not exist", () => {
    expect(() => writeLedger(join(scratch, "missing"), new FileAccessLog(), usage())).toThrow();
  });
});

/**
 * The ledger survives a stage that throws.
 *
 * This is the property the boundary write exists for, and `writeLedger` alone
 * does not show it: what matters is that the write runs on the way OUT of a
 * stage that died, and that a failure to write does not replace the error the
 * stage died of. Exercised here with a fake stage in place of the model.
 */
describe("keeping the ledger through a failure", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ledger-keep-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const usage = () => buildUsageReport(new UsageMeter(), "some-model", DEFAULT_RATE_CARD);
  const stageDied = new Error("closure gate: a not-determinable finding has no closure path");

  function persister(out: string, accessLog: FileAccessLog, warnings: Array<[AuditStage, string]>) {
    return ledgerPersister({ out, accessLog, usage, warn: (stage, message) => warnings.push([stage, message]) });
  }

  it("puts what was read before the throw on disk, and lets the throw through unchanged", async () => {
    const accessLog = new FileAccessLog();
    const warnings: Array<[AuditStage, string]> = [];
    const stage = async () => {
      accessLog.record("src/read-before-death.ts", "read");
      throw stageDied;
    };

    await expect(keepingLedger("closure", persister(scratch, accessLog, warnings), stage)).rejects.toBe(stageDied);

    expect(FileAccessLog.load(scratch).opened()).toEqual(accessLog.opened());
    expect(existsSync(join(scratch, "usage.json"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("returns the stage's value and writes the ledger on success too", async () => {
    const accessLog = new FileAccessLog();
    const value = await keepingLedger("verify", persister(scratch, accessLog, []), async () => {
      accessLog.record("src/a.ts", "read");
      return 42;
    });
    expect(value).toBe(42);
    expect(FileAccessLog.load(scratch).opened()).toEqual(new Set(["src/a.ts"]));
  });

  // A throw from the finally would replace the stage's own error, and "could
  // not write usage.json" is a worse diagnosis than the gate's message.
  it("reports a failed write as a warning against the stage rather than masking the stage's error", async () => {
    const notADirectory = join(scratch, "file-not-dir");
    writeFileSync(notADirectory, "");
    const warnings: Array<[AuditStage, string]> = [];

    await expect(
      keepingLedger("investigate", persister(notADirectory, new FileAccessLog(), warnings), async () => {
        throw stageDied;
      }),
    ).rejects.toBe(stageDied);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toBe("investigate");
    expect(warnings[0]?.[1]).toMatch(/investigate/);
  });

  it("does not turn a failed write into a failed stage when the stage succeeded", async () => {
    const notADirectory = join(scratch, "file-not-dir");
    writeFileSync(notADirectory, "");
    const warnings: Array<[AuditStage, string]> = [];
    await expect(
      keepingLedger("verify", persister(notADirectory, new FileAccessLog(), warnings), async () => "ok"),
    ).resolves.toBe("ok");
    expect(warnings.map(([stage]) => stage)).toEqual(["verify"]);
  });
});

/**
 * readSweep: absent and damaged are different answers.
 *
 * A damaged sweep.json used to read as "no sweep ran", and the report then
 * said the coverage figure rested on the investigation alone, for a run whose
 * sweep had read every file.
 */
describe("readSweep", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "read-sweep-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("is undefined when no sweep ran", () => {
    expect(readSweep(scratch)).toBeUndefined();
  });

  it("returns the record when it is one", () => {
    const record = { dispositions: [], signals: [], summary: [], read: 0, skipped: 0, total: 0, rev: null };
    writeFileSync(join(scratch, "sweep.json"), JSON.stringify(record));
    expect(readSweep(scratch)).toEqual(record);
  });

  it("refuses a damaged record instead of reporting that no sweep ran", () => {
    writeFileSync(join(scratch, "sweep.json"), "{ not json");
    expect(() => readSweep(scratch)).toThrow(/sweep\.json exists but could not be read/);
  });

  it("refuses a file that is not a sweep record", () => {
    writeFileSync(join(scratch, "sweep.json"), JSON.stringify({ runId: "not-a-sweep" }));
    expect(() => readSweep(scratch)).toThrow(/not a sweep record/);
  });
});

/**
 * readVerificationSummary: the record must belong to the findings.
 *
 * verification.json is written before the closure gate so a refused run
 * keeps it, and a refused run writes no findings.json. With --out reused, the
 * next render read the refused run's counts above the previous run's findings
 * and said "a rejected claim does not appear in this report" about a claim
 * set the report was not built from. Every investigate run writes
 * verification.json before findings.json; one that is newer is from a run
 * that never got that far.
 */
describe("readVerificationSummary", () => {
  let scratch: string;
  const record = { examined: 2, verified: 1, inferred: 0, notDeterminable: 0, rejected: 1 };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "read-verification-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function writeAt(name: string, content: string, secondsAgo: number): string {
    const path = join(scratch, name);
    writeFileSync(path, content);
    const at = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, at, at);
    return path;
  }

  it("is undefined when the run left no record", () => {
    expect(readVerificationSummary(scratch, join(scratch, "findings.json"))).toBeUndefined();
  });

  it("pairs a record written before the findings, as every completed run writes them", () => {
    writeAt("verification.json", JSON.stringify(record), 60);
    const findings = writeAt("findings.json", "[]", 30);
    expect(readVerificationSummary(scratch, findings)).toEqual({ summary: record, paired: true });
  });

  it("does not pair a record newer than the findings, which a refused run leaves behind", () => {
    const findings = writeAt("findings.json", "[]", 60);
    writeAt("verification.json", JSON.stringify(record), 30);
    expect(readVerificationSummary(scratch, findings)).toMatchObject({ summary: record, paired: false });
  });

  // The caller has the findings open already, so a missing stat is a race,
  // not an answer; the sweep's pairing rule makes the same call.
  it("pairs when the findings cannot be stat'ed", () => {
    writeAt("verification.json", JSON.stringify(record), 30);
    expect(readVerificationSummary(scratch, join(scratch, "not-there.json"))?.paired).toBe(true);
  });
});

/**
 * joinRun: a run is one revision.
 *
 * An --out reused after a re-acquire at another ref continued the previous
 * run's ledger and stamped the new rev onto reads made over a tree that no
 * longer existed. The record pins the rev from the first stage that knows it.
 */
describe("joinRun", () => {
  const path = "/run/run.json";
  const existing = { runId: "run-1", startedAt: "2026-09-01T00:00:00.000Z" };

  it("starts a run when there is none, carrying the rev when it is known", () => {
    const known = joinRun(undefined, "abc123", path);
    const unknown = joinRun(undefined, undefined, path);
    expect(known.write).toBe(true);
    expect(known.record.rev).toBe("abc123");
    expect(unknown.write).toBe(true);
    expect("rev" in unknown.record).toBe(false);
    expect(known.record.runId).not.toBe(unknown.record.runId);
  });

  it("joins an existing run at the same rev without rewriting it", () => {
    const joined = joinRun({ ...existing, rev: "abc123" }, "abc123", path);
    expect(joined.write).toBe(false);
    expect(joined.record.runId).toBe(existing.runId);
  });

  it("pins a rev onto a record that had none, keeping its id", () => {
    const pinned = joinRun(existing, "abc123", path);
    expect(pinned.write).toBe(true);
    expect(pinned.record).toEqual({ ...existing, rev: "abc123" });
  });

  it("joins without judgement when the caller does not know the rev", () => {
    const joined = joinRun({ ...existing, rev: "abc123" }, undefined, path);
    expect(joined.write).toBe(false);
    expect(joined.record.rev).toBe("abc123");
  });

  it("refuses a run over another revision, naming both", () => {
    expect(() => joinRun({ ...existing, rev: "abc123" }, "def456", path)).toThrow(/abc123.*def456/s);
    expect(() => joinRun({ ...existing, rev: "abc123" }, null, path)).toThrow(/fresh directory/);
  });

  it("treats a subject with no history as a rev of its own", () => {
    expect(joinRun({ ...existing, rev: null }, null, path).write).toBe(false);
    expect(() => joinRun({ ...existing, rev: null }, "abc123", path)).toThrow();
  });
});

/* ── The investigate row the release gate reads (OGE-2711) ────────────────── */

describe("the investigate row", () => {
  class Collector implements TelemetrySink {
    readonly sent: AuditEvent[] = [];
    async send(events: AuditEvent[]): Promise<void> {
      this.sent.push(...events);
    }
  }

  const GATE_KEYS = [
    "questions",
    "claims",
    "filesOpened",
    "filesInLedger",
    "modelCallFailures",
    "questionsWithFindings",
  ];

  function claimOn(questionId: string) {
    return { questionId, statement: "s", evidence: [{ path: "src/a.ts", rev: "r", line: 1 }], absence: false };
  }

  function answered(questionId: string, claims = 1): QuestionRunResult {
    return {
      questionId,
      claims: Array.from({ length: claims }, () => claimOn(questionId)),
      dropped: [],
      openedFiles: ["src/a.ts"],
    };
  }

  function silent(questionId: string): QuestionRunResult {
    return { questionId, claims: [], dropped: [], openedFiles: [] };
  }

  function setup() {
    const sink = new Collector();
    const telemetry = new AuditTelemetry({ runId: "run-1", sink, knownSecrets: [] });
    const row = new InvestigateRow(telemetry);
    const finishes = () =>
      telemetry
        .events()
        .filter((e) => e.kind === "stage" && e.stage === "investigate" && e.status === "finished");
    const warnings = () =>
      telemetry.events().flatMap((e) => (e.kind === "log" && e.level === "warn" ? [e.message] : []));
    return { telemetry, row, finishes, warnings };
  }

  const results = [answered("held", 2), answered("recalled"), silent("failed")];
  const files = { filesOpened: 4, filesInLedger: 9 };

  // The dashboard replaces counts wholesale. A row missing `questions` makes
  // the gate skip its coverage check without saying so, so every send has to
  // carry every key, and this is the test that notices when one stops.
  it("carries all six counts and the names on its first send", () => {
    const { row, finishes } = setup();
    row.send(investigateAccount({ results, ...files, modelCallFailures: 0 }));

    const [first] = finishes() as Array<{ counts: Record<string, number>; detail: string }>;
    expect(Object.keys(first!.counts).sort()).toEqual([...GATE_KEYS].sort());
    expect(first!.counts).toMatchObject({ questions: 3, claims: 3, questionsWithFindings: 2, ...files });
    expect(JSON.parse(first!.detail)).toEqual({ questionsWithoutFindings: ["failed"] });
  });

  it("does not send the same row twice", () => {
    const { row, finishes } = setup();
    const account = investigateAccount({ results, ...files, modelCallFailures: 0 });
    expect(row.send(account)).toBe(true);
    expect(row.send(investigateAccount({ results, ...files, modelCallFailures: 0 }))).toBe(false);
    expect(finishes()).toHaveLength(1);
  });

  it("re-sends the whole row, not the one field, when verify adds failures", () => {
    const { row, finishes } = setup();
    row.send(investigateAccount({ results, ...files, modelCallFailures: 0 }));
    expect(row.send(investigateAccount({ results, ...files, modelCallFailures: 2 }))).toBe(true);

    const [first, second] = finishes() as Array<{ counts: Record<string, number> }>;
    expect(Object.keys(second!.counts).sort()).toEqual(Object.keys(first!.counts).sort());
    expect(second!.counts).toEqual({ ...first!.counts, modelCallFailures: 2 });
  });

  // The starved run: every question answered from memory after its budget ran
  // out, every citation kept at parse, every one rejected at verify. The first
  // row says every question was covered. The settled row has to say what the
  // gate's own fallback would say from the findings table: only what stood.
  it("re-sends with the coverage verify left, naming the questions that lost everything", () => {
    const { row, finishes, warnings } = setup();
    const opened = investigateAccount({ results, ...files, modelCallFailures: 0 });
    row.send(opened);

    const survivors = results.flatMap((r) => r.claims).filter((c) => c.questionId === "held");
    const settled = investigateAccount({ results, standing: survivors, ...files, modelCallFailures: 0 });
    expect(row.send(settled)).toBe(true);

    const [first, second] = finishes() as Array<{ counts: Record<string, number>; detail: string }>;
    expect(second!.counts.questionsWithFindings).toBeLessThan(first!.counts.questionsWithFindings!);
    expect(second!.counts.questionsWithFindings).toBe(1);
    expect(second!.counts).toMatchObject({ questions: 3, claims: 3, ...files });
    expect(JSON.parse(second!.detail).questionsWithoutFindings).toEqual(["recalled", "failed"]);
    // A human reads the log; the names went there too, once per change.
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toMatch(/2 of 3 question\(s\).*recalled, failed/);
  });

  it("keeps the file counts the investigate stage measured on the settled row", () => {
    const { row } = setup();
    row.send(investigateAccount({ results, ...files, modelCallFailures: 0 }));
    const opened = row.sent()!;
    const settled = investigateAccount({
      results,
      standing: [],
      filesOpened: opened.counts.filesOpened,
      filesInLedger: opened.counts.filesInLedger,
      modelCallFailures: 1,
    });
    expect(settled.counts).toMatchObject(files);
    expect(settled.counts.questionsWithFindings).toBe(0);
  });

  it("says nothing about names when every question produced something", () => {
    const { row, finishes, warnings } = setup();
    row.send(investigateAccount({ results: [answered("a"), answered("b")], ...files, modelCallFailures: 0 }));
    const [first] = finishes() as Array<{ detail: string }>;
    expect(JSON.parse(first!.detail)).toEqual({ questionsWithoutFindings: [] });
    expect(warnings()).toHaveLength(0);
  });
});
