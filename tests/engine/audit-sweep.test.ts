import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepTree, signalsIn, isTestPath, summariseSignals, MAX_SWEEP_BYTES } from "../../src/engine/audit/sweep.js";
import { FileAccessLog } from "../../src/engine/audit/inventory.js";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "sweep-test-")); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function write(rel: string, text: string | Buffer): void {
  const full = join(scratch, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

describe("visiting every file", () => {
  // The whole point. Coverage stops being a claim the report makes and becomes
  // a ledger it can show, so every file needs exactly one recorded disposition.
  it("gives every file in the tree a disposition", () => {
    write("src/a.cs", "class A {}");
    write("src/b.ts", "export const b = 1;");
    write("docs/c.md", "# hi");
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.total).toBe(3);
    expect(result.dispositions.map((d) => d.path).sort()).toEqual(["docs/c.md", "src/a.cs", "src/b.ts"]);
    expect(result.dispositions.every((d) => d.outcome === "read")).toBe(true);
  });

  it("feeds the same access log coverage is computed from", () => {
    write("src/a.cs", "class A {}");
    const log = new FileAccessLog();
    sweepTree(scratch, log);
    expect(log.opened()).toEqual(new Set(["src/a.cs"]));
  });

  // Counting a PNG as covered would inflate the number this stage exists to
  // make trustworthy.
  it("records a binary as seen and not parsed, rather than as covered", () => {
    write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const log = new FileAccessLog();
    const result = sweepTree(scratch, log);
    expect(result.dispositions[0]?.outcome).toBe("binary");
    expect(result.read).toBe(0);
    expect(log.opened().size).toBe(0);
  });

  it("records an oversized file with its reason instead of reading it", () => {
    write("bundle.js", "x".repeat(MAX_SWEEP_BYTES + 10));
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.dispositions[0]?.outcome).toBe("too-large");
    expect(result.skipped).toBe(1);
  });
});

describe("what the sweep can establish without a model", () => {
  it("finds a token read without validation", () => {
    const found = signalsIn("Auth.cs", "var token = handler.ReadJwtToken(clerkToken);");
    expect(found[0]?.kind).toBe("unvalidated-token");
    expect(found[0]?.cwe).toBe("CWE-347");
    expect(found[0]?.owasp).toMatch(/API2/);
  });

  it("finds an anonymous endpoint", () => {
    expect(signalsIn("C.cs", "[AllowAnonymous]")[0]?.kind).toBe("anonymous-endpoint");
  });

  it("finds a password hashed with a general-purpose digest", () => {
    const found = signalsIn("Crypto.cs", "byte[] hash = SHA256.Create().ComputeHash(passwordBytes);");
    expect(found[0]?.kind).toBe("weak-password-hash");
    expect(found[0]?.cwe).toBe("CWE-916");
  });

  it.each([
    ["Program.cs", "builder.AllowAnyOrigin()", "permissive-cors"],
    ["web.config", '<compilation debug="true" />', "debug-enabled"],
    ["Startup.cs", 'config.AddJsonFile("appsettings.Test.json")', "config-precedence"],
  ])("finds %s as %s", (path, line, kind) => {
    expect(signalsIn(path, line).map((s) => s.kind)).toContain(kind);
  });

  // Every signal cites a standard, so a finding rests on something published
  // rather than on our opinion of what looks wrong.
  it("carries a CWE on every signal", () => {
    const found = signalsIn("C.cs", "[AllowAnonymous]\n[HttpPost]\nvar x = handler.ReadJwtToken(t);");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => /^CWE-\d+$/.test(s.cwe))).toBe(true);
  });

  // A comment describing code is not code. A rule that fires on prose produces
  // a finding nobody can act on.
  it("does not fire on a comment", () => {
    expect(signalsIn("C.cs", "// [AllowAnonymous] was removed last year")).toEqual([]);
  });

  // A fixture is not production risk surface. These files are still visited and
  // still counted as covered; what they do not do is generate findings.
  it.each(["tests/Foo.cs", "src/FooTests.cs", "src/__tests__/a.ts", "src/a.test.ts"])(
    "produces no signals from test code: %s",
    (path) => {
      expect(signalsIn(path, "[AllowAnonymous]\nvar t = handler.ReadJwtToken(x);")).toEqual([]);
    },
  );

  it("still counts test files as visited", () => {
    write("tests/FooTests.cs", "[AllowAnonymous]");
    const result = sweepTree(scratch, new FileAccessLog());
    expect(result.read).toBe(1);
    expect(result.signals).toEqual([]);
  });

  it.each(["tests/a.cs", "src/FooTests.cs", "e2e/x.ts"])("recognises %s as test code", (p) => {
    expect(isTestPath(p)).toBe(true);
  });
  it("does not mistake production code for test code", () => {
    expect(isTestPath("src/Services/ContestService.cs")).toBe(false);
  });
});

describe("separating surface from defects", () => {
  // 513 by-id fetches against 450 authorization checks is a statement worth
  // making. Calling those 513 defects would bury the eleven that are.
  it("classes an endpoint as surface and an unvalidated token as a defect", () => {
    const surface = signalsIn("C.cs", "[HttpGet]");
    const defect = signalsIn("C.cs", "var t = handler.ReadJwtToken(x);");
    expect(surface[0]?.signalClass).toBe("surface");
    expect(defect[0]?.signalClass).toBe("defect");
  });

  it("puts defects before surface in the summary, however common the surface", () => {
    const signals = [
      ...Array.from({ length: 50 }, () => signalsIn("C.cs", "[HttpGet]")).flat(),
      ...signalsIn("C.cs", "var t = handler.ReadJwtToken(x);"),
    ];
    expect(summariseSignals(signals)[0]?.signalClass).toBe("defect");
  });
});
