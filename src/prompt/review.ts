/**
 * Prompt template for per-item UAT verdicts.
 *
 * Two consumers feed it the same context:
 *   - The GitHub Action wraps `anthropics/claude-code-action` and embeds this
 *     prompt (see `.github/actions/review/prompts/review.md` — generated from
 *     this module so they stay in lockstep).
 *   - The local CLI (`src/cli.ts`) calls the Anthropic SDK directly with this
 *     prompt for the `/review-pr` plugin command.
 *
 * Stability discipline:
 *   - Keep this prompt small and explicit. Adding chatter to it tends to make
 *     verdicts drift between runs.
 *   - When you change the prompt in a way that could shift outputs, bump
 *     `REVIEWER_VERSION` in `src/version.ts`. That invalidates the sticky
 *     comment marker so old verdicts don't get edited under the new prompt.
 */

import { COMMENT_MARKER, REVIEWER_VERSION } from "../version.js";
import type { LinearTicketContext, PrContext } from "../schema/event.js";
import type { UatChecklist } from "../parser/uat.js";

export interface BuildPromptArgs {
  pr: PrContext;
  ticket: LinearTicketContext;
  checklist: UatChecklist;
  /** Unified diff produced by `git diff <base>..<head>` or `gh pr diff`. */
  diff: string;
}

/**
 * Builds the user message for the model. Pair with `SYSTEM_PROMPT` below.
 *
 * Heuristic on diff size: GitHub PRs above ~50k lines of diff are rare in
 * OgenticAI repos (ogentic-shield is ~5k LOC total) so we don't truncate
 * here. If we ever hit a giant PR, the model will surface that as
 * UNVERIFIABLE rather than hallucinating PASS — which is the right outcome.
 */
export function buildReviewPrompt(args: BuildPromptArgs): string {
  const { pr, ticket, checklist, diff } = args;

  const items = checklist.items
    .map((it) => `${it.id}. ${it.text}${it.checked ? " (author marked done)" : ""}`)
    .join("\n");

  const checklistBlock = checklist.found
    ? items
    : "(No `## UAT checklist` block found in the PR description.)";

  return [
    `# Review request`,
    ``,
    `**PR:** ${pr.owner}/${pr.repo}#${pr.number} — ${pr.title}`,
    `**Branch:** \`${pr.headRef}\` @ ${pr.headSha}`,
    `**Author:** @${pr.author}`,
    `**Linear ticket:** [${ticket.identifier}](${ticket.url}) — ${ticket.title} (status: ${ticket.status})`,
    ``,
    `## Linear ticket description`,
    ``,
    ticket.description.trim() || "_(empty)_",
    ``,
    `## UAT checklist (from PR description)`,
    ``,
    checklistBlock,
    ``,
    `## Diff to review`,
    ``,
    "```diff",
    diff,
    "```",
    ``,
    `## Your task`,
    ``,
    `For each numbered UAT item above, decide whether the diff (in the context of`,
    `the existing repo) delivers it. Produce a JSON object exactly matching the`,
    `\`ReviewVerdict\` schema. Do not include prose outside the JSON.`,
    ``,
    `Status meanings:`,
    `- **PASS** — clear evidence the item is delivered. Pin evidence in evidenceRefs.`,
    `- **FAIL** — clear evidence the item is NOT delivered, or a regression.`,
    `- **PARTIAL** — partially done. Use sparingly and explain.`,
    `- **UNVERIFIABLE** — cannot be checked from the diff alone (visual claims, manual`,
    `  reproduction steps, etc). Explain why a human is needed.`,
    ``,
    `Author tick-marks are advisory only — don't trust them. Decide from the diff.`,
    ``,
    `**Optional auto-patch hint:** for any item where status === "FAIL" AND the gap is`,
    `clearly mechanical (missing test for an explicitly-asserted behavior; missing`,
    `docstring on a public function; a README claim that doesn't match the code; a`,
    `version-string that wasn't bumped), set \`"autoPatchable": true\`. Default false.`,
    `Only flag an item autoPatchable when you could write the fix yourself from the`,
    `diff context alone — design questions, business decisions, and visual claims`,
    `must always be \`autoPatchable: false\`.`,
  ].join("\n");
}

export const SYSTEM_PROMPT = [
  `You are the **OgenticAI Reviewer** — an AI engineer that lives in GitHub and`,
  `reviews pull requests against the Linear ticket they are linked to.`,
  ``,
  `You speak like a senior teammate doing code review: terse, specific, and`,
  `useful. You never write filler. Every rationale should reference a file path`,
  `or a concrete claim from the diff. If you cannot verify an item from the diff`,
  `alone, return UNVERIFIABLE — that is not a failure, it is a request for`,
  `human eyes.`,
  ``,
  `You return ONE JSON object matching the \`ReviewVerdict\` schema. No prose`,
  `outside the JSON. No markdown code fences around the JSON. The same diff +`,
  `same checklist must produce the same verdicts every run; you are deterministic`,
  `at temperature 0.`,
  ``,
  `Reviewer version: ${REVIEWER_VERSION}.`,
  `Sticky comment marker: ${COMMENT_MARKER}.`,
].join("\n");
