/**
 * What a tree declares it depends on, per ecosystem.
 *
 * This exists because `npm audit` answers for exactly one ecosystem, and the
 * skip it produced elsewhere said "no npm lockfile at the repository root" — a
 * true sentence that told a reader of a .NET codebase nothing about the 123
 * NuGet packages nobody had looked at. A skip is only honest when it says what
 * went unexamined, and that requires counting it first.
 *
 * Deliberately parsing, not resolving. Direct dependencies are declared in the
 * manifest and can be counted from source. Transitive ones are decided by a
 * resolver against a registry, so a count taken here is a FLOOR, and every
 * caller is expected to say so rather than present it as a total.
 *
 * ── A floor that was wrong in both directions ───────────────────────────────
 *
 * The first version undercounted and overcounted at once. It parsed NuGet's
 * `packages.lock.json` through the npm branch and yielded the target framework
 * monikers (`net8.0`) as if they were packages; it skipped every directory
 * named `packages/`, which is the most common monorepo layout; and it did not
 * know `pnpm-lock.yaml` or `yarn.lock`, so a pnpm tree read as "not
 * lock-pinned". Each is a separate branch below, and each has a test that
 * asserts package names rather than whatever the parser happened to return.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export type Ecosystem = "npm" | "nuget" | "pypi" | "go" | "maven";

export interface EcosystemManifests {
  ecosystem: Ecosystem;
  /** Repo-relative manifest paths, sorted. */
  manifests: string[];
  /** Distinct package names declared across those manifests. */
  packages: number;
  /**
   * Whether a lockfile pins the resolved graph. Without one the package count
   * covers declared dependencies only.
   */
  lockfile: boolean;
}

/**
 * Directories never walked for manifests.
 *
 * Only vendored and generated trees: a manifest under `node_modules/` belongs
 * to someone else's package. `packages/` is deliberately NOT here. It is where
 * a pnpm, yarn or Nx monorepo keeps its own workspaces, and skipping it read a
 * multi-package repository as declaring nothing at all.
 */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "bin", "obj", "dist", "build", "vendor",
  ".venv", "venv", "__pycache__", "target",
]);

/** The npm-registry lockfiles `npm audit` can read. The others are pnpm's and yarn's. */
export const NPM_AUDIT_LOCKFILES: readonly string[] = ["package-lock.json", "npm-shrinkwrap.json"];

/** Filenames that identify an ecosystem, and whether they pin the graph. */
const MANIFESTS: Array<{ match: (name: string) => boolean; ecosystem: Ecosystem; lock: boolean }> = [
  { match: (n) => NPM_AUDIT_LOCKFILES.includes(n), ecosystem: "npm", lock: true },
  { match: (n) => n === "pnpm-lock.yaml" || n === "yarn.lock", ecosystem: "npm", lock: true },
  { match: (n) => n === "package.json", ecosystem: "npm", lock: false },
  { match: (n) => n === "packages.lock.json", ecosystem: "nuget", lock: true },
  { match: (n) => n === "packages.config", ecosystem: "nuget", lock: false },
  // Central package management: one file names the version for every project.
  { match: (n) => n === "Directory.Packages.props", ecosystem: "nuget", lock: false },
  { match: (n) => extname(n) === ".csproj" || extname(n) === ".fsproj" || extname(n) === ".vbproj", ecosystem: "nuget", lock: false },
  { match: (n) => n === "requirements.txt" || n === "pyproject.toml", ecosystem: "pypi", lock: false },
  { match: (n) => n === "poetry.lock", ecosystem: "pypi", lock: true },
  { match: (n) => n === "go.sum", ecosystem: "go", lock: true },
  { match: (n) => n === "go.mod", ecosystem: "go", lock: false },
  { match: (n) => n === "pom.xml" || n === "build.gradle" || n === "build.gradle.kts", ecosystem: "maven", lock: false },
];

/**
 * The package name in a lockfile key such as `@scope/name@1.2.3`,
 * `/name@1.2.3`, `name@npm:^1.0.0` or pnpm v5's `/name/1.2.3`.
 *
 * A scoped name carries its own leading `@`, so the version separator is the
 * first `@` after position zero. pnpm v5 used `/` instead, which is why a
 * bare `/name/1.2.3` falls back to the segment before the version-shaped tail.
 */
function packageNameOfKey(key: string): string | null {
  const bare = key.trim().replace(/^['"]|['"]$/g, "").replace(/^\//, "");
  if (!bare || bare.startsWith("__")) return null;
  const at = bare.indexOf("@", 1);
  if (at > 0) return bare.slice(0, at);
  const versionTail = bare.match(/^(.+?)\/\d[^/]*$/);
  return versionTail?.[1] ?? bare;
}

function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value as object) : [];
}

/** pnpm-lock.yaml, every version: workspace importers plus the resolved package keys. */
function pnpmPackages(text: string): string[] {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (typeof doc !== "object" || doc === null) return [];
  const names = new Set<string>();
  const declared = (block: unknown) => {
    for (const name of keysOf((block as { dependencies?: unknown })?.dependencies)) names.add(name);
    for (const name of keysOf((block as { devDependencies?: unknown })?.devDependencies)) names.add(name);
  };
  declared(doc);
  for (const importer of Object.values((doc["importers"] as Record<string, unknown> | undefined) ?? {})) declared(importer);
  for (const bucket of [doc["packages"], doc["snapshots"]]) {
    for (const key of keysOf(bucket)) {
      const name = packageNameOfKey(key);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** yarn.lock, classic and berry: every entry header is a comma-separated list of descriptors. */
function yarnPackages(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    // Entry headers sit at column zero and end with a colon; everything else
    // in the file is indented.
    if (!/^\S/.test(line) || !line.trimEnd().endsWith(":") || line.startsWith("#")) continue;
    for (const descriptor of line.trimEnd().slice(0, -1).split(",")) {
      const name = packageNameOfKey(descriptor);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Package names declared by one manifest. Names only; versions are not resolved here. */
export function declaredPackages(path: string, text: string): string[] {
  const name = basename(path);
  try {
    if (name === "package.json") {
      const json = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      return [
        ...Object.keys(json["dependencies"] ?? {}),
        ...Object.keys(json["devDependencies"] ?? {}),
      ];
    }
    if (NPM_AUDIT_LOCKFILES.includes(name)) {
      // v1 nests under `dependencies`, v2+ under `packages` keyed by path.
      const json = JSON.parse(text) as Record<string, unknown>;
      const buckets = [json["packages"], json["dependencies"]].filter(
        (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
      );
      const names = new Set<string>();
      for (const bucket of buckets) {
        for (const key of Object.keys(bucket)) if (key) names.add(key.replace(/^.*node_modules\//, ""));
      }
      return [...names];
    }
    if (name === "packages.lock.json") {
      // NuGet: `dependencies` is keyed by target framework, and the packages
      // sit one level below that. Reading the top level yields `net8.0`.
      const json = JSON.parse(text) as { dependencies?: Record<string, unknown> };
      const names = new Set<string>();
      for (const framework of Object.values(json.dependencies ?? {})) {
        for (const pkg of keysOf(framework)) names.add(pkg);
      }
      return [...names];
    }
    if (name === "pnpm-lock.yaml") return pnpmPackages(text);
    if (name === "yarn.lock") return yarnPackages(text);
  } catch {
    // A manifest we cannot parse is counted as present with nothing declared,
    // rather than crashing the walk. The manifest list still shows it.
    return [];
  }
  // XML and text formats, read with a regex on purpose: a full parser would be
  // a dependency added to count dependencies.
  const patterns = [
    /<PackageReference\s[^>]*Include\s*=\s*"([^"]+)"/gi, // .csproj / .fsproj / .vbproj
    /<PackageVersion\s[^>]*Include\s*=\s*"([^"]+)"/gi, //   Directory.Packages.props
    /<package\s[^>]*id\s*=\s*"([^"]+)"/gi, //               packages.config
    /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/gi, //       pom.xml
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) if (m[1]) found.add(m[1]);
  }
  if (found.size > 0) return [...found];

  if (name === "requirements.txt") {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
      .map((line) => (line.split(/[<>=!~[;]/)[0] ?? "").trim())
      .filter(Boolean);
  }
  if (name === "go.mod") {
    return [...text.matchAll(/^\s+([\w.\-/]+\.[\w.\-/]+)\s+v/gm)].map((m) => m[1] ?? "").filter(Boolean);
  }
  return [];
}

/**
 * Every dependency ecosystem the tree declares, with a floor on package counts.
 *
 * Sorted by package count so the caller can name the largest unscanned
 * ecosystem first, which is the one a reader will ask about.
 */
export function scanDependencyManifests(root: string, maxDepth = 8): EcosystemManifests[] {
  const byEcosystem = new Map<Ecosystem, { manifests: Set<string>; packages: Set<string>; lock: boolean }>();

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(entry) && !entry.startsWith(".")) walk(full, relPath, depth + 1);
        continue;
      }
      const spec = MANIFESTS.find((m) => m.match(entry));
      if (!spec) continue;
      const bucket = byEcosystem.get(spec.ecosystem) ?? {
        manifests: new Set<string>(),
        packages: new Set<string>(),
        lock: false,
      };
      bucket.manifests.add(relPath);
      if (spec.lock) bucket.lock = true;
      try {
        for (const pkg of declaredPackages(relPath, readFileSync(full, "utf8"))) bucket.packages.add(pkg);
      } catch {
        // Unreadable manifest: still counted as present.
      }
      byEcosystem.set(spec.ecosystem, bucket);
    }
  };

  walk(root, "", 0);

  return [...byEcosystem]
    .map(([ecosystem, b]) => ({
      ecosystem,
      manifests: [...b.manifests].sort(),
      packages: b.packages.size,
      lockfile: b.lock,
    }))
    .sort((a, b) => b.packages - a.packages);
}

/**
 * The directories `npm audit` has a lockfile to read in, repo-relative and
 * sorted; `""` is the root. One audit per directory, because `npm audit
 * --prefix root` resolves the root lockfile only, and a `client/` app with
 * its own `package-lock.json` was never audited at all.
 */
export function npmLockfileDirs(root: string): string[] {
  const npm = scanDependencyManifests(root).find((f) => f.ecosystem === "npm");
  const dirs = new Set<string>();
  for (const manifest of npm?.manifests ?? []) {
    if (!NPM_AUDIT_LOCKFILES.includes(basename(manifest))) continue;
    const slash = manifest.lastIndexOf("/");
    dirs.add(slash === -1 ? "" : manifest.slice(0, slash));
  }
  return [...dirs].sort();
}

/**
 * The sentence a skipped dependency scan should print.
 *
 * Names what was found and what could not be resolved, because "no npm
 * lockfile at the repository root" over a .NET tree reads as "there is nothing
 * here" when the truth is "nobody looked at 123 packages".
 *
 * Two different reasons hide behind an unscanned ecosystem, and the sentence
 * separates them. npm packages go unscanned because `npm audit` needs a
 * package-lock.json or npm-shrinkwrap.json and found none; that is a missing
 * lockfile, and blaming a missing advisory source for it when npm is installed
 * sends the reader to install a tool they already have. Every other ecosystem
 * goes unscanned because nothing on this host can look it up.
 */
export function describeUnscanned(found: EcosystemManifests[], scanned: Ecosystem[]): string | null {
  const missed = found.filter((f) => !scanned.includes(f.ecosystem) && f.packages > 0);
  if (missed.length === 0) return null;
  const parts = missed.map(
    (m) =>
      `${m.packages} ${m.ecosystem} package(s) across ${m.manifests.length} manifest(s)` +
      (m.lockfile ? "" : ", declared only and not lock-pinned"),
  );

  const causes: string[] = [];
  const npm = missed.find((m) => m.ecosystem === "npm");
  if (npm) {
    const otherLock = npm.manifests.some((m) => ["pnpm-lock.yaml", "yarn.lock"].includes(basename(m)));
    causes.push(
      "npm audit needs a package-lock.json or npm-shrinkwrap.json to resolve the graph and found none" +
        (otherLock ? " (the pnpm or yarn lockfile present is not one it reads)" : ""),
    );
  }
  const others = missed.filter((m) => m.ecosystem !== "npm").map((m) => m.ecosystem);
  if (others.length > 0) causes.push(`no advisory source is available for ${others.join(", ")} on this host`);

  return `${parts.join("; ")}. ${causes.join("; ")}, so these were NOT checked for known vulnerabilities`;
}
