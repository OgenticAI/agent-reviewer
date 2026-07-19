/**
 * Incremental review — carry verdicts forward across pushes (OGE-1590).
 *
 * The replay cache keys on `headSha`, so every push re-reviews the whole diff
 * against the whole checklist. That is slow and expensive, but the real cost is
 * trust: an item that was PASS yesterday can flip on an unrelated push, and an
 * author reads that as noise. If the code behind a verdict didn't change, the
 * verdict shouldn't either.
 *
 * The state lives entirely in the sticky-comment JSON sidecar — CodeRabbit
 * independently confirmed this "all state in the PR, none server-side" design,
 * so there's no backend to build. On a new push we compute the delta from the
 * highest previously-reviewed SHA to head and re-verify only the items it
 * touches (plus every FAIL); the rest carry forward, annotated "verified at
 * <sha>".
 *
 * ── Which items must re-verify ──────────────────────────────────────────────
 *
 * - **FAIL, always.** A FAIL is an open defect; carrying it forward unexamined
 *   would let a fix land silently unrecognized. Cheap insurance.
 * - **Any item whose evidence files intersect the push-delta.** The code it was
 *   judged against moved, so the judgment might too.
 * - Everything else carries forward. Its evidence didn't change, so re-judging
 *   it only risks churn.
 */

import type { ItemVerdict, ReviewVerdict } from "../schema/verdict.js";

/** Files an item was judged against — explicit if stored, else from evidenceRefs. */
export function evidenceFilesOf(item: ItemVerdict): string[] {
  if (item.evidenceFiles && item.evidenceFiles.length > 0) return item.evidenceFiles;
  const fromRefs = (item.evidenceRefs ?? [])
    .map((r) => (r as { path?: string }).path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return Array.from(new Set(fromRefs));
}

/** The highest (most recent) SHA a previous verdict was reviewed against. */
export function highestReviewedSha(previous: ReviewVerdict): string | null {
  const shas = previous.reviewedShas ?? [];
  return shas.length > 0 ? shas[shas.length - 1]! : previous.headSha;
}

/** Loose path match tolerating repo-root/rename differences, like the outcomes module. */
function pathTouched(evidenceFile: string, changed: Set<string>): boolean {
  if (changed.has(evidenceFile)) return true;
  for (const c of changed) {
    if (c.endsWith(`/${evidenceFile}`) || evidenceFile.endsWith(`/${c}`)) return true;
  }
  return false;
}

export interface SelectionResult {
  /** Item ids that must be re-verified this run. */
  reverify: Set<number>;
  /** Item ids that can carry forward unchanged. */
  carryForward: Set<number>;
}

/**
 * Decide, per item, re-verify vs carry-forward.
 *
 * `changedPaths` is the push-delta (highest reviewed SHA → head). An item with
 * no evidence files is always re-verified — we can't prove its code is
 * unchanged, so the safe default is to look again.
 */
export function selectItems(args: {
  previousItems: ItemVerdict[];
  currentItemIds: number[];
  changedPaths: string[];
}): SelectionResult {
  const changed = new Set(args.changedPaths);
  const prevById = new Map(args.previousItems.map((it) => [it.id, it]));
  const reverify = new Set<number>();
  const carryForward = new Set<number>();

  for (const id of args.currentItemIds) {
    const prev = prevById.get(id);
    // No prior verdict for this id (new or renumbered item) → must verify.
    if (!prev) {
      reverify.add(id);
      continue;
    }
    // Open defects always get another look.
    if (prev.status === "FAIL") {
      reverify.add(id);
      continue;
    }
    const files = evidenceFilesOf(prev);
    // No evidence files means we can't prove the code is untouched.
    if (files.length === 0) {
      reverify.add(id);
      continue;
    }
    if (files.some((f) => pathTouched(f, changed))) {
      reverify.add(id);
    } else {
      carryForward.add(id);
    }
  }
  return { reverify, carryForward };
}

/**
 * Merge a freshly-produced verdict with carried-forward items from the previous
 * one.
 *
 * For every carry-forward id, the PREVIOUS item wins — annotated with the SHA it
 * was verified at and its denormalized evidence files, so the next push can make
 * the same decision. This is the anti-churn guarantee: an untouched item shows
 * the exact same verdict it did last push, not whatever the model happened to
 * say this time.
 */
export function mergeCarriedForward(args: {
  fresh: ReviewVerdict;
  previous: ReviewVerdict;
  selection: SelectionResult;
}): ItemVerdict[] {
  const prevById = new Map(args.previous.items.map((it) => [it.id, it]));
  const verifiedSha = highestReviewedSha(args.previous) ?? args.previous.headSha;

  return args.fresh.items.map((item) => {
    if (!args.selection.carryForward.has(item.id)) return item;
    const prev = prevById.get(item.id);
    if (!prev) return item; // defensive: nothing to carry
    return {
      ...prev,
      evidenceFiles: evidenceFilesOf(prev),
      verifiedAtSha: prev.verifiedAtSha ?? verifiedSha,
    };
  });
}

/** Append `headSha` to the reviewed-SHA history, de-duplicated, capped. */
export function appendReviewedSha(
  previous: ReviewVerdict | null,
  headSha: string,
  cap = 20,
): string[] {
  const prior = previous?.reviewedShas ?? (previous ? [previous.headSha] : []);
  const next = prior.includes(headSha) ? prior : [...prior, headSha];
  return next.slice(-cap);
}
