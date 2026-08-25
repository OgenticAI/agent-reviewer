/**
 * Uploading a rendered report to Mission Control (OGE-2474).
 *
 * The engine renders to the operator's disk and, if Mission Control is
 * configured, sends a copy so the run page can offer it. OGE-2472 chose
 * Mission Control over the client's dataroom as the artifact's home; OGE-2475
 * built the encrypted store that receives this.
 *
 * Outside `src/engine/` for the same reason `audit-telemetry-http.ts` is: the
 * engine does not know a dashboard exists.
 *
 * ── Best effort, in the same sense telemetry is ─────────────────────────────
 *
 * A failed upload never fails a completed audit. The report is already on disk
 * and is the real artifact; this is a convenience so somebody who is not sitting
 * at that machine can read it. Every failure returns a reason the CLI prints,
 * and the run stays local-only — which the run page already knows how to say.
 *
 * ── Reuse the configuration, not the transport ──────────────────────────────
 *
 * Same `AUDIT_TELEMETRY_URL` / `AUDIT_TELEMETRY_TOKEN` as the telemetry sink —
 * one host, one credential. Not the same path: `TelemetrySink.send` posts JSON
 * events whose every free-text field is capped at 500 characters *precisely so
 * a file cannot be smuggled through it*. That cap stays exactly where it is.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * The most an upload may carry, matching the receiving route.
 *
 * Bodies are JSON with base64 bytes, which inflates by a third, against a
 * serverless request cap. OGE-1641 solved this elsewhere with a presigned
 * direct-to-storage upload; that is unavailable here because the store keeps
 * ciphertext in Postgres and there is no bucket to presign against. So an
 * oversized report is not uploaded, and says so, rather than being truncated
 * into something that looks like a report and is not.
 */
export const MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;

/** How long to wait. Longer than a telemetry flush — this is a whole file. */
export const UPLOAD_TIMEOUT_MS = 30_000;

export type ArtifactKind = "pdf" | "typ";

export interface UploadResult {
  uploaded: boolean;
  /** Present when it did not happen. Printed by the CLI, never thrown. */
  reason?: string;
  artifactId?: string;
  bytes?: number;
}

export interface UploaderOptions {
  baseUrl: string;
  token: string;
  runId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ArtifactUploader {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: UploaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  }

  /**
   * Send one file. Never throws.
   *
   * The digest is taken over the bytes read from disk and sent with them, so
   * the receiving end can reject a body that arrived truncated rather than
   * storing it and discovering the problem when somebody opens it.
   */
  async upload(
    path: string,
    kind: ArtifactKind,
    released: boolean,
  ): Promise<UploadResult> {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      return {
        uploaded: false,
        reason: `could not read ${path}: ${describe(error)}`,
      };
    }

    if (bytes.length === 0) {
      return { uploaded: false, reason: `${basename(path)} is empty` };
    }
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      return {
        uploaded: false,
        reason:
          `${basename(path)} is ${bytes.length} bytes, over the ${MAX_ARTIFACT_BYTES}-byte upload limit — ` +
          `it stays on this machine`,
      };
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/api/audits/${encodeURIComponent(
      this.options.runId,
    )}/artifacts`;

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify({
          kind,
          filename: basename(path),
          released,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentBase64: bytes.toString("base64"),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        // The reason travels back to the operator rather than a bare status: a
        // 503 means the dashboard cannot encrypt yet, and a 413 means the
        // report is too big. Those want different actions.
        const detail = await response.text().catch(() => "");
        return {
          uploaded: false,
          reason: `upload returned ${response.status}${detail ? ` — ${trim(detail)}` : ""}`,
        };
      }

      const body = (await response.json().catch(() => ({}))) as {
        artifactId?: unknown;
      };
      return {
        uploaded: true,
        bytes: bytes.length,
        ...(typeof body.artifactId === "string"
          ? { artifactId: body.artifactId }
          : {}),
      };
    } catch (error) {
      return { uploaded: false, reason: `upload failed: ${describe(error)}` };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep a server's error out of the operator's terminal at full length. */
function trim(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * An uploader from the environment, or `undefined` for a local-only run.
 *
 * Deliberately the same variables the telemetry sink reads. A second pair would
 * be a second thing to get wrong, and there is only one Mission Control.
 */
export function uploaderFromEnv(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): ArtifactUploader | undefined {
  const baseUrl = env["AUDIT_TELEMETRY_URL"];
  const token = env["AUDIT_TELEMETRY_TOKEN"];
  if (!baseUrl || !token) return undefined;
  return new ArtifactUploader({ baseUrl, token, runId });
}
