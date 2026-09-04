/**
 * Model calls that failed are counted where the call is made (OGE-2711).
 *
 * A run that lost calls to the API still finishes: the question is dropped,
 * the verifier says cannot-determine, the closing turn's error is folded into
 * a degraded reason, and the stage record says "finished". Each of those is
 * the honest thing for its own stage to do, and together they leave a run
 * that reads like one whose calls all went through. These tests pin the one
 * number the release gate uses to tell the two apart, and pin that it is
 * taken at the request rather than at any of the three places the failure
 * later surfaces, so that a failure is counted once whatever it was doing.
 */

import { describe, expect, it } from "vitest";

import { makeInvestigateModel, makeVerifierModel } from "../../src/audit-model.js";
import { ModelCallFailures } from "../../src/engine/audit/model-failures.js";
import { investigate, type Claim } from "../../src/engine/audit/investigate.js";
import { verifyClaims } from "../../src/engine/audit/verify.js";
import type { Question } from "../../src/engine/audit/questions.js";
import type { ReviewTool } from "../../src/engine/tools/registry.js";

const REV = "a3f91c2";

const READ_TOOL: ReviewTool = {
  definition: {
    name: "read_file",
    description: "Read a file.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  execute: async () => ({ content: "export const guard = true;\n" }),
};

function question(id: string): Question {
  return { id, ask: `Is ${id} handled anywhere in this codebase?`, seeds: [id], absenceClaim: false };
}

interface Request {
  messages: Array<{ content: unknown }>;
  tools?: unknown;
}

/** The text of the first user message, where the question or claim is. */
function openingOf(request: Request): string {
  const blocks = request.messages[0]?.content;
  if (typeof blocks === "string") return blocks;
  const first = (blocks as Array<{ text?: string }>)[0];
  return first?.text ?? "";
}

/** A credit rejection, in the shape the SDK throws it. */
const CREDIT_REJECTED = new Error(
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
);

/**
 * A fake client that answers, throws, or asks for a file, per request.
 *
 * Decides from the request itself rather than from a call counter, because
 * questions run concurrently and a counter would make the test depend on
 * scheduling order.
 */
type Reply = "answer" | "verdict" | "throw" | "tool";

function fakeAnthropic(decide: (request: Request) => Reply) {
  const requests: Request[] = [];
  const client = {
    messages: {
      create: async (body: Request) => {
        requests.push(body);
        const reply = decide(body);
        if (reply === "throw") throw CREDIT_REJECTED;
        if (reply === "tool") {
          return {
            content: [{ type: "tool_use", id: `tu_${requests.length}`, name: "read_file", input: { path: "src/a.ts" } }],
            stop_reason: "tool_use",
            usage: {},
          };
        }
        const text = reply === "verdict" ? VERDICT : ANSWER;
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} };
      },
    },
  };
  return { client, requests };
}

const ANSWER = JSON.stringify({
  claims: [{ statement: "The guard is on.", evidence: [{ path: "src/a.ts", line: 1, quote: "export const guard" }] }],
});
const VERDICT = JSON.stringify({ outcome: "not-refuted", reason: "stands", vocabulariesTried: [] });

/** Verifier requests open with the claim; investigation requests with the question. */
function isVerifierRequest(request: Request): boolean {
  return openingOf(request).startsWith("CLAIM (from question");
}

function options(client: unknown, failures: ModelCallFailures) {
  return {
    anthropic: client as any,
    readTool: READ_TOOL,
    failures,
    log: () => {},
  };
}

describe("counting the calls the API rejected", () => {
  // Two questions rejected outright, one that answered, and then one of the
  // two verifiers on its claim rejected: three failed calls, across two stages,
  // on one counter.
  it("reports two failed question runs and one failed verifier as three", async () => {
    const failures = new ModelCallFailures();
    let verifierCalls = 0;
    // One client for both stages, as in the CLI, so one counter sees both.
    const { client } = fakeAnthropic((request) => {
      if (isVerifierRequest(request)) {
        verifierCalls += 1;
        return verifierCalls === 1 ? "throw" : "verdict";
      }
      return openingOf(request).includes("QUESTION (works)") ? "answer" : "throw";
    });

    const results = await investigate({
      questions: [question("fails-one"), question("fails-two"), question("works")],
      model: makeInvestigateModel(options(client, failures)),
      repoMapFor: () => "src/a.ts",
      analyzerJobs: [],
      subjectRev: REV,
      log: () => {},
    });

    // Each failed question still becomes a dropped run, so the stage itself is
    // unchanged by the counting.
    const dropped = results.filter((result) => result.claims.length === 0);
    expect(dropped.map((result) => result.questionId).sort()).toEqual(["fails-one", "fails-two"]);
    for (const result of dropped) {
      expect(result.dropped[0]?.statement).toMatch(/^\(run failed: .*credit balance/);
    }
    expect(failures.count()).toBe(2);

    const claims: Claim[] = results.flatMap((result) => result.claims);
    expect(claims).toHaveLength(1);

    const verification = await verifyClaims({
      claims,
      model: makeVerifierModel(options(client, failures)),
      readLine: (path) => (path === "src/a.ts" ? "export const guard = true;" : null),
      verifiers: 2,
      log: () => {},
    });

    // The crashed verifier did not clear the claim, and it did count.
    const verdicts = verification.verified[0]?.verdicts ?? [];
    expect(verdicts).toHaveLength(2);
    expect(verdicts.filter((v) => v.outcome === "cannot-determine")).toHaveLength(1);
    expect(failures.count()).toBe(3);
    expect(failures.details().every((detail) => detail.includes("credit balance"))).toBe(true);
  });

  // The closing turn is a model call like any other, made after the loop has
  // already given up. Its failure used to vanish into a degraded string.
  it("counts a closing turn that the API rejected", async () => {
    const failures = new ModelCallFailures();
    // Tools offered: keep reading. Tools withheld: that is the closing turn.
    const { client, requests } = fakeAnthropic((request) => (request.tools ? "tool" : "throw"));

    const model = makeInvestigateModel(options(client, failures));
    const response = await model.investigate({
      question: question("capped"),
      systemPrompt: "You are an auditor.",
      userPrompt: "QUESTION (capped)",
    });

    expect(requests.length).toBeGreaterThan(1);
    expect(response.truncated).toMatch(/closing turn failed/);
    expect(failures.count()).toBe(1);
  });

  it("counts nothing when every call returned", async () => {
    const failures = new ModelCallFailures();
    const { client } = fakeAnthropic(() => "answer");

    await investigate({
      questions: [question("one"), question("two")],
      model: makeInvestigateModel(options(client, failures)),
      repoMapFor: () => "src/a.ts",
      analyzerJobs: [],
      subjectRev: REV,
      log: () => {},
    });

    expect(failures.count()).toBe(0);
  });

  // A caller with no counter is unaffected: the throw still reaches it.
  it("still throws to the caller when no counter was supplied", async () => {
    const { client } = fakeAnthropic(() => "throw");
    const model = makeInvestigateModel({
      anthropic: client as any,
      readTool: READ_TOOL,
      log: () => {},
    });

    await expect(
      model.investigate({ question: question("q"), systemPrompt: "s", userPrompt: "QUESTION (q)" }),
    ).rejects.toThrow(/credit balance/);
  });
});
