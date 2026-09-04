import { describe, it, expect } from "vitest";

import {
  deriveClosure,
  toAuditFindings,
  findingId,
  consolidateAsk,
  renderAsk,
  assertAllClosuresResolved,
  settleClosure,
  CLOSURE_CATALOGUE,
  type ClosureResult,
} from "../../src/engine/audit/closure.js";
import { validateFindings, type AuditFinding } from "../../src/engine/audit/finding.js";
import type { VerifiedClaim } from "../../src/engine/audit/verify.js";
import type { Claim } from "../../src/engine/audit/investigate.js";

const REV = "a3f91c2";

function claim(over: Partial<Claim> = {}): Claim {
  return {
    questionId: "config-precedence",
    statement: "Production behaviour cannot be established from the repository.",
    evidence: [{ path: "src/startup.ts", rev: REV, line: 42 }],
    absence: false,
    ...over,
  };
}

function verified(over: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    claim: claim(),
    verdicts: [],
    confidence: "verified",
    verifiers: 2,
    refutations: 0,
    vocabulariesTried: [],
    ...over,
  };
}

describe("drafting a closure path", () => {
  it("prices a known kind of access", () => {
    const closure = deriveClosure("the deployed configuration for production");
    expect(closure).toMatchObject({
      effortHours: 1,
      blocker: "Client exports the configuration from the hosting console",
    });
    expect(closure?.method).toMatch(/key by key/);
  });

  // The finding should read as an answer to its own question, not as a
  // catalogue entry that happened to match.
  it("keeps the verifier's own words for what it lacked", () => {
    const closure = deriveClosure("the App Service configuration blade");
    expect(closure?.access).toContain("the App Service configuration blade");
  });

  it.each([
    ["container acl", 0.5],
    ["a read-only database connection", 2],
    ["production log sample", 2],
    ["a runtime instance", 4],
    ["the deployment pipeline history", 1],
  ])("prices %s at %s hours", (access, hours) => {
    expect(deriveClosure(access)?.effortHours).toBe(hours);
  });

  // An invented estimate is worse than an absent one: someone quotes against
  // these numbers.
  it("returns null for an access it cannot price rather than guessing", () => {
    expect(deriveClosure("a conversation with the original architect")).toBeNull();
  });

  it("never prices anything at zero or less", () => {
    for (const template of CLOSURE_CATALOGUE) {
      expect(template.effortHours).toBeGreaterThan(0);
    }
  });

  // The credential entry must not invite anyone to hand over a value.
  it("asks for a credential by name only, never its value", () => {
    const closure = deriveClosure("which credential the service uses");
    expect(closure?.method).toMatch(/no value is requested or handled/);
  });
});

describe("turning verified claims into findings", () => {
  it("attaches a closure path to a not-determinable finding", () => {
    const result = toAuditFindings({
      verified: [
        verified({
          confidence: "not-determinable",
          needsAccess: "the deployed configuration for production",
        }),
      ],
    });

    expect(result.unresolved).toEqual([]);
    expect(result.findings[0]?.closure).toMatchObject({ effortHours: 1 });
  });

  it("leaves a settled finding without one", () => {
    const result = toAuditFindings({ verified: [verified()] });
    expect(result.findings[0]?.closure).toBeUndefined();
  });

  it("carries verifiers and refutations onto the finding", () => {
    const result = toAuditFindings({
      verified: [verified({ verifiers: 3, refutations: 0 })],
    });
    expect(result.findings[0]).toMatchObject({ verifiers: 3, refutations: 0 });
  });

  // The gate. An unpriced open question must not reach a report.
  it("reports an unpriceable access as unresolved rather than inventing hours", () => {
    const result = toAuditFindings({
      verified: [
        verified({ confidence: "not-determinable", needsAccess: "a conversation with the architect" }),
      ],
    });

    expect(result.unresolved).toHaveLength(1);
    expect(result.findings[0]?.closure).toBeUndefined();
    expect(() => assertAllClosuresResolved(result)).toThrow(/no closure path/);
  });

  it("says what to do about an unresolved closure", () => {
    const result = toAuditFindings({
      verified: [verified({ confidence: "not-determinable", needsAccess: "something novel" })],
    });
    expect(() => assertAllClosuresResolved(result)).toThrow(/Add a template to CLOSURE_CATALOGUE/);
  });

  it("passes the gate when everything is priced", () => {
    const result = toAuditFindings({
      verified: [verified({ confidence: "not-determinable", needsAccess: "runtime instance" })],
    });
    expect(() => assertAllClosuresResolved(result)).not.toThrow();
  });

  // An absence claim downgraded for thin searching needs more work from US, and
  // must not appear in the client's ask as though it were their job.
  it("prices a downgraded absence claim as our own runtime confirmation", () => {
    const result = toAuditFindings({
      verified: [
        verified({
          claim: claim({ absence: true, statement: "No client consumes the event." }),
          confidence: "not-determinable",
        }),
      ],
    });
    expect(result.findings[0]?.closure?.access).toMatch(/genuinely absent/);
  });

  it("produces findings that pass the OGE-2427 invariants", () => {
    const result = toAuditFindings({
      verified: [
        verified({ claim: claim({ evidence: [{ path: "a.ts", rev: REV, line: 1 }] }) }),
        verified({
          claim: claim({ questionId: "other", evidence: [{ path: "b.ts", rev: REV }] }),
          confidence: "not-determinable",
          needsAccess: "the deployed configuration",
        }),
      ],
    });

    expect(validateFindings(result.findings, REV)).toEqual([]);
  });
});

describe("finding ids", () => {
  it("is stable across runs for the same claim", () => {
    const a = findingId("q", "a statement", [{ path: "src/a.ts", rev: REV, line: 4 }]);
    const b = findingId("q", "a statement", [{ path: "src/a.ts", rev: REV, line: 4 }]);
    expect(a).toBe(b);
  });

  // A finding that moved down a file is the same finding.
  it("does not change when the cited line moves", () => {
    const before = findingId("q", "s", [{ path: "src/a.ts", rev: REV, line: 4 }]);
    const after = findingId("q", "s", [{ path: "src/a.ts", rev: REV, line: 91 }]);
    expect(before).toBe(after);
  });

  it("differs for a different statement, question or file", () => {
    const base = findingId("q", "s", [{ path: "a.ts", rev: REV }]);
    expect(findingId("q", "different", [{ path: "a.ts", rev: REV }])).not.toBe(base);
    expect(findingId("other", "s", [{ path: "a.ts", rev: REV }])).not.toBe(base);
    expect(findingId("q", "s", [{ path: "b.ts", rev: REV }])).not.toBe(base);
  });

  it("carries the question id, so an id is readable on sight", () => {
    expect(findingId("config-precedence", "s", [])).toMatch(/^config-precedence-[0-9a-f]{8}$/);
  });
});

describe("the consolidated ask", () => {
  function open(id: string, blocker: string, hours: number, access: string): AuditFinding {
    return {
      id,
      path: "a.ts",
      message: "m",
      severity: "warning",
      source: "audit",
      confidence: "not-determinable",
      evidence: [],
      verifiers: 2,
      refutations: 0,
      closure: { access, method: "m", effortHours: hours, blocker },
    };
  }

  // One person exports one thing and several findings close at once — a much
  // easier conversation than five separate requests.
  it("groups by blocker, because that is the unit of action", () => {
    const ask = consolidateAsk([
      open("a", "Client exports config", 1, "config dump"),
      open("b", "Client exports config", 0.5, "environment variables"),
      open("c", "Client provisions read-only credentials", 2, "schema"),
    ]);

    expect(ask.totalHours).toBe(3.5);
    expect(ask.openFindings).toBe(3);
    expect(ask.byBlocker).toHaveLength(2);
    expect(ask.byBlocker[0]).toMatchObject({ hours: 1.5 });
    expect(ask.byBlocker[0]?.access).toEqual(["config dump", "environment variables"]);
  });

  it("ignores settled findings", () => {
    const settled: AuditFinding = {
      id: "x",
      path: "a.ts",
      message: "m",
      severity: "info",
      source: "audit",
      confidence: "verified",
      evidence: [{ path: "a.ts", rev: REV }],
      verifiers: 2,
      refutations: 0,
    };
    expect(consolidateAsk([settled, open("a", "b", 1, "c")]).openFindings).toBe(1);
  });

  it("says there is no ask rather than printing an empty section", () => {
    expect(renderAsk(consolidateAsk([]))).toEqual(["No open questions require further access."]);
  });

  it("renders one priced list, not scattered caveats", () => {
    const rendered = renderAsk(
      consolidateAsk([open("a", "Client exports config", 1, "config dump")]),
    ).join("\n");

    expect(rendered).toMatch(/1 finding\(s\) could not be settled/);
    expect(rendered).toMatch(/estimated 1 hour\(s\)/);
    expect(rendered).toMatch(/Client exports config — 1 hour\(s\)/);
    expect(rendered).toMatch(/· config dump/);
  });
});


describe("code that was never in scope", () => {
  // The exact string that killed a run against agent-knowledge after 50 minutes
  // and US$19.78: the verifier wanted to read a cost parameter off code it had
  // not been given, nothing in the catalogue matched, and the report never
  // rendered. Kept verbatim rather than paraphrased — a paraphrase would drift
  // toward whatever the implementation happens to match.
  const REAL =
    "The API key creation endpoint or server action that calls bcrypt.hash() to " +
    "generate the hashedSecret field. This would show the actual cost parameter used.";

  it("closes the finding that had no closure path", () => {
    const closure = deriveClosure(REAL);
    expect(closure).not.toBeNull();
    expect(closure?.effortHours).toBe(1);
    // The verifier's own words survive into the ask, so the client is told what
    // is actually wanted rather than a catalogue category.
    expect(closure?.access).toContain("bcrypt.hash()");
  });

  it("asks for the code, not for a console export", () => {
    const closure = deriveClosure(REAL);
    expect(closure?.blocker).toMatch(/repository or path/i);
    expect(closure?.method).toMatch(/nothing is executed/i);
  });

  it.each([
    "the implementation of the token refresh helper",
    "the server action that writes the row",
  ])("covers the other ways a verifier asks for source: %s", (access) => {
    expect(deriveClosure(access)).not.toBeNull();
  });

  // Appended last so they can only catch what already fell through. If one of
  // these were hoisted above `configuration` or `log`, a deployed-state question
  // would start being answered with "send us the code", which is the wrong ask
  // and a wrong estimate.
  it("does not shadow the deployed-state entries", () => {
    expect(deriveClosure("the deployed endpoint's configuration")?.effortHours).toBe(1);
    expect(deriveClosure("the deployed endpoint's configuration")?.blocker).toMatch(/hosting console/i);
    expect(deriveClosure("logs from the endpoint")?.blocker).toMatch(/log sample/i);
  });

describe("call sites and third-party behaviour", () => {
  // Both strings come from a run that died at the closure gate with the model
  // spend already committed. The symbol names are substituted, because this
  // repository is public and the originals came from a client tree; the
  // sentence SHAPE is what the matcher keys on and that is preserved exactly.
  const CALLERS =
    "Code that calls INotificationService.SendAsync() - such as API controllers, " +
    "command handlers, or application services - to verify whether they check the " +
    "boolean return value and provide user notifications when it returns false";
  const VENDOR =
    "The SDK's documentation or source code to confirm whether Client.CaptureEvent() " +
    "can throw exceptions under failure conditions";

  it("closes the call-site question the implementation entry could not", () => {
    const closure = deriveClosure(CALLERS);
    expect(closure).not.toBeNull();
    expect(closure?.blocker).toMatch(/callers/i);
    // The verifier already had the implementation; what it lacked was who calls it.
    expect(closure?.access).toContain("INotificationService.SendAsync()");
  });

  it("treats third-party behaviour as our lookup, not a client ask", () => {
    const closure = deriveClosure(VENDOR);
    expect(closure).not.toBeNull();
    expect(closure?.blocker).toMatch(/reviewer/i);
    expect(closure?.blocker).not.toMatch(/^Client/);
    expect(closure?.effortHours).toBe(0.5);
  });

  it.each(["the callers of the retry helper", "code that calls the token refresher"])(
    "covers both ways a verifier asks for the call graph: %s",
    (access) => {
      expect(deriveClosure(access)?.blocker).toMatch(/callers/i);
    },
  );

  // Same hazard as the block above: appended last so a deployed-state question
  // that happens to mention calls or documentation is still answered with the
  // right ask and the right estimate.
  it("does not shadow the deployed-state entries", () => {
    expect(deriveClosure("the deployed configuration for the service that calls Stripe")?.blocker)
      .toMatch(/hosting console/i);
    expect(deriveClosure("logs showing which caller hit the endpoint")?.blocker)
      .toMatch(/log sample/i);
  });

  // The match is a plain substring test, so a word that CONTAINS an earlier
  // token wins on that token. "the audit logger" carries "log" and is answered
  // with a log sample rather than with its call sites. Pinned here because it
  // is the documented consequence of first-match-wins, and because the fix if
  // it ever bites is to make the entry more specific, never to reorder the
  // deployed-state block.
  it("gives an earlier token priority even inside a longer word", () => {
    expect(deriveClosure("code that calls the audit logger")?.blocker).toMatch(/log sample/i);
  });
});

  // The gate has to keep its teeth. Some access genuinely has no catalogue
  // answer, and inventing an estimate for it is worse than refusing to render —
  // these hours get quoted and signed off.
  it("still refuses what it cannot price", () => {
    expect(deriveClosure("a conversation with the original architect")).toBeNull();
    expect(deriveClosure("the client's threat model")).toBeNull();
  });
});

/**
 * settleClosure — refusing to certify an audit must not destroy its evidence.
 *
 * From a real run. An agent-knowledge audit finished investigate 9/9 and
 * verified 83 of 84 claims over 67 minutes, then persisted NOTHING: the 84th
 * finding was not-determinable with no closure path, `assertAllClosuresResolved`
 * threw, and the loop that publishes findings sat after the throw.
 *
 * The gate is correct and stays — a bare "not determinable" hands the risk back
 * to the client. What must not follow from it is losing the 83 that were fine.
 */
describe("settleClosure", () => {
  const finding = (id: string): AuditFinding =>
    ({ id, message: `finding ${id}` }) as unknown as AuditFinding;

  it("publishes every finding before the gate can throw", () => {
    const published: string[] = [];
    const result: ClosureResult = {
      findings: [finding("a"), finding("b"), finding("c")],
      unresolved: [{ id: "c", needsAccess: "a running instance" }],
    };

    expect(() => settleClosure(result, (f) => void published.push(f.id))).toThrow(
      /no closure path/,
    );
    // The refusal stands AND the evidence survives it.
    expect(published).toEqual(["a", "b", "c"]);
  });

  it("still throws, so an unresolved closure never passes silently", () => {
    const result: ClosureResult = {
      findings: [finding("a")],
      unresolved: [{ id: "a", needsAccess: "production logs" }],
    };
    expect(() => settleClosure(result, () => {})).toThrow(/hands the risk back to the client/);
  });

  it("publishes and returns when everything is resolved", () => {
    const published: string[] = [];
    const result: ClosureResult = { findings: [finding("a"), finding("b")], unresolved: [] };
    expect(() => settleClosure(result, (f) => void published.push(f.id))).not.toThrow();
    expect(published).toEqual(["a", "b"]);
  });

  it("a run with no findings is not an error", () => {
    expect(() => settleClosure({ findings: [], unresolved: [] }, () => {})).not.toThrow();
  });
});
