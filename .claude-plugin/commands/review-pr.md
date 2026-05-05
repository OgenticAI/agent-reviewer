# /review-pr `<github-pr-url>`

Run the OgenticAI Reviewer locally on a GitHub PR. Same prompt + same schema as the GitHub Action — produces a per-item PASS / FAIL / PARTIAL / UNVERIFIABLE verdict against the linked Linear ticket's UAT checklist.

## What this does

1. Resolves the Linear ticket from the PR's branch / body / title.
2. Fetches the ticket via the Linear MCP (or `LINEAR_API_TOKEN` if no MCP is wired).
3. Parses the `## UAT checklist` block from the PR description.
4. Pulls the PR diff via `gh pr diff`.
5. Asks Claude for a per-item verdict.
6. Prints the rendered sticky comment (Markdown).

By default this is a **dry run** — it prints the comment but doesn't post it. Pass `--post` to actually upsert it on the PR.

## Required env

- `ANTHROPIC_API_KEY` — Claude API
- `GITHUB_TOKEN` — `repo` + `read:org`
- `LINEAR_API_TOKEN` — Linear personal API key (only when the Linear MCP isn't wired)

## Run

```bash
cd /path/to/agent-reviewer
tsx src/cli.ts review-pr {{1}}
```

Add `--post` to actually publish the sticky comment, or `--output-json verdict.json` to dump the raw verdict.

When you're done, summarize the verdict's overall status to me and ask whether I want to follow up by posting the comment, opening child Linear issues for FAILs, or rewriting any of the items the reviewer flagged.
