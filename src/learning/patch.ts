/**
 * Rendering a learning proposal as a config change a human can merge (OGE-1594).
 *
 * The reviewer never writes `learned_rules` by direct commit. It opens a PR
 * against `.agent-reviewer.yml` on the default branch, and the human merging
 * that PR IS the acceptance signal — the same committed-config-only trust model
 * that makes the whole config safe (OGE-1585). This module produces the YAML to
 * append and the PR body that explains it; the orchestrator opens the PR.
 *
 * There is no LLM here. The rules are already-derived literals; this is pure
 * serialization plus a human-readable justification built from provenance.
 */

import { stringify as stringifyYaml } from "yaml";

import type { LearnedRule } from "../config.js";
import type { DemotionCandidate, ProposedRule } from "./propose.js";

/** The branch a learning PR is opened from. Stable so re-runs update, not spam. */
export const LEARNING_BRANCH = "agent-reviewer/learned-rules";

/**
 * The YAML block to append under `learned_rules:` in `.agent-reviewer.yml`.
 *
 * Only the persisted fields — `rationale` is for the PR body, not the config,
 * so a merged rule stays minimal. Emits nothing for an empty proposal set so a
 * caller can cheaply detect "nothing to propose".
 */
export function renderLearnedRulesYaml(proposals: ProposedRule[]): string {
  if (proposals.length === 0) return "";
  const rules: LearnedRule[] = proposals.map((p) => ({
    trigger: p.trigger,
    ...(p.glob ? { glob: p.glob } : {}),
    instructions: p.instructions,
    provenance: p.provenance,
  }));
  return stringifyYaml({ learned_rules: rules }).trimEnd();
}

/**
 * The PR body proposing the learnings.
 *
 * Leads with the trust model so a reviewer of this PR knows what they are being
 * asked to accept: each rule came from a real human decision, and merging is
 * how it takes effect. Demotions are surfaced as a checklist rather than
 * auto-applied — removing a rule class is a judgment call the maintainer owns.
 */
export function renderLearningPrBody(args: {
  proposals: ProposedRule[];
  demotions?: DemotionCandidate[];
}): string {
  const lines: string[] = [
    `## Proposed learned rules`,
    ``,
    `The reviewer noticed human decisions that carry repo-specific verification`,
    `knowledge. Each rule below comes from a real override or sub-issue`,
    `resolution — **merging this PR is how you accept it.** Nothing here was`,
    `written by direct commit, and no rule was generated or scored by a model:`,
    `the text is the human's own words, and the trigger is a literal string.`,
    ``,
  ];

  for (const p of args.proposals) {
    lines.push(`### \`${p.trigger}\`${p.glob ? ` · \`${p.glob}\`` : ""}`);
    lines.push(``);
    lines.push(`> ${p.instructions}`);
    lines.push(``);
    lines.push(`- **From:** ${p.provenance}`);
    lines.push(`- **Why:** ${p.rationale}`);
    lines.push(``);
  }

  if (args.demotions && args.demotions.length > 0) {
    lines.push(`## Finding classes to consider demoting`, ``);
    lines.push(
      `These were force-passed repeatedly with no code change — evidence the`,
      `reviewer keeps flagging something you keep waving through. Demotion is`,
      `your call; nothing is applied automatically.`,
      ``,
    );
    for (const d of args.demotions) {
      lines.push(
        `- [ ] \`${d.trigger}\` — waved through ${d.overriddenWithoutChange}×` +
          ` (e.g. "${d.sampleItemText}")`,
      );
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`_Proposed by **OgenticAI Reviewer** · review and merge to accept_`);
  return lines.join("\n");
}
