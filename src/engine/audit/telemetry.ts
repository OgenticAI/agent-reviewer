/**
 * Audit run telemetry (OGE-2435).
 *
 * An audit runs for hours on someone's machine. Without this it is a terminal
 * you have to be sitting in front of; with it, Mission Control can show the
 * run while it happens and the findings before the PDF exists.
 *
 * The engine is the runner and the dashboard is the observer, following the
 * `podcast-pipeline → /api/podcasts/voices` pattern. This file holds the shape
 * of what is emitted and the rules about what may be emitted; the HTTP
 * transport lives outside the engine, the same split as `InvestigateModel` and
 * `audit-model.ts`.
 *
 * ── Two rules that are not conveniences ─────────────────────────────────────
 *
 * MASKING HAPPENS HERE, NOT AT DISPLAY TIME. Logs are the surface where client
 * material leaks by accident — a stack trace, a URL with a token in it, an
 * error echoing a config value. A masked line in the database is something you
 * recover from. An unmasked one in the database is an incident, and moving the
 * mask to the renderer would mean the raw value was written down first.
 *
 * LOG LINES ARE NOT A TRANSCRIPT. Paths, counts, decisions, durations — never
 * file contents or prompt bodies. That is enforced by a hard character cap
 * rather than by asking callers to be careful: at 500 characters a source file
 * physically does not fit, and a rule the type system enforces survives
 * contributors who never read this comment.
 */

import { maskSecrets, collectKnownSecrets } from "../tools/sanitize.js";
import type { AuditFinding } from "./finding.js";
import type { UsageReport } from "./usage.js";

/**
 * A run an operator stopped.
 *
 * Thrown rather than returned so it unwinds through whatever stage was running
 * without every call site having to check a flag. It is not a failure: the
 * artifacts written before the stop are valid, and the run is reported
 * `cancelled` rather than `failed`.
 */
export class RunCancelled extends Error {
  constructor(stage?: string) {
    super(
      stage
        ? `Run stopped at the operator's request, before ${stage}.`
        : `Run stopped at the operator's request.`,
    );
    this.name = "RunCancelled";
  }
}

/**
 * The eight stages, fixed and named.
 *
 * A progress bar over unnamed work is decoration. Naming them means the UI can
 * say "stuck on verify, claim 31 of 41" rather than showing a bar that is
 * three-quarters full for two hours.
 *
 * `as const` so a typo at a call site is a type error rather than a stage that
 * silently never appears in the dashboard.
 */
export const AUDIT_STAGES = [
  "acquire",
  "inventory",
  "map",
  "analyze",
  "investigate",
  "verify",
  "closure",
  "render",
] as const;

export type AuditStage = (typeof AUDIT_STAGES)[number];

/** Terminal states a stage can reach. `skipped` always carries a reason. */
export type StageStatus = "started" | "finished" | "failed" | "skipped";

export type LogLevel = "info" | "warn" | "error";

export interface StageEvent {
  kind: "stage";
  runId: string;
  stage: AuditStage;
  status: StageStatus;
  at: string;
  /** e.g. `{ questions: 9 }` — whatever the stage counts. */
  counts?: Record<string, number>;
  /** Why it was skipped or how it failed. Required for both. */
  detail?: string;
}

export interface ProgressEvent {
  kind: "progress";
  runId: string;
  stage: AuditStage;
  done: number;
  /** Absent when the stage genuinely cannot know its denominator. */
  total?: number;
  at: string;
}

export interface LogEvent {
  kind: "log";
  runId: string;
  stage: AuditStage;
  level: LogLevel;
  message: string;
  at: string;
}

export interface FindingEvent {
  kind: "finding";
  runId: string;
  finding: AuditFinding;
  at: string;
}

/**
 * The run itself stopping, as opposed to a stage finishing.
 *
 * Kept distinct from a stage status so "the run was cancelled" can never be
 * confused with "a stage failed" — a cancelled run is a partial audit someone
 * chose to stop, and a failed one is an audit that broke.
 */
export interface RunEvent {
  kind: "run";
  runId: string;
  status: "cancelled" | "mask-fired";
  at: string;
}

/**
 * What the run cost (OGE-2502).
 *
 * Carries the rate card it was priced with, so the figure the dashboard shows
 * stays a fact about THIS run rather than a recomputation against whatever the
 * price list says later.
 */
export interface UsageEvent {
  kind: "usage";
  runId: string;
  usage: UsageReport;
  at: string;
}

export type AuditEvent =
  | StageEvent
  | ProgressEvent
  | LogEvent
  | FindingEvent
  | UsageEvent
  | RunEvent;

/**
 * Where events go. Implemented by the HTTP poster outside the engine, and by a
 * collector in tests.
 *
 * `send` may reject; the recorder treats that as "not delivered yet", never as
 * a run failure.
 */
export interface SinkAck {
  /**
   * The observer asking the run to stop.
   *
   * Carried on the acknowledgement of a post the engine was making anyway,
   * because nothing can reach into this process from outside — an operator
   * clicking "stop" in Mission Control writes a row, and this is how the row
   * gets here. No polling loop, no inbound port, no second protocol.
   */
  cancelRequested?: boolean;
}

export interface TelemetrySink {
  send(events: AuditEvent[]): Promise<SinkAck | void>;
}

/**
 * The cap that makes "logs are not a transcript" mechanical.
 *
 * Long enough for a path, a count and a sentence. Far too short for a source
 * file or a prompt, which is the point.
 */
export const MAX_LOG_CHARS = 500;

export const TRUNCATION_MARKER = " …[truncated]";

export interface TelemetryOptions {
  runId: string;
  sink?: TelemetrySink;
  /** Injected so tests do not depend on the clock. */
  now?: () => Date;
  /**
   * Resolved once, like the tool loop does. Reading `process.env` per line
   * would be wasteful and would let a mid-run env change produce inconsistent
   * masking — some lines redacted, some not, in the same run.
   */
  knownSecrets?: string[];
}

/**
 * Redact and bound one piece of free text.
 *
 * Mask first, then truncate. The other order could cut a secret in half and
 * leave the surviving characters readable — a partially-masked token still
 * leaks and looks handled, which is the same trap `maskSecrets` documents for
 * overlapping secrets.
 */
export function redactLine(text: string, knownSecrets: string[]): string {
  const masked = maskSecrets(text, knownSecrets);
  if (masked.length <= MAX_LOG_CHARS) return masked;
  return (
    masked.slice(0, MAX_LOG_CHARS - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

/**
 * Records what a run is doing, and hands it to a sink.
 *
 * Every method is synchronous and never throws. A stage calling `progress` is
 * in the middle of real work; making it await a network round trip, or handle
 * a telemetry failure, would put the observer in the runner's critical path.
 * Delivery happens on `flush`.
 */
export class AuditTelemetry {
  private readonly runId: string;
  private readonly sink: TelemetrySink | undefined;
  private readonly now: () => Date;
  private readonly knownSecrets: string[];

  /** Not yet delivered. Retained on a failed flush rather than dropped. */
  private pending: AuditEvent[] = [];
  /** Everything recorded this run, for the local run record and for tests. */
  private readonly all: AuditEvent[] = [];
  /** Flushes that failed. Surfaced at the end rather than swallowed silently. */
  private undelivered = 0;
  /** Sticky once seen: a stop is not withdrawn by a later quiet acknowledgement. */
  private cancelSeen = false;
  private cancelRecorded = false;

  constructor(options: TelemetryOptions) {
    this.runId = options.runId;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.knownSecrets = options.knownSecrets ?? collectKnownSecrets();
  }

  private record(event: AuditEvent): void {
    this.all.push(event);
    this.pending.push(event);
  }

  private at(): string {
    return this.now().toISOString();
  }

  stageStarted(stage: AuditStage): void {
    this.record({
      kind: "stage",
      runId: this.runId,
      stage,
      status: "started",
      at: this.at(),
    });
  }

  stageFinished(stage: AuditStage, counts?: Record<string, number>): void {
    this.record({
      kind: "stage",
      runId: this.runId,
      stage,
      status: "finished",
      at: this.at(),
      ...(counts ? { counts } : {}),
    });
  }

  /**
   * A stage that did not run, and why.
   *
   * The reason is not optional. "semgrep is not installed" is how a
   * `parsed: false` analyzer becomes visible in the UI hours before the PDF
   * exists — a skipped stage with no reason is indistinguishable from one
   * nobody bothered to implement.
   */
  stageSkipped(stage: AuditStage, reason: string): void {
    this.record({
      kind: "stage",
      runId: this.runId,
      stage,
      status: "skipped",
      at: this.at(),
      detail: redactLine(reason, this.knownSecrets),
    });
  }

  stageFailed(stage: AuditStage, reason: string): void {
    this.record({
      kind: "stage",
      runId: this.runId,
      stage,
      status: "failed",
      at: this.at(),
      detail: redactLine(reason, this.knownSecrets),
    });
  }

  progress(stage: AuditStage, done: number, total?: number): void {
    this.record({
      kind: "progress",
      runId: this.runId,
      stage,
      done,
      ...(total !== undefined ? { total } : {}),
      at: this.at(),
    });
  }

  log(stage: AuditStage, level: LogLevel, message: string): void {
    this.record({
      kind: "log",
      runId: this.runId,
      stage,
      level,
      message: redactLine(message, this.knownSecrets),
      at: this.at(),
    });
  }

  /**
   * A finding, as soon as it is verified rather than at the end.
   *
   * Its free text is redacted like a log line. A finding whose text changes
   * under masking would be refused by the render gate anyway, so masking here
   * cannot hide something the report would have shown — it only stops the
   * database being the place the raw value landed first.
   */
  /**
   * Report what the run cost.
   *
   * No redaction here, unlike a finding's message: token counts and rates carry
   * nothing from the client's source.
   */
  usage(usage: UsageReport): void {
    this.record({ kind: "usage", runId: this.runId, at: this.at(), usage });
  }

  finding(finding: AuditFinding): void {
    this.record({
      kind: "finding",
      runId: this.runId,
      at: this.at(),
      finding: {
        ...finding,
        message: redactLine(finding.message, this.knownSecrets),
      },
    });
  }

  /**
   * Try to deliver. Never throws.
   *
   * A failed flush keeps its events pending so the next one carries them —
   * telemetry must never be the reason an engagement fails, and an audit that
   * completed but could not report its progress has still done the work.
   */
  async flush(): Promise<void> {
    if (!this.sink || this.pending.length === 0) return;

    const batch = this.pending;
    this.pending = [];

    try {
      const ack = await this.sink.send(batch);
      if (ack && ack.cancelRequested) this.cancelSeen = true;
    } catch {
      this.pending = [...batch, ...this.pending];
      this.undelivered += 1;
    }
  }

  /**
   * Has an operator asked this run to stop?
   *
   * Sticky. Once a stop has been seen it stays seen, even if a later
   * acknowledgement omits the flag — a dashboard that briefly forgets, or a
   * response that loses the field, must not un-cancel a run someone deliberately
   * stopped.
   */
  cancelRequested(): boolean {
    return this.cancelSeen;
  }

  /**
   * Stop here if an operator has asked the run to stop.
   *
   * Called at checkpoints — stage boundaries, and the per-question and
   * per-claim progress points inside the two long stages. Investigate can run
   * for ninety minutes; a stop that only took effect between stages would leave
   * an operator watching a run they had already cancelled.
   */
  throwIfCancelled(stage?: string): void {
    if (!this.cancelSeen) return;
    // Recorded here so every call site confirms the stop without having to
    // remember to. Once only — a run is cancelled once, however many
    // checkpoints it passes on the way out.
    if (!this.cancelRecorded) {
      this.cancelRecorded = true;
      this.recordCancelled();
    }
    throw new RunCancelled(stage);
  }

  /**
   * A literal secret reached the rendered report.
   *
   * Only the engine can report this: it is detected by masking the rendered
   * text and noticing that masking CHANGED it, and the dashboard never sees the
   * unmasked version — which is the point. So the fact travels as a run event
   * and becomes a release blocker on the other side.
   */
  recordMaskFired(): void {
    this.record({
      kind: "run",
      runId: this.runId,
      status: "mask-fired",
      at: this.at(),
    });
  }

  /** The engine confirming it acted. Distinct from the request. */
  recordCancelled(): void {
    this.record({
      kind: "run",
      runId: this.runId,
      status: "cancelled",
      at: this.at(),
    });
  }

  /** The run this recorder belongs to, for callers that need to address it. */
  runIdValue(): string {
    return this.runId;
  }

  /** Every event recorded this run, delivered or not. */
  events(): readonly AuditEvent[] {
    return this.all;
  }

  /** What flush could not deliver, for the operator's end-of-run summary. */
  outstanding(): { events: number; failedFlushes: number } {
    return { events: this.pending.length, failedFlushes: this.undelivered };
  }
}
