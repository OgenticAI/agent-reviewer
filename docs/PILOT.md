# OgenticAI Reviewer · v1 Pilot Rollout

This page lists the four pilot repos for v1 and the playbook for adding the reviewer to each. SpendRule is **out of scope** for v1 — separate Linear team, different review conventions, dedicated rollout phase later.

## Pilot repos

| # | Repo | Default branch | Linear team | Notes |
|---|------|----------------|-------------|-------|
| 1 | [`OgenticAI/ogentic-shield`](https://github.com/OgenticAI/ogentic-shield) | `main` | OGE | Highest-leverage target — has v0.2 PRs that already use the UAT-checklist convention. Start here. |
| 2 | [`agents-ogenticai/agent-sizer`](https://github.com/OgenticAI/agent-dealsizer) | `main` | OGE | Most-active agent repo. Real-world MNPI workloads. |
| 3 | `agents-ogenticai/agent-covenant` | `main` | OGE | Private-credit covenant monitoring. |
| 4 | `agents-ogenticai/agent-knowledge` | `main` | OGE | Multi-source knowledge aggregation. |

## Per-repo rollout (one-shot)

Once the GitHub App is registered + the four org secrets exist (see [`GITHUB_APP_SETUP.md`](GITHUB_APP_SETUP.md)):

```bash
GITHUB_TOKEN=ghp_xxx tsx scripts/rollout-reviewer.ts \
  --repo OgenticAI/ogentic-shield \
  --repo OgenticAI/agent-dealsizer \
  --repo agents-ogenticai/agent-covenant \
  --repo agents-ogenticai/agent-knowledge
```

The script is **idempotent**:

- For each target repo, it reads the current contents of `.github/workflows/ogenticai-reviewer.yml` and `.github/workflows/uat-override.yml` from the default branch.
- If both files match the canonical templates, it prints `[ok] already installed` and moves on.
- Otherwise it creates (or updates) a stable rollout branch `ogenticai-reviewer/install-v1`, writes the templates, and opens (or updates) a PR titled `chore: install OgenticAI Reviewer (UAT-checklist gate)`.
- The maintainer reviews + merges per their own house style. Direct pushes to `main` never happen.

Re-running the script picks up template drift (e.g. a future v1.1 of the workflow) and updates the existing rollout PR — no spam.

## Per-repo merge gate

Once you've watched 5–10 verdicts on a repo and trust the calls, flip the merge gate:

1. Edit `.github/workflows/ogenticai-reviewer.yml` on the target repo: change `fail_on: ""` → `fail_on: NEEDS_WORK`.
2. From the `agent-reviewer` checkout, install the required Check on branch protection:
   ```bash
   GITHUB_TOKEN=ghp_xxx tsx scripts/install-branch-protection.ts \
     --repo OgenticAI/ogentic-shield \
     --branch main \
     --check 'OgenticAI Reviewer / UAT' \
     --app-id "$OGENTICAI_REVIEWER_APP_ID"
   ```
   The script merges with existing protection — it never strips required reviewers, code-owner rules, or other contexts.

## Per-repo auto-patch

Auto-patch is **off by default** for v1 — set `auto_patch: "true"` in the workflow input only after merge-gating has been on for ~2 weeks and verdicts feel stable. When enabled, the reviewer opens a follow-up draft PR for any item the model flagged as `autoPatchable: true`. The maintainer reviews + merges (or closes) like any other PR.

## Pilot dashboard

Filter the [OgenticAI Reviewer Linear project](https://linear.app/ogenticai/project/ogenticai-reviewer-fb5a5ede32c7) by:

- **Label `uat-override`** — every override that's been applied across the pilot repos. A spike here means the agent's verdicts aren't matching reality and the prompt needs tuning.
- **Sub-issues with title prefix `Fix UAT:`** — every FAIL verdict that auto-filed a follow-up. A pile of these on a single parent ticket means the original PR isn't ready to ship.

## Out-of-band steps (manual, one-time)

These can't be scripted; they require browser actions.

- [ ] Register the **OgenticAI Reviewer GitHub App** on the OgenticAI org. See [`GITHUB_APP_SETUP.md`](GITHUB_APP_SETUP.md).
- [ ] Set the four org-level secrets at https://github.com/organizations/OgenticAI/settings/secrets/actions: `ANTHROPIC_API_KEY`, `OGENTICAI_REVIEWER_APP_ID`, `OGENTICAI_REVIEWER_APP_KEY`, `LINEAR_API_TOKEN`.
- [ ] Run `tsx scripts/install-linear-statuses.ts --team OGE` once to ensure team OGE has a `Ready to Merge` workflow state.
- [ ] Install the App on each pilot repo (the rollout PR body links the install URL — one click).
