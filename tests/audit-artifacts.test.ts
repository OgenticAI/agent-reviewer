import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  ArtifactUploader,
  uploaderFromEnv,
  MAX_ARTIFACT_BYTES,
} from "../src/audit-artifacts.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "artifact-upload-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function file(name: string, bytes: Buffer | string): string {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  return path;
}

function uploader(fetchImpl: typeof fetch) {
  return new ArtifactUploader({
    baseUrl: "https://mission.example",
    token: "t",
    runId: "run-1",
    fetchImpl,
  });
}

const ok = (body: unknown = { ok: true, artifactId: "a-1" }) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("sending a rendered report", () => {
  it("posts the bytes with a digest taken over them", async () => {
    const pdf = Buffer.from("%PDF-1.7 report");
    const path = file("report.pdf", pdf);

    let sent: Record<string, unknown> = {};
    const capture = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, artifactId: "a-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await uploader(capture).upload(path, "pdf", false);

    expect(result).toMatchObject({ uploaded: true, bytes: pdf.length, artifactId: "a-1" });
    expect(sent["sha256"]).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(Buffer.from(String(sent["contentBase64"]), "base64")).toEqual(pdf);
    expect(sent["kind"]).toBe("pdf");
  });

  it("addresses the run it belongs to, with the machine bearer", async () => {
    let url = "";
    let auth = "";
    const capture = (async (u: string, init: RequestInit) => {
      url = u;
      auth = String((init.headers as Record<string, string>)["authorization"]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await uploader(capture).upload(file("report.typ", "= Report"), "typ", true);

    expect(url).toBe("https://mission.example/api/audits/run-1/artifacts");
    expect(auth).toBe("Bearer t");
  });

  it("carries whether the report was released", async () => {
    let sent: Record<string, unknown> = {};
    const capture = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await uploader(capture).upload(file("report.pdf", "x"), "pdf", true);
    expect(sent["released"]).toBe(true);
  });
});

/* ── Never the reason an audit fails ──────────────────────────────────────── */

describe("failure is reported, never thrown", () => {
  it("survives a dashboard that is not there", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await uploader(dead).upload(file("report.pdf", "x"), "pdf", false);
    expect(result.uploaded).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  // A 503 means the dashboard cannot encrypt yet; a 413 means the report is too
  // big. Those want different actions, so the status and the body both travel.
  it("reports the status and the reason, not a bare failure", async () => {
    const refuse = (async () =>
      new Response(JSON.stringify({ error: "NO_BACKEND", message: "no key backend" }), {
        status: 503,
      })) as unknown as typeof fetch;

    const result = await uploader(refuse).upload(file("report.pdf", "x"), "pdf", false);
    expect(result.uploaded).toBe(false);
    expect(result.reason).toMatch(/503/);
    expect(result.reason).toMatch(/NO_BACKEND/);
  });

  it("says which file it could not read", async () => {
    const result = await uploader(ok()).upload(join(scratch, "absent.pdf"), "pdf", false);
    expect(result.uploaded).toBe(false);
    expect(result.reason).toMatch(/could not read/);
  });

  it("refuses an empty file rather than uploading nothing", async () => {
    const result = await uploader(ok()).upload(file("empty.pdf", ""), "pdf", false);
    expect(result.uploaded).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  // There is no bucket to presign against, so the honest answer is no — not a
  // truncated report, which would look complete and not be.
  it("refuses an oversized report and names the size", async () => {
    let called = false;
    const watch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const big = file("big.pdf", Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x41));
    const result = await uploader(watch).upload(big, "pdf", false);

    expect(result.uploaded).toBe(false);
    expect(result.reason).toMatch(/over the \d+-byte upload limit/);
    expect(called).toBe(false);
  });

  it("keeps a long server error out of the operator's terminal", async () => {
    const shouty = (async () =>
      new Response("y".repeat(9000), { status: 500 })) as unknown as typeof fetch;

    const result = await uploader(shouty).upload(file("report.pdf", "x"), "pdf", false);
    expect(result.reason!.length).toBeLessThan(300);
  });
});

/* ── Configuration ────────────────────────────────────────────────────────── */

describe("configuration", () => {
  it("reuses the telemetry variables rather than inventing a second pair", () => {
    const up = uploaderFromEnv("run-1", {
      AUDIT_TELEMETRY_URL: "https://mission.example",
      AUDIT_TELEMETRY_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(up).toBeInstanceOf(ArtifactUploader);
  });

  it("is absent for a local-only run", () => {
    expect(uploaderFromEnv("run-1", {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      uploaderFromEnv("run-1", { AUDIT_TELEMETRY_URL: "https://x" } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});
