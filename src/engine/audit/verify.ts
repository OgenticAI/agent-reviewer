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
import type { Confidence, EvidenceRef } from "./finding.js";
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
}

export interface RejectedClaim {
  claim: Claim;
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

export interface AnchorProblem {
  ref: EvidenceRef;
  reason: "file-unreadable" | "quote-not-at-line" | "not-a-line-reference";
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
 * report cites the truth rather than the model's arithmetic. The claim is
 * mutated in place; nothing else about it is touched.
 */
export function checkAnchors(
  claim: Claim,
  readLine: LineReader,
): AnchorProblem[] {
  const problems: AnchorProblem[] = [];

  for (const ref of claim.evidence) {
    if (!ref.quote || ref.line === undefined) continue;

    // A directory, or the `:0` a model writes when it means "this path". It
    // asserts nothing about a line, so the line gate has nothing to judge.
    // Reporting it as an unreadable file was wrong twice over: the path is
    // often perfectly real, and the operator was told to go looking for a
    // reading failure that never happened.
    if (ref.line < 1) {
      problems.push({ ref, reason: "not-a-line-reference" });
      continue;
    }

    const found = locateQuote(ref.quote, ref.path, ref.line, readLine);
    if (found === "unreadable") {
      problems.push({ ref, reason: "file-unreadable" });
      continue;
    }
    if (found === null) {
      problems.push({ ref, reason: "quote-not-at-line" });
      continue;
    }
    // Found, but not where the claim said. Correcting it here is the point:
    // accepting it silently would leave the report pointing a reader at a line
    // that does not contain the quoted text, which is the same disappointment
    // as a fabricated citation even though the evidence is real.
    if (found !== ref.line) ref.line = found;
  }

  return problems;
}

/**
 * Where the quote actually is, within `ANCHOR_WINDOW` lines of the claim.
 *
 * Returns the line it was found at, `null` if it is nowhere in the window, or
 * `"unreadable"` if the file itself could not be read. That last distinction
 * matters: a line beyond the end of a real file is a wrong citation, not a
 * missing file, and telling an operator otherwise sends them after the wrong
 * bug.
 */
function locateQuote(
  quote: string,
  path: string,
  line: number,
  readLine: LineReader,
): number | null | "unreadable" {
  const lines = new Map<number, string>();
  for (let n = Math.max(1, line - ANCHOR_WINDOW); n <= line + ANCHOR_WINDOW; n++) {
    const text = readLine(path, n);
    if (text !== null) lines.set(n, text);
  }
  if (lines.size === 0) {
    // Nothing readable around the citation. Line 1 settles which kind of wrong
    // this is, and costs nothing: the reader caches the file either way.
    return readLine(path, 1) === null ? "unreadable" : null;
  }

  // Nearest first, so a correction moves the reference as little as the
  // evidence allows, and an exact hit at the cited line never gets displaced.
  const nearest = [...lines.keys()].sort(
    (a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b,
  );

  for (const n of nearest) {
    if (quoteAppearsAt(quote, lines.get(n)!)) return n;
  }

  // A multi-line construct spreads its words across consecutive lines, so no
  // single line can hold 80% of them however close it is. Join before matching.
  // The span is bounded by the quote's own height: a two-line quote is looked
  // for in two lines, never in four, so the extra text cannot be what lets a
  // fabricated quote through.
  const height = Math.min(quote.split("\n").length, ANCHOR_WINDOW + 1);
  for (let span = 2; span <= Math.max(height, 2); span++) {
    for (const start of nearest) {
      const run: string[] = [];
      for (let n = start; n < start + span; n++) {
        const text = lines.get(n);
        if (text === undefined) break;
        run.push(text);
      }
      if (run.length === span && quoteAppearsAt(quote, run.join("\n"))) {
        return start;
      }
    }
  }

  return null;
}

export function quoteAppearsAt(quote: string, line: string): boolean {
  const wanted = significantWords(quote);
  // A quote of nothing but punctuation asserts nothing; let the verifiers judge.
  if (wanted.length === 0) return true;

  const present = new Set(significantWords(line));
  const found = wanted.filter((word) => present.has(word)).length;
  return found / wanted.length >= ANCHOR_MATCH_THRESHOLD;
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
      const anchorProblems = checkAnchors(claim, options.readLine);
      if (anchorProblems.length > 0) {
        const detail = anchorProblems
          .map(
            (problem) =>
              `${problem.ref.path}:${problem.ref.line} ${problem.reason}`,
          )
          .join("; ");
        log(`[verify] ${claim.questionId}: citation does not hold — ${detail}`);
        rejected.push({
          claim,
          reason: `fabricated or stale citation: ${detail}`,
          verdicts: [],
        });
        continue;
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
        rejected.push({ claim, reason: why, verdicts });
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

      verified.push({
        claim,
        verdicts,
        confidence,
        verifiers: verdicts.length,
        refutations: decision.refutations,
        ...(decision.needsAccess ? { needsAccess: decision.needsAccess } : {}),
        vocabulariesTried,
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

/** Totals for the run record and the report's method section. */
export function summariseVerification(result: VerificationResult): {
  examined: number;
  verified: number;
  inferred: number;
  notDeterminable: number;
  rejected: number;
} {
  const count = (confidence: Confidence): number =>
    result.verified.filter((entry) => entry.confidence === confidence).length;

  return {
    examined: result.verified.length + result.rejected.length,
    verified: count("verified"),
    inferred: count("inferred"),
    notDeterminable: count("not-determinable"),
    rejected: result.rejected.length,
  };
}
