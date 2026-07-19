/**
 * The feedback loop (OGE-1594).
 *
 * This was the single most-replicated technique in the research set — Qodo's
 * auto `best_practices`, CodeRabbit's chat "learnings", Greptile's downvote
 * suppression, BitsAI-CR's data flywheel — and it is the one aimed most
 * directly at the 88% punt rate. The premise: every human resolution carries
 * repo-specific verification knowledge. When a maintainer overrides a punt with
 * "this is checked by the e2e job", that sentence is exactly what would turn
 * the *next* similar item from a punt into a real verdict.
 *
 * ── The one hard constraint ─────────────────────────────────────────────────
 *
 * **No LLM anywhere in the acceptance path.** Greptile measured LLM
 * self-scoring as "nearly random", so nothing here asks a model to grade a
 * model. The learning substrate is:
 *   - recorded human words (override reasons, resolution notes) as rule text,
 *   - literal string triggers, not semantic matching,
 *   - a git merge as the acceptance signal — the reviewer PROPOSES a rule by
 *     opening a PR against `.agent-reviewer.yml`; a human merging it is the
 *     accept. It never writes learned rules by direct commit.
 *
 * This module is pure: events in, proposals out. Turning a proposal into an
 * actual PR is the orchestrator's job, gated on human review by construction.
 */

import type { LearnedRule } from "../config.js";
import type { OutcomeRow } from "../metrics/outcomes.js";

/**
 * A resolved human decision the reviewer can learn from.
 *
 * Deliberately not the raw verdict: a learning event is a point where a person
 * told us something the reviewer got wrong or couldn't see. The `note` is their
 * words — an override reason, a sub-issue resolution comment — and becomes the
 * rule text verbatim, because paraphrasing it through a model is exactly the
 * self-scoring this ticket forbids.
 */
export interface LearningEvent {
  kind: "override" | "subissue-resolved";
  /** The checklist item text this decision was about. */
  itemText: string;
  /** The human's own words: override reason or resolution note. */
  note: string;
  /** Provenance string, e.g. "OGE-1200 override on PR #48". */
  source: string;
  /** Files the item's verdict cited, used to scope the learned rule. */
  citedGlobs?: string[];
}

/** A rule the reviewer proposes appending to committed config. */
export interface ProposedRule extends LearnedRule {
  /** Why this proposal exists, for the PR body. Not persisted in config. */
  rationale: string;
}

/** Stop-words that make a useless trigger — too common to scope anything. */
const TRIGGER_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "be",
  "works", "should", "must", "when", "with", "for", "that", "this", "it",
  "renders", "cleanly", "correctly", "properly",
]);

/**
 * Pick a trigger word from the item text: the longest non-stopword token.
 *
 * A literal string, never an embedding — the whole point is that matching stays
 * inspectable and deterministic. Longest wins because it is the most specific;
 * "migration" scopes better than "adds".
 */
export function deriveTrigger(itemText: string): string | null {
  const tokens = itemText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !TRIGGER_STOPWORDS.has(t));
  if (tokens.length === 0) return null;
  return tokens.sort((a, b) => b.length - a.length)[0]!;
}

/**
 * Narrow cited file paths to a single glob, or nothing.
 *
 * Only emits a glob when every cited path sits under one top-level directory —
 * otherwise the scope is ambiguous and an unscoped trigger is safer than a
 * wrong glob. Errs toward broad-but-correct over narrow-but-misapplied.
 */
export function deriveGlob(citedGlobs: string[] | undefined): string | undefined {
  if (!citedGlobs || citedGlobs.length === 0) return undefined;
  const tops = new Set(citedGlobs.map((p) => p.split("/")[0]).filter(Boolean));
  if (tops.size !== 1) return undefined;
  const [top] = [...tops];
  return `${top}/**`;
}

/**
 * Turn learning events into proposed rules.
 *
 * Skips anything already covered by an existing rule with the same trigger, and
 * anything whose text yields no usable trigger — a proposal that can never fire
 * is noise in the config and noise in the review PR.
 */
export function proposeRules(args: {
  events: LearningEvent[];
  existing: LearnedRule[];
}): ProposedRule[] {
  const seen = new Set(args.existing.map((r) => r.trigger.toLowerCase()));
  const proposals: ProposedRule[] = [];

  for (const ev of args.events) {
    const trigger = deriveTrigger(ev.itemText);
    if (!trigger) continue;
    if (seen.has(trigger)) continue; // already learned; don't duplicate
    seen.add(trigger);

    const glob = deriveGlob(ev.citedGlobs);
    proposals.push({
      trigger,
      ...(glob ? { glob } : {}),
      instructions: ev.note.trim(),
      provenance: ev.source,
      rationale:
        ev.kind === "override"
          ? `A maintainer overrode this item; their reason is the verification hint the reviewer lacked.`
          : `A from-reviewer sub-issue was resolved; the resolution says how this class is verified.`,
    });
  }

  return proposals;
}

/**
 * The suppression side of the flywheel (BitsAI-CR).
 *
 * A finding class that is repeatedly force-passed *without any code change* is,
 * by the evidence, noise: the reviewer keeps flagging something maintainers
 * keep waving through untouched. That class should be demoted. The signal comes
 * entirely from outcome telemetry (OGE-1592) — `unexplained-flip` and
 * `overridden` rows — never from a model reconsidering its own finding.
 */
export interface DemotionCandidate {
  trigger: string;
  /** How many times this class was waved through without a code change. */
  overriddenWithoutChange: number;
  sampleItemText: string;
}

/** Below this, one grumpy maintainer isn't yet a pattern. */
export const DEMOTION_THRESHOLD = 3;

export function findDemotionCandidates(
  rows: OutcomeRow[],
  threshold = DEMOTION_THRESHOLD,
): DemotionCandidate[] {
  const byTrigger = new Map<string, { count: number; sample: string }>();

  for (const row of rows) {
    // The evidence of noise: waved through (overridden / unexplained flip) with
    // nothing in the code actually touched.
    const noChange = row.changedEvidencePaths.length === 0;
    const wavedThrough = row.outcome === "overridden" || row.outcome === "unexplained-flip";
    if (!noChange || !wavedThrough) continue;

    const trigger = deriveTrigger(row.itemText);
    if (!trigger) continue;
    const entry = byTrigger.get(trigger) ?? { count: 0, sample: row.itemText };
    entry.count += 1;
    byTrigger.set(trigger, entry);
  }

  return [...byTrigger.entries()]
    .filter(([, v]) => v.count >= threshold)
    .map(([trigger, v]) => ({
      trigger,
      overriddenWithoutChange: v.count,
      sampleItemText: v.sample,
    }))
    .sort((a, b) => b.overriddenWithoutChange - a.overriddenWithoutChange);
}
