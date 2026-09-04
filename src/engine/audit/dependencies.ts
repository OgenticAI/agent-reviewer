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
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

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

const SKIP_DIRS = new Set([
  ".git", "node_modules", "bin", "obj", "dist", "build", "vendor",
  "packages", ".venv", "venv", "__pycache__", "target",
]);

/** Filenames that identify an ecosystem, and whether they pin the graph. */
const MANIFESTS: Array<{ match: (name: string) => boolean; ecosystem: Ecosystem; lock: boolean }> = [
  { match: (n) => n === "package-lock.json" || n === "npm-shrinkwrap.json", ecosystem: "npm", lock: true },
  { match: (n) => n === "package.json", ecosystem: "npm", lock: false },
  { match: (n) => n === "packages.lock.json", ecosystem: "nuget", lock: true },
  { match: (n) => n === "packages.config", ecosystem: "nuget", lock: false },
  { match: (n) => extname(n) === ".csproj" || extname(n) === ".fsproj" || extname(n) === ".vbproj", ecosystem: "nuget", lock: false },
  { match: (n) => n === "requirements.txt" || n === "pyproject.toml", ecosystem: "pypi", lock: false },
  { match: (n) => n === "poetry.lock", ecosystem: "pypi", lock: true },
  { match: (n) => n === "go.sum", ecosystem: "go", lock: true },
  { match: (n) => n === "go.mod", ecosystem: "go", lock: false },
  { match: (n) => n === "pom.xml" || n === "build.gradle" || n === "build.gradle.kts", ecosystem: "maven", lock: false },
];

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
    if (name === "package-lock.json" || name === "npm-shrinkwrap.json" || name === "packages.lock.json") {
      // Both shapes nest the resolved graph one level down; the keys are the
      // package identifiers either way.
      const json = JSON.parse(text) as Record<string, unknown>;
      const buckets = [json["packages"], json["dependencies"]].filter(
        (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
      );
      const names = new Set<string>();
      for (const bucket of buckets) {
        for (const key of Object.keys(bucket)) if (key) names.add(key.replace(/^node_modules\//, ""));
      }
      return [...names];
    }
  } catch {
    // A manifest we cannot parse is counted as present with nothing declared,
    // rather than crashing the walk. The manifest list still shows it.
    return [];
  }
  // XML and text formats, read with a regex on purpose: a full parser would be
  // a dependency added to count dependencies.
  const patterns = [
    /<PackageReference\s[^>]*Include\s*=\s*"([^"]+)"/gi, // .csproj / .fsproj / .vbproj
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
 * The sentence a skipped dependency scan should print.
 *
 * Names what was found and what could not be resolved, because "no npm
 * lockfile at the repository root" over a .NET tree reads as "there is nothing
 * here" when the truth is "nobody looked at 123 packages".
 */
export function describeUnscanned(found: EcosystemManifests[], scanned: Ecosystem[]): string | null {
  const missed = found.filter((f) => !scanned.includes(f.ecosystem) && f.packages > 0);
  if (missed.length === 0) return null;
  const parts = missed.map(
    (m) =>
      `${m.packages} ${m.ecosystem} package(s) across ${m.manifests.length} manifest(s)` +
      (m.lockfile ? "" : ", declared only and not lock-pinned"),
  );
  return `${parts.join("; ")}. No advisory source is available for ${missed
    .map((m) => m.ecosystem)
    .join(", ")} on this host, so these were NOT checked for known vulnerabilities`;
}
