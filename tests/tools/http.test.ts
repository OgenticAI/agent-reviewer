/**
 * Allowlisted HTTP fetch (OGE-1556).
 *
 * The URL comes from model output, and the model's input includes a
 * PR-authored diff. So the allowlist tests are the point of this file: an
 * unrestricted fetcher in a process holding an Anthropic key, a Linear token,
 * and a GitHub App private key is an SSRF primitive.
 */

import { describe, expect, it, vi } from "vitest";

import {
  assertAllowedUrl,
  HostNotAllowedError,
  HTTP_MAX_BYTES,
  makeHttpTools,
} from "../../src/engine/tools/http.js";

function okFetch(body: string) {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => body }));
}

function tool(fetchImpl: unknown) {
  return makeHttpTools(fetchImpl as never)[0]!;
}

describe("assertAllowedUrl", () => {
  it("accepts an allowlisted https host", () => {
    expect(assertAllowedUrl("https://pypi.org/pypi/ogentic-shield/json").hostname).toBe("pypi.org");
  });

  it("rejects a host that merely ends with an allowlisted one", () => {
    // endsWith("pypi.org") would accept this — the classic way this check is
    // written wrong.
    expect(() => assertAllowedUrl("https://evil-pypi.org/x")).toThrow(HostNotAllowedError);
  });

  it("rejects cloud metadata and internal addresses", () => {
    expect(() => assertAllowedUrl("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => assertAllowedUrl("https://localhost/admin")).toThrow();
    expect(() => assertAllowedUrl("https://10.0.0.1/")).toThrow();
  });

  it("rejects non-https schemes", () => {
    expect(() => assertAllowedUrl("http://pypi.org/x")).toThrow(/https only/);
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow();
  });

  it("rejects a malformed URL", () => {
    expect(() => assertAllowedUrl("not a url")).toThrow(HostNotAllowedError);
  });

  it("explains that general link-checking is unsupported", () => {
    // The model should leave those items UNVERIFIABLE rather than retrying.
    expect(() => assertAllowedUrl("https://example.com/badge.svg")).toThrow(/UNVERIFIABLE/);
  });
});

describe("fetch_url", () => {
  it("returns the body from an allowlisted host", async () => {
    const r = await tool(okFetch('{"info":{"version":"0.2.0"}}')).execute({
      url: "https://pypi.org/pypi/ogentic-shield/json",
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("0.2.0");
  });

  it("refuses a disallowed host without making a request", async () => {
    const f = okFetch("secret");
    const r = await tool(f).execute({ url: "https://169.254.169.254/" });
    expect(r.isError).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses to follow redirects", async () => {
    // A 302 from an allowlisted host to an internal one would otherwise walk
    // straight around the allowlist.
    const f = vi.fn(async (_url: string, init?: { redirect?: string }) => {
      expect(init?.redirect).toBe("error");
      return { ok: true, status: 200, text: async () => "body" };
    });
    await tool(f).execute({ url: "https://pypi.org/x" });
    expect(f).toHaveBeenCalled();
  });

  it("reports a non-200 as an error result", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }));
    const r = await tool(f).execute({ url: "https://pypi.org/pypi/nope/json" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("404");
  });

  it("truncates an oversized body rather than blowing the context", async () => {
    const r = await tool(okFetch("x".repeat(HTTP_MAX_BYTES + 5000))).execute({
      url: "https://pypi.org/x",
    });
    expect(r.content).toMatch(/truncated at \d+ bytes/);
    expect(r.content.length).toBeLessThan(HTTP_MAX_BYTES + 200);
  });

  it("turns a network failure into an error result, not a throw", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await tool(f).execute({ url: "https://pypi.org/x" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Fetch failed/);
  });

  it("validates its own input", async () => {
    expect((await tool(okFetch("x")).execute({})).isError).toBe(true);
    expect((await tool(okFetch("x")).execute(null)).isError).toBe(true);
  });
});
