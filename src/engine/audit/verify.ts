/**
 * Adversarial verification (OGE-2430).
 *
 * The load-bearing stage, and the one thing here a competitor cannot copy by
 * buying a tool. Every claim from the investigate stage is handed to independent
 * verifiers instructed to REFUTE it, and confidence is derived from what
 * happened — never from what the model said about its own certainty.
 *
 * ── Why not simply ask the model how sure it is ─────────────────────────────
 *
 * Because a self-reported score is a vibe. A study of 31,073 review comment /
 * feedback pairs across 239 repositories found 56.3% of AI review comments
 * rejected, and separately 26–55% of *correct* findings were shown to rest on
 * flawed reasoning — the answer right, the reason wrong. A non-technical reader
 * cannot tell those apart, and neither can a model scoring itself. A refutation
 * stage can.
 *
 * The positive evidence points the same way: DARPA's AIxCC winner reported
 * 0.9999 patch accuracy for a proof-validated approach against 44.4% for
 * static-analysis-only, and curl closed its bug bounty in January 2026 after the
 * confirmed rate fell below 5% — while explicitly exempting pull requests,
 * because there they had tools and tests to verify contributions automatically.
 * Unverifiable claims are the problem. Verification is the answer.
 *
 * ── The first gate needs no model at all ────────────────────────────────────
 *
 * A claim citing a quote at a line is checkable by reading that line. If the
 * text is not there, the citation is fabricated and no amount of model opinion
 * should rescue it. `checkAnchors` does that deterministically, before a single
 * verifier is spawned — which also means the cheapest refutation is free.
 */

import type { Claim } from "./investigate.js";
import type { Confidence, DroppedCitation, EvidenceRef } from "./finding.js";
import { sanitizeUntrusted } from "../tools/sanitize.js";

/** Minimum independent verifiers before `verified` may be claimed. */
export const MIN_VERIFIERS = 2;

/** Minimum alternative vocabularies before an absence claim may stand. */
export const MIN_VOCABULARIES = 3;

export type Outcome = "refuted" | "not-refuted" | "cannot-determine";

export interface VerifierVerdict {
  /** Which independent run. Verifiers do not see each other's verdicts. */
  verifier: number;
  outcome: Outcome;
  reason: string;
  /**
   * Set when the verifier could not settle the claim because the answer lives
   * outside the repository. Feeds the closure path in OGE-2431.
   */
  needsAccess?: string;
  /** Vocabularies searched, for an absence claim. */
  vocabulariesTried?: string[];
}

export interface VerifiedClaim {
  claim: Claim;
  verdicts: VerifierVerdict[];
  /** Computed here, from the verdicts. Never taken from the claim. */
  confidence: Confidence;
  verifiers: number;
  refutations: number;
  /** Present when at least one verifier named access it lacked. */
  needsAccess?: string;
  /** Distinct vocabularies searched across verifiers, for an absence claim. */
  vocabulariesTried: string[];
  /**
   * Present when the citation check dropped a quoted citation the claim gave.
   * The claim stands on what held; this is the record of what did not, and it
   * is what caps the claim at `inferred` and reaches the finding as `dropped`.
   */
  dropped?: DroppedCitation[];
}

/**
 * Why a claim was thrown away, as a code the run can count.
 *
 * One run rejected 54 of 75 claims and every one carried the same code, so
 * the count said "54 fabricated" when the tree said otherwise: some cited a
 * line past the end of the file, some named a file that was not there, and
 * most cited a real quote at the wrong line. Those are three different
 * failures of the investigation, and a reader deciding whether to trust the
 * remaining 21 needs to know which one they are looking at.
 */
export type RejectionCode = CitationCode | "refuted";

/**
 * Why one quoted citation was not kept. A claim is rejected under the code of
 * its first failed citation when nothing it cites holds; a claim that keeps
 * something drops the failed citation under the same code, and the run counts
 * those apart, because a dropped invention is still an invention.
 */
export type CitationCode = AnchorProblem["reason"];

/** Every citation code, in the order the summary line prints them. */
export const CITATION_CODES: readonly CitationCode[] = [
  "quote-absent",
  "quote-ambiguous",
  "line-beyond-eof",
  "file-unreadable",
  "not-a-line-reference",
];

/** Every rejection code, in the order the summary line prints them. */
export const REJECTION_CODES: readonly RejectionCode[] = [
  ...CITATION_CODES,
  "refuted",
];

export interface RejectedClaim {
  claim: Claim;
  code: RejectionCode;
  reason: string;
  verdicts: VerifierVerdict[];
}

export interface VerificationResult {
  verified: VerifiedClaim[];
  rejected: RejectedClaim[];
}

/* ── Gate one: the citation is real ───────────────────────────────────────── */

/** Reads one line of a file from the acquired tree. `null` if it cannot. */
export type LineReader = (path: string, line: number) => string | null;

/**
 * What a cited path actually is in the acquired tree.
 *
 * `LineReader` returns `null` for a directory and for a file that is not there,
 * which are different mistakes: one is a model citing a real thing at the wrong
 * granularity, the other is a fabrication. Without this the first was reported
 * as an unreadable file and sent an operator looking for a reading failure that
 * never happened (OGE-2514).
 *
 * Optional, so a caller with nothing but a line reader still works. Such a
 * caller gets `file-unreadable` for a directory, which is what it always got.
 */
export type PathKind = (path: string) => "file" | "directory" | "missing";

/**
 * What became of one quoted citation.
 *
 * - `holds`             the quote is within `ANCHOR_WINDOW` of the cited line.
 * - `line-drift`        the quote is in the file, but not near the cited line.
 *                       Real evidence at a wrong address: corrected, and the
 *                       claim capped at `inferred`.
 * - `quote-absent`      the file is real and the quote is nowhere in it.
 * - `quote-ambiguous`   the quote is at more than one line of the file and
 *                       none of them is near the cited line. Real text, but
 *                       no address: the gate cannot say which one the claim
 *                       meant, and guessing the nearest moved a claim about
 *                       one function onto a `return null;` in another.
 * - `line-beyond-eof`   the cited line is past the end of the file and the
 *                       quote is nowhere in it. A drift whose cited line was
 *                       past the end is still `line-drift`, flagged.
 * - `file-unreadable`   the file could not be read at all.
 * - `not-a-line-reference` a directory, or `:0`.
 *
 * The first two keep the citation. Everything else was one code before this,
 * and the one code was thrown away whole: measured on a real run, 54 of 63
 * rejected citations pointed inside the file at a line where the quote was
 * not, and nothing could tell them from the 9 that named a line past the end
 * or a file that did not exist. The 54 are salvageable evidence.
 */
export type AnchorOutcome =
  | "holds"
  | "line-drift"
  | "quote-absent"
  | "quote-ambiguous"
  | "line-beyond-eof"
  | "file-unreadable"
  | "not-a-line-reference";

export interface AnchorProblem {
  ref: EvidenceRef;
  reason: Exclude<AnchorOutcome, "holds" | "line-drift">;
  /** For `quote-ambiguous`: how many lines of the file carry the quote. */
  occurrences?: number;
}

/** A citation moved to where its quote actually is, outside the window. */
export interface AnchorCorrection {
  ref: EvidenceRef;
  citedLine: number;
  foundLine: number;
  /** Lines between the two, always positive. */
  distance: number;
  /** The cited line was past the end of the file. */
  beyondEof: boolean;
}

export interface AnchorReport {
  problems: AnchorProblem[];
  corrected: AnchorCorrection[];
  /** Quoted citations that held or drifted: what the claim still stands on. */
  held: EvidenceRef[];
}

/**
 * How far either side of the cited line the quote is looked for.
 *
 * The gate used to read exactly one line, which rejected two ordinary and
 * honest things: a quote spanning a multi-line construct, and a line number one
 * out. Measured over 4,000 sampled lines of a real subject, a two-line quote at
 * its own correct line passed 32.7% of the time and a single-line quote one line
 * out passed 0.9% — while a fabricated quote passes this window 0.0% of the
 * time. The two failure modes are separable, and only one of them was ever the
 * point (OGE-2514).
 *
 * Three lines, not more: far enough for a signature, an object literal or a
 * short `if` block, near enough that a correction still points at the construct
 * the model meant.
 */
export const ANCHOR_WINDOW = 3;

/**
 * Fraction of a quote's distinctive words that must appear at the cited line.
 *
 * Not an exact substring match, deliberately. A model re-typing a line drops a
 * quote mark, closes a bracket early, or trims a trailing argument, and none of
 * that is dishonesty. Exact matching would reject those as fabrications — and a
 * false rejection here DROPS A REAL FINDING, which is a worse outcome than
 * passing a doubtful citation to verifiers who will read the file themselves.
 *
 * So this gate is deliberately conservative about rejecting: it fires when the
 * quoted text is substantially not there, which is what a fabricated citation
 * looks like.
 */
export const ANCHOR_MATCH_THRESHOLD = 0.8;

/** Words worth matching on. One- and two-character tokens carry no signal. */
function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

/**
 * Check every quoted citation against the file it names.
 *
 * What this catches is a quote whose text is substantially not at the line it
 * claims — a fabricated citation, which is the failure mode that makes a
 * confident wrong finding indistinguishable from a right one. It costs nothing
 * and runs before a single verifier is spawned.
 *
 * Refs with no quote are not checked here: a path-and-line reference is a
 * pointer, not an assertion about content, and the verifiers judge it.
 *
 * CHECKS AND CORRECTS. Where the quote is found within `ANCHOR_WINDOW` lines of
 * the line claimed, `ref.line` is rewritten to where it actually is, so the
 * report cites the truth rather than the model's arithmetic. Where it is found
 * at exactly one other line of the file, `ref.line` is rewritten the same way
 * and the ref is marked `corrected`, which is what caps the claim at
 * `inferred`. Where it is found at several, nothing is rewritten: the check
 * cannot say which one the claim meant, and the citation fails as ambiguous.
 * The claim is mutated in place; nothing else about it is touched.
 *
 * The problems alone, for callers that only ask whether the claim may pass;
 * `anchorClaim` is the same check with the corrections and the survivors.
 */
export function checkAnchors(
  claim: Claim,
  readLine: LineReader,
  pathKind?: PathKind,
): AnchorProblem[] {
  return anchorClaim(claim, readLine, pathKind).problems;
}

export function anchorClaim(
  claim: Claim,
  readLine: LineReader,
  pathKind?: PathKind,
): AnchorReport {
  const problems: AnchorProblem[] = [];
  const corrected: AnchorCorrection[] = [];
  const held: EvidenceRef[] = [];

  for (const ref of claim.evidence) {
    if (!ref.quote || ref.line === undefined) continue;

    // `:0`, which is what a model writes when it means "this path". It asserts
    // nothing about a line, so the line gate has nothing to judge.
    if (ref.line < 1) {
      problems.push({ ref, reason: "not-a-line-reference" });
      continue;
    }

    // A directory cited at a real-looking line is the same mistake wearing a
    // different number, and it is the commoner shape: 2 of the 124 citation
    // problems in run 4df552c1 were a directory at a positive line, against 0
    // at `:0`. Checking the path first means the number it was given does not
    // decide which mistake it gets called.
    if (pathKind?.(ref.path) === "directory") {
      problems.push({ ref, reason: "not-a-line-reference" });
      continue;
    }

    const found = locateQuote(ref.quote, ref.path, ref.line, readLine);
    if (found.kind === "holds") {
      // Found, but not where the claim said. Correcting it here is the point:
      // accepting it silently would leave the report pointing a reader at a
      // line that does not contain the quoted text, which is the same
      // disappointment as a fabricated citation even though the evidence is
      // real.
      if (found.line !== ref.line) ref.line = found.line;
      held.push(ref);
      continue;
    }
    if (found.kind === "line-drift") {
      // Corrected, and MARKED. The window correction above is a slip of one or
      // two in a line number read from the file; this is a quote the claim
      // placed forty lines away or past the end of the file, which is a line
      // number recalled rather than read. The evidence is real, so it is kept;
      // the claim's author did not read it there, so `verified` is off the
      // table for it. The marker is what carries that to the finding.
      corrected.push({
        ref,
        citedLine: ref.line,
        foundLine: found.line,
        distance: Math.abs(found.line - ref.line),
        beyondEof: found.beyondEof,
      });
      ref.corrected = { citedLine: ref.line, beyondEof: found.beyondEof };
      ref.line = found.line;
      held.push(ref);
      continue;
    }
    if (found.kind === "quote-ambiguous") {
      problems.push({ ref, reason: found.kind, occurrences: found.occurrences });
      continue;
    }
    problems.push({ ref, reason: found.kind });
  }

  return { problems, corrected, held };
}

/**
 * How many lines of a file the whole-file search will read before giving up.
 *
 * A guard, not a budget. A `LineReader` that never returns `null` (a stub, or
 * a reader over something that is not a file) would otherwise keep the stage
 * reading for ever. No source file this engine has met comes near it; one
 * that did would be searched to here and the rest treated as not searched,
 * so a quote beyond the limit reads as absent rather than as found.
 */
export const ANCHOR_SCAN_LIMIT = 200_000;

type Located =
  | { kind: "holds"; line: number }
  | { kind: "line-drift"; line: number; beyondEof: boolean }
  | { kind: "quote-absent" }
  | { kind: "quote-ambiguous"; occurrences: number }
  | { kind: "line-beyond-eof" }
  | { kind: "file-unreadable" };

/**
 * Where the quote actually is.
 *
 * The window around the cited line is searched first, and a hit there `holds`.
 * Only when the window fails is the whole file read: a quote found at exactly
 * one other place is `line-drift`, one found at several is ambiguous, and one
 * found nowhere is absent. The two searches are the same match at the same
 * threshold; widening WHERE the gate looks does not loosen WHAT it accepts,
 * and a fabricated quote that passed the window 0.0% of the time passes the
 * whole file no more often per line.
 *
 * The window and the file are anchored differently, and that is why the
 * second pass is stricter about what it will move. In the window the cited
 * line is the anchor and the quote only confirms it, so a quote that several
 * lines could satisfy still lands on the nearest one, which is the one the
 * claim meant. In the whole file the quote is the only anchor there is. A
 * quote at three lines of the file names none of them, and a quote of nothing
 * but punctuation names every line: neither can place a citation, and the
 * nearest-first rule that is right in the window would here move a claim
 * about one function onto the same `return null;` in another, or a `}` past
 * the end of the file onto its last line.
 *
 * A file that cannot be read at all is its own answer, and a cited line past
 * the end of a readable file is another: telling an operator the file was
 * unreadable when the claim simply overran it sends them after the wrong bug.
 */
function locateQuote(
  quote: string,
  path: string,
  line: number,
  readLine: LineReader,
): Located {
  const wanted = significantWords(quote);
  const match = matcherFor(wanted);
  const height = Math.min(quote.split("\n").length, ANCHOR_WINDOW + 1);

  const window = new Map<number, string>();
  for (let n = Math.max(1, line - ANCHOR_WINDOW); n <= line + ANCHOR_WINDOW; n++) {
    const text = readLine(path, n);
    if (text !== null) window.set(n, text);
  }
  // Nearest first, so a correction moves the reference as little as the
  // evidence allows, and an exact hit at the cited line never gets displaced.
  const nearest = [...window.keys()].sort(
    (a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b,
  );
  const inWindow = matchingLines(match, window, nearest, height)[0];
  if (inWindow !== undefined) return { kind: "holds", line: inWindow };

  // Read to the end, or to the guard. `null` from the reader is the end of
  // the file, so a file whose first line is `null` is one that could not be
  // read; the reader caches the file either way, so this costs one lookup a
  // line and no second read from disk.
  const file = new Map<number, string>();
  let reachedEnd = false;
  for (let n = 1; n <= ANCHOR_SCAN_LIMIT; n++) {
    const text = readLine(path, n);
    if (text === null) {
      reachedEnd = true;
      break;
    }
    file.set(n, text);
  }
  if (file.size === 0) return { kind: "file-unreadable" };

  // Only a file read to its end can say the citation overran it.
  const beyondEof = reachedEnd && line > file.size;

  // A quote with no words in it matched every line of the window, so an empty
  // window is the only way it gets here, and the file has nothing to add: it
  // would match every line of that too. What is left to say is whether the
  // cited line was past the end.
  if (wanted.length === 0) {
    return { kind: beyondEof ? "line-beyond-eof" : "quote-absent" };
  }

  const ascending = [...file.keys()].sort((a, b) => a - b);
  const inFile = matchingLines(match, file, ascending, height);
  if (inFile.length === 1) {
    return { kind: "line-drift", line: inFile[0]!, beyondEof };
  }
  if (inFile.length > 1) {
    return { kind: "quote-ambiguous", occurrences: inFile.length };
  }
  return { kind: beyondEof ? "line-beyond-eof" : "quote-absent" };
}

/**
 * Every line at which the quote appears, in the order the lines are given.
 *
 * Single lines first; only if no line holds the quote on its own are runs of
 * consecutive lines tried. The window takes the first hit and the whole-file
 * pass counts them, and it is one search for both so that what the window
 * accepts and what the file accepts cannot drift apart.
 */
function matchingLines(
  match: (text: string) => boolean,
  lines: Map<number, string>,
  order: number[],
  height: number,
): number[] {
  const single = order.filter((n) => match(lines.get(n)!));
  if (single.length > 0) return single;

  // A multi-line construct spreads its words across consecutive lines, so no
  // single line can hold 80% of them however close it is. Join before matching.
  // The span is bounded by the quote's own height: a two-line quote is looked
  // for in two lines, never in four, so the extra text cannot be what lets a
  // fabricated quote through.
  for (let span = 2; span <= Math.max(height, 2); span++) {
    const starts: number[] = [];
    for (const start of order) {
      // Two runs that overlap are one construct seen from two starting lines,
      // not two occurrences; counting both would call a unique quote ambiguous.
      if (starts.some((taken) => Math.abs(taken - start) < span)) continue;
      const run: string[] = [];
      for (let n = start; n < start + span; n++) {
        const text = lines.get(n);
        if (text === undefined) break;
        run.push(text);
      }
      if (run.length === span && match(run.join("\n"))) starts.push(start);
    }
    if (starts.length > 0) return starts;
  }

  return [];
}

/**
 * The match, with the quote's words extracted once.
 *
 * The whole-file search calls this once per line of the file, and tokenising
 * the quote again for each of them is the difference between a search that is
 * free and one that is not.
 */
function matcherFor(wanted: string[]): (text: string) => boolean {
  // A quote of nothing but punctuation asserts nothing; let the verifiers judge.
  if (wanted.length === 0) return () => true;

  return (text: string): boolean => {
    const present = new Set(significantWords(text));
    const found = wanted.filter((word) => present.has(word)).length;
    return found / wanted.length >= ANCHOR_MATCH_THRESHOLD;
  };
}

export function quoteAppearsAt(quote: string, line: string): boolean {
  return matcherFor(significantWords(quote))(line);
}

/* ── Gate two: independent refutation attempts ────────────────────────────── */

export interface VerifyRequest {
  claim: Claim;
  /** Which run this is. Included so a caller can vary sampling if it wants. */
  verifier: number;
  systemPrompt: string;
  userPrompt: string;
}

export interface VerifierModel {
  refute(request: VerifyRequest): Promise<VerifierVerdict>;
}

const SYSTEM_PROMPT = [
  "You are trying to REFUTE a claim another reviewer made about this codebase.",
  "",
  "Do not confirm it. Open the files it cites and look for the reading that",
  "makes it wrong: a caller that changes the picture, a branch that is never",
  "taken, a configuration value set elsewhere, a version that does not match.",
  "",
  "Three outcomes, and the middle one is not a soft version of the first:",
  '  "refuted"          — you found the reading that makes it wrong. Say which.',
  '  "not-refuted"      — you tried and the claim survives on the cited evidence.',
  '  "cannot-determine" — the answer is not in the repository at all. Name the',
  "                       access that would settle it in `needsAccess`.",
  "",
  "Default to `cannot-determine` over `not-refuted` when you are unsure. A claim",
  "that survives because nobody looked hard is worse than one marked open.",
  "",
  "Reply with JSON only:",
  '{"outcome":"...","reason":"...","needsAccess":null,"vocabulariesTried":[]}',
].join("\n");

/**
 * The extra instruction an absence claim gets.
 *
 * "There is no X" is the easiest claim to get wrong and the most damaging to
 * retract, because absence is proved by exhaustion and a search proves only
 * that one spelling was missing. So the verifier must try several vocabularies
 * and record them — and `MIN_VOCABULARIES` is enforced in code afterwards,
 * because a model asked to try three will sometimes report three it did not.
 */
const ABSENCE_INSTRUCTION = [
  "",
  "This claim asserts something does NOT exist. Absence is proved by exhaustion,",
  "and one spelling missing proves nothing. Search at least three genuinely",
  "different vocabularies — the concept's other names, the library's term of art,",
  "the abbreviation — and list every one you tried in `vocabulariesTried`.",
  "Finding nothing under one name is not absence.",
].join("\n");

export function buildVerifyPrompt(claim: Claim): {
  systemPrompt: string;
  userPrompt: string;
} {
  return {
    systemPrompt: claim.absence
      ? SYSTEM_PROMPT + ABSENCE_INSTRUCTION
      : SYSTEM_PROMPT,
    userPrompt: [
      `CLAIM (from question ${claim.questionId})`,
      sanitizeUntrusted(claim.statement),
      "",
      "CITED EVIDENCE",
      ...claim.evidence.map((ref) => {
        const where =
          ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`;
        const quote = ref.quote
          ? ` — quoted: ${sanitizeUntrusted(ref.quote)}`
          : "";
        return `  ${where}${quote}`;
      }),
    ].join("\n"),
  };
}

/* ── Deciding what the verdicts mean ──────────────────────────────────────── */

/**
 * Confidence, computed from verdicts.
 *
 * The order matters and is deliberate:
 *
 *   1. Any refutation rejects the claim outright. Not a weaker finding — gone.
 *      One verifier finding the reading that breaks it means the claim is live,
 *      not settled, and a report is not the place to argue with yourself.
 *   2. Any verifier naming access it lacked makes it not-determinable, even if
 *      others were satisfied. The honest answer to "we could not see the
 *      configuration" is not "two out of three thought it was fine".
 *   3. `verified` needs the full bar: at least MIN_VERIFIERS, every one of them
 *      not-refuted. One verifier is an opinion.
 *   4. Everything else is inferred — supported, but the chain is not closed.
 */
export function decideConfidence(verdicts: VerifierVerdict[]): {
  confidence: Confidence;
  rejected: boolean;
  refutations: number;
  needsAccess?: string;
} {
  const refutations = verdicts.filter((v) => v.outcome === "refuted").length;
  if (refutations > 0) {
    return { confidence: "not-determinable", rejected: true, refutations };
  }

  const blocked = verdicts.find(
    (v) => v.outcome === "cannot-determine" && v.needsAccess,
  );
  if (blocked?.needsAccess) {
    return {
      confidence: "not-determinable",
      rejected: false,
      refutations: 0,
      needsAccess: blocked.needsAccess,
    };
  }

  const survived = verdicts.filter((v) => v.outcome === "not-refuted").length;
  if (verdicts.length >= MIN_VERIFIERS && survived === verdicts.length) {
    return { confidence: "verified", rejected: false, refutations: 0 };
  }

  return { confidence: "inferred", rejected: false, refutations: 0 };
}

/** Every distinct vocabulary any verifier reported trying, in a stable order. */
export function vocabulariesFrom(verdicts: VerifierVerdict[]): string[] {
  const all = verdicts.flatMap((v) => v.vocabulariesTried ?? []);
  return [
    ...new Set(
      all.map((entry) => entry.trim()).filter((entry) => entry !== ""),
    ),
  ].sort();
}

/* ── Running the stage ────────────────────────────────────────────────────── */

export interface VerifyOptions {
  claims: Claim[];
  model: VerifierModel;
  readLine: LineReader;
  /** Tells a directory from a missing file. Without it, both read as missing. */
  pathKind?: PathKind;
  /** How many independent attempts per claim. Never below MIN_VERIFIERS. */
  verifiers?: number;
  log?: (message: string) => void;
  /** Called as each claim is settled. Claims are verified in input order. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Checked before each claim. Returning true stops the loop and returns what
   * has been settled so far.
   *
   * Per-claim rather than per-stage because verification is the long tail — two
   * model calls for every claim, sequentially — and a stop that only took effect
   * at the end of the stage would leave an operator watching a run they had
   * already cancelled. Investigation cannot offer the same: its questions all
   * start at once, so there is nothing left to not-start.
   */
  shouldStop?: () => boolean;
}

/**
 * Verify every claim.
 *
 * Deterministic given deterministic verdicts: claims keep their input order,
 * verifiers are numbered, and vocabularies are sorted. Two runs over an
 * unchanged tree must produce the same output, because a report that shifts
 * between runs cannot be diffed against the next audit.
 */
export async function verifyClaims(
  options: VerifyOptions,
): Promise<VerificationResult> {
  const log = options.log ?? ((message: string) => console.error(message));
  const attempts = Math.max(options.verifiers ?? MIN_VERIFIERS, MIN_VERIFIERS);

  const verified: VerifiedClaim[] = [];
  const rejected: RejectedClaim[] = [];

  for (const [index, claim] of options.claims.entries()) {
    // Between claims, where nothing is half-done: the claims settled so far are
    // complete and their verdicts stand.
    if (options.shouldStop?.()) {
      log(
        `[verify] stopping at the operator's request after ${index} of ${options.claims.length} claim(s)`,
      );
      break;
    }

    // `finally`, so a claim rejected at an early gate still advances the
    // count. Two of the exits below are `continue`, and a progress bar that
    // silently skips them stalls on any run with a bad citation.
    try {
      // Gate one, free and deterministic: does the citation exist?
      const anchors = anchorClaim(claim, options.readLine, options.pathKind);
      let dropped: DroppedCitation[] = [];
      for (const moved of anchors.corrected) {
        log(
          `[verify] ${claim.questionId}: citation moved ${moved.ref.path}:${moved.citedLine} -> ` +
            `${moved.foundLine} (${moved.distance} line(s) away` +
            `${moved.beyondEof ? ", cited line is past the end of the file" : ""}); ` +
            `confidence capped at inferred`,
        );
      }
      if (anchors.problems.length > 0) {
        const detail = anchors.problems
          .map(
            (problem) =>
              `${problem.ref.path}:${problem.ref.line} ${problem.reason}` +
              (problem.occurrences === undefined ? "" : ` (at ${problem.occurrences} lines)`),
          )
          .join("; ");
        // The claim goes only when NOTHING it cites holds. A claim with one
        // real citation and one invented one used to be thrown away whole,
        // which discarded the real evidence for the sake of the invented
        // reference; now the failed citations are dropped and the claim stands
        // on what is left, for the verifiers to judge. Unquoted pointers were
        // never judged here and do not count as holding.
        if (anchors.held.length === 0) {
          log(`[verify] ${claim.questionId}: no citation holds: ${detail}`);
          rejected.push({
            claim,
            // The first failure names the claim's code. Every quoted citation
            // failed, so any of them is a fair name; the first is the stable one.
            code: anchors.problems[0]!.reason,
            reason: `fabricated or stale citation: ${detail}`,
            verdicts: [],
          });
          continue;
        }
        const failed = new Set(anchors.problems.map((problem) => problem.ref));
        claim.evidence = claim.evidence.filter((ref) => !failed.has(ref));
        // Dropped, not forgotten. The failed citation leaves the evidence,
        // where nothing may stand on it, and goes on the record instead: a
        // run whose every claim carried one invented citation beside one real
        // one used to print "quote-absent 0" and show every finding clean,
        // because a citation that was only dropped was counted nowhere.
        dropped = anchors.problems.map((problem) => ({
          path: problem.ref.path,
          line: problem.ref.line!,
          reason: problem.reason,
          ...(problem.occurrences === undefined ? {} : { occurrences: problem.occurrences }),
        }));
        log(
          `[verify] ${claim.questionId}: ${anchors.problems.length} citation(s) dropped, ` +
            `${anchors.held.length} held: ${detail}`,
        );
      }

      const { systemPrompt, userPrompt } = buildVerifyPrompt(claim);
      const verdicts = await runVerifiers({
        claim,
        attempts,
        model: options.model,
        systemPrompt,
        userPrompt,
        log,
      });

      const decision = decideConfidence(verdicts);
      const vocabulariesTried = vocabulariesFrom(verdicts);

      if (decision.rejected) {
        const why =
          verdicts.find((v) => v.outcome === "refuted")?.reason ?? "refuted";
        log(`[verify] ${claim.questionId}: REFUTED — ${why}`);
        rejected.push({ claim, code: "refuted", reason: why, verdicts });
        continue;
      }

      // An absence claim that nobody searched properly is not absence. Downgrade
      // rather than drop: the question is still open, we just cannot say "no".
      let confidence = decision.confidence;
      if (
        claim.absence &&
        confidence === "verified" &&
        vocabulariesTried.length < MIN_VOCABULARIES
      ) {
        log(
          `[verify] ${claim.questionId}: absence not established — ` +
            `${vocabulariesTried.length} vocabulary/ies tried, ${MIN_VOCABULARIES} required`,
        );
        confidence = "not-determinable";
      }

      // A claim whose citation had to be found for it was written from memory,
      // not from the file. The verifiers may well fail to refute it, since the
      // evidence is real; what they cannot do is make it re-derived, because
      // its author never read the line. Inferred is the ceiling. After the
      // absence rule, so an absence claim nobody searched properly stays
      // not-determinable rather than being lifted to inferred here.
      //
      // A dropped citation caps the same way, and a fortiori: a line number
      // recalled wrongly is one kind of memory, a quote that is nowhere in the
      // file is another, and the second reached `verified` while the first
      // was capped. The verifiers judged only the evidence that held, and
      // what held is real; what they never saw is the citation the author
      // made up, and a claim with one of those was not read from the file.
      const moved = claim.evidence.some((ref) => ref.corrected !== undefined);
      if (confidence === "verified" && (moved || dropped.length > 0)) {
        log(
          `[verify] ${claim.questionId}: verified by the verifiers, capped at inferred: ` +
            (moved ? "a citation was moved" : "a citation was dropped"),
        );
        confidence = "inferred";
      }

      verified.push({
        claim,
        verdicts,
        confidence,
        verifiers: verdicts.length,
        refutations: decision.refutations,
        ...(decision.needsAccess ? { needsAccess: decision.needsAccess } : {}),
        vocabulariesTried,
        ...(dropped.length > 0 ? { dropped } : {}),
      });
    } finally {
      options.onProgress?.(index + 1, options.claims.length);
    }
  }

  return { verified, rejected };
}

async function runVerifiers(args: {
  claim: Claim;
  attempts: number;
  model: VerifierModel;
  systemPrompt: string;
  userPrompt: string;
  log: (message: string) => void;
}): Promise<VerifierVerdict[]> {
  const runs = Array.from(
    { length: args.attempts },
    (_, index) => index + 1,
  ).map(async (verifier): Promise<VerifierVerdict> => {
    try {
      const verdict = await args.model.refute({
        claim: args.claim,
        verifier,
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
      });
      return { ...verdict, verifier };
    } catch (error) {
      // A verifier that crashed did not clear the claim. Counting a failure as
      // "not refuted" would let an outage manufacture confidence.
      const detail = error instanceof Error ? error.message : String(error);
      args.log(
        `[verify] ${args.claim.questionId}: verifier ${verifier} failed — ${detail}`,
      );
      return {
        verifier,
        outcome: "cannot-determine",
        reason: `verifier failed: ${detail}`,
      };
    }
  });

  const verdicts = await Promise.all(runs);
  return verdicts.sort((a, b) => a.verifier - b.verifier);
}

/** Totals for the run record and the report's coverage section. */
export interface VerificationSummary {
  examined: number;
  verified: number;
  inferred: number;
  notDeterminable: number;
  rejected: number;
  /** `rejected`, by why. The values sum to `rejected`. */
  rejectedBy: Record<RejectionCode, number>;
  /** Claims kept after a citation was moved to where its quote is. */
  corrected: number;
  /**
   * Quoted citations dropped from claims that were kept. Citations, not
   * claims: a claim that gave three invented references beside one real one
   * counts three here, and its one finding is capped at inferred.
   */
  dropped: number;
  /** `dropped`, by why. The values sum to `dropped`. */
  droppedBy: Record<CitationCode, number>;
}

export function summariseVerification(result: VerificationResult): VerificationSummary {
  const count = (confidence: Confidence): number =>
    result.verified.filter((entry) => entry.confidence === confidence).length;

  const rejectedBy = Object.fromEntries(
    REJECTION_CODES.map((code) => [code, 0]),
  ) as Record<RejectionCode, number>;
  for (const entry of result.rejected) rejectedBy[entry.code] += 1;

  const droppedBy = Object.fromEntries(
    CITATION_CODES.map((code) => [code, 0]),
  ) as Record<CitationCode, number>;
  const dropped = result.verified.flatMap((entry) => entry.dropped ?? []);
  for (const citation of dropped) droppedBy[citation.reason] += 1;

  return {
    examined: result.verified.length + result.rejected.length,
    verified: count("verified"),
    inferred: count("inferred"),
    notDeterminable: count("not-determinable"),
    rejected: result.rejected.length,
    rejectedBy,
    corrected: result.verified.filter((entry) =>
      entry.claim.evidence.some((ref) => ref.corrected !== undefined),
    ).length,
    dropped: dropped.length,
    droppedBy,
  };
}

/**
 * The one line that says how many claims were thrown away and why.
 *
 * Printed by the CLI and by the report, from the same function, so the number
 * an operator saw at the terminal is the number the reader sees on the page.
 * Every code is printed every time, zeros included: a code that appears only
 * when non-zero is a line that changes shape between runs and cannot be
 * compared across them. No em dash; hyphens and semicolons only.
 */
export function describeVerification(summary: VerificationSummary): string {
  const rejectedBy = REJECTION_CODES.map(
    (code) => `${code} ${summary.rejectedBy[code]}`,
  ).join(", ");
  const droppedBy = CITATION_CODES.map(
    (code) => `${code} ${summary.droppedBy[code]}`,
  ).join(", ");
  return (
    `claims rejected: ${summary.rejected} (${rejectedBy}); ` +
    `corrected for line drift: ${summary.corrected}; ` +
    `citations dropped from kept claims: ${summary.dropped} (${droppedBy})`
  );
}

/**
 * The same counts, flat, for `stageFinished("verify")`.
 *
 * Keys rather than nested objects because a stage event carries
 * `Record<string, number>` and nothing else. `verified` is deliberately NOT
 * here: on the stage event it has always meant "claims that survived", not
 * "claims at confidence verified", and the dashboard reads it that way.
 */
export function verificationCounts(summary: VerificationSummary): Record<string, number> {
  return {
    rejected: summary.rejected,
    rejectedQuoteAbsent: summary.rejectedBy["quote-absent"],
    rejectedQuoteAmbiguous: summary.rejectedBy["quote-ambiguous"],
    rejectedLineBeyondEof: summary.rejectedBy["line-beyond-eof"],
    rejectedFileUnreadable: summary.rejectedBy["file-unreadable"],
    rejectedNotALineReference: summary.rejectedBy["not-a-line-reference"],
    rejectedRefuted: summary.rejectedBy.refuted,
    correctedLineDrift: summary.corrected,
    droppedCitations: summary.dropped,
    droppedQuoteAbsent: summary.droppedBy["quote-absent"],
    droppedQuoteAmbiguous: summary.droppedBy["quote-ambiguous"],
    droppedLineBeyondEof: summary.droppedBy["line-beyond-eof"],
    droppedFileUnreadable: summary.droppedBy["file-unreadable"],
    droppedNotALineReference: summary.droppedBy["not-a-line-reference"],
  };
}
