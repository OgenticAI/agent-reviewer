import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  acquire,
  AcquireError,
  isArchivePath,
  normaliseCloneUrl,
  describeCloneFailure,
  unsafeArchiveEntries,
  writeSubject,
} from "../../src/engine/audit/acquire.js";
import { languageOf, summariseTree, walkTree } from "../../src/engine/audit/tree.js";

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
