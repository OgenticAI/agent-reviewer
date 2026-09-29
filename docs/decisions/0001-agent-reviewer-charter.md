# 0001. Reviewer Bot charter

- Agent: `agent-reviewer`
- Status: Accepted
- Date: 2026-09-29
- Filed by: david@ogenticai.com

## Context

**01 Principal.** Who does it serve?

> David Oladeji, CTO, who owns engineering and set the rule that every OgenticAI pull request carries a UAT checklist. The maintainers of each repository it reviews are its day-to-day audience.
>
> Sources: OgenticAI/agent-reviewer README and CLAUDE.md, registry/teammate-agents.yml (agent-reviewer), registry/humans.yml.

**03 Incumbent.** Who holds that job today, and why is that not enough?

> Nobody. Every pull request already had a UAT checklist, and nothing enforced it: checklists were written and then ignored at merge. The factory's own reviewer panel checks factory PRs before checkpoint 3; this bot checks every PR, whoever wrote it.

Existing agents shown as overlapping when this was filed (question 03 was answered with these in view):

- `02-coordinator` (ops) — Turns a triaged request into an actionable Linear ticket — objective, acceptance criteria as checkboxes, action plan, owner, tier, and approver. Runs after inta — shared: acceptance, criteria, linear, request, ticket
- `01-intake-triage` (ops) — Read-only first responder. Classifies an incoming ops request (domain, urgency, requester, tier), dedupes against open tickets, and drafts the ticket stub. ALWA — shared: against, request, ticket, tickets
- `05-ops-verifier` (ops) — Read-only truth-teller. Confirms an executed ops action actually happened, captures evidence onto the ticket, ticks the acceptance criteria, and only then moves — shared: acceptance, criteria, evidence, ticket
- `02-story-writer` (engineering) — Turns a rough feature idea plus researcher findings into a clear user story with acceptance criteria. Runs after researcher, before spec-writer. Output is the f — shared: acceptance, criteria
- `06-test-verifier` (engineering) — Writes acceptance tests against the approved user story. Verifies the feature actually does what the story said. Does NOT fix code — reports failures back to th — shared: acceptance, against
- `08-ai-eval-engineer` (engineering) — Writes and runs LLM evals against the story's AI behaviour criteria. Runs only when the feature touches an LLM. Reports an eval scorecard alongside the test ver — shared: against, criteria
- `09-security-reviewer` (engineering) — Security-focused review of every PR before merge. Read-only. Runs after the validator. Reports findings grouped by severity. Required for all features before ch — shared: merge, review
- `18-deploy-fitness-reviewer` (engineering) — Checks the diff against the ACTUAL deploy runtime (serverless / edge), catching code that passes every test but throws in production. Read-only. Reviewer-panel  — shared: against, reviewer
- `software-factory` (engineering) — Software Factory — turns a Linear ticket into a vetted PR end-to-end (3 human checkpoints), for ops requests that need code shipped — shared: linear, ticket

## Decision

**02 Job.** What job does it hold?

> Review every OgenticAI pull request against the UAT checklist of its linked Linear ticket. For each item it gives a verdict (PASS, FAIL, PARTIAL or UNVERIFIABLE) with evidence, posts one sticky comment, publishes the OgenticAI Reviewer / UAT check that gates the merge, mirrors the verdict to the ticket, and opens a child ticket for each failed item so the dropped work is not lost.
>
> A second agent reviewing PRs against their tickets' acceptance criteria would be on this job.

**04 Harnesses.** Where does it run?

> A GitHub Action (OgenticAI/agent-reviewer/.github/actions/review) that each repository calls from its own workflow on pull request events. It acts as a GitHub App, reaches Linear through the Linear API, and makes one Claude call at temperature 0 per push. The same code also ships as a Claude Code plugin, /review-pr, for local runs. Its home channel is #orgwide-repo-updates.

**05 Memory.** Where does its memory start and stop?

> Reads the pull request, its diff, the linked ticket's checklist, and any comment an author links as verification evidence. It keeps no memory between runs: the sticky comment is updated in place, and the verdict lives on the PR and the ticket.

## Consequences

**06 Tier.** What sits behind approval?

> Unattended within its lane: it comments, sets its own check, moves the Linear ticket between review states, and opens Fix UAT child tickets. It cannot merge, and it cannot do ops or admin work. A maintainer can override a failing check with /uat-override and a reason; the original verdict stays in the comment as the audit trail. Drafting patch PRs is off unless a repository opts in.

**07 Reporting.** How do activity, failures and cost report?

> The sticky verdict comment and the OgenticAI Reviewer / UAT check on the pull request, a mirrored comment and status on the Linear ticket, and Fix UAT child tickets for failures. Repository updates land in #orgwide-repo-updates.

**08 Harm.** Who could it harm, how, and what would they do about it?

> Engineers and the users of whatever ships: a false PASS lets an unmet criterion merge, and a false FAIL blocks good work. A maintainer can override the check with a stated reason, and David would correct the checklist or the rule, since the override stays on record.

---

Filed through Mission Control (OGE-2797). This record is not edited. When the remit changes, a new record supersedes it.
