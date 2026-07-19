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
import type { ResearchPolicy } from "../research/policy.js";
import { renderCiSection, type CiSummary } from "../ci/summary.js";
import { fenceUntrusted, sanitizeUntrusted, UNTRUSTED_CONTENT_RULE } from "../tools/sanitize.js";

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
  /**
   * Whether the server-side web-search tool is attached to this request
   * (OGE-1566). Changes the grounding rules the model is given: with search
   * available it is told to look things up and cite them; without it, it is
   * told to stop at the edge of what the diff supports rather than reaching
   * into memory. Omitted defaults to disabled, which keeps prompts for
   * non-research repos byte-identical to v2.
   */
  research?: ResearchPolicy;
  /**
   * Check runs and commit statuses for the head SHA (OGE-1554). Omitted keeps
   * the prompt byte-identical to v2 for callers that don't supply it.
   */
  ci?: CiSummary;
}

const DISABLED_RESEARCH: ResearchPolicy = {
  enabled: false,
  reason: "not requested",
  allowedDomains: [],
  maxUses: 0,
};

/**
 * The grounding rules for `[human]` items, which differ by whether the model
 * can actually look anything up.
 *
 * Both branches enforce the same principle — never assert a domain fact you
 * can't point at a source for — but the available move differs. Without
 * search, the honest move is to stop and name what would need checking. With
 * search, the honest move is to go and check, then cite.
 */
function groundingRules(research: ResearchPolicy): string[] {
  if (!research.enabled) {
    return [
      `Ground every claim in the diff or the ticket, and cite it. Do NOT assert`,
      `domain facts from memory — no clinical, legal, regulatory, or standards claims`,
      `you cannot point at a source for. A confident wrong claim about DSM-5 is worse`,
      `than silence, because it anchors the expert who reads it. If narrowing the`,
      `question requires domain knowledge you can't cite, say exactly what would need`,
      `to be checked and stop there.`,
    ];
  }
  return [
    `You have a **web_search** tool, limited to authoritative sources`,
    `(${research.allowedDomains.slice(0, 6).join(", ")}, and similar) and to`,
    `${research.maxUses} searches for this whole review. Use it only to settle the`,
    `factual half of a "human sign-off" item — whether the code's categories,`,
    `names, or values actually match the standard the criterion names.`,
    ``,
    `Rules for searching:`,
    `- Search for the **standard**, not for this PR. Query things like`,
    `  "HIPAA Safe Harbor 18 identifiers" — never paste code, diff hunks, file`,
    `  contents, or ticket text into a query.`,
    `- Cite every source you rely on in \`evidenceRefs\` as`,
    `  \`{ "kind": "external", "url": "<the URL the search returned>", "note": "..." }\`.`,
    `  Use the URL verbatim from the search results. A citation that did not come`,
    `  back from a search this run will be dropped before the comment is posted,`,
    `  taking the claim's support with it.`,
    `- Still do NOT assert a domain fact you did not find a source for. If the`,
    `  searches don't settle it, say what remains open and stop — that is a useful`,
    `  briefing too.`,
    ``,
    `Searching never changes the verdict: a "human sign-off" item stays`,
    `**UNVERIFIABLE** no matter what you find. Research narrows the question for`,
    `the person signing; it does not substitute for the signature.`,
  ];
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
  const research = args.research ?? DISABLED_RESEARCH;

  const items = checklist.items
    .map((it) => {
      const annotations = [
        it.checked ? "author marked done" : null,
        // OGE-1559: the author declared this one as needing a person. The
        // verdict is fixed at UNVERIFIABLE, but the model should still narrow
        // the question for whoever signs — see the "human sign-off" block in
        // the task section below.
        it.human ? "human sign-off — brief the reviewer, don't rule on it" : null,
      ].filter((a): a is string => a !== null);
      const suffix = annotations.length > 0 ? ` (${annotations.join("; ")})` : "";
      return `${it.id}. ${it.text}${suffix}`;
    })
    .join("\n");

  const checklistBlock = checklist.found
    ? items
    : "(No `## UAT checklist` block found in the PR description.)";

  const linkedCommentsSection = renderLinkedCommentsSection(linkedComments);
  // CI job names and statuses come from workflow files in the PR — a job can
  // be named to look like an instruction. Fenced like everything else.
  const rawCi = args.ci ? renderCiSection(args.ci, pr.headSha) : null;
  const ciSection = rawCi
    ? fenceUntrusted(sanitizeUntrusted(rawCi), { source: "ci-status" })
    : null;

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
    fenceUntrusted(sanitizeUntrusted(ticket.description.trim() || "_(empty)_"), {
      source: "linear-ticket",
    }),
    ``,
    `## UAT checklist (from PR description)`,
    ``,
    // Checklist text is PR-authored prose, so it is both sanitized (hidden
    // instructions stripped) and fenced.
    fenceUntrusted(sanitizeUntrusted(checklistBlock), { source: "uat-checklist" }),
    ``,
    ...(ciSection ? [ciSection, ``] : []),
    ...(linkedCommentsSection ? [linkedCommentsSection, ``] : []),
    `## Diff to review`,
    ``,
    // The diff is written by whoever opened the PR and their merge depends on
    // this verdict — it is the single most attacker-influenced input we have
    // (OGE-1579). Fenced, not sanitized: stripping HTML comments out of a diff
    // would corrupt the code under review. The fence plus the standing rule is
    // the mitigation here.
    fenceUntrusted(["```diff", diff, "```"].join("\n"), { source: "pr-diff" }),
    ``,
    `## Your task`,
    ``,
    UNTRUSTED_CONTENT_RULE,
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
    `- **CODE_VERIFIED** — the code plainly delivers the item and you have evidence`,
    `  for it, but proving it end-to-end would need running the system. Use this`,
    `  instead of UNVERIFIABLE whenever the code-level answer is positive and only`,
    `  runtime validation is missing. It is an affirmative result, it does not gate`,
    `  the merge, and it is NOT a punt — say what you verified and what remains.`,
    `- **UNVERIFIABLE** — you investigated and still cannot tell. Name the specific`,
    `  capability you lacked ("no way to run the suite", "needs a person to look").`,
    ``,
    `Author tick-marks alone are advisory — don't trust them. Decide from the diff.`,
    ``,
    `**Confidence, and when a punt is legitimate.** Give every item a`,
    `\`confidence\` between 0 and 1, and list what you actually looked at in`,
    `\`evidence\` ("read src/foo.ts:40-58", "CI job \`test\` reported success").`,
    ``,
    `- Above **0.7** you know the answer — commit to PASS, CODE_VERIFIED, PARTIAL,`,
    `  or FAIL. Hedging to UNVERIFIABLE at high confidence is the single most`,
    `  common failure in this reviewer's history and is not acceptable.`,
    `- **0.4–0.7** usually means PARTIAL or CODE_VERIFIED with the gap stated —`,
    `  not a punt.`,
    `- Below **0.4**, UNVERIFIABLE is right, and \`evidence\` must name the missing`,
    `  capability rather than restating the item.`,
    ``,
    `Do not inflate confidence to avoid a punt. A confident wrong PASS on a`,
    `merge-gating check is far worse than an honest UNVERIFIABLE — the point of`,
    `the confidence field is that both mistakes are visible afterwards.`,
    ``,
    `**Items marked "human sign-off"** were explicitly declared by the author as`,
    `needing a person (clinician approval, design judgment, docs clarity). Always`,
    `return **UNVERIFIABLE** for these — the sign-off is an attestation and only a`,
    `person can give it. They're excluded from the merge gate downstream.`,
    ``,
    `But "a person must sign it" is not "you have nothing to contribute". Most such`,
    `items bundle an *attestation* with a *factual question the reviewer can narrow*`,
    `— "clinician confirms the PHI categories match DSM-5 practice" is a signature`,
    `plus a concrete question about what the code actually enumerates. Use the`,
    `rationale to hand the reviewer a briefing: what the diff actually does, which`,
    `specific cases look routine, and which one or two need their attention. Turn`,
    `"someone should look at this" into "check line 40 — the rest is mechanical".`,
    ``,
    ...groundingRules(research),
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
      // A verification comment is written by the PR author to argue their own
      // item should pass — squarely adversarial input (OGE-1579).
      fenceUntrusted(sanitizeUntrusted(`${lc.body}${truncatedNote}`), {
        source: "pr-comment",
        attrs: { item: String(lc.itemId), author: lc.author },
      }),
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
  `or a concrete claim from the evidence you gathered.`,
  ``,
  `**You may investigate before deciding.** When tools are available, use them:`,
  `read the file the diff didn't show you, check what CI actually reported, look`,
  `up the standard a criterion names. UNVERIFIABLE means "still unverifiable`,
  `**after** investigating" — not "not visible in the diff". Reaching for it`,
  `without having tried the tools in front of you is the failure mode to avoid;`,
  `it is the answer that was correct when you were blind, and it is what made`,
  `this reviewer punt on 88% of items. Earn it before you use it.`,
  ``,
  `UNVERIFIABLE is still the right answer for things no tool can settle — a`,
  `visual judgment, a clinician's sign-off, an action that happens after merge.`,
  `Say which, and say what you tried.`,
  ``,
  `You return ONE JSON object matching the \`ReviewVerdict\` schema. No prose`,
  `outside the JSON. No markdown code fences around the JSON. The same diff +`,
  `same checklist must produce the same verdicts every run; you are deterministic`,
  `at temperature 0.`,
  ``,
  `Reviewer version: ${REVIEWER_VERSION}.`,
  `Sticky comment marker: ${COMMENT_MARKER}.`,
].join("\n");
