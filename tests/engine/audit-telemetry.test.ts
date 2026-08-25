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
