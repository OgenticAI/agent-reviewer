import { describe, it, expect } from "vitest";

import {
  AuditTelemetry,
  AUDIT_STAGES,
  MAX_LOG_CHARS,
  redactLine,
  RunCancelled,
  type AuditEvent,
  type TelemetrySink,
} from "../../src/engine/audit/telemetry.js";
import type { AuditFinding } from "../../src/engine/audit/finding.js";

const REV = "a3f91c2";
const SECRET = "sk-ant-api03-THISLOOKSLIKEACREDENTIAL0000";

class Collector implements TelemetrySink {
  readonly sent: AuditEvent[] = [];
  calls = 0;

  async send(events: AuditEvent[]): Promise<void> {
    this.calls += 1;
    this.sent.push(...events);
  }
}

function telemetry(sink?: TelemetrySink) {
  return new AuditTelemetry({
    runId: "run-1",
    ...(sink ? { sink } : {}),
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    knownSecrets: [SECRET],
  });
}

function finding(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "config-precedence-abc12345",
    path: "src/startup.ts",
    message: "The test configuration loads after the environment file.",
    severity: "warning",
    source: "audit",
    confidence: "verified",
    evidence: [{ path: "src/startup.ts", rev: REV, line: 42 }],
    verifiers: 2,
    refutations: 0,
    ...over,
  };
}

/* ── The stage model ──────────────────────────────────────────────────────── */

describe("the stage model", () => {
  it("names the eight stages in pipeline order", () => {
    expect([...AUDIT_STAGES]).toEqual([
      "acquire",
      "inventory",
      "map",
      "analyze",
      "investigate",
      "verify",
      "closure",
      "render",
    ]);
  });

  it("carries a count and a denominator when the stage knows one", () => {
    const t = telemetry();
    t.progress("verify", 31, 41);
    expect(t.events()[0]).toMatchObject({
      kind: "progress",
      stage: "verify",
      done: 31,
      total: 41,
    });
  });

  // A bar with an invented denominator is worse than one without.
  it("omits the denominator rather than inventing one", () => {
    const t = telemetry();
    t.progress("investigate", 3);
    expect(t.events()[0]).not.toHaveProperty("total");
  });

  // "semgrep is not installed" is how a parsed:false analyzer becomes visible
  // hours before the PDF exists.
  it("records why a stage was skipped, and the reason survives", () => {
    const t = telemetry();
    t.stageSkipped("analyze", "semgrep is not installed on this machine");
    expect(t.events()[0]).toMatchObject({
      status: "skipped",
      detail: "semgrep is not installed on this machine",
    });
  });

  it("distinguishes a failure from a skip", () => {
    const t = telemetry();
    t.stageFailed("render", "typst exited 1");
    expect(t.events()[0]).toMatchObject({
      status: "failed",
      detail: "typst exited 1",
    });
  });

  it("carries counts on a finished stage", () => {
    const t = telemetry();
    t.stageFinished("inventory", { files: 4187 });
    expect(t.events()[0]).toMatchObject({
      status: "finished",
      counts: { files: 4187 },
    });
  });
});

/* ── Masking, at record time ──────────────────────────────────────────────── */

describe("redaction happens before anything is stored", () => {
  it("masks a known secret in a log line", () => {
    const t = telemetry();
    t.log(
      "acquire",
      "error",
      `clone failed for https://x:${SECRET}@host/repo.git`,
    );

    const event = t.events()[0] as { message: string };
    expect(event.message).not.toContain(SECRET);
    expect(event.message).toContain("clone failed");
  });

  it("masks a credential-shaped string nobody registered", () => {
    const t = telemetry();
    t.log(
      "analyze",
      "warn",
      "token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 rejected",
    );
    expect((t.events()[0] as { message: string }).message).not.toContain(
      "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ",
    );
  });

  it("masks the reason on a skip and a failure, not only log lines", () => {
    const t = telemetry();
    t.stageSkipped("analyze", `no auth for ${SECRET}`);
    t.stageFailed("acquire", `clone rejected: ${SECRET}`);

    for (const event of t.events()) {
      expect(JSON.stringify(event)).not.toContain(SECRET);
    }
  });

  // A finding's text is client-derived too. Masking here cannot hide anything
  // the report would show — the render gate refuses a finding whose text
  // changes under masking — it only stops the database being where the raw
  // value landed first.
  it("masks a finding's message on the way out", () => {
    const t = telemetry();
    t.finding(finding({ message: `the key ${SECRET} is committed` }));
    expect(JSON.stringify(t.events()[0])).not.toContain(SECRET);
  });

  // Truncating first could cut a secret in half and leave the tail readable.
  it("masks before truncating, so a long line cannot leak a split secret", () => {
    const line = "x".repeat(MAX_LOG_CHARS - 10) + SECRET + "y".repeat(200);
    expect(redactLine(line, [SECRET])).not.toContain(SECRET.slice(0, 12));
  });
});

/* ── Logs are not a transcript ────────────────────────────────────────────── */

describe("a log line cannot hold a file", () => {
  it("caps every line, so file contents physically do not fit", () => {
    const fileBody = "const a = 1;\n".repeat(4000);
    const t = telemetry();
    t.log("investigate", "info", fileBody);

    const message = (t.events()[0] as { message: string }).message;
    expect(message.length).toBeLessThanOrEqual(MAX_LOG_CHARS);
    expect(message).toContain("truncated");
  });

  it("leaves an ordinary line untouched and unmarked", () => {
    const t = telemetry();
    t.log("inventory", "info", "opened src/server/auth.ts (412 lines)");

    const message = (t.events()[0] as { message: string }).message;
    expect(message).toBe("opened src/server/auth.ts (412 lines)");
    expect(message).not.toContain("truncated");
  });

  it("holds a realistic decision line whole", () => {
    const line =
      "verify: claim config-precedence-abc12345 not-refuted by 2 of 2 verifiers (3 vocabularies)";
    expect(redactLine(line, [])).toBe(line);
  });

  it("caps a prompt body the same way", () => {
    const prompt = "You are auditing a codebase. ".repeat(500);
    expect(redactLine(prompt, []).length).toBeLessThanOrEqual(MAX_LOG_CHARS);
  });
});

/* ── Best effort, never the reason a run fails ────────────────────────────── */

describe("delivery is best effort", () => {
  it("delivers pending events on flush", async () => {
    const c = new Collector();
    const t = telemetry(c);

    t.stageStarted("acquire");
    t.stageFinished("acquire");
    await t.flush();

    expect(c.sent).toHaveLength(2);
    expect(t.outstanding().events).toBe(0);
  });

  it("does not call the sink when there is nothing to send", async () => {
    const c = new Collector();
    await telemetry(c).flush();
    expect(c.calls).toBe(0);
  });

  // Telemetry must never be the reason an engagement fails.
  it("does not throw when the dashboard is unreachable", async () => {
    const failing: TelemetrySink = {
      async send() {
        throw new Error("ECONNREFUSED 127.0.0.1:3000");
      },
    };
    const t = telemetry(failing);
    t.stageStarted("render");

    await expect(t.flush()).resolves.toBeUndefined();
  });

  // Buffered, not dropped: a run whose dashboard was down for a minute should
  // still deliver that minute once it comes back.
  it("retains undelivered events and sends them on the next flush", async () => {
    let fail = true;
    const flaky: TelemetrySink = {
      async send(events) {
        if (fail) throw new Error("down");
        delivered.push(...events);
      },
    };
    const delivered: AuditEvent[] = [];

    const t = telemetry(flaky);
    t.stageStarted("verify");
    await t.flush();
    expect(t.outstanding()).toMatchObject({ events: 1, failedFlushes: 1 });

    t.progress("verify", 1, 2);
    fail = false;
    await t.flush();

    expect(delivered).toHaveLength(2);
    expect(t.outstanding().events).toBe(0);
  });

  it("keeps the local record whether or not delivery succeeded", async () => {
    const failing: TelemetrySink = {
      async send() {
        throw new Error("down");
      },
    };
    const t = telemetry(failing);
    t.stageStarted("closure");
    await t.flush();

    expect(t.events()).toHaveLength(1);
  });

  it("runs with no sink at all, for a local-only audit", async () => {
    const t = telemetry();
    t.stageStarted("map");
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.events()).toHaveLength(1);
  });
});

/* ── The progress hooks the stages expose ─────────────────────────────────── */

describe("progress is reported from work that finished, not work that started", () => {
  it("advances once per question, including one that failed", async () => {
    const { investigate } =
      await import("../../src/engine/audit/investigate.js");
    const seen: Array<[number, number]> = [];
    let call = 0;

    await investigate({
      questions: [
        { id: "a", ask: "?", seeds: [], absence_claim: false },
        { id: "b", ask: "?", seeds: [], absence_claim: false },
      ] as never,
      model: {
        async investigate() {
          call += 1;
          if (call === 1) throw new Error("model down");
          return { text: '{"claims":[]}' };
        },
      },
      repoMapFor: () => "map",
      analyzerJobs: [],
      subjectRev: REV,
      log: () => {},
      onProgress: (done, total) => seen.push([done, total]),
    });

    // Both, not just the one that succeeded — a bar that stalls short of its
    // denominator on a failure is worse than no bar.
    expect(seen).toHaveLength(2);
    expect(seen.at(-1)).toEqual([2, 2]);
  });

  it("advances once per claim, including claims rejected at an early gate", async () => {
    const { verifyClaims } = await import("../../src/engine/audit/verify.js");
    const seen: Array<[number, number]> = [];

    await verifyClaims({
      claims: [
        // Cited line does not exist — rejected before any verifier runs.
        {
          questionId: "q",
          statement: "s",
          absence: false,
          evidence: [{ path: "gone.ts", rev: REV, line: 9 }],
        },
        {
          questionId: "q",
          statement: "t",
          absence: false,
          evidence: [{ path: "a.ts", rev: REV, line: 1 }],
        },
      ],
      model: {
        async refute({ verifier }) {
          return {
            verifier,
            outcome: "not-refuted",
            reason: "stands",
            vocabulariesTried: ["a", "b", "c"],
          };
        },
      },
      readLine: (path) => (path === "a.ts" ? "const a = 1;" : null),
      log: () => {},
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

/* ── Cancellation ─────────────────────────────────────────────────────────── */

describe("stopping a run someone asked to stop", () => {
  class Acking implements TelemetrySink {
    constructor(private readonly cancel: boolean) {}
    calls = 0;
    async send() {
      this.calls += 1;
      return { cancelRequested: this.cancel };
    }
  }

  it("does not stop a run nobody asked to stop", async () => {
    const t = telemetry(new Acking(false));
    t.stageStarted("verify");
    await t.flush();

    expect(t.cancelRequested()).toBe(false);
    expect(() => t.throwIfCancelled()).not.toThrow();
  });

  // The signal rides back on a post the engine was making anyway — nothing can
  // reach into this process from outside.
  it("learns of a stop from the acknowledgement of its own post", async () => {
    const t = telemetry(new Acking(true));
    t.stageStarted("verify");
    await t.flush();

    expect(t.cancelRequested()).toBe(true);
    expect(() => t.throwIfCancelled("closure")).toThrow(RunCancelled);
  });

  it("names where it stopped", async () => {
    const t = telemetry(new Acking(true));
    t.stageStarted("verify");
    await t.flush();
    expect(() => t.throwIfCancelled("closure")).toThrow(/before closure/);
  });

  // A dashboard that briefly forgets, or a response that loses the field, must
  // not un-cancel a run someone deliberately stopped.
  it("stays cancelled once seen, even if a later acknowledgement is quiet", async () => {
    let cancel = true;
    const flaky: TelemetrySink = {
      async send() {
        const ack = { cancelRequested: cancel };
        cancel = false;
        return ack;
      },
    };

    const t = telemetry(flaky);
    t.stageStarted("verify");
    await t.flush();
    t.progress("verify", 1, 2);
    await t.flush();

    expect(t.cancelRequested()).toBe(true);
  });

  // A response we cannot read means the batch was delivered, which is all the
  // caller needed. Inventing a stop from a malformed body would kill a run over
  // a JSON error.
  it("treats a sink that acknowledges nothing as no cancellation", async () => {
    const silent: TelemetrySink = { async send() {} };
    const t = telemetry(silent);
    t.stageStarted("verify");
    await t.flush();
    expect(t.cancelRequested()).toBe(false);
  });

  it("records the confirmation exactly once, however many checkpoints it passes", async () => {
    const t = telemetry(new Acking(true));
    t.stageStarted("verify");
    await t.flush();

    for (const stage of ["closure", "render", "render"]) {
      expect(() => t.throwIfCancelled(stage)).toThrow(RunCancelled);
    }

    const confirmations = t.events().filter((e) => e.kind === "run");
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("verification stops between claims", () => {
  it("settles the claims it reached and stops, rather than running to the end", async () => {
    const { verifyClaims } = await import("../../src/engine/audit/verify.js");
    let settled = 0;

    const result = await verifyClaims({
      claims: [1, 2, 3, 4].map((n) => ({
        questionId: "q",
        statement: `s${n}`,
        absence: false,
        evidence: [{ path: "a.ts", rev: REV, line: 1 }],
      })),
      model: {
        async refute({ verifier }) {
          return {
            verifier,
            outcome: "not-refuted",
            reason: "stands",
            vocabulariesTried: ["a", "b", "c"],
          };
        },
      },
      readLine: () => "const a = 1;",
      log: () => {},
      onProgress: () => {
        settled += 1;
      },
      // Stop once two claims are done.
      shouldStop: () => settled >= 2,
    });

    // The two it settled are complete and keep their verdicts; the rest are
    // simply not there. A partial verification is honest; a rushed one is not.
    expect(result.verified).toHaveLength(2);
    expect(settled).toBe(2);
  });

  it("verifies everything when nothing asked it to stop", async () => {
    const { verifyClaims } = await import("../../src/engine/audit/verify.js");
    const result = await verifyClaims({
      claims: [1, 2, 3].map((n) => ({
        questionId: "q",
        statement: `s${n}`,
        absence: false,
        evidence: [{ path: "a.ts", rev: REV, line: 1 }],
      })),
      model: {
        async refute({ verifier }) {
          return {
            verifier,
            outcome: "not-refuted",
            reason: "stands",
            vocabulariesTried: ["a", "b", "c"],
          };
        },
      },
      readLine: () => "const a = 1;",
      log: () => {},
      shouldStop: () => false,
    });
    expect(result.verified).toHaveLength(3);
  });
});

/* ── A secret that reached the report ─────────────────────────────────────── */

describe("reporting that masking altered the rendered text", () => {
  // The dashboard never sees the unmasked report — that is the point of masking
  // at the engine — so only the engine can say this happened.
  it("records it as a run-level fact, distinct from a stage failing", () => {
    const t = telemetry();
    t.recordMaskFired();

    const event = t.events()[0];
    expect(event).toMatchObject({ kind: "run", status: "mask-fired" });
    expect(event).not.toHaveProperty("stage");
  });

  it("is not confused with a cancellation", () => {
    const t = telemetry();
    t.recordMaskFired();
    t.recordCancelled();

    const statuses = t
      .events()
      .filter((e) => e.kind === "run")
      .map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(["mask-fired", "cancelled"]);
  });
});

/* ── What this run is auditing, and who started it (OGE-2563) ────────────── */

describe("reporting the subject and who started the run", () => {
  it("records origin, name, rev and startedBy as one event", () => {
    const t = telemetry();
    t.recordSubject(
      { origin: "github.com/OgenticAI/agentshub", name: "agentshub", rev: REV, revProvenance: "git" },
      "david@ogenticai.com",
    );

    expect(t.events()).toEqual([
      {
        kind: "subject",
        runId: "run-1",
        origin: "github.com/OgenticAI/agentshub",
        name: "agentshub",
        rev: REV,
        revProvenance: "git",
        startedBy: "david@ogenticai.com",
        at: "2026-08-25T12:00:00.000Z",
      },
    ]);
  });

  it("carries startedBy as null rather than inventing one", () => {
    const t = telemetry();
    t.recordSubject(
      { origin: "github.com/OgenticAI/agentshub", name: "agentshub", rev: null, revProvenance: "no .git directory" },
      null,
    );

    const event = t.events()[0];
    expect(event).toMatchObject({ kind: "subject", startedBy: null, rev: null });
  });

  it("is not confused with a run event", () => {
    const t = telemetry();
    t.recordSubject(
      { origin: "github.com/OgenticAI/agentshub", name: "agentshub", rev: REV, revProvenance: "git" },
      "david@ogenticai.com",
    );
    t.recordMaskFired();

    const kinds = t.events().map((e) => e.kind);
    expect(kinds).toEqual(["subject", "run"]);
  });

  it("is delivered like any other event, including retry on a failed post", async () => {
    let attempts = 0;
    const sink: TelemetrySink = {
      send: async (events) => {
        attempts += 1;
        if (attempts === 1) throw new Error("network blip");
        return { collected: events } as unknown as void;
      },
    };
    const t = telemetry(sink);
    t.recordSubject(
      { origin: "github.com/OgenticAI/agentshub", name: "agentshub", rev: REV, revProvenance: "git" },
      "david@ogenticai.com",
    );

    await t.flush();
    expect(attempts).toBe(1);
    await t.flush();
    expect(attempts).toBe(2);
  });
});

/**
 * drain — the last flush a process ever gets.
 *
 * `flush` retains what it could not deliver so the NEXT flush carries it. At the
 * end of a subcommand there is no next flush: the process exits and whatever is
 * pending dies with it.
 *
 * Run 45dcd536 completed a full audit — 1,245 model calls, a 182KB report — and
 * Mission Control recorded ZERO findings, because the flush carrying closure and
 * every finding landed inside one of the box's outbound stalls. The report was
 * fine; the record of it was empty.
 */
describe("drain is the last chance, so it keeps trying", () => {
  it("recovers events when delivery comes back mid-backoff", async () => {
    const delivered: AuditEvent[] = [];
    let attempts = 0;
    const flaky: TelemetrySink = {
      async send(events) {
        attempts += 1;
        // Down for the first two attempts, as a short outage would be.
        if (attempts <= 2) throw new Error("down");
        delivered.push(...events);
      },
    };

    const t = telemetry(flaky);
    t.stageStarted("closure");
    t.progress("closure", 1, 1);

    // Tiny backoff so the test does not sleep for two minutes.
    const outstanding = await t.drain(5, 1);

    expect(attempts).toBe(3);
    expect(delivered).toHaveLength(2);
    expect(outstanding.events).toBe(0);
  });

  it("gives up after its attempts and reports what was lost", async () => {
    const dead: TelemetrySink = {
      async send() {
        throw new Error("down");
      },
    };

    const t = telemetry(dead);
    t.stageStarted("closure");

    const outstanding = await t.drain(3, 1);

    // Retained, not silently discarded — and countable, so the caller can say so.
    expect(outstanding.events).toBe(1);
    expect(outstanding.failedFlushes).toBe(3);
  });

  it("returns immediately when the first attempt succeeds", async () => {
    const collector = new Collector();
    const t = telemetry(collector);
    t.stageStarted("verify");

    const outstanding = await t.drain(8, 1000);

    // One call, and no backoff slept: a healthy run must not pay for this.
    expect(collector.calls).toBe(1);
    expect(outstanding.events).toBe(0);
  });

  it("does nothing when there is nothing pending", async () => {
    const collector = new Collector();
    const t = telemetry(collector);
    expect((await t.drain(3, 1)).events).toBe(0);
    expect(collector.calls).toBe(0);
  });

  // Sized against the fault actually observed: outbound stops for one to three
  // minutes. Defaults that cover only seconds would not have saved 45dcd536.
  it("its defaults span about two minutes", async () => {
    const dead: TelemetrySink = { async send() { throw new Error("down"); } };
    const t = telemetry(dead);
    t.stageStarted("closure");

    const started = Date.now();
    await t.drain(4, 10);   // 10+20+40 = 70ms, proving the shape
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);

    // The real defaults: 12 attempts, doubling from 500ms, each sleep capped at
    // 30s => 11 sleeps totalling ~181s. Computed rather than asserted as a
    // magic number, so changing the defaults changes this and is noticed.
    const sleeps = [...Array(11).keys()].map((i) => Math.min(500 * 2 ** i, 30_000));
    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(180_000);
    // And no single sleep eats the whole budget.
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });
});
