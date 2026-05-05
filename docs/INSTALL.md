# Installing the OgenticAI Reviewer in a repo

Once the [GitHub App is set up](GITHUB_APP_SETUP.md) and installed on the OgenticAI org, adding the reviewer to any repo is two files.

## 1. Add the workflow

Drop this into `.github/workflows/ogenticai-reviewer.yml`:

```yaml
name: OgenticAI Reviewer

on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: github.event.pull_request.draft == false
    steps:
      - uses: actions/checkout@v5
      - uses: OgenticAI/agent-reviewer/.github/actions/review@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          github_app_id: ${{ secrets.OGENTICAI_REVIEWER_APP_ID }}
          github_app_private_key: ${{ secrets.OGENTICAI_REVIEWER_APP_KEY }}
          linear_api_token: ${{ secrets.LINEAR_API_TOKEN }}
          # Opt-in: when a UAT FAIL is mechanically fixable, open a draft
          # patch PR. Default off for v1 rollout.
          auto_patch: "false"
```

Required org-level secrets (set under **Settings → Secrets and variables → Actions** at the org level so all repos inherit):

- `ANTHROPIC_API_KEY`
- `OGENTICAI_REVIEWER_APP_ID`
- `OGENTICAI_REVIEWER_APP_KEY`
- `LINEAR_API_TOKEN`

## 2. Require the Check (merge gate)

Once you've seen the reviewer post a few sticky comments and trust the verdicts, flip on the merge gate:

```bash
gh api -X PUT \
  repos/OgenticAI/<repo>/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["OgenticAI Reviewer / UAT"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

A helper script lives at `scripts/install-branch-protection.ts` (ships in [OGE-340](https://linear.app/ogenticai/issue/OGE-340)) — that's the recommended path once the script lands, since it merges with any existing protection rules instead of overwriting them.

## 3. (Optional) Override mechanism

Maintainers can override a failing UAT verdict by commenting `/uat-override <reason>` on the PR. The reviewer flips the Check to `success`, posts a comment on the linked Linear ticket attributing the override, and labels the ticket `uat-override`. Override use is auditable from the Linear ticket's comment thread.

## 4. Sanity-check it works

Open any PR with a `## UAT checklist` block. Within ~60 s of CI starting, you should see:

- A sticky comment from `OgenticAI Reviewer` with a per-item verdict table.
- A new check `OgenticAI Reviewer / UAT` on the PR's status checks list.
- A new comment on the linked Linear ticket linking back to the PR.

If any of those don't appear, check the Action run logs — the reviewer prints structured diagnostic output for failed lookups (missing ticket id, malformed checklist, etc.).
