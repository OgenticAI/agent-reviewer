# OgenticAI Reviewer

> An AI engineer that lives in GitHub. Reviews each PR against its linked Linear ticket's UAT checklist, comments per-item like a human reviewer, blocks merge on failure, and files follow-ups.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/OgenticAI/agent-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/OgenticAI/agent-reviewer/actions/workflows/ci.yml)

## What it does

Every OgenticAI PR follows the same convention: a `## UAT checklist` block in the description with `- [ ]` items. Today nobody enforces it — checklists get written and ignored. This bot fixes that.

On every `pull_request: [opened, synchronize, ready_for_review]` event:

1. Resolves the linked Linear ticket from the branch name or PR body (`OGE-NNN`).
2. Pulls the ticket + its UAT checklist via the Linear MCP.
3. Reads the PR diff.
4. For each UAT item, decides **PASS / FAIL / PARTIAL / UNVERIFIABLE** with a short rationale and evidence.
5. Posts (or updates) a single **sticky comment** on the PR with a per-item verdict table.
6. Mirrors the verdict to the Linear ticket; transitions status; opens follow-up child issues for FAIL items.
7. Sets a GitHub Check `OgenticAI Reviewer / UAT` — `success` / `failure` / `neutral`.
8. Optionally drafts a patch PR for mechanically-fixable failures.

A `/uat-override <reason>` slash command in a PR comment from a maintainer flips the Check to success and logs the override on the Linear ticket.

## Architecture

```
any OgenticAI repo
   └── .github/workflows/ogenticai-reviewer.yml
         └── uses: OgenticAI/agent-reviewer/.github/actions/review@v1
                ├── mints a GitHub App token (actions/create-github-app-token)
                ├── runs the agent CLI exactly once per push:
                │     tsx src/cli.ts review-pr <url> --post --output-json verdict.json
                │       ├── fetches PR + diff via Octokit
                │       ├── resolves Linear ticket from branch / body / title
                │       ├── fetches the ticket via Linear GraphQL
                │       ├── parses the ## UAT checklist block
                │       ├── ONE call to Claude (temperature 0) → verdict JSON
                │       ├── renders the deterministic sticky comment
                │       └── upserts the comment via the App token
                └── publishes a Check "OgenticAI Reviewer / UAT" based on overall
```

**Why one LLM call (and not the model-driven `claude-code-action` tool loop):** stable verdicts. Letting the model orchestrate every step (parse, render, upsert) means tool-call ordering and intermediate decisions vary between runs. By doing the deterministic plumbing (parser, renderer, upserter) in TypeScript and using the model only for the per-item judgement, the same diff + same checklist produces the same verdicts on every push. That's what the "no comment churn" promise actually requires.

The same logic also ships as a **Claude Code plugin**: `/review-pr <github-pr-url>` runs the review locally during a cowork session for a faster feedback loop. The plugin and the Action are the same code path — `src/review.ts`'s `runReview()` — so a verdict produced locally matches what CI would produce.

## Substrate (build-not-buy)

Built on top of the production-ready Anthropic infrastructure OgenticAI already pays for, plus a thin custom layer for the UAT-checklist semantics that nothing on the market handles:

- [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) — the GitHub Action runtime that calls Claude with MCP servers attached.
- The existing **Linear MCP** wires read+write Linear access into the Action's tool surface.
- `@octokit/rest` + a GitHub App identity (registered once per org) own the comment + check writes.
- A small **TypeScript core** (this repo) defines the verdict schema, the prompt, the sticky-comment renderer, and a CLI entry point for the plugin path.

We surveyed the alternatives before building — see the [build vs buy notes](docs/BUILD_VS_BUY.md). The short version: CodeRabbit ($24/dev/mo) added Linear "Issue Planner" read-context in early 2026 but has no per-checkbox verdict semantics and no structured Linear writeback. Greptile, Sourcery, Cody, Sweep, and Devin reviewer-mode all stop one step short of "review against the linked ticket's checklist." The piece nothing in the market sells — *map every UAT checkbox to a verdict, comment back to both PR and Linear, gate the merge, file follow-up tickets* — is the entire product.

## Repo layout

```
agent-reviewer/
├── src/
│   ├── parser/uat.ts          UAT-checklist parser (the parser of record)
│   ├── schema/verdict.ts      ReviewVerdict zod schema (status, evidence, etc.)
│   ├── schema/event.ts        PrContext + LinearTicketContext shapes
│   ├── linear/resolve.ts      Branch/body/title → OGE-NNN resolver
│   ├── prompt/review.ts       Per-item verdict prompt + system message
│   ├── render/comment.ts      Sticky-comment renderer (deterministic, idempotent)
│   ├── github/sticky.ts       Find-or-upsert sticky comment via Octokit
│   ├── cli.ts                 Local CLI entry — used by the Claude plugin
│   └── version.ts             REVIEWER_VERSION + COMMENT_MARKER
├── tests/
│   ├── fixtures/              Real PR bodies snapshotted from ogentic-shield
│   ├── parser/uat.test.ts     Parser tests against PR fixtures + edge cases
│   ├── linear/resolve.test.ts Resolver tests
│   └── render/comment.test.ts Renderer + idempotency tests
├── .github/
│   ├── actions/review/        Composite Action consumers point their workflow at
│   │   ├── action.yml
│   │   └── prompts/review.md  Runtime system prompt
│   └── workflows/             CI + self-review (dogfood)
├── .claude-plugin/            Claude Code plugin manifest + slash commands
└── docs/
    ├── GITHUB_APP_SETUP.md    One-time setup for the OgenticAI Reviewer GitHub App
    ├── INSTALL.md             Per-repo install instructions
    └── BUILD_VS_BUY.md        Why we built this instead of buying one
```

## Roadmap

| Feature | Linear ticket | Status |
|---------|--------------|--------|
| Spec, scaffold, GitHub App, UAT parser | [OGE-337](https://linear.app/ogenticai/issue/OGE-337) | In review |
| Per-item PR review + sticky comment (advisory) | [OGE-338](https://linear.app/ogenticai/issue/OGE-338) | In progress |
| Linear writeback (comments, status, follow-ups) | [OGE-339](https://linear.app/ogenticai/issue/OGE-339) | Backlog |
| Merge gate via required Check + `/uat-override` | [OGE-340](https://linear.app/ogenticai/issue/OGE-340) | Backlog |
| Auto-patch drafts + plugin + multi-repo rollout | [OGE-341](https://linear.app/ogenticai/issue/OGE-341) | Backlog |

## Install

See [docs/INSTALL.md](docs/INSTALL.md) for the per-repo workflow + branch-protection setup, and [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) for the one-time org-level App registration.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Run the reviewer against a real PR locally (dry-run, prints the comment but doesn't post):

```bash
cp .env.example .env  # fill in ANTHROPIC_API_KEY, GITHUB_TOKEN, LINEAR_API_TOKEN
npm run review-pr -- review-pr https://github.com/OgenticAI/ogentic-shield/pull/1
```

Pass `--post` to actually upsert the sticky comment on the PR.

## License

Apache 2.0 — see [LICENSE](LICENSE).
