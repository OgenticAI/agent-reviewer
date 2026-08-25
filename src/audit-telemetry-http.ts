/**
 * Posting audit telemetry to Mission Control.
 *
 * The transport half of OGE-2435. Kept out of `src/engine/` for the same
 * reason `audit-model.ts` is: the engine defines `TelemetrySink` as an
 * interface and is tested against a collector, and this is the one file that
 * knows a dashboard exists.
 *
 * Follows the `podcast-pipeline → /api/podcasts/voices` shape: bearer token,
 * best effort, and the run does not care whether it worked.
 *
 * ── Off unless configured ───────────────────────────────────────────────────
 *
 * No environment variables means no sink at all, and an audit runs exactly as
 * it does today. That is what lets the engine ship fully instrumented before
 * the ingest route exists, rather than pointing at a half-built endpoint and
 * logging a failed POST every few seconds.
 */

import type { AuditEvent, TelemetrySink } from "./engine/audit/telemetry.js";

/**
 * How long to wait for the dashboard before giving up on a batch.
 *
 * Short deliberately. `flush` is called between stages of a run that already
 * takes hours; a dashboard that has stopped answering must cost seconds, not
 * minutes. The batch is retained either way, so a timeout loses nothing but
 * time.
 */
export const POST_TIMEOUT_MS = 5_000;

export interface HttpSinkOptions {
  /** Base URL of Mission Control, e.g. https://mission.ogenticai.com */
  baseUrl: string;
  token: string;
  runId: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpTelemetrySink implements TelemetrySink {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpSinkOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/api/audits/${encodeURIComponent(options.runId)}/events`;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? POST_TIMEOUT_MS;
  }

  /**
   * Post a batch.
   *
   * Throws on anything that is not a success, which is what tells
   * `AuditTelemetry.flush` to keep the batch pending. A non-2xx that resolved
   * silently would look delivered and be lost — the failure has to be loud
   * here so it can be quiet upstream.
   */
  async send(events: AuditEvent[]): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`telemetry POST ${this.url} returned ${response.status}`);
    }
  }
}

/**
 * Build a sink from the environment, or `undefined` for a local-only run.
 *
 * Both variables or neither. One without the other is a misconfiguration
 * rather than a preference, and silently running without telemetry because
 * someone set the URL and forgot the token is the kind of quiet degradation
 * that gets noticed a week later.
 */
export function sinkFromEnv(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): { sink?: TelemetrySink; note: string } {
  const baseUrl = env["AUDIT_TELEMETRY_URL"];
  const token = env["AUDIT_TELEMETRY_TOKEN"];

  if (!baseUrl && !token) {
    return { note: "telemetry off — AUDIT_TELEMETRY_URL is not set; this run is local only" };
  }
  if (!baseUrl || !token) {
    const missing = baseUrl ? "AUDIT_TELEMETRY_TOKEN" : "AUDIT_TELEMETRY_URL";
    return { note: `telemetry off — ${missing} is missing; set both or neither` };
  }

  return {
    sink: new HttpTelemetrySink({ baseUrl, token, runId }),
    note: `telemetry → ${baseUrl}`,
  };
}
