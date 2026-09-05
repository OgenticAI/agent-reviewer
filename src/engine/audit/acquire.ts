/**
 * Acquiring a codebase to audit (OGE-2425).
 *
 * This is the whole of "Bitbucket support". The audit head touches no host API
 * — it reads a directory — so acquisition is `git clone` or an archive
 * extraction, and which host the code came from stops mattering the moment the
 * tree is on disk.
 *
 * ── Why the archive path is not an afterthought ─────────────────────────────
 *
 * Source arrives as an export more often than you would expect — a zip in a
 * shared drive, sent by someone who had clone access the whole time. The path
 * that looks like the edge case is the one real engagements take, so both are
 * first-class here and the difference is recorded rather than smoothed over: an
 * archive yields `rev: null`, and the report says in Coverage that history
 * signals were unavailable instead of quietly omitting them.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { maskSecrets } from "../tools/sanitize.js";
import { summariseTree, walkTree, type TreeSummary } from "./tree.js";

const run = promisify(execFile);

/** Long enough for a large clone, short enough that a hung process is not forever. */
const ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;

export type SourceKind = "clone" | "archive";

export interface Subject extends TreeSummary {
  kind: SourceKind;
  /**
   * What the operator asked for, so a `-v3` repo is never reported as the
   * live product. Verbatim except for one thing: a credential embedded in the
   * URL is removed before it gets here (see `redactUrl`). Everything that
   * reads a subject prints this field, and none of it needs the token.
   */
  origin: string;
  /** Directory name of the acquired tree. */
  name: string;
  /** The pinned revision. `null` when the source carried no history. */
  rev: string | null;
  /**
   * What the operator ASKED for, kept apart from what it resolved to.
   *
   * A SHA alone does not say which branch it came from, and that ambiguity is
   * what let a review of a stale default branch look identical to a review of
   * the deploying one. `null` means no ref was named, in which case
   * `defaultBranch` records what was taken instead.
   */
  requestedRef: string | null;
  /**
   * The branch the remote serves by default, recorded whether or not it was
   * used. When `requestedRef` is null this is the branch that WAS read, and
   * saying so is the whole point: a silent default is invisible until a client
   * finds it.
   */
  defaultBranch: string | null;
  /** Why `rev` is what it is. Never blank — a missing revision is a fact to state. */
  revProvenance: string;
  /**
   * The single top-level folder an archive wrapped its contents in, when one
   * was lifted out of the way. Recorded because every path in the report is
   * one segment shorter than the path in the file the client sent, and a
   * reader comparing the two should be able to see why.
   */
  liftedWrapper?: string;
  acquiredAt: string;
}

export class AcquireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcquireError";
  }
}

/* ── Source classification ────────────────────────────────────────────────── */

/**
 * `.7z` is here because it is what a Windows shop's right-click menu makes;
 * `.tar.xz` and `.tar.bz2` because that is how a release tarball tends to
 * arrive. Refusing any of them as "not an archive" sends the client back to
 * re-export, which costs a day for a format `tar` already reads.
 */
const ARCHIVE_EXTENSIONS = [".zip", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tar", ".7z"];

export function isArchivePath(from: string): boolean {
  const lower = from.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * A bare `host/owner/repo` needs a scheme before `git clone` will take it.
 *
 * Three things must NOT be rewritten: a URL that already has a scheme, an SCP
 * form (`git@host:owner/repo`), and a local filesystem path. That last one is
 * not hypothetical — cloning a local mirror is how you re-acquire a tree whose
 * history was lost, which is the usual state of an exported codebase, and
 * prefixing it with `https://` turns an absolute path into a hostname lookup
 * for `var`.
 */
export function normaliseCloneUrl(from: string): string {
  // Case-insensitive, because a scheme typed as `HTTPS://` is still a scheme;
  // prefixing it again makes `https://HTTPS://user:token@...`, which git
  // rejects with the token quoted back in its own error.
  if (/^(https?|ssh|git|file):\/\//i.test(from)) return from;
  if (/^[^/]+@[^/]+:/.test(from)) return from;
  if (from.startsWith("/") || from.startsWith(".") || from.startsWith("~")) return from;
  return `https://${from}`;
}

/**
 * The URL with any credential removed: `https://user:token@host/x` becomes
 * `https://host/x`.
 *
 * A token in the clone URL is the ordinary way to give a one-off process
 * read access, and it is the one input here that must never travel further
 * than the `git clone` it was meant for. Left in, it lands in subject.json,
 * in the telemetry event Mission Control stores, in the error text an
 * operator pastes into a chat, and on the cover of the client's PDF. So the
 * raw URL goes to git and nowhere else; everything that describes the
 * acquisition sees this, and the clone's own .git/config is rewritten to it
 * (see `cloneRepository`).
 *
 * The whole userinfo goes, username included, and nothing stands in for it.
 * A placeholder would read as a value on a cover page, and the username
 * alone is not worth keeping when it is sometimes the token (GitHub accepts a
 * PAT as the user with no password).
 *
 * Two shapes carry a userinfo: `scheme://userinfo@host/...`, and the
 * scheme-less shorthand `userinfo@host/owner/repo` that `normaliseCloneUrl`
 * turns into a URL before git sees it. The shorthand is the one that was
 * missed: the operator types `user:token@git.example.com/acme/app`, git
 * clones it with the token, and the un-normalised input is what gets
 * recorded as the origin. So the decision of what is a URL is delegated to
 * `normaliseCloneUrl` rather than repeated here: whatever it would give a
 * scheme is a URL whose userinfo goes, and whatever it leaves alone (the SCP
 * form `git@host:owner/repo`, which names a user and carries no secret, and a
 * local path, which has no host) is left alone here too.
 */
export function redactUrl(url: string): string {
  const withScheme = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
  if (withScheme !== url) return withScheme;
  if (normaliseCloneUrl(url) === url) return url;
  return url.replace(/^[^/]*@/, "");
}

/* ── Archive safety ───────────────────────────────────────────────────────── */

/**
 * Entry names an archive must not contain (zip-slip).
 *
 * Checked from the LISTING, before anything is written, because the cheapest
 * moment to refuse a malicious archive is before it has touched the disk.
 * `verifyContained` below is the second line: it catches what a listing cannot
 * show, such as a symlink whose target escapes.
 */
export function unsafeArchiveEntries(entries: string[]): string[] {
  return entries.filter((entry) => {
    const name = entry.trim();
    if (name === "") return false;
    if (name.startsWith("/") || name.startsWith("\\")) return true;
    if (/^[a-zA-Z]:[\\/]/.test(name)) return true;

    const segments = name.split(/[\\/]/);
    return segments.includes("..");
  });
}

/** Every extracted path really sits inside `root`, symlinks resolved. */
function verifyContained(root: string): void {
  const realRoot = realpathSync(root);

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      let real: string;
      try {
        real = realpathSync(absolute);
      } catch {
        // A symlink pointing at nothing cannot leak anything; drop it and move on.
        rmSync(absolute, { force: true });
        continue;
      }

      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new AcquireError(
          `archive entry "${entry.name}" resolves outside the target directory; refusing`,
        );
      }
      if (entry.isDirectory()) visit(absolute);
    }
  };

  visit(realRoot);
}

/* ── The two acquisition paths ────────────────────────────────────────────── */

const RUN_OPTIONS = { timeout: ACQUIRE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 };

/**
 * The 7-Zip binary, by the names it ships under: `7z` from p7zip, `7zz` from
 * 7-Zip's own Linux and macOS builds. Neither is a dependency of this package
 * and the error for a missing one names what to install.
 */
const SEVEN_ZIP_BINARIES = ["7z", "7zz"];

type ArchiveFormat = "zip" | "tar" | "7z";

function archiveFormat(archive: string): ArchiveFormat {
  const lower = archive.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".7z")) return "7z";
  return "tar";
}

interface SpawnFailure {
  code?: number | string;
  stderr?: string;
  stdout?: string;
}

function spawnFailure(error: unknown): SpawnFailure {
  const e = error as SpawnFailure;
  return {
    code: e.code,
    stderr: typeof e.stderr === "string" ? e.stderr : "",
    stdout: typeof e.stdout === "string" ? e.stdout : "",
  };
}

/** Run 7-Zip under whichever name is installed, or say that none is. */
async function sevenZip(args: string[]): Promise<{ stdout: string }> {
  for (const binary of SEVEN_ZIP_BINARIES) {
    try {
      return await run(binary, args, RUN_OPTIONS);
    } catch (error) {
      if (spawnFailure(error).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new AcquireError(
    `this is a .7z archive and no 7-Zip binary (${SEVEN_ZIP_BINARIES.join(" or ")}) is on PATH. ` +
      `Install p7zip, or ask for the export as a .zip or .tar.gz. Nothing was written.`,
  );
}

async function listArchive(archive: string): Promise<string[]> {
  switch (archiveFormat(archive)) {
    case "zip": {
      const { stdout } = await run("unzip", ["-Z1", archive], RUN_OPTIONS);
      return stdout.split("\n").filter((line) => line.trim() !== "");
    }
    case "7z": {
      // `-slt` prints one `Path = ...` record per entry, which is the only 7z
      // listing that does not truncate or right-align names into columns.
      const { stdout } = await sevenZip(["l", "-slt", "-p", archive]);
      return parseSevenZipListing(stdout);
    }
    case "tar": {
      const { stdout } = await run("tar", ["-tf", archive], RUN_OPTIONS);
      return stdout.split("\n").filter((line) => line.trim() !== "");
    }
  }
}

/**
 * The entry names in a `7z l -slt` listing.
 *
 * The technical listing has two blocks of `Key = value` records: first the
 * archive's own (its `Path` is the archive file, which is an absolute path
 * on this machine), then, after a `----------` line, one block per entry.
 * Only the entries are wanted. Taking every `Path` would hand the archive's
 * own absolute path to the zip-slip check and refuse every .7z ever offered,
 * and the tests would not notice unless a 7-Zip binary was installed where
 * they ran. So the archive block is cut at the separator when there is one,
 * and a listing without the separator (as with `-ba`, which drops the
 * headers) is taken whole.
 */
export function parseSevenZipListing(stdout: string): string[] {
  const lines = stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  const separator = lines.indexOf("----------");
  const entries = separator === -1 ? lines : lines.slice(separator + 1);
  return entries
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length));
}

/**
 * Whether an extractor failed because the archive wants a password.
 *
 * Both extractors are run with an empty password supplied on the command
 * line, so neither ever asks for one: unzip opens /dev/tty for the prompt
 * even when stdin is closed, and under an operator's terminal it would sit
 * on that prompt until the ten-minute timeout and then be reported as a
 * corrupt file. Given the empty password, unzip writes "skipping: <entry>
 * incorrect password" to stderr for each encrypted entry and exits 82 when
 * nothing at all was extracted, or 1 when something was (a directory entry
 * is enough); 7-Zip says "Wrong password". The listing succeeded either way
 * (names are not encrypted), so nothing upstream saw it coming.
 *
 * The match is on the extractor's own phrasing, at the end of a line, per
 * format. unzip and 7-Zip both echo the entry's path in their error lines, so
 * a looser word like "encrypted" is matched by a corrupt archive that
 * happens to contain an `EncryptedVault.cs`, and the client is then asked
 * to re-export unencrypted for what was a transfer error.
 */
function isPasswordFailure(format: ArchiveFormat, failure: SpawnFailure): boolean {
  const text = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`;
  switch (format) {
    case "zip":
      return failure.code === 82 || /(unable to get|incorrect) password\s*$/im.test(text);
    case "7z":
      return /wrong password\??\s*(:.*)?$/im.test(text);
    case "tar":
      return false;
  }
}

function describeExtractFailure(archive: string, error: unknown): AcquireError {
  if (error instanceof AcquireError) return error;
  const failure = spawnFailure(error);
  const name = basename(archive);
  if (isPasswordFailure(archiveFormat(archive), failure)) {
    return new AcquireError(
      `${name} is password-protected and cannot be extracted without a terminal to ask on. ` +
        `Ask for an unencrypted export of the same code. Nothing was extracted.`,
    );
  }
  const tail = `${failure.stderr ?? ""}`.trim().split("\n").slice(-2).join(" ");
  return new AcquireError(
    `could not extract ${name}${tail ? `: ${tail}` : ""}. ` +
      `Check that the file is a complete, uncorrupted archive.`,
  );
}

async function extractArchive(archive: string, into: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await listArchive(archive);
  } catch (error) {
    throw describeExtractFailure(archive, error);
  }
  const unsafe = unsafeArchiveEntries(entries);
  if (unsafe.length > 0) {
    throw new AcquireError(
      `archive contains ${unsafe.length} unsafe path(s), first: "${unsafe[0]}"; refusing to extract`,
    );
  }

  mkdirSync(into, { recursive: true });
  try {
    switch (archiveFormat(archive)) {
      case "zip":
        // `-P ''` is not a guess at the password; it is what stops unzip
        // asking for one (see isPasswordFailure). Not `-q`: that also
        // silences the one warning that says an entry was skipped and why,
        // and with it gone a locked archive exits 1 with nothing to read.
        // The per-file progress on stdout is kept in memory and dropped.
        await run("unzip", ["-P", "", archive, "-d", into], RUN_OPTIONS);
        break;
      case "7z":
        // Bare `-p` is 7-Zip's empty password, for the same reason.
        await sevenZip(["x", "-y", "-p", `-o${into}`, archive]);
        break;
      case "tar":
        // One flag for gzip, xz and bzip2 alike: tar reads the magic bytes.
        await run("tar", ["-xf", archive, "-C", into], RUN_OPTIONS);
        break;
    }
  } catch (error) {
    throw describeExtractFailure(archive, error);
  }

  verifyContained(into);
  return liftSingleWrapperDirectory(into);
}

/**
 * What Finder adds to a zip and what the wrapper decision must see past.
 *
 * A right-click "Compress" on macOS writes `__MACOSX/` beside the folder and a
 * `.DS_Store` inside it. Counted, they make a one-folder archive look like a
 * two-entry one, the wrapper stays, and every path in the report gains a
 * segment that was never part of the codebase.
 */
const ARCHIVE_DEBRIS: ReadonlySet<string> = new Set(["__MACOSX", ".DS_Store"]);

/**
 * Archives usually wrap everything in one top-level folder. Left in place it
 * shifts every path in every finding by a segment that is an artefact of how
 * the file was made, not part of the codebase.
 *
 * Returns the name of the folder that was lifted, or nothing if there was no
 * single wrapper to lift.
 */
function liftSingleWrapperDirectory(root: string): string | undefined {
  const entries = readdirSync(root, { withFileTypes: true }).filter(
    (entry) => !ARCHIVE_DEBRIS.has(entry.name),
  );
  const [only] = entries;
  if (entries.length !== 1 || !only || !only.isDirectory()) return undefined;

  const wrapper = join(root, only.name);
  for (const child of readdirSync(wrapper)) {
    // Debris can sit at both levels; a rename onto an existing directory
    // fails, and the outer copy is worth nothing anyway.
    if (ARCHIVE_DEBRIS.has(child)) rmSync(join(root, child), { recursive: true, force: true });
    renameSync(join(wrapper, child), join(root, child));
  }
  rmSync(wrapper, { recursive: true, force: true });
  return only.name;
}

/**
 * Turn git's stderr into something an operator can act on.
 *
 * A missing credential is the single most likely way this fails — the host is
 * private, which is the whole reason we were granted read access — and it is
 * not a crash. Reporting it as a stack trace makes an ordinary setup step look
 * like a defect in the audit.
 */
/**
 * Bitbucket's two ways to fail with an identical message.
 *
 * Both of these produce a plain `Authentication failed` over git, which is why
 * naming them is worth the words at the exact moment someone is stuck.
 *
 * The username is the expensive one. An Atlassian account email authenticates
 * perfectly well against Bitbucket's REST API — `/2.0/repositories/...` returns
 * 200 — and is rejected by git. So every check short of an actual clone reports
 * a healthy credential, and the natural conclusion is that the token is bad
 * when the token is fine.
 *
 * Bitbucket app passwords, which this message used to recommend, no longer
 * exist; that settings page is a 404.
 */
function bitbucketCredentialHelp(): string {
  return (
    `On bitbucket.org an Atlassian API token needs two things that both fail this way: ` +
    `it must be created with Bitbucket SCOPES (the "Create API token with scopes" button, ` +
    `granting read:repository:bitbucket), and the git username must be ` +
    `"x-bitbucket-api-token-auth" rather than the account email; the email works against ` +
    `the REST API and is refused by git.`
  );
}

/** Advice for the host we were actually pointed at, and no other. */
function credentialHelpFor(url: string): string {
  if (/(^|[/@.])bitbucket\.org([/:]|$)/i.test(url)) return bitbucketCredentialHelp();
  return (
    `Configure a read credential for that host: a personal access token, or an SSH key ` +
    `with the git@ form of the URL.`
  );
}

export function describeCloneFailure(rawUrl: string, rawStderr: string): string {
  // The URL is the operator's, and the one place a token is expected to be;
  // git's stderr quotes the URL back, token and all, on a not-found. Both are
  // redacted here rather than by the caller so that no caller can forget.
  const url = redactUrl(rawUrl);
  const stderr = maskSecrets(rawStderr);
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(stderr)) {
    return (
      `cannot authenticate to ${url}. ` +
      `${credentialHelpFor(url)} ` +
      `Nothing was written.`
    );
  }
  if (/not found|does not exist|Repository not found/i.test(stderr)) {
    return `${url} not found, or the credential in use cannot see it. Nothing was written.`;
  }
  return `git clone failed for ${url}: ${stderr.trim().split("\n").slice(-2).join(" ")}`;
}

interface CloneResult {
  /** The commit the tree is actually at. */
  rev: string;
  /** The branch the remote serves by default, before any checkout. */
  defaultBranch: string | null;
}

/**
 * Clone, then move to the requested ref if one was named.
 *
 * A plain `git clone` fetches every branch and tag, so one `checkout` covers a
 * branch, a tag and any commit in history without a second network call and
 * without the server needing to allow fetch-by-SHA.
 *
 * The checkout failure is deliberately NOT a fallback to the default branch.
 * Silently reading something other than what was asked for is the failure this
 * whole flag exists to prevent, so an unresolvable ref stops the run.
 */
async function cloneRepository(from: string, into: string, ref?: string): Promise<CloneResult> {
  // The one line that may see a credential. Every message below uses `url`.
  const rawUrl = normaliseCloneUrl(from);
  const url = redactUrl(rawUrl);
  try {
    await run("git", ["clone", "--quiet", rawUrl, into], { timeout: ACQUIRE_TIMEOUT_MS });
  } catch (error) {
    throw new AcquireError(describeCloneFailure(rawUrl, spawnFailure(error).stderr ?? ""));
  }

  // git writes the URL it cloned, credential included, into the tree's own
  // .git/config, and the tree outlives this run in a directory the operator
  // chose. Nothing after the clone talks to the remote (the branches and
  // tags are already fetched, and a checkout of one is local), so the
  // remote is pointed at the redacted URL before anything else happens. The
  // model cannot read .git anyway; this is about what sits on the disk.
  if (url !== rawUrl) {
    try {
      await run("git", ["-C", into, "remote", "set-url", "origin", url], {
        timeout: ACQUIRE_TIMEOUT_MS,
      });
    } catch (error) {
      throw new AcquireError(
        `cloned ${url}, but could not replace the credentialed remote URL in its .git/config: ` +
          `${maskSecrets(spawnFailure(error).stderr ?? "").trim()}. ` +
          `The tree at ${into} still carries the credential; remove it before keeping the tree.`,
      );
    }
  }

  // Read before any checkout, so it records what the remote serves rather than
  // wherever we have just moved to.
  let defaultBranch: string | null = null;
  try {
    const head = await run("git", ["-C", into, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: ACQUIRE_TIMEOUT_MS,
    });
    defaultBranch = head.stdout.trim() || null;
  } catch {
    defaultBranch = null;
  }

  if (ref) {
    try {
      await run("git", ["-C", into, "checkout", "--quiet", ref], { timeout: ACQUIRE_TIMEOUT_MS });
    } catch {
      throw new AcquireError(
        `${url} was cloned, but the ref "${ref}" does not exist in it. ` +
          `Check the branch, tag or commit, or omit --ref to read the default branch` +
          (defaultBranch ? ` (${defaultBranch}).` : "."),
      );
    }
  }

  const { stdout } = await run("git", ["-C", into, "rev-parse", "HEAD"], {
    timeout: ACQUIRE_TIMEOUT_MS,
  });
  return { rev: stdout.trim(), defaultBranch };
}

/* ── Entry point ──────────────────────────────────────────────────────────── */

export interface AcquireOptions {
  /**
   * The branch, tag or commit to read. Omitted means the remote's default
   * branch, which is recorded rather than assumed.
   */
  ref?: string;
  /** A clone URL, `host/owner/repo`, or a path to a `.zip` / `.tar.gz`. */
  from: string;
  /** Where the tree lands. Must not already exist unless `replace` is set. */
  into: string;
  /** Replace an existing target rather than refusing. */
  replace?: boolean;
}

/**
 * Acquire a codebase and describe what was acquired.
 *
 * Refuses a target that already exists unless told to replace it: merging a new
 * tree over an old one produces a directory that matches no revision at all,
 * and every finding cited against it would be unreproducible.
 */
export async function acquire(options: AcquireOptions): Promise<Subject> {
  const into = resolve(options.into);
  prepareTarget(into, options.replace === true);

  const archive = isArchivePath(options.from);
  let rev: string | null = null;
  let defaultBranch: string | null = null;
  let revProvenance: string;
  let liftedWrapper: string | undefined;

  if (archive) {
    liftedWrapper = await extractArchive(resolve(options.from), into);
    revProvenance = "none: archive carries no history; re-acquire by clone for history signals";
    if (options.ref) {
      throw new AcquireError(
        `--ref ${options.ref} was given, but ${options.from} is an archive and carries no history. ` +
          `Acquire by clone to pin a ref.`,
      );
    }
  } else {
    const cloned = await cloneRepository(options.from, into, options.ref);
    rev = cloned.rev;
    defaultBranch = cloned.defaultBranch;
    // Which branch was read is part of the provenance, not a detail. An
    // unpinned acquire that stays silent about the default is how a review of a
    // dormant branch reads exactly like a review of the deployed one.
    revProvenance = options.ref
      ? `clone: full history available; pinned to the requested ref "${options.ref}"`
      : `clone: full history available; NO ref was requested, so the remote's default branch` +
        `${defaultBranch ? ` ("${defaultBranch}")` : ""} was read. Confirm it is the branch that deploys.`;
  }

  const files = walkTree(into);
  return {
    kind: archive ? "archive" : "clone",
    // Redacted here, at the source, so that nothing downstream has to know
    // a credential was ever in the URL: subject.json, the telemetry event,
    // the CLI summary and the report cover all print this field as-is.
    origin: redactUrl(options.from),
    name: basename(into),
    rev,
    requestedRef: options.ref ?? null,
    defaultBranch,
    revProvenance,
    ...(liftedWrapper !== undefined ? { liftedWrapper } : {}),
    acquiredAt: new Date().toISOString(),
    ...summariseTree(files),
  };
}

function prepareTarget(into: string, replace: boolean): void {
  let exists = true;
  try {
    statSync(into);
  } catch {
    exists = false;
  }

  if (!exists) return;
  if (!replace) {
    throw new AcquireError(
      `${into} already exists; pass replace to overwrite it. ` +
        `Merging a new tree over an old one produces a directory matching no revision.`,
    );
  }
  rmSync(into, { recursive: true, force: true });
}

/**
 * Where the subject file for a tree lives.
 *
 * Exported because every later stage has to find this file, and a stage that
 * re-derives the formula gets to drift from it. One function, one answer.
 */
export function subjectPathFor(treeDir: string): string {
  const dir = resolve(treeDir);
  return join(dir, "..", `${basename(dir)}.subject.json`);
}

/** Write the subject beside the tree. The audit's identity, on disk. */
export function writeSubject(into: string, subject: Subject): string {
  const path = subjectPathFor(into);
  writeFileSync(path, `${JSON.stringify(subject, null, 2)}\n`);
  return path;
}

/** A scratch directory for a caller that has not chosen one. */
export function scratchTarget(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "audit-")), name);
}
