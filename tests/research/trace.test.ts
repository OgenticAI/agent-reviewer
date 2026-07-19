/**
 * Reading the server-side search trace out of response content (OGE-1566).
 *
 * These fixtures are hand-written to the documented server-tool block shapes.
 * The asymmetry worth pinning: a *successful* `web_search_tool_result` carries
 * an array in `.content`, an *errored* one carries a bare object. Indexing
 * without checking `Array.isArray` first is the standard way to get this
 * wrong, and errors arrive as HTTP 200 so nothing throws to warn you.
 */

import { describe, expect, it } from "vitest";

import { extractResearchTrace, extractText } from "../../src/research/trace.js";

const SEARCH_USE = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "HIPAA Safe Harbor 18 identifiers" },
};

const SEARCH_OK = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: [
    { type: "web_search_result", url: "https://hhs.gov/hipaa/safe-harbor", title: "Safe Harbor" },
    { type: "web_search_result", url: "https://hhs.gov/hipaa/deid", title: "De-identification" },
  ],
};

const SEARCH_ERR = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_2",
  content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
};

describe("extractText", () => {
  it("joins text blocks and ignores tool blocks", () => {
    const text = extractText([
      { type: "text", text: '{"items":' },
      SEARCH_USE,
      SEARCH_OK,
      { type: "text", text: "[]}" },
    ]);
    expect(text).toBe('{"items":[]}');
  });

  it("returns an empty string when there is no text block", () => {
    expect(extractText([SEARCH_USE, SEARCH_OK])).toBe("");
  });

  it("survives malformed blocks without throwing", () => {
    expect(extractText([null, undefined, 42, "raw", { type: "text", text: "ok" }])).toBe("ok");
  });
});

describe("extractResearchTrace", () => {
  it("collects the queries the model composed", () => {
    const trace = extractResearchTrace([SEARCH_USE, SEARCH_OK]);
    expect(trace.queries).toEqual(["HIPAA Safe Harbor 18 identifiers"]);
  });

  it("collects result URLs as the permitted citation set", () => {
    const trace = extractResearchTrace([SEARCH_USE, SEARCH_OK]);
    expect(trace.citedUrls).toEqual([
      "https://hhs.gov/hipaa/safe-harbor",
      "https://hhs.gov/hipaa/deid",
    ]);
  });

  it("dedupes URLs returned by more than one search", () => {
    const trace = extractResearchTrace([SEARCH_USE, SEARCH_OK, SEARCH_OK]);
    expect(trace.citedUrls).toHaveLength(2);
  });

  it("records an errored result instead of crashing on the object shape", () => {
    const trace = extractResearchTrace([SEARCH_USE, SEARCH_ERR]);
    expect(trace.errors).toEqual(["max_uses_exceeded"]);
    expect(trace.citedUrls).toEqual([]);
  });

  it("labels an error with no code rather than dropping it", () => {
    // Silently dropping would make "search failed" indistinguishable from
    // "search found nothing" in the logs.
    const trace = extractResearchTrace([
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error" } },
    ]);
    expect(trace.errors).toEqual(["unknown_error"]);
  });

  it("returns an empty trace when no search ran", () => {
    const trace = extractResearchTrace([{ type: "text", text: "{}" }]);
    expect(trace).toEqual({ queries: [], citedUrls: [], errors: [] });
  });

  it("ignores non-search server tool uses", () => {
    const trace = extractResearchTrace([
      { type: "server_tool_use", name: "code_execution", input: { code: "1+1" } },
    ]);
    expect(trace.queries).toEqual([]);
  });

  it("preserves query order across multiple searches", () => {
    const second = { ...SEARCH_USE, id: "srvtoolu_2", input: { query: "CPT code structure" } };
    const trace = extractResearchTrace([SEARCH_USE, SEARCH_OK, second, SEARCH_OK]);
    expect(trace.queries).toEqual(["HIPAA Safe Harbor 18 identifiers", "CPT code structure"]);
  });
});
