import { describe, it, expect } from "vitest";
import {
  checkEvidencePresent,
  checkClosurePresent,
  checkVerifiedIsEarned,
  checkEvidenceRev,
  checkMaskIsNoop,
  validateFinding,
  validateFindings,
  countByConfidence,
  closureAsk,
  MIN_VERIFIERS,
  type AuditFinding,
} from "../../src/engine/audit/finding.js";

const REV = "a3f91c2";

/** A settled, well-formed finding. Every case below is this minus one thing. */
function verified(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "f-1",
    path: "src/media/upload.ts",
    message: "Uploaded media is written a second time to a public-read container.",
    severity: "error",
    source: "audit",
    confidence: "verified",
    evidence: [{ path: "src/media/upload.ts", rev: REV, line: 88 }],
    verifiers: 2,
    refutations: 0,
    ...over,
  };
}

/** The other shape that matters: open, priced, and pointing at nothing in the code. */
function notDeterminable(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "f-2",
    path: "src/config/loader.ts",
    message: "Production behaviour cannot be established from the repository.",
    severity: "error",
    source: "audit",
    confidence: "not-determinable",
    evidence: [],
    closure: {
      access: "App Service configuration dump",
      method: "compare pinned settings against the test configuration file",
      effortHours: 1,
      blocker: "client exports the settings blade",
    },
    verifiers: 2,
    refutations: 0,
    ...over,
  };
}

describe("1 — a claim must point at something", () => {
  it("passes when evidence is present", () => {
    expect(checkEvidencePresent(verified())).toBeNull();
  });

  it("fails a verified finding with no evidence", () => {
    expect(checkEvidencePresent(verified({ evidence: [] }))?.code).toBe("evidence-missing");
  });

  it("fails an inferred finding with no evidence too", () => {
    const f = verified({ confidence: "inferred", evidence: [] });
    expect(checkEvidencePresent(f)?.code).toBe("evidence-missing");
  });

  // The exception is exact: this is the one class where the code does NOT hold
  // the answer, so requiring a citation would force a fabricated one.
  it("exempts not-determinable, which is the whole point of the label", () => {
    expect(checkEvidencePresent(notDeterminable())).toBeNull();
  });
});

describe("2 — every not-determinable carries a usable closure path", () => {
  it("passes a complete closure path", () => {
    expect(checkClosurePresent(notDeterminable())).toBeNull();
  });

  it("fails when the closure path is absent", () => {
    const f = notDeterminable();
    delete f.closure;
    expect(checkClosurePresent(f)?.code).toBe("closure-missing");
  });

  it.each([
    ["access", { access: "   " }],
    ["method", { method: "" }],
    ["blocker", { blocker: " " }],
  ])("fails when %s is blank", (_name, patch) => {
    const base = notDeterminable();
    const f = notDeterminable({ closure: { ...base.closure!, ...patch } });
    expect(checkClosurePresent(f)?.code).toBe("closure-incomplete");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails when effortHours is %s — an unpriced ask is not a plan",
    (hours) => {
      const base = notDeterminable();
      const f = notDeterminable({ closure: { ...base.closure!, effortHours: hours } });
      expect(checkClosurePresent(f)?.code).toBe("closure-incomplete");
    },
  );

  // The reverse direction: a next step printed under a settled finding means
  // the confidence and the prose disagree about whether the question is open.
  it("fails a settled finding that carries a closure path", () => {
    const base = notDeterminable();
    const f = verified({ closure: base.closure });
    expect(checkClosurePresent(f)?.code).toBe("closure-not-applicable");
  });
});

describe("3 — verified has to be earned", () => {
  it("passes at the minimum with no refutations", () => {
    expect(checkVerifiedIsEarned(verified({ verifiers: MIN_VERIFIERS, refutations: 0 }))).toBeNull();
  });

  it("fails with a single verifier — one opinion is not independence", () => {
    expect(checkVerifiedIsEarned(verified({ verifiers: 1 }))?.code).toBe("unearned-verified");
  });

  it("fails with any refutation, however many verifiers agreed", () => {
    const f = verified({ verifiers: 9, refutations: 1 });
    expect(checkVerifiedIsEarned(f)?.code).toBe("unearned-verified");
  });

  it("does not police inferred or not-determinable, which make no such claim", () => {
    expect(checkVerifiedIsEarned(verified({ confidence: "inferred", verifiers: 0 }))).toBeNull();
    expect(checkVerifiedIsEarned(notDeterminable({ verifiers: 0 }))).toBeNull();
  });

  // A citation the check had to relocate was written from memory. The verify
  // stage caps such a claim at inferred as it goes; this is the same rule where
  // the report is admitted, so a finding that slipped past the first cannot
  // pass the second.
  it("fails a verified finding whose citation was moved, however many verifiers agreed", () => {
    const moved = verified({
      verifiers: 9,
      refutations: 0,
      evidence: [{ path: "src/media/upload.ts", rev: REV, line: 128, quote: "rawToken", corrected: { citedLine: 88, beyondEof: false } }],
    });
    expect(checkVerifiedIsEarned(moved)?.code).toBe("unearned-verified");
    expect(checkVerifiedIsEarned(moved)?.detail).toMatch(/moved/);
  });

  it("allows a moved citation on an inferred finding, which is what the cap produces", () => {
    const moved = verified({
      confidence: "inferred",
      evidence: [{ path: "src/media/upload.ts", rev: REV, line: 128, quote: "rawToken", corrected: { citedLine: 88, beyondEof: true } }],
    });
    expect(checkVerifiedIsEarned(moved)).toBeNull();
    expect(validateFinding(moved, REV)).toEqual([]);
  });

  // A citation the check could not find at all was invented, which is worse
  // than one it had to relocate; a finding that kept `verified` with one of
  // those on its record slipped past a rule the moved case already enforces.
  it("fails a verified finding that dropped a citation, whatever held beside it", () => {
    const dropped = verified({
      verifiers: 9,
      refutations: 0,
      dropped: [{ path: "src/media/upload.ts", line: 12, reason: "quote-absent" }],
    });
    expect(checkVerifiedIsEarned(dropped)?.code).toBe("unearned-verified");
    expect(checkVerifiedIsEarned(dropped)?.detail).toMatch(/could not find/);
  });

  it("allows a dropped citation on an inferred finding, which is what the cap produces", () => {
    const dropped = verified({
      confidence: "inferred",
      dropped: [{ path: "src/media/upload.ts", line: 12, reason: "quote-ambiguous", occurrences: 3 }],
    });
    expect(checkVerifiedIsEarned(dropped)).toBeNull();
    expect(validateFinding(dropped, REV)).toEqual([]);
  });

  it("does not count an empty record as a dropped citation", () => {
    expect(checkVerifiedIsEarned(verified({ dropped: [] }))).toBeNull();
  });
});

describe("4 — citations are against the revision actually audited", () => {
  it("passes when every ref matches", () => {
    expect(checkEvidenceRev(verified(), REV)).toBeNull();
  });

  it("fails a ref from another revision", () => {
    const f = verified({ evidence: [{ path: "a.ts", rev: "deadbee", line: 1 }] });
    expect(checkEvidenceRev(f, REV)?.code).toBe("evidence-rev-mismatch");
  });

  // An archive with no history. The check cannot run; it must not pretend it did
  // by passing silently on refs it never compared.
  it("is skipped when the subject has no revision", () => {
    const f = verified({ evidence: [{ path: "a.ts", rev: null }] });
    expect(checkEvidenceRev(f, null)).toBeNull();
  });

  it("still fails a null-rev ref when the subject DOES have a revision", () => {
    const f = verified({ evidence: [{ path: "a.ts", rev: null }] });
    expect(checkEvidenceRev(f, REV)?.code).toBe("evidence-rev-mismatch");
  });
});

describe("5 — masking must be a no-op by render time", () => {
  const identity = (s: string) => s;

  it("is clean when masking changes nothing", () => {
    expect(checkMaskIsNoop("no secrets here", identity).clean).toBe(true);
  });

  // If masking fires, the defence worked AND something upstream failed. The
  // masked copy is safe to read and unsafe to ship, because the next value
  // might not be one we know to mask.
  it("is not clean when masking alters the text", () => {
    const mask = (s: string) => s.replace("sk-live-abc", "[REDACTED]");
    const result = checkMaskIsNoop("token is sk-live-abc", mask);
    expect(result.clean).toBe(false);
    expect(result.detail).toMatch(/do not ship the masked copy/);
  });
});

describe("the whole report", () => {
  it("reports every violation at once rather than the first", () => {
    const f: AuditFinding = {
      ...verified(),
      confidence: "verified",
      evidence: [{ path: "a.ts", rev: "wrong", line: 1 }],
      verifiers: 1,
      refutations: 3,
    };
    const codes = validateFinding(f, REV).map((v) => v.code).sort();
    expect(codes).toEqual(["evidence-rev-mismatch", "unearned-verified"]);
  });

  it("passes a well-formed mixed set", () => {
    expect(validateFindings([verified(), notDeterminable()], REV)).toEqual([]);
  });

  // Two findings sharing an id silently become one in a version diff, which
  // would read as "fixed" when nothing was fixed.
  it("rejects duplicate ids", () => {
    const dup = validateFindings([verified(), verified()], REV);
    expect(dup.some((v) => v.detail.includes("duplicate finding id"))).toBe(true);
  });

  it("counts by confidence", () => {
    const counts = countByConfidence([verified(), notDeterminable(), verified({ id: "f-3", confidence: "inferred" })]);
    expect(counts).toEqual({ verified: 1, inferred: 1, "not-determinable": 1 });
  });
});

describe("the consolidated ask", () => {
  it("totals the hours across open findings", () => {
    const a = notDeterminable();
    const b = notDeterminable({
      id: "f-9",
      closure: { ...a.closure!, effortHours: 2.5, access: "read replica" },
    });
    const ask = closureAsk([verified(), a, b]);

    expect(ask.totalHours).toBe(3.5);
    expect(ask.items).toHaveLength(2);
    expect(ask.items.map((i) => i.access)).toContain("read replica");
  });

  it("is empty when nothing is open — no ask, rather than an empty section", () => {
    expect(closureAsk([verified()])).toEqual({ totalHours: 0, items: [] });
  });
});
