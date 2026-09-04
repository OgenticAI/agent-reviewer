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

import { summariseTree, walkTree, type TreeSummary } from "./tree.js";

const run = promisify(execFile);

/** Long enough for a large clone, short enough that a hung process is not forever. */
const ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;

export type SourceKind = "clone" | "archive";

export interface Subject extends TreeSummary {
  kind: SourceKind;
  /** Exactly what the operator asked for, so a `-v3` repo is never reported as the live product. */
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
  acquiredAt: string;
}

export class AcquireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcquireError";
  }
}

/* ── Source classification ────────────────────────────────────────────────── */

const ARCHIVE_EXTENSIONS = [".zip", ".tar.gz", ".tgz", ".tar"];

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
  if (/^(https?|ssh|git|file):\/\//.test(from)) return from;
  if (/^[^/]+@[^/]+:/.test(from)) return from;
  if (from.startsWith("/") || from.startsWith(".") || from.startsWith("~")) return from;
  return `https://${from}`;
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
          `archive entry "${entry.name}" resolves outside the target directory — refusing`,
        );
      }
      if (entry.isDirectory()) visit(absolute);
    }
  };

  visit(realRoot);
}

/* ── The two acquisition paths ────────────────────────────────────────────── */

async function listArchive(archive: string): Promise<string[]> {
  const lower = archive.toLowerCase();
  const { stdout } = lower.endsWith(".zip")
    ? await run("unzip", ["-Z1", archive], { timeout: ACQUIRE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
    : await run("tar", ["-tf", archive], { timeout: ACQUIRE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

async function extractArchive(archive: string, into: string): Promise<void> {
  const entries = await listArchive(archive);
  const unsafe = unsafeArchiveEntries(entries);
  if (unsafe.length > 0) {
    throw new AcquireError(
      `archive contains ${unsafe.length} unsafe path(s), first: "${unsafe[0]}" — refusing to extract`,
    );
  }

  mkdirSync(into, { recursive: true });
  const lower = archive.toLowerCase();
  if (lower.endsWith(".zip")) {
    await run("unzip", ["-q", archive, "-d", into], { timeout: ACQUIRE_TIMEOUT_MS });
  } else {
    await run("tar", ["-xf", archive, "-C", into], { timeout: ACQUIRE_TIMEOUT_MS });
  }

  verifyContained(into);
  liftSingleWrapperDirectory(into);
}

/**
 * Archives usually wrap everything in one top-level folder. Left in place it
 * shifts every path in every finding by a segment that is an artefact of how
 * the file was made, not part of the codebase.
 */
function liftSingleWrapperDirectory(root: string): void {
  const entries = readdirSync(root, { withFileTypes: true });
  const [only] = entries;
  if (entries.length !== 1 || !only || !only.isDirectory()) return;

  const wrapper = join(root, only.name);
  for (const child of readdirSync(wrapper)) {
    renameSync(join(wrapper, child), join(root, child));
  }
  rmSync(wrapper, { recursive: true, force: true });
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
    `"x-bitbucket-api-token-auth" rather than the account email — the email works against ` +
    `the REST API and is refused by git.`
  );
}

/** Advice for the host we were actually pointed at, and no other. */
function credentialHelpFor(url: string): string {
  if (/(^|[/@.])bitbucket\.org([/:]|$)/i.test(url)) return bitbucketCredentialHelp();
  return (
    `Configure a read credential for that host — a personal access token, or an SSH key ` +
    `with the git@ form of the URL.`
  );
}

export function describeCloneFailure(url: string, stderr: string): string {
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
  const url = normaliseCloneUrl(from);
  try {
    await run("git", ["clone", "--quiet", url, into], { timeout: ACQUIRE_TIMEOUT_MS });
  } catch (error) {
    const stderr = typeof (error as { stderr?: string }).stderr === "string" ? (error as { stderr: string }).stderr : "";
    throw new AcquireError(describeCloneFailure(url, stderr));
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

  if (archive) {
    await extractArchive(resolve(options.from), into);
    revProvenance = "none — archive carries no history; re-acquire by clone for history signals";
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
      ? `clone — full history available; pinned to the requested ref "${options.ref}"`
      : `clone — full history available; NO ref was requested, so the remote's default branch` +
        `${defaultBranch ? ` ("${defaultBranch}")` : ""} was read. Confirm it is the branch that deploys.`;
  }

  const files = walkTree(into);
  return {
    kind: archive ? "archive" : "clone",
    origin: options.from,
    name: basename(into),
    rev,
    requestedRef: options.ref ?? null,
    defaultBranch,
    revProvenance,
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
      `${into} already exists — pass replace to overwrite it. ` +
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
