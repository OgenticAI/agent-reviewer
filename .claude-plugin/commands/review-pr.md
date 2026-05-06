# /review-pr `<github-pr-url>`

Run the OgenticAI Reviewer locally on a GitHub PR. Same prompt + same schema as the GitHub Action — produces a per-item PASS / FAIL / PARTIAL / UNVERIFIABLE verdict against the linked Linear ticket's UAT checklist.

## Parity with the Action

This command and the GitHub Action both reduce to the same `runReview()` function (`src/review.ts`) with the same system prompt at temperature 0. Given the same diff + same checklist, you get the same per-item verdicts on the same SHA whether you run the plugin or the Action. That parity is the contract — if you see drift between local and CI verdicts, file a bug.

## What this does

1. Resolves the Linear ticket from the PR's branch / body / title (`OGE-NNN`).
2. Fetches the ticket via the Linear API (`LINEAR_API_TOKEN`).
3. Parses the `## UAT checklist` block from the PR description.
4. Pulls the PR diff via `gh pr diff` (Octokit under the hood).
5. Asks Claude for a per-item verdict (one call, temperature 0).
6. Prints the rendered sticky comment (Markdown) to stdout.

By default this is a **dry run** — it prints the comment but doesn't post it. Pass `--post` to upsert it on the PR (and run Linear writeback).

## Required env

- `ANTHROPIC_API_KEY` — Claude API
- `GITHUB_TOKEN` — `repo` + `read:org`
- `LINEAR_API_TOKEN` — Linear personal API key

## Run

```bash
cd /path/to/agent-reviewer
npm install                 # one-time
tsx src/cli.ts review-pr {{1}}
```

Add `--post` to publish the sticky comment + Linear writeback, or `--output-json verdict.json` to dump the raw verdict.

When you're done, summarize the verdict's overall status to me and ask whether I want to follow up by:
- Posting the comment / running writeback (if you didn't pass `--post`)
- Opening child Linear issues for any FAIL items (this happens automatically with `--post`)
- Rewriting any of the items the reviewer flagged
