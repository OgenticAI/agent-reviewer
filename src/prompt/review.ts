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
 *
 * Determinism contract input vector:
 *   `(prBody, headRef, headSha, ticket, diff, linkedComments)`. As of v2
 *   linked-comment bodies are part of the input — editing a same-PR
 *   verification comment will (correctly) refresh the next sticky on push.
 */

import { COMMENT_MARKER, REVIEWER_VERSION } from "../version.js";
import type { LinearTicketContext, PrContext } from "../schema/event.js";
import type { UatChecklist } from "../parser/uat.js";

/**
 * A PR comment fetched by the orchestrator and attached to the prompt as
 * potential verification evidence. Pairs a comment with the UAT item that
 * linked it. Only items that are ticked AND link a same-PR comment make it
 * into this list — see `runReview` for the gate.
 */
export interface LinkedComment {
  /** 1-based UAT item id this comment is attached to. */
  itemId: number;
  /** The URL the item linked. Cited verbatim in the model's evidenceRefs. */
  sourceUrl: string;
  /** Comment author login, e.g. "davidoladeji-ogenticai". */
  author: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Comment body. May be truncated — see `LINKED_COMMENT_BODY_MAX_CHARS`. */
  body: string;
  /** True when `body` was truncated for prompt budget. */
  truncated: boolean;
}

/**
 * Hard cap on a linked comment's body in the prompt. Authors occasionally
 * paste large logs; we trim past this so the diff isn't crowded out. Pinned
 * in tests so the truncation marker is reproducible.
 */
export const LINKED_COMMENT_BODY_MAX_CHARS = 2000;

export interface BuildPromptArgs {
  pr: PrContext;
  ticket: LinearTicketContext;
  checklist: UatChecklist;
  /** Unified diff produced by `git diff <base>..<head>` or `gh pr diff`. */
  diff: string;
  /**
   * Same-PR comments fetched by the orchestrator for ticked items that link
   * a comment. Empty / undefined when no item triggered a fetch — in that
   * case the prompt omits the "## Linked verification comments" section
   * entirely so unrelated PRs see byte-identical output to v1.
   */
  linkedComments?: LinkedComment[];
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
  const { pr, ticket, checklist, diff, linkedComments } = args;

  const items = checklist.items
    .map((it) => {
      const annotations = [
        it.checked ? "author marked done" : null,
        // OGE-1559: the author declared this one as needing a person. Say so
        // explicitly rather than letting the model burn reasoning deciding it
        // can't verify a clinician sign-off from a diff.
        it.human ? "human sign-off — do not attempt to verify" : null,
      ].filter((a): a is string => a !== null);
      const suffix = annotations.length > 0 ? ` (${annotations.join("; ")})` : "";
      return `${it.id}. ${it.text}${suffix}`;
    })
    .join("\n");

  const checklistBlock = checklist.found
    ? items
    : "(No `## UAT checklist` block found in the PR description.)";

  const linkedCommentsSection = renderLinkedCommentsSection(linkedComments);

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
    ...(linkedCommentsSection ? [linkedCommentsSection, ``] : []),
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
    `- **PARTIAL** — partially done. Use sparingly and explain. Also the ceiling`,
    `  for the ticked-with-verification-comment promotion path — see below.`,
    `- **UNVERIFIABLE** — cannot be checked from the diff alone (visual claims, manual`,
    `  reproduction steps, etc). Explain why a human is needed.`,
    ``,
    `Author tick-marks alone are advisory — don't trust them. Decide from the diff.`,
    ``,
    `**Items marked "human sign-off"** were explicitly declared by the author as`,
    `needing a person (clinician approval, design judgment, docs clarity). Return`,
    `**UNVERIFIABLE** for these with a one-line rationale naming who needs to look.`,
    `Don't argue with the designation and don't spend effort trying to verify them —`,
    `they're excluded from the merge gate downstream.`,
    ``,
    `**Exception (ticked-box + verification comment):** if a UAT item is ticked`,
    `(\`(author marked done)\` annotation above) AND the "## Linked verification`,
    `comments" section contains a comment attached to that item whose body has`,
    `on-topic verification evidence (a code fence with command + output, "Verified:"`,
    `/ "PASS" markers, screenshots, logs), you MAY return **PARTIAL** for that item`,
    `and MUST cite the comment URL in \`evidenceRefs\` as \`{ "kind": "external",`,
    `"url": "...", "note": "..." }\`. Self-verification by the author cannot upgrade`,
    `an UNVERIFIABLE item past PARTIAL — only the diff itself can produce PASS, and`,
    `a clear diff-supported PASS is unaffected by this rule. If the linked comment`,
    `is missing, off-topic, or has no verification block, leave the verdict at`,
    `UNVERIFIABLE and note "linked comment had no verification block" in the`,
    `rationale.`,
    ``,
    `**Optional auto-patch hint:** for any item where status === "FAIL" AND the gap is`,
    `clearly mechanical (missing test for an explicitly-asserted behavior; missing`,
    `docstring on a public function; a README claim that doesn't match the code; a`,
    `version-string that wasn't bumped), set \`"autoPatchable": true\`. Default false.`,
    `Only flag an item autoPatchable when you could write the fix yourself from the`,
    `diff context alone — design questions, business decisions, and visual claims`,
    `must always be \`autoPatchable: false\`.`,
    ``,
    `## Output shape — return JSON only, no prose`,
    ``,
    `One JSON object with this shape (the agent fills in the rest of the envelope):`,
    ``,
    "```json",
    `{`,
    `  "items": [`,
    `    {`,
    `      "id": 1,`,
    `      "itemText": "verbatim copy of the UAT item text from the list above",`,
    `      "status": "PASS",`,
    `      "rationale": "one to three sentences",`,
    `      "evidenceRefs": [`,
    `        { "kind": "file", "path": "src/foo.py" },`,
    `        { "kind": "lines", "path": "src/foo.py", "start": 42, "end": 58 },`,
    `        { "kind": "test", "path": "tests/test_foo.py", "name": "test_round_trip" },`,
    `        { "kind": "external", "url": "https://github.com/...", "note": "rendered README" }`,
    `      ],`,
    `      "autoPatchable": false`,
    `    }`,
    `  ],`,
    `  "summary": "1-2 sentence overall summary"`,
    `}`,
    "```",
    ``,
    `Rules:`,
    `- One item per UAT entry, in the same order as the numbered list above.`,
    `- \`id\` is 1-based and matches the numbering in the UAT checklist.`,
    `- \`itemText\` is the verbatim item text from the checklist (no edits).`,
    `- \`evidenceRefs\` is always an array of objects with a \`"kind"\` field. Never bare strings.`,
    `- \`autoPatchable\` is optional; omit when status !== "FAIL".`,
    `- No code fences around the JSON. No prose before or after.`,
  ].join("\n");
}

/**
 * Render the "## Linked verification comments" prompt section, or null if
 * there are no comments to attach. The orchestrator passes only same-PR
 * comments that the gate (ticked + linked + matching owner/repo/PR-number)
 * accepted, so any LinkedComment that lands here is in scope.
 *
 * Stable across runs given the same inputs — important for the determinism
 * contract. Order is preserved from `linkedComments` (orchestrator preserves
 * checklist order).
 */
function renderLinkedCommentsSection(
  linkedComments: LinkedComment[] | undefined,
): string | null {
  if (!linkedComments || linkedComments.length === 0) return null;
  const blocks = linkedComments.map((lc) => {
    const truncatedNote = lc.truncated ? "\n\n... [truncated]" : "";
    return [
      `Item ${lc.itemId} → comment by @${lc.author} (${lc.createdAt}) — ${lc.sourceUrl}`,
      ``,
      "```",
      `${lc.body}${truncatedNote}`,
      "```",
    ].join("\n");
  });
  return [
    `## Linked verification comments`,
    ``,
    `The following comments were linked from ticked UAT items. Use them only`,
    `under the ticked-box exception described in the "Status meanings" section`,
    `below — they cap a verdict at PARTIAL, never PASS.`,
    ``,
    blocks.join("\n\n"),
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
