/**
 * Model calls that failed (OGE-2711).
 *
 * A run whose credit ran out halfway through still finishes. Every question
 * that could not be asked is dropped with a reason, every verifier that could
 * not run answers `cannot-determine`, and each of those is the honest thing to
 * do for the question or the claim in front of it. But they are recorded where
 * they happen, one line each, in a log nobody reads until something looks
 * wrong; the run record itself says "finished" and the report reads exactly as
 * confident as one whose calls all went through.
 *
 * The release gate needs one number: how many model calls this run lost to the
 * API. Not a token count (that is the meter's job) and not the reasons (the
 * logs have those), just the count, carried on the stage record the gate reads.
 *
 * ── Counted at the API, not at the drop ──────────────────────────────────────
 *
 * The same failure surfaces in three places on its way out. A turn that throws
 * mid-investigation becomes a dropped question; the closing turn's throw is
 * folded into the loop's `degraded` string; a verifier's throw becomes a
 * `cannot-determine` verdict. Counting at any of those would miss the others,
 * and counting at all three would count one failure twice. The one place every
 * call passes through is the request itself, so that is where the count lives:
 * one increment per call that threw, whatever it was doing at the time.
 *
 * A failure here is a rejection the SDK has already given up on. It retries
 * transient errors on its own before throwing, so what arrives is the outcome,
 * not an attempt.
 */
export class ModelCallFailures {
  private readonly reasons: string[] = [];

  /** One call, after retries, that did not return a response. */
  record(detail: string): void {
    this.reasons.push(detail);
  }

  /** How many calls failed so far. */
  count(): number {
    return this.reasons.length;
  }

  /** What each one said, in the order they failed. For logs and tests. */
  details(): readonly string[] {
    return this.reasons;
  }
}
