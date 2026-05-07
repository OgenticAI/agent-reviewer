# Chaos / regression runbook

Live-exercise records for the OgenticAI Reviewer's edge-case code paths. Each section corresponds to one chaos item from [OGE-391](https://linear.app/ogenticai/issue/OGE-391); the audit comment on the source ticket links back here.

The throwaway-PR pattern mirrors the OGE-365 / OGE-380 verification flow: open a branch, push the trigger, capture evidence, close without merge.

---

## A. Failure-mode → `neutral` Check (OGE-340)

**What it tests.** Any reviewer exception (Linear unreachable, Anthropic 401, malformed model output) must map to GitHub Check `conclusion: neutral`, never `failure`. Code path: `.github/actions/review/action.yml` `set +e` (line 88) + `ERROR|*) conclusion="neutral"` (line 129).

**Method.** Open a throwaway PR whose branch name carries a non-existent Linear ticket id (`oge-99999-…`). The reviewer's `resolveTickets` picks it up; `linear.getIssue("OGE-99999")` throws 404; the CLI propagates the exception and exits non-zero; the action wrapper's `set +e` catches the failure and sets `overall=ERROR`.

**Run.** [agent-reviewer#19](https://github.com/OgenticAI/agent-reviewer/pull/19) (closed). Workflow [run 25494410717](https://github.com/OgenticAI/agent-reviewer/actions/runs/25494410717).

**Evidence (from run log).**

```
Reviewer exit code: 1
Overall verdict: ERROR
OVERALL: ERROR
…
"conclusion":"neutral","output":{"title":"UAT verdict: ERROR"}
```

**Outcome.** ✅ Check published as `neutral` (not `failure`). Merge button stays available. No sticky comment posted (the verdict was never produced).

**Replay.** Branch from `main` with any branch name matching `oge-NNNNN` where NNNNN is large enough not to exist in Linear. Push. Observe the Check resolves to `neutral` and the workflow itself completes successfully.

> **Variant — malformed `ANTHROPIC_API_KEY`:** the same code path fires whenever the CLI throws after parsing args. Documented as covered by the same wiring; not separately exercised because rotating the org secret would break every active reviewer run.

---

## B. All-PASS + green CI → "Ready to Merge" Linear transition (OGE-339)

**What it tests.** When every UAT item is PASS and CI is green, the reviewer's writeback should transition the linked Linear ticket "In Review" → "Ready to Merge" (`pickStatusTransition` in `src/linear/writeback.ts:268-273`).

**Method.** Open a throwaway PR with a UAT checklist where every item is unambiguously verifiable from the diff: file existence, exact heading text, literal marker string. The model returns 3/3 PASS.

**Run.** [agent-reviewer#20](https://github.com/OgenticAI/agent-reviewer/pull/20) (closed). Verdict: ✅ all-PASS confirmed in the sticky.

**Outcome.** ⚠️ **Partially verified.**

- ✅ Verdict was 3/3 PASS — overall `PASS`.
- ✅ Reviewer Bot posted the verdict comment on OGE-391 (Linear writeback comment-path works).
- ❌ **Status transition did NOT fire.** Run log: `[linear:comment:create] [linear:status:noop] children=0 errors=0`.

**Root cause discovered.** `isCiGreen` in `src/cli.ts:451-466` calls `octokit.repos.getCombinedStatusForRef` and short-circuits to `return false` when `status.data.state !== "success"`. On `agent-reviewer` (and any repo with no commit-statuses, only Checks), this combined-status state is `pending` because the `contexts` array is empty. The pure `pickStatusTransition` logic is correct given its inputs; the wrapper's CI gate is overly conservative.

```bash
$ gh api repos/OgenticAI/agent-reviewer/commits/<sha>/status --jq '{state, contexts}'
{"contexts":[],"state":"pending"}
```

Followup ticket recommended: harden `isCiGreen` to treat "no statuses + all checks green" as `ciGreen=true` (or use `checks.listForRef` exclusively).

**Replay.** Same PR shape as above. Watch the run log for `linear:status:noop` (current bug) vs `linear:status:update→Ready to Merge` (post-fix).

---

## C. FAIL items → child Linear issue creation + idempotency (OGE-339)

**What it tests.** For every FAIL or PARTIAL item, the reviewer's writeback should create a child Linear issue titled `Fix UAT: <truncated item>` under the parent. Re-running the reviewer on the same PR (no-op trigger) must NOT create a duplicate.

**Method.** Throwaway PR with a UAT item the diff does NOT deliver: claim "file contains `second-marker-not-here`" against a file that explicitly says it does NOT contain that string. Model returns FAIL.

**Run.** [agent-reviewer#21](https://github.com/OgenticAI/agent-reviewer/pull/21) (closed). Initial run + a no-op-trigger second run.

**Evidence.**

- ✅ Sticky verdict: ❌ FAIL on item 1, ✅ PASS on item 2. Overall `NEEDS_WORK` → Check `failure` (because `fail_on: NEEDS_WORK` is set on agent-reviewer's self-review).
- ✅ Child issue [OGE-392](https://linear.app/ogenticai/issue/OGE-392) created under parent OGE-391 by Reviewer Bot. Title: `Fix UAT: item 1: docs/throwaway/oge-391-chaos-C.md contains the literal string…`. Body links back to PR #21 with the rationale.
- ✅ Idempotency: pushed a no-op commit to retrigger the reviewer. Run completed; sticky updated; **no second `Fix UAT: …` issue created** under OGE-391. The de-dup keys on title.
- ✅ Bonus: chaos F's reviewer run ([#23](https://github.com/OgenticAI/agent-reviewer/pull/23)) also produced a child issue [OGE-393](https://linear.app/ogenticai/issue/OGE-393) under OGE-391 — the FAIL-→-child path fires reliably across PRs.

**Outcome.** ✅ Both ACs verified live.

**Replay.** Branch with one diff-contradicting UAT item; push; observe child issue created; push no-op; observe no duplicate.

---

## D. Non-maintainer override rejection (OGE-366)

**What it tests.** The override action's auth gate validates the commenter's collaborator permission via `octokit.repos.getCollaboratorPermissionLevel` (`src/cli.ts:400-411`). A user without `write`/`maintain`/`admin` must be rejected.

**Method.** Switch active gh user to `davido-spendrule` (read-only collaborator on `OgenticAI/agent-reviewer`); post `/uat-override` on an open PR.

**Run.** Override workflow [run 25494845891](https://github.com/OgenticAI/agent-reviewer/actions/runs/25494845891) on PR #20. Comment: [issuecomment-4396959496](https://github.com/OgenticAI/agent-reviewer/pull/20#issuecomment-4396959496).

**Evidence (from run log).**

```
ACTOR: davido-spendrule
[deny] @davido-spendrule does not have write/maintain/admin on OgenticAI/agent-reviewer
```

**Outcome.** ✅ Verified live. Workflow `conclusion: success` (the workflow itself ran cleanly), but the override action's CLI rejected internally and did NOT flip the `OgenticAI Reviewer / UAT` Check or post on Linear.

**Replay.** `gh auth switch --user <non-collaborator>`; comment `/uat-override <reason>` on any PR with the override workflow installed; observe the `[deny]` log line and the unchanged Check.

---

## E. Ticked + linked-empty-comment → UNVERIFIABLE (OGE-365)

**What it tests.** When a UAT item is ticked AND links a same-PR comment but the comment has no on-topic verification evidence (no code-fenced output, no "Verified:" markers), the verdict must stay UNVERIFIABLE — not promote to PARTIAL. Anti-rubber-stamp guard.

**Method.**

1. Open throwaway PR with an unticked UAT item.
2. Post a vapid comment on the PR (body: "see above").
3. Edit PR body to tick the item + link to the vapid comment.
4. Push a no-op commit to retrigger the reviewer.
5. Reviewer fetches the comment, sees no evidence, stays UNVERIFIABLE.

**Run.** [agent-reviewer#22](https://github.com/OgenticAI/agent-reviewer/pull/22) (closed). Vapid comment: [issuecomment-4396971172](https://github.com/OgenticAI/agent-reviewer/pull/22#issuecomment-4396971172).

**Evidence (from sticky).**

> Item 1: 🤔 UNVERIFIABLE — *"that comment contains only 'see above' with no verification block, command output, screenshots, or PASS markers. Per the ticked-box exception rule, linked comment had no verification block, so the verdict stays UNVERIFIABLE."*

**Outcome.** ✅ Verified live. Anti-rubber-stamp guard preserved.

**Replay.** Open a PR with one UAT item; post a vapid comment; tick + link; push trigger; observe UNVERIFIABLE with the exact rationale fragment "linked comment had no verification block".

---

## F. Auto-patch draft PR (OGE-341)

**What it tests.** When `auto_patch: true` AND the verdict has a FAIL item with `autoPatchable: true`, the action's auto-patch step fires `anthropics/claude-code-action@v1` with a focused prompt; the inner action opens a draft PR `chore(uat): suggest fixes for <branch>`.

**Method.** Throwaway PR adding `src/foo-chaos.ts` (with `bar(): number { return 42 }`) but NO test. UAT item asserts `tests/foo-chaos.test.ts` exists and asserts the return value (mechanical FAIL — missing test for explicit behavior). Branch flips `auto_patch: "true"` in `self-review.yml` (branch-only override).

**Run.** [agent-reviewer#23](https://github.com/OgenticAI/agent-reviewer/pull/23) (closed). Workflow run completed with `conclusion: success`.

**Evidence (from run log).**

```
"autoPatchable": true                                       # ✅ model flagged
should=true                                                 # ✅ auto-patch decision = true
Run anthropics/claude-code-action@v1                        # ✅ inner action invoked
prompt: "The OgenticAI Reviewer flagged the following UAT
        items on PR #23 as mechanically fixable failures…"  # ✅ prompt rendered correctly
```

**Outcome.** ⚠️ **Wiring verified; downstream PR creation didn't fire.**

- ✅ The reviewer correctly identified the FAIL as `autoPatchable: true`.
- ✅ The action's gate (`should_autopatch`) evaluated `true`.
- ✅ `claude-code-action@v1` was invoked with the right prompt.
- ✅ Child Linear issue [OGE-393](https://linear.app/ogenticai/issue/OGE-393) was created (separate writeback path also works).
- ❌ **No draft PR titled `chore(uat): suggest fixes for david/oge-391-chaos-F-auto-patch` appeared.** The `claude-code-action@v1` step exited cleanly but did not create a branch or PR.

Likely cause: the inner action's GitHub App token (minted with `actions/create-github-app-token@v1` and passed via `github_token`) has the right scopes for *commenting* but the inner action also needs to create branches and push commits, and either the model declined to commit (the prompt has a "if a fix isn't obvious or safe, skip it" escape) or the runner's checked-out workspace was the action's `github.action_path`-relative dir, not the consumer-PR head branch.

Followup ticket recommended: instrument the auto-patch step with explicit error capture so the next time it doesn't create a PR, we know whether the model declined or the tooling failed.

**Replay.** Same setup. Watch the inner `claude-code-action@v1` step's logs (currently truncated by GitHub's run-log redaction).

---

## G. Pilot dashboard Linear view (OGE-341)

**Status.** ⏸️ **Needs manual user action.** The Linear MCP exposes issue / label / attachment / comment creation but **no view-creation tool** (verified by `ToolSearch` for "linear view filter create" — only Notion has `create-view`). Linear views can only be created via the Linear web UI.

**Recommended setup (for the maintainer):**

1. In Linear, navigate to the **OgenticAI Reviewer** project (`projectId: 015abff9-53b6-49b7-a139-b47e0e9368f2`).
2. **New view** → name it `OgenticAI Reviewer · Pilot`.
3. Filters:
   - Project = OgenticAI Reviewer (implicit)
   - Has comment by `Reviewer Bot` OR Has label `uat-override` OR Parent issue is OGE-NNN where the parent itself was reviewer-touched.
4. Visualization: group by status; add a count summary row.
5. Save the view URL and add a link to `agent-reviewer/README.md` under a new `## Dashboard` subsection.

---

## H. Plugin marketplace listing (OGE-341)

**Status.** ⏸️ **Needs manual user action.** The Claude Code plugin manifest at `.claude-plugin/plugin.json` is locally installable; the README architecture diagram references "the same logic ships as a Claude Code plugin." Whether OgenticAI runs an internal plugin marketplace (vs publishing publicly) is an organizational decision outside this repo's code.

**Recommended setup (for the maintainer):**

1. If publishing to a centralized OgenticAI marketplace: follow the marketplace's onboarding flow with `name: ogenticai-reviewer`, `version: 0.1.0`.
2. If keeping it in-repo only: update `agent-reviewer/README.md` with a copy-pasteable `claude plugin install <git-url>` snippet pointing at the repo + `.claude-plugin/plugin.json` path.
3. Parity test: from a clean `~/.claude/plugins/`, install the plugin; run `/review-pr <github-pr-url>` against an existing PR; confirm the verdict matches the latest sticky comment on that PR (proves the plugin's `runReview()` agrees with the Action's).

---

## Summary table

| Item | Status | AC verdict |
|---|---|---|
| A. Failure-mode → neutral | ✅ Live | OGE-340 AC verified |
| B. All-PASS → Ready to Merge | ⚠️ Partial | OGE-339 AC verified for verdict + comment path; status-transition path blocked by `isCiGreen` bug |
| C. FAIL → child issue + idempotency | ✅ Live | OGE-339 AC verified |
| D. Non-maintainer override rejected | ✅ Live | OGE-366 AC verified |
| E. Ticked + linked-empty → UNVERIFIABLE | ✅ Live | OGE-365 AC verified |
| F. Auto-patch draft PR | ⚠️ Partial | OGE-341 AC: wiring fires; downstream PR creation didn't |
| G. Pilot dashboard Linear view | ⏸️ Manual | OGE-341 AC: needs Linear UI work |
| H. Plugin marketplace listing | ⏸️ Manual | OGE-341 AC: needs marketplace decision + publish |

**Followup tickets to file:**

- `isCiGreen` returns false when commit has no statuses — blocks the OGE-339 Ready-to-Merge transition in normal flow.
- Auto-patch downstream PR creation didn't fire — `claude-code-action@v1` invoked but no branch/PR created. Add error capture; investigate why.
