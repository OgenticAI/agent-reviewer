import { describe, it, expect } from "vitest";

import {
  toSweepFindings,
  mergeSweepFindings,
  sweepArtifactFrom,
  skippedByReason,
  sweepSeverity,
  SWEEP_SOURCE,
} from "../../src/engine/audit/sweep-findings.js";
import { signalsIn, sweepTree, type Signal, type SignalKind } from "../../src/engine/audit/sweep.js";
import { validateFindings, type AuditFinding } from "../../src/engine/audit/finding.js";
import { FileAccessLog } from "../../src/engine/audit/inventory.js";
import { SEVERITY_ORDER } from "../../src/engine/audit/render.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REV = "a3f91c2";

/** A defect-class signal, shaped like the sweep emits it. */
function defect(over: Partial<Signal> = {}): Signal {
  return {
    path: "src/Auth.cs",
    line: 12,
    kind: "unvalidated-token",
    signalClass: "defect",
    excerpt: "var token = handler.ReadJwtToken(raw);",
    cwe: "CWE-347",
    owasp: "API2:2023 Broken Authentication",
    ...over,
  };
}

function surface(over: Partial<Signal> = {}): Signal {
  return defect({ kind: "http-endpoint", signalClass: "surface", excerpt: "[HttpGet]", cwe: "CWE-1059", ...over });
}

/** Every defect-class kind the sweep can emit, taken from the sweep's own rules. */
const DEFECT_KINDS: SignalKind[] = [
  ...new Set(
    [
      signalsIn("A.cs", "var t = handler.ReadJwtToken(x);"),
      signalsIn("A.cs", "[AllowAnonymous]"),
      signalsIn("A.cs", 'var org = Request.Headers["X-Tenant-Id"];'),
      signalsIn("A.cs", 'var q = "SELECT * FROM t WHERE id = " + id;'),
      signalsIn("A.cs", "var h = MD5.Create();"),
      signalsIn("A.cs", "ServerCertificateValidationCallback += (a, b, c, d) => true;"),
      signalsIn("A.cs", "builder.AllowAnyOrigin()"),
      signalsIn("A.cs", 'config.AddJsonFile("appsettings.Test.json")'),
      signalsIn("web.config", '<compilation debug="true" />'),
      signalsIn("A.cs", "options.Cookie.HttpOnly = false;"),
      signalsIn("A.cs", "var hash = SHA256.Create().ComputeHash(passwordBytes);"),
    ]
      .flat()
      .filter((s) => s.signalClass === "defect")
      .map((s) => s.kind),
  ),
];

describe("what a sweep finding may claim", () => {
  // The rule the module exists to enforce. A pattern nothing with judgment has
  // read has not been refuted by anything, so it cannot be verified by anything.
  it("is never verified, whatever the kind", () => {
    const findings = toSweepFindings(
      DEFECT_KINDS.map((kind) => defect({ kind })),
      REV,
    );
    expect(findings.length).toBe(DEFECT_KINDS.length);
    expect(findings.every((f) => f.confidence === "inferred")).toBe(true);
    expect(findings.some((f) => f.confidence === "verified")).toBe(false);
  });

  it("records that no verifier examined it, so the label can be checked", () => {
    const [finding] = toSweepFindings([defect()], REV);
    expect(finding).toMatchObject({ verifiers: 0, refutations: 0, source: SWEEP_SOURCE });
  });

  it("drops surface signals rather than promoting them", () => {
    const findings = toSweepFindings([surface(), defect(), surface({ line: 40 })], REV);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("src/Auth.cs");
  });

  // path + line + quote is the evidence contract every finding must meet, and
  // the excerpt is the only thing the sweep actually saw.
  it("cites the matched line, with the excerpt as the quote and the run's rev", () => {
    const [finding] = toSweepFindings([defect({ line: 77 })], REV);
    expect(finding?.evidence).toEqual([
      { path: "src/Auth.cs", line: 77, quote: "var token = handler.ReadJwtToken(raw);", rev: REV },
    ]);
    expect(finding?.position).toEqual({ line: 77 });
  });

  it("carries a null rev when the subject had no history, rather than inventing one", () => {
    const [finding] = toSweepFindings([defect()], null);
    expect(finding?.evidence[0]?.rev).toBeNull();
  });

  it("says what the pattern means and cites the standard", () => {
    const [withOwasp] = toSweepFindings([defect()], REV);
    expect(withOwasp?.message).toContain("CWE-347");
    expect(withOwasp?.message).toContain("API2:2023");
    expect(withOwasp?.message).toMatch(/not read by a reviewer/);

    const [cweOnly] = toSweepFindings([defect({ kind: "weak-crypto", cwe: "CWE-327", owasp: undefined })], REV);
    expect(cweOnly?.message).toContain("CWE-327");
    expect(cweOnly?.message).not.toMatch(/API\d:/);
  });

  // The message reaches the rendered report, and a meaning that merely repeats
  // the kind's name tells the reader nothing the table did not.
  it("gives every defect kind a meaning that is more than its name", () => {
    for (const finding of toSweepFindings(DEFECT_KINDS.map((kind) => defect({ kind })), REV)) {
      const kind = finding.id.replace(/^sweep-/, "").replace(/-[0-9a-f]{8}$/, "");
      const meaning = finding.message.split(" Matched by the sweep")[0] ?? "";
      expect(meaning.length).toBeGreaterThan(kind.length + 20);
    }
  });

  it("emits no em dash in anything that reaches the report", () => {
    for (const finding of toSweepFindings(DEFECT_KINDS.map((kind) => defect({ kind })), REV)) {
      expect(finding.message).not.toContain("\u2014");
    }
  });

  it("passes the report invariants a model finding has to pass", () => {
    const findings = toSweepFindings(
      [defect(), defect({ line: 13 }), defect({ kind: "raw-sql", path: "src/Db.cs", cwe: "CWE-89" })],
      REV,
    );
    expect(validateFindings(findings, REV)).toEqual([]);
  });

  // The dashboard's own release gate looks at three things: verified with no
  // evidence, verified by fewer than two, and not-determinable with no closure.
  // A sweep finding must be able to trip none of them.
  it("cannot trip the dashboard's soundness rules", () => {
    for (const finding of toSweepFindings(DEFECT_KINDS.map((kind) => defect({ kind })), REV)) {
      expect(finding.confidence).not.toBe("verified");
      expect(finding.confidence).not.toBe("not-determinable");
      expect(finding.closure).toBeUndefined();
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("how severe a sweep finding is", () => {
  const rank = (kind: SignalKind) => SEVERITY_ORDER.indexOf(sweepSeverity(kind));

  // Relationships, not a copy of the table. An unchecked token undermines every
  // authorisation decision after it; an anonymous endpoint may be intended; a
  // weak digest reference may protect nothing.
  it("ranks an unchecked token above an anonymous endpoint above a weak digest", () => {
    expect(rank("unvalidated-token")).toBeLessThan(rank("anonymous-endpoint"));
    expect(rank("anonymous-endpoint")).toBeLessThan(rank("weak-crypto"));
  });

  it("puts the injection and password-storage kinds beside the token", () => {
    expect(rank("raw-sql")).toBe(rank("unvalidated-token"));
    expect(rank("weak-password-hash")).toBe(rank("unvalidated-token"));
  });

  it("puts every misconfiguration at one rung below", () => {
    for (const kind of [
      "permissive-cors",
      "debug-enabled",
      "disabled-cert-validation",
      "config-precedence",
      "identity-from-request",
    ] as const) {
      expect(rank(kind)).toBe(rank("anonymous-endpoint"));
    }
  });

  it("never lands on unknown, which is reserved for a tool that withheld a rank", () => {
    for (const kind of DEFECT_KINDS) expect(sweepSeverity(kind)).not.toBe("unknown");
  });

  // Confidence and severity are orthogonal; the rank must not leak into the label.
  it("keeps an error-ranked finding at inferred", () => {
    const [finding] = toSweepFindings([defect({ kind: "raw-sql" })], REV);
    expect(finding?.severity).toBe("error");
    expect(finding?.confidence).toBe("inferred");
  });
});

describe("sweep finding ids", () => {
  it("is the same across two calls over the same signals", () => {
    const a = toSweepFindings([defect(), defect({ line: 30, kind: "raw-sql" })], REV).map((f) => f.id);
    const b = toSweepFindings([defect(), defect({ line: 30, kind: "raw-sql" })], REV).map((f) => f.id);
    expect(a).toEqual(b);
  });

  // A finding that moved down a file is the same finding.
  it("does not change when the matched line moves", () => {
    const [before] = toSweepFindings([defect({ line: 12 })], REV);
    const [after] = toSweepFindings([defect({ line: 91 })], REV);
    expect(before?.id).toBe(after?.id);
  });

  // Two [AllowAnonymous] in one controller share kind, message and path. Without
  // this they would share an id and the report would be refused as a duplicate.
  it("gives identical excerpts in one file distinct ids", () => {
    const findings = toSweepFindings(
      [defect({ line: 10 }), defect({ line: 20 }), defect({ line: 30 })],
      REV,
    );
    expect(new Set(findings.map((f) => f.id)).size).toBe(3);
    expect(validateFindings(findings, REV)).toEqual([]);
  });

  it("differs by kind, path and excerpt", () => {
    const [base] = toSweepFindings([defect()], REV);
    const [otherKind] = toSweepFindings([defect({ kind: "raw-sql" })], REV);
    const [otherPath] = toSweepFindings([defect({ path: "src/Other.cs" })], REV);
    const [otherText] = toSweepFindings([defect({ excerpt: "something else" })], REV);
    for (const other of [otherKind, otherPath, otherText]) expect(other?.id).not.toBe(base?.id);
  });

  it("names the kind so the id is readable on sight", () => {
    const [finding] = toSweepFindings([defect()], REV);
    expect(finding?.id).toMatch(/^sweep-unvalidated-token-[0-9a-f]{8}$/);
  });
});

describe("merging sweep candidates behind model findings", () => {
  function model(over: Partial<AuditFinding> = {}): AuditFinding {
    return {
      id: "authn-completeness-deadbeef",
      path: "src/Auth.cs",
      message: "The token is decoded but never validated.",
      severity: "error",
      source: "audit",
      confidence: "verified",
      evidence: [{ path: "src/Auth.cs", rev: REV, line: 12 }],
      verifiers: 2,
      refutations: 0,
      ...over,
    };
  }

  it("lets a model finding on the same line win", () => {
    const sweep = toSweepFindings([defect({ line: 12 })], REV);
    const merged = mergeSweepFindings([model()], sweep);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]?.source).toBe("audit");
    expect(merged).toMatchObject({ added: 0, displaced: 1 });
  });

  it("adds a sweep finding the model did not reach", () => {
    const sweep = toSweepFindings([defect({ line: 12 }), defect({ line: 40, kind: "raw-sql" })], REV);
    const merged = mergeSweepFindings([model()], sweep);
    expect(merged.findings).toHaveLength(2);
    expect(merged.findings.map((f) => f.source)).toEqual(["audit", SWEEP_SOURCE]);
    expect(merged).toMatchObject({ added: 1, displaced: 1 });
  });

  // A claim spanning two files is anchored at both; the second anchor counts.
  it("matches on every line the model finding cites, not only the first", () => {
    const spanning = model({
      evidence: [
        { path: "src/Auth.cs", rev: REV, line: 3 },
        { path: "src/Db.cs", rev: REV, line: 40 },
      ],
    });
    const sweep = toSweepFindings([defect({ path: "src/Db.cs", line: 40, kind: "raw-sql" })], REV);
    expect(mergeSweepFindings([spanning], sweep).displaced).toBe(1);
  });

  it("does not treat the same line in a different file as the same line", () => {
    const sweep = toSweepFindings([defect({ path: "src/Other.cs", line: 12 })], REV);
    expect(mergeSweepFindings([model()], sweep).added).toBe(1);
  });

  it("keeps model findings first and in their own order", () => {
    const first = model({ id: "a" });
    const second = model({ id: "b", evidence: [{ path: "x.cs", rev: REV, line: 1 }] });
    const merged = mergeSweepFindings([first, second], toSweepFindings([defect({ line: 99 })], REV));
    expect(merged.findings.slice(0, 2).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("leaves the model's findings untouched when there is nothing to merge", () => {
    const only = [model()];
    expect(mergeSweepFindings(only, []).findings).toEqual(only);
  });
});

describe("the sweep artifact", () => {
  let scratch: string;
  const write = (rel: string, text: string | Buffer) => {
    const full = join(scratch, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  };

  it("carries a summary beside the raw signals, so the renderer needs no sweep code", () => {
    scratch = mkdtempSync(join(tmpdir(), "sweep-artifact-"));
    try {
      write("src/A.cs", "[HttpGet]\n[AllowAnonymous]\n");
      const artifact = sweepArtifactFrom(sweepTree(scratch, new FileAccessLog()), REV);
      expect(artifact.summary.map((r) => r.kind).sort()).toEqual(["anonymous-endpoint", "http-endpoint"]);
      expect(artifact.total).toBe(artifact.dispositions.length);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // The rev on a sweep finding is the one the excerpt was read at, and it has
  // to travel on the artifact: investigate used to stamp the subject's current
  // rev onto whatever sweep.json sat in --out, so an old sweep in a reused
  // directory was cited against a tree it never read.
  it("records the revision the tree was read at, or that none was known", () => {
    scratch = mkdtempSync(join(tmpdir(), "sweep-artifact-"));
    try {
      write("src/A.cs", "[AllowAnonymous]\n");
      const result = sweepTree(scratch, new FileAccessLog());
      expect(sweepArtifactFrom(result, REV).rev).toBe(REV);
      expect(sweepArtifactFrom(result, null).rev).toBeNull();
      // And the findings built from the artifact cite that rev, not another.
      const cited = toSweepFindings(sweepArtifactFrom(result, REV).signals, REV).flatMap((f) => f.evidence.map((e) => e.rev));
      expect(new Set(cited)).toEqual(new Set([REV]));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // A single "skipped" number hides the difference between a vendored bundle
  // and a permission error, and only one of those is the client's problem.
  it("counts why files were not parsed, omitting reasons that did not occur", () => {
    scratch = mkdtempSync(join(tmpdir(), "sweep-artifact-"));
    try {
      write("a.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
      write("b.png", Buffer.from([0x89, 0x50, 0x00, 0x02]));
      write("c.cs", "class C {}");
      const result = sweepTree(scratch, new FileAccessLog());
      const reasons = skippedByReason(result.dispositions);
      expect(reasons).toEqual([{ reason: "binary", count: 2 }]);
      expect(reasons.reduce((n, r) => n + r.count, 0)).toBe(result.skipped);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
