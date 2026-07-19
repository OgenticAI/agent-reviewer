/**
 * When the reviewer is allowed to research, and against which sources (OGE-1566).
 *
 * Research exists to narrow the *factual half* of a `[human]` criterion.
 * "Clinician confirms the PHI categories match DSM-5 practice" bundles an
 * attestation only a licensed person can give with a concrete question about
 * what the code enumerates — the signature is undelegatable, the question
 * isn't. Researching the question shrinks the signer's job from "figure this
 * out" to "confirm this".
 *
 * Mechanism: Anthropic's **server-side** web-search tool, declared in the
 * `tools` array of the same `messages.create` call. It runs on Anthropic's
 * infrastructure, so there is no client-side execute-and-feed-back loop — this
 * is why research does not depend on the tool-loop work in OGE-1552.
 *
 * The security boundary, stated plainly:
 *
 *   The **model** composes the search query and Anthropic dispatches it. Our
 *   code never sees the query before it leaves. So we cannot *prevent* diff
 *   content reaching a search backend — we can only constrain where results
 *   come from (`allowedDomains`, enforced server-side), cap how many searches
 *   run (`maxUses`), and log every query after the fact for audit.
 *
 * That is detection, not prevention. It is an acceptable trade where a leak
 * would be embarrassing; it is NOT acceptable where a leak would be PHI or
 * MNPI. Hence: research is **off by default** and must be opted into per repo.
 * Repos importing `@ogenticai/shield` or `@ogenticai/audit`, and anything in
 * the Therapy or Private Credit verticals, should stay off until the
 * client-side search path exists (where we build the query and can test it).
 */

import type { UatItem } from "../parser/uat.js";

/**
 * Sources the reviewer may cite. Enforced by Anthropic server-side via the
 * tool's `allowed_domains`, not by asking the model nicely in the prompt —
 * that distinction is the whole reason this list is worth maintaining.
 *
 * Admission rule: a domain belongs here only if it is the *authoritative
 * publisher* of a standard, specification, or regulation. Not aggregators,
 * not summaries, not vendor blogs — a wrong claim sourced from a plausible
 * secondary source is exactly the failure mode this feature must avoid,
 * because the whole value of a briefing is that the expert trusts it enough
 * to move faster.
 */
export const RESEARCH_SOURCE_ALLOWLIST: readonly string[] = [
  // Health / clinical
  "hhs.gov", // HIPAA, Safe Harbor identifiers
  "cms.gov", // CPT / HCPCS coding
  "nih.gov",
  "who.int", // ICD
  // Legal / regulatory
  "sec.gov",
  "ecfr.gov",
  "ftc.gov",
  "europa.eu", // GDPR
  // Web / accessibility / security standards
  "w3.org", // WCAG, ARIA
  "ietf.org", // RFCs
  "rfc-editor.org",
  "nist.gov",
  "owasp.org",
  "iso.org",
  // Language & platform references (for standards-shaped engineering claims)
  "developer.mozilla.org",
  "python.org",
  "nodejs.org",
  "typescriptlang.org",
];

/**
 * Cap on server-side searches per review run. Research only fires on
 * `[human]`-marked items, which are rare by construction, so this is a
 * backstop against a runaway loop rather than a routine constraint.
 */
export const RESEARCH_MAX_USES = 3;

export interface ResearchPolicy {
  /** When false, the request carries no `tools` array at all. */
  enabled: boolean;
  /**
   * Why research is on or off, in words. Logged on every run — an operator
   * debugging "why didn't it research?" should not have to read this file.
   */
  reason: string;
  allowedDomains: readonly string[];
  maxUses: number;
}

export interface ResolveResearchPolicyArgs {
  /** Parsed checklist items. Research is pointless without a `[human]` one. */
  items: UatItem[];
  /**
   * Per-repo opt-in. Default false everywhere — see the security note above.
   * Sourced from the `research` Action input / `REVIEWER_RESEARCH` env var.
   */
  enabledByConfig: boolean;
}

/**
 * Decide whether this run may research, and under what constraints.
 *
 * Two independent gates, both of which must open:
 *   1. The repo opted in (`enabledByConfig`).
 *   2. The checklist actually has a `[human]` item to brief.
 *
 * Gate 2 matters for cost and for blast radius: a PR with no `[human]` items
 * sends no `tools` array at all, so there is no search path to leak through
 * on the overwhelming majority of reviews.
 */
export function resolveResearchPolicy(args: ResolveResearchPolicyArgs): ResearchPolicy {
  const off = (reason: string): ResearchPolicy => ({
    enabled: false,
    reason,
    allowedDomains: [],
    maxUses: 0,
  });

  if (!args.enabledByConfig) {
    return off("research not enabled for this repo (default off)");
  }
  const humanItems = args.items.filter((it) => it.human);
  if (humanItems.length === 0) {
    return off("no [human]-marked items in the checklist");
  }
  return {
    enabled: true,
    reason: `${humanItems.length} [human]-marked item(s) to brief`,
    allowedDomains: RESEARCH_SOURCE_ALLOWLIST,
    maxUses: RESEARCH_MAX_USES,
  };
}
