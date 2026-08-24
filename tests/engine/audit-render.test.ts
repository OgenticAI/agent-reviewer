import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escapeTypst,
  renderTypst,
  renderReport,
  orderFindings,
  checkMask,
  checkCoverageIsReal,
  subjectLabel,
  RenderRefused,
  type ReportInput,
} from "../../src/engine/audit/render.js";
import { severityFor, SECURITY_QUESTIONS } from "../../src/engine/audit/severity.js";
import type { AuditFinding } from "../../src/engine/audit/finding.js";
import type { VerifiedClaim } from "../../src/engine/audit/verify.js";
import type { Coverage } from "../../src/engine/audit/inventory.js";
import type { Subject } from "../../src/engine/audit/acquire.js";

const REV = "a3f91c2";
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "render-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function subject(over: Partial<Subject> = {}): Subject {
  return {
    kind: "clone",
    origin: "bitbucket.org/acme/acme-web-app",
    name: "acme-web-app",
    rev: REV,
    revProvenance: "clone — full history available",
    acquiredAt: "2026-08-24T12:00:00.000Z",
    files: 1000,
    loc: 120000,
    langs: { typescript: 0.8 },
    ...over,
  };
}

function coverage(over: Partial<Coverage> = {}): Coverage {
  return {
    opened: 700,
    total: 1000,
    share: 0.7,
    byLanguage: {},
    byArea: { src: { opened: 700, total: 900, share: 0.78 } },
    unreadable: [],
    caveat: "This is file coverage: the share of files the run opened. It is not defect coverage.",
    ...over,
  };
}

function finding(over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: "config-precedence-abc12345",
    path: "src/startup.ts",
    message: "The test configuration loads after the environment file.",
    severity: "error",
    source: "audit",
    confidence: "verified",
    evidence: [{ path: "src/startup.ts", rev: REV, line: 42 }],
    verifiers: 2,
    refutations: 0,
    ...over,
  };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    subject: subject(),
    findings: [finding()],
    coverage: coverage(),
    analyzerJobs: [{ job: "semgrep", parsed: true, findings: [] }],
    analyzerReach: { typescript: { files: 900, analyzers: ["semgrep"] } },
    questionCount: 10,
    ...over,
  };
}

const SUMMARY = "This review read source only, and answered ten agreed questions.";
const noMask = (text: string) => text;

/* ── Escaping ─────────────────────────────────────────────────────────────── */

describe("escaping text that came out of a client codebase", () => {
  // Typst reads these as syntax. A finding quoting an attribute or a shell
  // snippet would break the compile or silently reformat the page.
  it.each(["#", "$", "*", "_", "@", "\\", "<", ">", "`", '"'])("escapes %s", (char) => {
    expect(escapeTypst(`a${char}b`)).toBe(`a\\${char}b`);
  });

  it("escapes a realistic hostile finding", () => {
    const escaped = escapeTypst('#[allow(dead_code)] let x = $HOME * 2;');
    expect(escaped).not.toMatch(/(^|[^\\])#/);
    expect(escaped).not.toMatch(/(^|[^\\])\$/);
  });

  it("flattens newlines, which would end a markup block early", () => {
    expect(escapeTypst("line one\nline two")).toBe("line one line two");
  });

  it("leaves ordinary prose alone", () => {
    expect(escapeTypst("The configuration loads in the wrong order.")).toBe(
      "The configuration loads in the wrong order.",
    );
  });

  it("escapes every finding message that reaches the document", () => {
    const source = renderTypst({
      input: input({ findings: [finding({ message: "uses $SECRET and #[inline]" })] }),
      executiveSummary: SUMMARY,
    });
    expect(source).toContain("\\$SECRET");
    expect(source).toContain("\\#[inline]");
  });
});

/* ── Ordering ─────────────────────────────────────────────────────────────── */

describe("reading order", () => {
  it("puts the worst first, and within a severity what we can stand behind first", () => {
    const ordered = orderFindings([
      finding({ id: "c", severity: "info", confidence: "verified" }),
      finding({ id: "b", severity: "error", confidence: "not-determinable" }),
      finding({ id: "a", severity: "error", confidence: "verified" }),
    ]);
    expect(ordered.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });

  // Two runs must put the same finding in the same place, or the version diff
  // in OGE-2437 sees movement that is not a change.
  it("is stable for findings that tie on severity and confidence", () => {
    const tied = [finding({ id: "zebra" }), finding({ id: "alpha" })];
    expect(orderFindings(tied).map((f) => f.id)).toEqual(["alpha", "zebra"]);
    expect(orderFindings([...tied].reverse()).map((f) => f.id)).toEqual(["alpha", "zebra"]);
  });
});

/* ── Generated sections ───────────────────────────────────────────────────── */

describe("Coverage, generated from the run", () => {
  it("states the ratio and carries the caveat with it", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toMatch(/read 700 of 1000 files/);
    expect(source).toMatch(/70%/);
    expect(source).toMatch(/not defect coverage/);
  });

  it("names files it could not read rather than counting them as covered", () => {
    const source = renderTypst({
      input: input({ coverage: coverage({ unreadable: ["src/huge.ts"] }) }),
      executiveSummary: SUMMARY,
    });
    expect(source).toMatch(/could not read/);
    expect(source).toContain("src/huge.ts");
  });

  // The provenance gap is stated, never omitted.
  it("says so when the subject carried no history", () => {
    const source = renderTypst({
      input: input({
        subject: subject({ rev: null, revProvenance: "none — archive carries no history" }),
      }),
      executiveSummary: SUMMARY,
    });
    expect(source).toMatch(/carried no version history/);
    expect(source).toMatch(/no history-derived/);
  });
});

describe("Automated Testing, generated from the run", () => {
  it("prints a skipped analyzer with its reason", () => {
    const source = renderTypst({
      input: input({
        analyzerJobs: [{ job: "semgrep", parsed: false, findings: [], reason: "not installed" }],
      }),
      executiveSummary: SUMMARY,
    });
    expect(source).toMatch(/did not run/);
    expect(source).toContain("not installed");
  });

  // The honest headline: a language nothing deterministic reached.
  it("names a language no analyzer reached, rather than implying parity", () => {
    const source = renderTypst({
      input: input({ analyzerReach: { csharp: { files: 400, analyzers: [] } } }),
      executiveSummary: SUMMARY,
    });
    expect(source).toMatch(/no automated analysis reached/i);
    expect(source).toMatch(/csharp — 400 file/);
    expect(source).toMatch(/weaker signal/);
  });

  it("says so plainly when everything ran", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toMatch(/Every configured analyzer ran/);
  });
});

describe("findings and the closing ask", () => {
  it("prints the confidence counts and separates them from severity", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toMatch(/Confidence is separate from severity/);
  });

  it("shows how many reviewers failed to refute a verified finding", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toMatch(/2 independent reviewers attempted to refute/);
  });

  it("prints a closure path under an open finding", () => {
    const open = finding({
      confidence: "not-determinable",
      evidence: [],
      closure: {
        access: "A configuration dump",
        method: "Compare deployed values key by key",
        effortHours: 1,
        blocker: "Client exports the configuration",
      },
    });
    const source = renderTypst({ input: input({ findings: [open] }), executiveSummary: SUMMARY });

    expect(source).toMatch(/What would settle this/);
    expect(source).toMatch(/1 hour\(s\)/);
    expect(source).toMatch(/Client exports the configuration/);
  });

  it("always carries the notices, on every render", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toMatch(/read source code only/);
    expect(source).toMatch(/never its value/);
  });
});

/* ── The watermark ────────────────────────────────────────────────────────── */

describe("draft versus released", () => {
  // A PDF that generates with one command is a PDF that gets sent by accident.
  it("watermarks a draft across every page", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toMatch(/DRAFT — NOT FOR DISTRIBUTION/);
    expect(source).toMatch(/Status:\*? ?DRAFT/);
  });

  it("removes the watermark only for an attributed release", () => {
    const source = renderTypst({
      input: input({ release: { by: "david@ogenticai.com", at: "2026-09-04" } }),
      executiveSummary: SUMMARY,
    });
    expect(source).not.toMatch(/DRAFT/);
    expect(source).toMatch(/Released by/);
    // `@` is Typst reference syntax, so an email arrives escaped. It renders as
    // written; the backslash is an escape, not a printed character.
    expect(source).toContain("david\\@ogenticai.com");
  });
});

/* ── The gates ────────────────────────────────────────────────────────────── */

describe("the mask gate", () => {
  it("is clean when masking changes nothing", () => {
    expect(checkMask("no secrets", noMask).clean).toBe(true);
  });

  it("is not clean when masking alters the text", () => {
    const result = checkMask("token abc123", (t) => t.replace("abc123", "[REDACTED]"));
    expect(result.clean).toBe(false);
    expect(result.detail).toMatch(/do not ship the masked copy/);
  });

  // Locking an operator out of their own working copy teaches them to bypass
  // the check. Shipping a masked copy is the thing that must not happen.
  it("warns on a draft but still writes the source", async () => {
    const result = await renderReport({
      input: input({ findings: [finding({ message: "the key is abc123" })] }),
      executiveSummary: SUMMARY,
      outDir: scratch,
      subjectRev: REV,
      mask: (t) => t.replace("abc123", "[REDACTED]"),
    });

    expect(result.warnings[0]).toMatch(/DRAFT ONLY/);
    expect(existsSync(result.typstPath)).toBe(true);
  });

  it("refuses a release outright", async () => {
    await expect(
      renderReport({
        input: input({
          findings: [finding({ message: "the key is abc123" })],
          release: { by: "david@ogenticai.com", at: "2026-09-04" },
        }),
        executiveSummary: SUMMARY,
        outDir: scratch,
        subjectRev: REV,
        mask: (t) => t.replace("abc123", "[REDACTED]"),
      }),
    ).rejects.toThrow(RenderRefused);
  });
});

describe("the invariant gate", () => {
  it("refuses a report whose findings break an invariant, naming it", async () => {
    const bare = finding({ confidence: "not-determinable", evidence: [] });
    await expect(
      renderReport({
        input: input({ findings: [bare] }),
        executiveSummary: SUMMARY,
        outDir: scratch,
        subjectRev: REV,
        mask: noMask,
      }),
    ).rejects.toThrow(/closure-missing/);
  });

  it("refuses before writing anything", async () => {
    const bare = finding({ confidence: "not-determinable", evidence: [] });
    await renderReport({
      input: input({ findings: [bare] }),
      executiveSummary: SUMMARY,
      outDir: scratch,
      subjectRev: REV,
      mask: noMask,
    }).catch(() => {});

    expect(existsSync(join(scratch, "report.typ"))).toBe(false);
  });
});

/* ── Determinism and the binary ───────────────────────────────────────────── */

describe("determinism", () => {
  // A report that shifts between runs cannot be diffed against the next audit.
  it("produces byte-identical source for identical input", () => {
    const options = {
      input: input({
        findings: [finding({ id: "b" }), finding({ id: "a", severity: "info" as const })],
      }),
      executiveSummary: SUMMARY,
    };
    expect(renderTypst(options)).toBe(renderTypst(options));
  });

  it("writes the same file twice over", async () => {
    const options = {
      input: input(),
      executiveSummary: SUMMARY,
      outDir: scratch,
      subjectRev: REV,
      mask: noMask,
    };
    const first = await renderReport(options);
    const firstBytes = readFileSync(first.typstPath, "utf8");
    const second = await renderReport(options);

    expect(readFileSync(second.typstPath, "utf8")).toBe(firstBytes);
  });
});

describe("when typst is not installed", () => {
  // The .typ is the artifact that matters; a missing binary must not lose it.
  it("still writes the source and says why there is no PDF", async () => {
    const result = await renderReport({
      input: input(),
      executiveSummary: SUMMARY,
      outDir: scratch,
      subjectRev: REV,
      mask: noMask,
    });

    expect(existsSync(result.typstPath)).toBe(true);
    if (result.pdfPath === null) {
      expect(result.pdfSkipped).toMatch(/typst is not installed|failed to compile/);
    } else {
      expect(existsSync(result.pdfPath)).toBe(true);
    }
  });
});

/* ── Severity ─────────────────────────────────────────────────────────────── */

describe("how severe is a finding", () => {
  function claimEntry(questionId: string, absence = false): VerifiedClaim {
    return {
      claim: { questionId, statement: "s", evidence: [], absence },
      verdicts: [],
      confidence: "verified",
      verifiers: 2,
      refutations: 0,
      vocabulariesTried: [],
    };
  }

  // The analyzer ranked against a calibrated rule; overriding it here would be
  // re-deriving what the pipeline already treats as established.
  it("defers to an analyzer's own severity", () => {
    expect(severityFor({ entry: claimEntry("test-reality"), analyzerSeverity: "error" })).toBe("error");
  });

  it("passes through `unknown` rather than inventing a ranking the tool withheld", () => {
    expect(severityFor({ entry: claimEntry("test-reality"), analyzerSeverity: "unknown" })).toBe("unknown");
  });

  it("starts a security question at error", () => {
    for (const questionId of SECURITY_QUESTIONS) {
      expect(severityFor({ entry: claimEntry(questionId) })).toBe("error");
    }
  });

  it("starts everything else at warning", () => {
    expect(severityFor({ entry: claimEntry("test-reality") })).toBe("warning");
    expect(severityFor({ entry: claimEntry("observability") })).toBe("warning");
  });

  // Nothing is broken; something was never built.
  it("drops an absence claim one rung", () => {
    expect(severityFor({ entry: claimEntry("observability", true) })).toBe("info");
  });

  // The missing control is itself the exposure.
  it("keeps a security absence above info", () => {
    expect(severityFor({ entry: claimEntry("authn-completeness", true) })).toBe("warning");
  });

  // The one rule that must not break.
  it("never consults confidence", () => {
    const base = claimEntry("test-reality");
    const ranks = (["verified", "inferred", "not-determinable"] as const).map((confidence) =>
      severityFor({ entry: { ...base, confidence } }),
    );
    expect(new Set(ranks).size).toBe(1);
  });
});

/* ── Coverage must be real ────────────────────────────────────────────────── */

describe("refusing a coverage number that came from a missing input", () => {
  // "read 0 of 224 files" is not a cautious understatement, it is a false
  // statement: the run did read them and the log was lost on the way here.
  it("refuses rather than printing 0%", async () => {
    await expect(
      renderReport({
        input: input({ coverage: coverage({ opened: 0, total: 1000, share: 0 }) }),
        executiveSummary: SUMMARY,
        outDir: scratch,
        subjectRev: REV,
        mask: noMask,
      }),
    ).rejects.toThrow(RenderRefused);
  });

  it("says which stage produces the missing artifact", async () => {
    await expect(
      renderReport({
        input: input({ coverage: coverage({ opened: 0, total: 1000, share: 0 }) }),
        executiveSummary: SUMMARY,
        outDir: scratch,
        subjectRev: REV,
        mask: noMask,
      }),
    ).rejects.toThrow(/investigation stage/);
  });

  // Refusing on a draft too: a draft is still shown to people.
  it("refuses on a draft, not only on a release", async () => {
    expect(checkCoverageIsReal(coverage({ opened: 0, total: 5, share: 0 }))).not.toBeNull();
  });

  // The one honest zero.
  it("allows zero when the tree itself is empty", () => {
    expect(checkCoverageIsReal(coverage({ opened: 0, total: 0, share: 0 }))).toBeNull();
  });

  it("writes nothing when it refuses", async () => {
    await renderReport({
      input: input({ coverage: coverage({ opened: 0, total: 9, share: 0 }) }),
      executiveSummary: SUMMARY,
      outDir: scratch,
      subjectRev: REV,
      mask: noMask,
    }).catch(() => undefined);
    expect(existsSync(join(scratch, "report.typ"))).toBe(false);
  });
});

/* ── What the cover calls the subject ─────────────────────────────────────── */

describe("naming the subject on the cover", () => {
  it("uses the repository URL when there is one", () => {
    expect(subjectLabel(subject())).toBe("bitbucket.org/acme/acme-web-app");
  });

  // A local path is meaningless to the reader and puts our own filesystem
  // layout into a document that leaves the building.
  it.each(["." , "../checkout", "/Users/someone/work/tree"])(
    "falls back to the repository name for the local path %s",
    (origin) => {
      expect(subjectLabel(subject({ origin, name: "acme-web-app" }))).toBe("acme-web-app");
    },
  );

  it("never prints a bare dot as the subject", () => {
    const source = renderTypst({
      input: input({ subject: subject({ origin: ".", name: "acme-web-app" }) }),
      executiveSummary: SUMMARY,
    });
    expect(source).not.toMatch(/\*Subject:\* \.$/m);
    expect(source).toContain("*Subject:* acme-web-app");
  });
});

describe("the cover date", () => {
  // A millisecond-precision ISO timestamp is a machine artifact; the cover of a
  // client document carries a date.
  it("is a date, not a timestamp", () => {
    const source = renderTypst({ input: input(), executiveSummary: SUMMARY });
    expect(source).toContain("*Reviewed:* 2026-08-24");
    expect(source).not.toContain("12:00:00.000Z");
  });
});
