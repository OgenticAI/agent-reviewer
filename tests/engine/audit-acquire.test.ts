import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquire,
  AcquireError,
  isArchivePath,
  normaliseCloneUrl,
  redactUrl,
  describeCloneFailure,
  parseSevenZipListing,
  unsafeArchiveEntries,
  writeSubject,
} from "../../src/engine/audit/acquire.js";
import { languageOf, summariseTree, walkTree } from "../../src/engine/audit/tree.js";
import {
  AuditTelemetry,
  type AuditEvent,
  type TelemetrySink,
} from "../../src/engine/audit/telemetry.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "acquire-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A one-entry tar containing whatever name you give it, including one no tar
 * CLI would let you write. 512-byte header, then the body padded to a 512-byte
 * block, then two zero blocks to end the archive.
 */
function maliciousTar(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8"); // mode
  header.write("0000000\0", 108, 8, "utf8"); // uid
  header.write("0000000\0", 116, 8, "utf8"); // gid
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8"); // mtime
  header.write("ustar\x0000", 257, 8, "utf8");
  header.write("0", 156, 1, "utf8"); // type: regular file

  // Checksum is computed with the checksum field itself read as spaces.
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

  const content = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  content.write(body, 0, "utf8");
  return Buffer.concat([header, content, Buffer.alloc(1024)]);
}

/** A small codebase on disk: two languages, a skipped dir, and a binary. */
function plantCodebase(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });

  writeFileSync(join(root, "src", "app.ts"), "const a = 1;\nconst b = 2;\n");
  writeFileSync(join(root, "src", "Handler.cs"), "class Handler {\n}\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
}

describe("source classification", () => {
  it.each([
    ["repo.zip", true],
    ["export.tar.gz", true],
    ["export.TGZ", true],
    ["release.tar.xz", true],
    ["release.tar.bz2", true],
    ["export.7z", true],
    ["bitbucket.org/acme/acme-web-app-v3", false],
    ["https://github.com/OgenticAI/agent-reviewer.git", false],
  ])("classifies %s", (from, archive) => {
    expect(isArchivePath(from)).toBe(archive);
  });

  it("adds https to a bare host/owner/repo, and leaves real URLs alone", () => {
    expect(normaliseCloneUrl("bitbucket.org/acme/acme-web-app-v3")).toBe(
      "https://bitbucket.org/acme/acme-web-app-v3",
    );
    expect(normaliseCloneUrl("https://x.com/a/b")).toBe("https://x.com/a/b");
    expect(normaliseCloneUrl("git@bitbucket.org:acme/x.git")).toBe("git@bitbucket.org:acme/x.git");
  });

  // A scheme typed in capitals is still a scheme. Prefixed again it became
  // `https://HTTPS://...`, which git refuses, quoting the URL back with
  // whatever credential it carried.
  it("does not prefix a scheme that is merely upper-case", () => {
    expect(normaliseCloneUrl("HTTPS://git.example.com/acme/app")).toBe(
      "HTTPS://git.example.com/acme/app",
    );
  });
});

describe("zip-slip refusal", () => {
  it("passes ordinary entries", () => {
    expect(unsafeArchiveEntries(["src/app.ts", "README.md", "a/b/c.txt", ""])).toEqual([]);
  });

  it.each([
    ["absolute posix", "/etc/passwd"],
    ["absolute windows", "C:\\windows\\system32"],
    ["parent traversal", "../../../etc/passwd"],
    ["traversal mid-path", "src/../../escape.txt"],
    ["backslash traversal", "..\\..\\escape.txt"],
  ])("refuses %s", (_name, entry) => {
    expect(unsafeArchiveEntries([entry])).toEqual([entry]);
  });

  // "..foo" is a normal name; only a ".." SEGMENT traverses.
  it("does not refuse a filename that merely starts with dots", () => {
    expect(unsafeArchiveEntries(["src/..hidden", "..config"])).toEqual([]);
  });
});

describe("the tree walk", () => {
  it("counts lines and languages, skipping vendored directories", () => {
    plantCodebase(scratch);
    const files = walkTree(scratch);
    const paths = files.map((f) => f.path);

    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("src/Handler.cs");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);

    const summary = summariseTree(files);
    expect(summary.files).toBe(4); // app.ts, Handler.cs, README.md, logo.png
    expect(summary.loc).toBe(5); // 2 + 2 + 1; the png counts as 0
  });

  it("counts a binary as zero lines rather than inflating the denominator", () => {
    plantCodebase(scratch);
    const png = walkTree(scratch).find((f) => f.path === "logo.png");
    expect(png?.loc).toBe(0);
    expect(png?.bytes).toBeGreaterThan(0);
  });

  it("does not follow symlinks out of the tree", () => {
    plantCodebase(scratch);
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.ts"), "const secret = 1;\n");
    symlinkSync(outside, join(scratch, "escape"));

    try {
      expect(walkTree(scratch).some((f) => f.path.includes("secret"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Finder's "Compress" writes a `._A.cs` beside every `A.cs`: AppleDouble
  // metadata, not C#, and `languageOf` cannot tell from the extension.
  it("skips AppleDouble sidecars and the __MACOSX folder Finder adds", () => {
    plantCodebase(scratch);
    mkdirSync(join(scratch, "__MACOSX", "src"), { recursive: true });
    writeFileSync(join(scratch, "__MACOSX", "src", "._Handler.cs"), "meta\nmeta\nmeta\n");
    writeFileSync(join(scratch, "src", "._Handler.cs"), "meta\nmeta\nmeta\n");

    const files = walkTree(scratch);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/Handler.cs");
    expect(paths.some((p) => basename(p).startsWith("._"))).toBe(false);
    expect(paths.some((p) => p.startsWith("__MACOSX/"))).toBe(false);

    // The sidecars carry more lines than the real file; none of them count.
    const summary = summariseTree(files);
    expect(summary.files).toBe(4);
    expect(summary.loc).toBe(5);
  });

  it("reports language share, not just a count", () => {
    const summary = summariseTree([
      { path: "a.cs", language: "csharp", bytes: 10, loc: 80, sha256: "a" },
      { path: "b.ts", language: "typescript", bytes: 10, loc: 20, sha256: "b" },
    ]);
    expect(summary.langs).toEqual({ csharp: 0.8, typescript: 0.2 });
  });

  it("reports no languages for an empty tree rather than dividing by zero", () => {
    expect(summariseTree([])).toEqual({ files: 0, loc: 0, langs: {} });
  });

  it("maps extensions it knows and buckets the rest", () => {
    expect(languageOf("x/y/App.tsx")).toBe("typescript");
    expect(languageOf("Service.CS")).toBe("csharp");
    expect(languageOf("notes.wat")).toBe("other");
  });
});

describe("acquiring from an archive", () => {
  function makeArchive(kind: "zip" | "tgz"): string {
    const staging = join(scratch, "staging", "acme-web-app-v3");
    plantCodebase(staging);
    const archive = join(scratch, `export.${kind === "zip" ? "zip" : "tar.gz"}`);

    if (kind === "zip") {
      execFileSync("zip", ["-qr", archive, "acme-web-app-v3"], {
        cwd: join(scratch, "staging"),
      });
    } else {
      execFileSync("tar", ["-czf", archive, "acme-web-app-v3"], {
        cwd: join(scratch, "staging"),
      });
    }
    return archive;
  }

  it.each(["zip", "tgz"] as const)("extracts a %s and reports no revision", async (kind) => {
    const into = join(scratch, "work");
    const subject = await acquire({ from: makeArchive(kind), into });

    expect(subject.kind).toBe("archive");
    expect(subject.rev).toBeNull();
    // The absence is stated, not left blank — the report prints this in Coverage.
    expect(subject.revProvenance).toMatch(/archive carries no history/);
    expect(existsSync(join(into, "src", "app.ts"))).toBe(true);
  });

  // The wrapper folder is an artefact of how the file was made. Left in place it
  // shifts every path in every finding by one segment.
  it("lifts the single wrapper directory archives usually add", async () => {
    const into = join(scratch, "work");
    await acquire({ from: makeArchive("tgz"), into });

    expect(existsSync(join(into, "src", "app.ts"))).toBe(true);
    expect(existsSync(join(into, "acme-web-app-v3"))).toBe(false);
  });

  it("computes loc and langs from the extracted tree", async () => {
    const subject = await acquire({ from: makeArchive("tgz"), into: join(scratch, "work") });
    expect(subject.loc).toBe(5);
    expect(Object.keys(subject.langs).sort()).toEqual(["csharp", "markdown", "typescript"]);
  });

  // A client can hand over a rebuild rather than the build actually in
  // production, and the two carry the same product name. Which artefact was
  // reviewed has to survive into the report's Targets section, so `origin` is
  // recorded verbatim rather than tidied into a display name.
  it("records the origin verbatim, so a -v3 repo is never reported as the live product", async () => {
    const staging = join(scratch, "staging", "acme-web-app-v3");
    plantCodebase(staging);
    const archive = join(scratch, "acme-web-app-v3.tar.gz");
    execFileSync("tar", ["-czf", archive, "acme-web-app-v3"], {
      cwd: join(scratch, "staging"),
    });

    const subject = await acquire({ from: archive, into: join(scratch, "work") });

    expect(subject.origin).toBe(archive);
    expect(basename(subject.origin)).toBe("acme-web-app-v3.tar.gz");
  });

  it("refuses an archive containing a traversal entry, before writing anything", async () => {
    // Written byte by byte rather than with `tar --transform`: bsdtar has no
    // such flag, and every tar that does will happily sanitise the path on the
    // way in — which would leave the test passing for the wrong reason.
    const archive = join(scratch, "evil.tar");
    writeFileSync(archive, maliciousTar("../escaped.txt", "owned\n"));

    const into = join(scratch, "work");
    await expect(acquire({ from: archive, into })).rejects.toThrow(AcquireError);
    expect(existsSync(join(scratch, "escaped.txt"))).toBe(false);
    // Refused from the listing, so the target was never even created.
    expect(existsSync(join(into, "escaped.txt"))).toBe(false);
  });
});

/**
 * The shapes a real export arrives in. Each archive is built with the same
 * tool a client would use, so what is tested is the extractor's behaviour
 * against the real file, not a model of it.
 */
describe("common export shapes", () => {
  function stageProject(): string {
    const staging = join(scratch, "staging");
    mkdirSync(join(staging, "proj"), { recursive: true });
    writeFileSync(join(staging, "proj", "A.cs"), "class A {\n}\n");
    return staging;
  }

  // The listing succeeds (names are not encrypted), so nothing upstream sees
  // it coming. Given the empty password acquire passes, unzip skips every
  // encrypted entry with a warning that says so, whether or not a terminal
  // is attached; without that flag it prompts on /dev/tty under an
  // operator's shell and hangs. Unmapped, that was an uncaught throw and no
  // subject.json.
  it("says an encrypted zip is password-protected and asks for an unencrypted export", async () => {
    const staging = stageProject();
    const archive = join(scratch, "locked.zip");
    execFileSync("zip", ["-P", "EXAMPLE_PASSWORD", "-qr", archive, "proj"], { cwd: staging });

    const into = join(scratch, "work");
    const attempt = acquire({ from: archive, into });
    await expect(attempt).rejects.toThrow(AcquireError);
    await expect(attempt).rejects.toThrow(/password-protected/);
    await expect(attempt).rejects.toThrow(/unencrypted export/);
    expect(existsSync(join(into, "A.cs"))).toBe(false);
  });

  // Finder's "Compress" writes `proj/` and `__MACOSX/` side by side, with an
  // AppleDouble `._A.cs` for every `A.cs`. Two top-level entries used to mean
  // "no single wrapper", so `proj/` stayed and every path gained a segment.
  it("lifts the wrapper out of a Finder zip and does not count the sidecars", async () => {
    const staging = stageProject();
    mkdirSync(join(staging, "__MACOSX", "proj"), { recursive: true });
    writeFileSync(join(staging, "__MACOSX", "proj", "._A.cs"), "meta\nmeta\nmeta\nmeta\n");
    writeFileSync(join(staging, "proj", ".DS_Store"), Buffer.from([0x00, 0x00, 0x00, 0x01]));
    const archive = join(scratch, "finder.zip");
    execFileSync("zip", ["-qr", archive, "proj", "__MACOSX"], { cwd: staging });

    const into = join(scratch, "work");
    const subject = await acquire({ from: archive, into });

    expect(existsSync(join(into, "A.cs"))).toBe(true);
    expect(existsSync(join(into, "proj"))).toBe(false);
    expect(subject.liftedWrapper).toBe("proj");

    const paths = walkTree(into).map((f) => f.path);
    expect(paths).toContain("A.cs");
    expect(paths.some((p) => basename(p).startsWith("._"))).toBe(false);
    // The sidecar has twice the lines of the real file. If it were counted as
    // C# the total would be 6, not 2.
    expect(subject.loc).toBe(2);
    expect(subject.langs).toEqual({ csharp: 1 });
  });

  it("does not record a lifted wrapper when there was none to lift", async () => {
    const staging = stageProject();
    writeFileSync(join(staging, "README.md"), "# top\n");
    const archive = join(scratch, "flat.tar.gz");
    execFileSync("tar", ["-czf", archive, "proj", "README.md"], { cwd: staging });

    const into = join(scratch, "work");
    const subject = await acquire({ from: archive, into });
    expect(subject.liftedWrapper).toBeUndefined();
    expect(existsSync(join(into, "proj", "A.cs"))).toBe(true);
  });

  it.each([
    ["tar.xz", "-cJf"],
    ["tar.bz2", "-cjf"],
  ])("extracts a %s the same way as a tar.gz", async (extension, flag) => {
    const staging = stageProject();
    const archive = join(scratch, `release.${extension}`);
    execFileSync("tar", [flag, archive, "proj"], { cwd: staging });

    const into = join(scratch, `work-${extension}`);
    const subject = await acquire({ from: archive, into });
    expect(subject.kind).toBe("archive");
    expect(subject.liftedWrapper).toBe("proj");
    expect(existsSync(join(into, "A.cs"))).toBe(true);
  });

  function sevenZipOnPath(): string | undefined {
    for (const binary of ["7z", "7zz"]) {
      try {
        execFileSync(binary, ["i"], { stdio: "ignore" });
        return binary;
      } catch {
        continue;
      }
    }
    return undefined;
  }
  const sevenZip = sevenZipOnPath();

  it.runIf(sevenZip !== undefined)("extracts a .7z when 7-Zip is installed", async () => {
    const staging = stageProject();
    const archive = join(scratch, "export.7z");
    execFileSync(sevenZip as string, ["a", "-bso0", "-bsp0", archive, "proj"], { cwd: staging });

    const into = join(scratch, "work");
    const subject = await acquire({ from: archive, into });
    expect(subject.liftedWrapper).toBe("proj");
    expect(existsSync(join(into, "A.cs"))).toBe(true);
  });

  it.skipIf(sevenZip !== undefined)("names the missing 7-Zip binary rather than crashing", async () => {
    const archive = join(scratch, "export.7z");
    writeFileSync(archive, Buffer.from("7z\xbc\xaf\x27\x1c", "latin1"));

    const attempt = acquire({ from: archive, into: join(scratch, "work") });
    await expect(attempt).rejects.toThrow(AcquireError);
    await expect(attempt).rejects.toThrow(/7z/);
    await expect(attempt).rejects.toThrow(/install|PATH/i);
  });

  it("reports a corrupt archive as an AcquireError, not a raw spawn failure", async () => {
    const archive = join(scratch, "broken.zip");
    writeFileSync(archive, "this is not a zip file\n");

    const attempt = acquire({ from: archive, into: join(scratch, "work") });
    await expect(attempt).rejects.toThrow(AcquireError);
    await expect(attempt).rejects.toThrow(/could not extract broken\.zip/);
  });

  // unzip echoes the entry's path in its error line. A tree with a crypto
  // module in it, damaged in transfer, used to be diagnosed off that path as
  // password-protected, and the client was asked to re-export unencrypted.
  it("does not mistake a corrupt entry named Encrypted for a password prompt", async () => {
    const staging = join(scratch, "staging");
    mkdirSync(join(staging, "proj"), { recursive: true });
    // Big enough that the middle of the zip file is inside this entry's data
    // rather than in a header, and varied enough that deflate keeps it big.
    let body = "";
    for (let i = 0; i < 3000; i++) body += `${(i * 2654435761) % 4294967296}\n`;
    writeFileSync(join(staging, "proj", "EncryptedVault.cs"), body);
    const archive = join(scratch, "damaged.zip");
    execFileSync("zip", ["-q", archive, "proj/EncryptedVault.cs"], { cwd: staging });
    const bytes = readFileSync(archive);
    const middle = Math.floor(bytes.length / 2);
    for (let i = 0; i < 64; i++) bytes[middle + i] = (bytes[middle + i] as number) ^ 0xff;
    writeFileSync(archive, bytes);

    // The central directory at the end is intact, so the listing still passes
    // and the failure comes from extraction, as it did for the real file.
    expect(execFileSync("unzip", ["-Z1", archive]).toString()).toContain("proj/EncryptedVault.cs");

    const attempt = acquire({ from: archive, into: join(scratch, "work") });
    await expect(attempt).rejects.toThrow(AcquireError);
    await expect(attempt).rejects.toThrow(/could not extract damaged\.zip/);
    await expect(attempt).rejects.not.toThrow(/password-protected/);
  });

  // No 7-Zip binary can be assumed where the tests run, and the listing parse
  // is the one line that decides whether every .7z is refused as unsafe: the
  // technical listing opens with the archive's OWN record, whose Path is an
  // absolute path on this machine. The parse is therefore checked against
  // both shapes the listing takes, with and without that header block.
  describe("the 7z listing parse", () => {
    const entryBlocks = [
      "Path = proj",
      "Folder = +",
      "",
      "Path = proj/A.cs",
      "Size = 12",
      "Attributes = A",
      "",
    ].join("\n");

    it("cuts the archive's own record away and keeps the entries", () => {
      const listing = [
        "7-Zip 24.09 (arm64) : Copyright (c) 1999-2024 Igor Pavlov : 2024-11-29",
        "",
        "Listing archive: /srv/exports/export.7z",
        "",
        "--",
        "Path = /srv/exports/export.7z",
        "Type = 7z",
        "Physical Size = 220",
        "",
        "----------",
        entryBlocks,
      ].join("\n");
      const entries = parseSevenZipListing(listing);
      expect(entries).toEqual(["proj", "proj/A.cs"]);
      // The relationship that matters: what the parse hands on passes the
      // zip-slip check, and the archive's absolute path is not in it.
      expect(unsafeArchiveEntries(entries)).toEqual([]);
      expect(entries.some((e) => e.startsWith("/"))).toBe(false);
    });

    it("takes a listing with no header block whole", () => {
      expect(parseSevenZipListing(entryBlocks)).toEqual(["proj", "proj/A.cs"]);
    });

    it("still refuses an entry that escapes, once the header is gone", () => {
      const listing = ["--", "Path = /srv/exports/x.7z", "----------", "Path = ../escape.txt", ""].join("\n");
      expect(unsafeArchiveEntries(parseSevenZipListing(listing))).toEqual(["../escape.txt"]);
    });
  });
});

describe("re-acquiring", () => {
  it("refuses an existing target rather than merging two trees", async () => {
    const into = join(scratch, "work");
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "stale.ts"), "const old = 1;\n");

    await expect(acquire({ from: join(scratch, "nope.zip"), into })).rejects.toThrow(
      /already exists/,
    );
    expect(existsSync(join(into, "stale.ts"))).toBe(true);
  });

  it("replaces cleanly when told to, leaving nothing of the old tree", async () => {
    const staging = join(scratch, "staging", "repo");
    plantCodebase(staging);
    const archive = join(scratch, "e.tar.gz");
    execFileSync("tar", ["-czf", archive, "repo"], { cwd: join(scratch, "staging") });

    const into = join(scratch, "work");
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "stale.ts"), "const old = 1;\n");

    await acquire({ from: archive, into, replace: true });
    expect(existsSync(join(into, "stale.ts"))).toBe(false);
    expect(existsSync(join(into, "src", "app.ts"))).toBe(true);
  });
});

describe("acquiring by clone", () => {
  it("pins the revision and says the history is available", async () => {
    const origin = join(scratch, "origin");
    plantCodebase(origin);
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: origin,
    });
    const head = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"]).toString().trim();

    const subject = await acquire({ from: origin, into: join(scratch, "work") });

    expect(subject.kind).toBe("clone");
    expect(subject.rev).toBe(head);
    expect(subject.revProvenance).toMatch(/full history/);
  });
});

describe("pinning a ref", () => {
  // A repository whose default branch is NOT the branch that deploys. This is
  // the shape that produced the incident: `develop` is served by default and
  // months behind `production`, so an unpinned acquire reads the dormant one
  // and the subject gave no hint of it.
  function twoBranchOrigin(): { origin: string; developHead: string; productionHead: string } {
    const origin = join(scratch, "two-branch");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", origin, ...args])
        .toString()
        .trim();
    plantCodebase(origin);
    execFileSync("git", ["init", "--quiet", "-b", "develop"], { cwd: origin });
    git("add", "-A");
    git("commit", "-qm", "on develop");
    const developHead = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "-b", "production");
    writeFileSync(join(origin, "shipped.ts"), "export const shipped = true;\n");
    git("add", "-A");
    git("commit", "-qm", "on production");
    const productionHead = git("rev-parse", "HEAD");
    git("tag", "v1.0.0");
    // Leave the default branch selected, so a plain clone serves develop.
    git("checkout", "--quiet", "develop");
    return { origin, developHead, productionHead };
  }

  it("reads the ref that was asked for, not the default branch", async () => {
    const { origin, productionHead } = twoBranchOrigin();
    const subject = await acquire({ from: origin, into: join(scratch, "w1"), ref: "production" });
    expect(subject.rev).toBe(productionHead);
    expect(subject.requestedRef).toBe("production");
  });

  it.each(["production", "v1.0.0"])("resolves a branch or a tag: %s", async (ref, index) => {
    const { origin, productionHead } = twoBranchOrigin();
    const subject = await acquire({ from: origin, into: join(scratch, `w-ref-${index}`), ref });
    expect(subject.rev).toBe(productionHead);
  });

  it("resolves a bare commit sha", async () => {
    const { origin, developHead } = twoBranchOrigin();
    const subject = await acquire({ from: origin, into: join(scratch, "w2"), ref: developHead });
    expect(subject.rev).toBe(developHead);
    expect(subject.requestedRef).toBe(developHead);
  });

  // The requested ref and the resolved sha are kept apart on purpose: a sha
  // alone does not say which branch it came from, and that ambiguity is what
  // made a review of a stale branch indistinguishable from a review of the
  // deployed one.
  it("records what was asked for beside what it resolved to", async () => {
    const { origin, productionHead } = twoBranchOrigin();
    const subject = await acquire({ from: origin, into: join(scratch, "w3"), ref: "production" });
    expect(subject.requestedRef).toBe("production");
    expect(subject.rev).toBe(productionHead);
    expect(subject.rev).not.toBe(subject.requestedRef);
    expect(subject.revProvenance).toContain("production");
  });

  // The half that matters more than the flag. An operator who forgets --ref
  // must still end up with a subject that says which branch was read.
  it("names the default branch when no ref was given", async () => {
    const { origin, developHead } = twoBranchOrigin();
    const subject = await acquire({ from: origin, into: join(scratch, "w4") });
    expect(subject.rev).toBe(developHead);
    expect(subject.requestedRef).toBeNull();
    expect(subject.defaultBranch).toBe("develop");
    expect(subject.revProvenance).toMatch(/default branch/i);
    expect(subject.revProvenance).toContain("develop");
  });

  // Falling back to the default on a typo would reproduce the original failure
  // exactly: a review of something other than what was asked for, with nothing
  // saying so.
  it("fails naming the ref rather than falling back to the default", async () => {
    const { origin } = twoBranchOrigin();
    await expect(
      acquire({ from: origin, into: join(scratch, "w5"), ref: "no-such-branch" }),
    ).rejects.toThrow(/no-such-branch/);
  });

  it("refuses a ref on an archive, which has no history to pin", async () => {
    const staging = join(scratch, "arch-staging");
    plantCodebase(join(staging, "repo"));
    const archive = join(scratch, "repo.tar.gz");
    execFileSync("tar", ["-czf", archive, "repo"], { cwd: staging });
    await expect(
      acquire({ from: archive, into: join(scratch, "w6"), ref: "production" }),
    ).rejects.toThrow(/archive/i);
  });
});

describe("clone failures read as instructions, not crashes", () => {
  const url = "https://bitbucket.org/acme/acme-web-app-v3";

  // The likeliest failure by far: the host is private, which is the whole
  // reason read access had to be granted. That is a setup step, not a defect.
  it.each([
    "fatal: could not read Username for 'https://bitbucket.org': terminal prompts disabled",
    "remote: Invalid credentials\nfatal: Authentication failed for 'https://bitbucket.org/'",
  ])("explains an auth failure and says nothing was written", (stderr) => {
    const message = describeCloneFailure(url, stderr);
    expect(message).toMatch(/cannot authenticate/i);
    expect(message).toMatch(/Nothing was written/);
  });

  // Bitbucket app passwords were REMOVED — that settings page is a 404. This
  // message is the one thing an operator reads at the moment they are stuck, so
  // pointing them at a feature that no longer exists costs an afternoon.
  it("never recommends a feature Bitbucket has removed", () => {
    for (const host of [
      "https://bitbucket.org/acme/app",
      "https://github.com/acme/app",
      "git@gitlab.com:acme/app.git",
    ]) {
      expect(describeCloneFailure(host, "fatal: Authentication failed")).not.toMatch(
        /app password/i,
      );
    }
  });

  // Both Bitbucket mistakes produce an IDENTICAL `Authentication failed`, which
  // is exactly why they are worth naming here rather than left to be guessed.
  it.each([
    "https://bitbucket.org/acme/app.git",
    "git@bitbucket.org:acme/app.git",
  ])("names both ways a Bitbucket token fails, for %s", (bitbucket) => {
    const message = describeCloneFailure(bitbucket, "fatal: Authentication failed");
    expect(message).toMatch(/scopes/i);
    expect(message).toMatch(/read:repository:bitbucket/);
    // The expensive one: the account email authenticates against the REST API
    // and is refused by git, so every check short of a clone looks healthy.
    expect(message).toMatch(/x-bitbucket-api-token-auth/);
    expect(message).toMatch(/REST API/);
  });

  // Advice for the host we were pointed at, and no other. A GitHub failure has
  // no business being told about Atlassian tokens.
  it.each([
    "https://github.com/acme/app.git",
    "https://gitlab.com/acme/app.git",
    "git@github.com:acme/app.git",
  ])("keeps Bitbucket-specific advice off %s", (other) => {
    const message = describeCloneFailure(other, "fatal: Authentication failed");
    expect(message).not.toMatch(/bitbucket/i);
    expect(message).toMatch(/personal access token|SSH key/);
  });

  it("distinguishes not-found from not-authorised, without guessing which", () => {
    const message = describeCloneFailure(url, "fatal: Repository not found");
    expect(message).toMatch(/not found, or the credential in use cannot see it/);
  });

  it("still says something useful for a failure it does not recognise", () => {
    const message = describeCloneFailure(url, "fatal: the remote end hung up unexpectedly");
    expect(message).toMatch(/git clone failed/);
    expect(message).toMatch(/hung up unexpectedly/);
  });
});

/**
 * A token in the clone URL goes to `git clone` and nowhere else.
 *
 * The URL is the ordinary place to put a one-off read token, and everything
 * that describes an acquisition prints the origin: subject.json, the
 * telemetry event, the CLI summary line, the report cover. One copy of the
 * URL with the token still in it is a leak into every one of those.
 */
describe("a credential in the clone URL never leaves the clone", () => {
  const TOKEN = "EXAMPLE_TOKEN_0123456789";

  it("strips the userinfo and nothing else, and leaves URLs without one alone", () => {
    expect(redactUrl(`https://user:${TOKEN}@git.example.com/acme/app.git`)).toBe(
      "https://git.example.com/acme/app.git",
    );
    // A bare token as the user, which GitHub accepts, goes the same way.
    expect(redactUrl(`https://${TOKEN}@git.example.com/acme/app.git`)).toBe(
      "https://git.example.com/acme/app.git",
    );
    expect(redactUrl(`file://user:${TOKEN}@/srv/mirror/app`)).toBe("file:///srv/mirror/app");
    // The shorthand the CLI documents, `host/owner/repo`, takes a userinfo
    // too, and normaliseCloneUrl turns it into a URL that git clones with
    // the token. The operator's spelling stays; only the userinfo goes.
    expect(redactUrl(`user:${TOKEN}@git.example.com/acme/app`)).toBe("git.example.com/acme/app");
    expect(redactUrl(`${TOKEN}@git.example.com/acme/app`)).toBe("git.example.com/acme/app");
    expect(redactUrl(`HTTPS://user:${TOKEN}@git.example.com/acme/app`)).toBe(
      "HTTPS://git.example.com/acme/app",
    );
    for (const plain of [
      "https://git.example.com/acme/app.git",
      "git@git.example.com:acme/app.git",
      "/srv/mirror/app",
      "git.example.com/acme/app",
    ]) {
      expect(redactUrl(plain)).toBe(plain);
    }
  });

  // The two functions must agree on what a URL is, or a shape one treats as
  // a URL and the other as a path is exactly the one that leaks.
  it("strips from every shape normaliseCloneUrl would clone, and nothing else", () => {
    for (const from of [
      `user:${TOKEN}@git.example.com/acme/app`,
      `https://user:${TOKEN}@git.example.com/acme/app`,
      `ssh://${TOKEN}@git.example.com/acme/app`,
    ]) {
      expect(normaliseCloneUrl(from)).not.toBe(normaliseCloneUrl(redactUrl(from)));
      expect(redactUrl(from)).not.toContain(TOKEN);
    }
    for (const left of ["git@git.example.com:acme/app.git", "/srv/mirror/app", "./mirror"]) {
      expect(redactUrl(left)).toBe(left);
    }
  });

  it("puts nothing in the token's place that could be read as a value", () => {
    const redacted = redactUrl(`https://user:${TOKEN}@git.example.com/acme/app.git`);
    expect(redacted).not.toContain("@");
    expect(redacted).not.toMatch(/\*\*\*|redacted|hidden|xxx/i);
  });

  // A real clone through a file:// URL carrying userinfo, which git accepts.
  // Every surface the origin reaches is checked against the same token.
  it("keeps the token out of the subject, subject.json, telemetry and the CLI summary", async () => {
    const origin = join(scratch, "origin");
    plantCodebase(origin);
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: origin,
    });
    const from = `file://user:${TOKEN}@${origin}`;

    const into = join(scratch, "work");
    const subject = await acquire({ from, into });
    expect(subject.kind).toBe("clone");
    expect(subject.origin).toBe(`file://${origin}`);
    expect(JSON.stringify(subject)).not.toContain(TOKEN);

    // git wrote the URL it cloned into the tree's own config, and the tree
    // outlives the run. The remote is still there, pointed at the same
    // repository minus the credential.
    const config = readFileSync(join(into, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).toContain(`url = file://${origin}`);

    const written = readFileSync(writeSubject(into, subject), "utf8");
    expect(written).not.toContain(TOKEN);
    expect(written).toContain(`file://${origin}`);

    const sent: AuditEvent[] = [];
    const sink: TelemetrySink = {
      send: async (events) => {
        sent.push(...events);
      },
    };
    const telemetry = new AuditTelemetry({ runId: "run-1", sink, knownSecrets: [] });
    telemetry.recordSubject(subject, null);
    await telemetry.flush();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);

    // The CLI itself, as an operator runs it. Its summary line is the origin
    // an operator copies into a ticket.
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const stdout = execFileSync(
      process.execPath,
      [
        join(root, "node_modules", ".bin", "tsx"),
        join(root, "src", "audit-cli.ts"),
        "acquire",
        "--from",
        from,
        "--into",
        join(scratch, "cli-work"),
        "--started-by",
        "operator@example.com",
      ],
      {
        cwd: root,
        env: { ...process.env, AUDIT_TELEMETRY_URL: "", AUDIT_TELEMETRY_TOKEN: "" },
        encoding: "utf8",
      },
    );
    expect(stdout).toMatch(/^acquired file:\/\//m);
    expect(stdout).toContain(`file://${origin}`);
    expect(stdout).not.toContain(TOKEN);
  }, 60_000);

  // The shorthand the CLI documents, with a token in it, cloned for real:
  // git is pointed at a local origin through an `insteadOf` rewrite of the
  // exact credentialed URL, so the clone succeeds the way it does against a
  // host, and the token is then looked for everywhere the origin goes.
  it("strips a token from the scheme-less shorthand, and the remote still checks out a ref", async () => {
    const origin = join(scratch, "origin");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", origin, ...args])
        .toString()
        .trim();
    plantCodebase(origin);
    execFileSync("git", ["init", "--quiet", "-b", "develop"], { cwd: origin });
    git("add", "-A");
    git("commit", "-qm", "on develop");
    git("checkout", "--quiet", "-b", "production");
    writeFileSync(join(origin, "shipped.ts"), "export const shipped = true;\n");
    git("add", "-A");
    git("commit", "-qm", "on production");
    const productionHead = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "develop");

    const from = `user:${TOKEN}@git.example.com/acme/app`;
    const saved = { ...process.env };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = normaliseCloneUrl(from);
    const into = join(scratch, "work");
    let subject;
    try {
      subject = await acquire({ from, into, ref: "production" });
    } finally {
      for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }

    expect(subject.rev).toBe(productionHead);
    expect(subject.origin).toBe("git.example.com/acme/app");
    expect(JSON.stringify(subject)).not.toContain(TOKEN);
    expect(readFileSync(writeSubject(into, subject), "utf8")).not.toContain(TOKEN);

    // The checkout above ran after the remote URL was replaced with one no
    // network could resolve, which is the proof that nothing after the clone
    // needs the credential.
    const config = readFileSync(join(into, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).toContain("url = https://git.example.com/acme/app");
  }, 60_000);

  // The failure text is what an operator pastes into a chat when stuck. git
  // quotes the URL back in its own stderr, token included, so both inputs
  // to the message are checked.
  it.each([
    ["auth", "fatal: Authentication failed for 'https://user:EXAMPLE_TOKEN_0123456789@git.example.com/acme/app.git/'"],
    ["not found", "fatal: repository 'https://user:EXAMPLE_TOKEN_0123456789@git.example.com/acme/app.git/' not found"],
    ["unrecognised", "fatal: unable to access 'https://user:EXAMPLE_TOKEN_0123456789@git.example.com/acme/app.git/': Could not resolve host"],
  ])("keeps the token out of the %s failure message", (_kind, stderr) => {
    const message = describeCloneFailure(
      `https://user:${TOKEN}@git.example.com/acme/app.git`,
      stderr,
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("user:");
    expect(message).toContain("git.example.com/acme/app.git");
  });
});

describe("acquired client code is never committable", () => {
  // Client code stays on the machine. A .gitignore entry is the difference
  // between that being a rule and being a hope.
  it("gitignores the default work directory and subject files", () => {
    const ignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
    expect(ignore).toMatch(/^work\/$/m);
    expect(ignore).toMatch(/^\*\.subject\.json$/m);
  });

  it("git itself agrees the paths are ignored", () => {
    // check-ignore exits 0 only when the path is actually ignored, so this
    // tests git's resolution rather than our reading of the file.
    const root = new URL("../../", import.meta.url).pathname;
    for (const path of ["work/acme-web/src/app.ts", "acme-web.subject.json"]) {
      expect(() => execFileSync("git", ["check-ignore", "-q", path], { cwd: root })).not.toThrow();
    }
  });
});

describe("subject.json", () => {
  it("writes the audit's identity beside the tree", async () => {
    const staging = join(scratch, "staging", "repo");
    plantCodebase(staging);
    const archive = join(scratch, "e.tar.gz");
    execFileSync("tar", ["-czf", archive, "repo"], { cwd: join(scratch, "staging") });

    const into = join(scratch, "work");
    const subject = await acquire({ from: archive, into });
    const path = writeSubject(into, subject);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.rev).toBeNull();
    expect(written.revProvenance).toBeTruthy();
    expect(written.origin).toBe(archive);
    expect(written.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
