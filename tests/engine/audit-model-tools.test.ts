import { describe, expect, it } from "vitest";

import { makeInvestigateModel, makeVerifierModel } from "../../src/audit-model.js";
import type { ReviewTool } from "../../src/engine/tools/registry.js";
import type { Question } from "../../src/engine/audit/questions.js";

/* ── Which tools each stage is offered ─────────────────────────────────────── */

/**
 * The investigator had `read_file` and nothing else, and the last run over a
 * large subject opened 2.2% of its files: a model that cannot search or list
 * guesses paths and answers from memory when the cap arrives. These pin the
 * registry each stage is actually sent, from the request body, because the
 * option being present on the factory proves nothing about what reaches the
 * API.
 */

const QUESTION: Question = {
  id: "unauthenticated-side-effects",
  ask: "Which endpoints are reachable without authentication?",
  seeds: ["AllowAnonymous"],
  absenceClaim: false,
};

function tool(name: string): ReviewTool {
  return {
    definition: {
      name,
      description: `${name} stub`,
      input_schema: { type: "object", properties: {} },
    },
    execute: async () => ({ content: "" }),
  };
}

const READ = tool("read_file");
const SEARCH = tool("search_repo");
const LIST = tool("list_files");

interface Captured {
  tools?: Array<{ name: string }>;
}

/** A client that answers at once and records what it was sent. */
function fakeAnthropic(text: string) {
  const requests: Captured[] = [];
  const client = {
    messages: {
      create: async (body: Captured) => {
        requests.push(JSON.parse(JSON.stringify(body)) as Captured);
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} };
      },
    },
  };
  return { client, requests };
}

function toolNames(request: Captured | undefined): string[] {
  return (request?.tools ?? []).map((t) => t.name).sort();
}

describe("the investigator's toolset", () => {
  it("offers read_file, search_repo and list_files together", async () => {
    const { client, requests } = fakeAnthropic('{"claims":[]}');
    const model = makeInvestigateModel({
      anthropic: client as never,
      readTool: READ,
      searchTools: [SEARCH, LIST],
      log: () => {},
    });
    await model.investigate({ question: QUESTION, systemPrompt: "s", userPrompt: "u" });

    expect(toolNames(requests[0])).toEqual(["list_files", "read_file", "search_repo"]);
  });

  it("still runs with the reader alone when no search tools are bound", async () => {
    const { client, requests } = fakeAnthropic('{"claims":[]}');
    const model = makeInvestigateModel({ anthropic: client as never, readTool: READ, log: () => {} });
    await model.investigate({ question: QUESTION, systemPrompt: "s", userPrompt: "u" });

    expect(toolNames(requests[0])).toEqual(["read_file"]);
  });
});

describe("the verifier's toolset", () => {
  // A verifier that can search goes looking for a better argument instead of
  // testing the cited location it was given. It keeps the reader whatever the
  // caller bound, because the CLI builds both stages from one options object.
  it("is read_file only, even when search tools were bound on the same options", async () => {
    const { client, requests } = fakeAnthropic('{"outcome":"not-refuted","reason":"","vocabulariesTried":[]}');
    const model = makeVerifierModel({
      anthropic: client as never,
      readTool: READ,
      searchTools: [SEARCH, LIST],
      log: () => {},
    });
    await model.refute({
      claim: { questionId: QUESTION.id, statement: "s", evidence: [{ path: "src/a.ts", rev: null }], absence: false },
      verifier: 1,
      systemPrompt: "s",
      userPrompt: "u",
    });

    expect(toolNames(requests[0])).toEqual(["read_file"]);
  });
});
