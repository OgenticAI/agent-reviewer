/**
 * Ranking the repo map with personalized PageRank (OGE-1582).
 *
 * Aider's existence proof: no embeddings, no vector store, no extra LLM call —
 * a reference graph plus personalized PageRank plus a couple of hand-tuned
 * multipliers. A symbol defined in one file and referenced in many is central;
 * a file the diff touches, or that a checklist item names, is where the review
 * should look first. PageRank over the def→ref graph, personalized toward those
 * seeds, ranks every file accordingly.
 *
 * Deterministic by construction: fixed iteration count, no randomness, stable
 * tie-break on path. The same repo + same seeds always produce the same order,
 * which is what lets the prompt snapshot be pinned.
 */

import type { Tag } from "./tags.js";

/** Aider's damping factor. */
const DAMPING = 0.85;
/** Fixed iterations — plenty for convergence on repo-scale graphs, and stable. */
const ITERATIONS = 40;
/** Weight multiplier for an edge into a diff-touched or checklist-named file. */
const SEED_EDGE_MULTIPLIER = 4;

export interface RankedFile {
  path: string;
  score: number;
}

/**
 * Rank files by personalized PageRank over the symbol reference graph.
 *
 * An edge runs from a file that REFERENCES a symbol to the file(s) that DEFINE
 * it — references flow importance to definitions, so a widely-used definition
 * ranks high. Edges into a seed file are up-weighted (Aider's multiplier), and
 * the personalization vector concentrates the random-restart mass on the seeds.
 */
export function rankFiles(args: {
  tags: Tag[];
  /** Diff-touched files + files named by checklist identifiers. */
  seeds: string[];
}): RankedFile[] {
  const defsByName = new Map<string, Set<string>>();
  const files = new Set<string>();
  for (const tag of args.tags) {
    files.add(tag.path);
    if (tag.kind === "def") {
      if (!defsByName.has(tag.name)) defsByName.set(tag.name, new Set());
      defsByName.get(tag.name)!.add(tag.path);
    }
  }
  const fileList = [...files].sort();
  if (fileList.length === 0) return [];

  const seedSet = new Set(args.seeds.filter((s) => files.has(s)));

  // Weighted adjacency: refFile -> { defFile -> weight }.
  const edges = new Map<string, Map<string, number>>();
  const addEdge = (from: string, to: string, w: number) => {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Map());
    const inner = edges.get(from)!;
    inner.set(to, (inner.get(to) ?? 0) + w);
  };
  for (const tag of args.tags) {
    if (tag.kind !== "ref") continue;
    const defFiles = defsByName.get(tag.name);
    if (!defFiles) continue;
    for (const defFile of defFiles) {
      const w = seedSet.has(defFile) ? SEED_EDGE_MULTIPLIER : 1;
      addEdge(tag.path, defFile, w);
    }
  }

  // Personalization vector: mass on seeds, else uniform.
  const n = fileList.length;
  const personal = new Map<string, number>();
  if (seedSet.size > 0) {
    for (const f of fileList) personal.set(f, seedSet.has(f) ? 1 / seedSet.size : 0);
  } else {
    for (const f of fileList) personal.set(f, 1 / n);
  }

  // Power iteration.
  let rank = new Map<string, number>(fileList.map((f) => [f, 1 / n]));
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const next = new Map<string, number>(fileList.map((f) => [f, 0]));
    let dangling = 0;
    for (const f of fileList) {
      const outs = edges.get(f);
      const mass = rank.get(f)!;
      if (!outs || outs.size === 0) {
        dangling += mass;
        continue;
      }
      const total = [...outs.values()].reduce((a, b) => a + b, 0);
      for (const [to, w] of outs) {
        next.set(to, next.get(to)! + (mass * w) / total);
      }
    }
    // Redistribute teleport + dangling mass via the personalization vector.
    for (const f of fileList) {
      const teleport = (1 - DAMPING) * personal.get(f)! + DAMPING * dangling * personal.get(f)!;
      next.set(f, DAMPING * next.get(f)! + teleport);
    }
    rank = next;
  }

  return fileList
    .map((path) => ({ path, score: rank.get(path)! }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Identifiers lexically extracted from checklist item text (OGE-1582).
 *
 * Aider's `\W+` split with a ≥5-char stem filter. Matched against the file
 * index to seed the personalization vector, so a claim naming `redactCategory`
 * boosts the file that defines it before any tool call is spent.
 */
export function checklistIdentifiers(checklistTexts: string[]): string[] {
  const out = new Set<string>();
  for (const text of checklistTexts) {
    for (const token of text.split(/\W+/)) {
      if (token.length >= 5) out.add(token);
    }
  }
  return [...out];
}

/** Files whose path or a defined symbol matches a checklist identifier. */
export function filesMatchingIdentifiers(tags: Tag[], identifiers: string[]): string[] {
  const idset = identifiers.map((s) => s.toLowerCase());
  const matched = new Set<string>();
  for (const tag of tags) {
    const hay = `${tag.path} ${tag.name}`.toLowerCase();
    if (idset.some((id) => hay.includes(id))) matched.add(tag.path);
  }
  return [...matched];
}
