# OgenticAI Reviewer — GitHub App setup

This is a one-time org-level setup. You only need to do it once for the whole `OgenticAI` GitHub org; every repo that adopts the reviewer thereafter just installs the existing App.

## 1. Register the App

1. Go to **https://github.com/organizations/OgenticAI/settings/apps**.
2. Click **New GitHub App**.
3. Fill the form:
   - **Name**: `OgenticAI Reviewer`
   - **Homepage URL**: `https://github.com/OgenticAI/agent-reviewer`
   - **Webhook**: uncheck "Active" — we don't run a webhook server (the Action is the trigger).
   - **Repository permissions**:
     - Pull requests: **Read & write**
     - Issues: **Read & write** (needed to post comments + labels)
     - Contents: **Read** (for diffs)
     - Checks: **Read & write**
     - Metadata: **Read** (default)
   - **Organization permissions**: none.
   - **Subscribe to events**: none (Action is the trigger).
   - **Where can this GitHub App be installed?**: "Only on this account".
4. Save. Note the **App ID** at the top of the new App page.
5. Click **Generate a private key**. A `.pem` file downloads.

## 2. Store the credentials

Two destinations:

**1Password** (long-term archive):

- Title: `OgenticAI Reviewer GitHub App`
- App ID, raw `.pem` file, and a link to the App's settings page.

**GitHub org secrets** (runtime):

Go to **https://github.com/organizations/OgenticAI/settings/secrets/actions** and create:

- `OGENTICAI_REVIEWER_APP_ID` — the App ID (a short integer).
- `OGENTICAI_REVIEWER_APP_KEY` — the **contents** of the `.pem` file. (`actions/create-github-app-token@v1` accepts both raw PEM and base64. Raw is fine.)

Repository access scope: **Selected repositories** is safest — start with `agent-reviewer` and `ogentic-shield` and add others as the rollout proceeds. "All repositories" works too if you'd rather not maintain the list manually.

## 3. Install on the org

1. From the App's settings page, click **Install App**.
2. Choose `OgenticAI`.
3. Pick **All repositories** or **Only select repositories** and pick the pilot set: `agent-reviewer`, `ogentic-shield`, and (later) `agent-sizer`, `agent-covenant`, `agent-knowledge`.

## 4. Add the other org secrets

Same Org-Settings → Secrets page:

- `ANTHROPIC_API_KEY` — from <https://console.anthropic.com/settings/keys>. Use a key dedicated to the reviewer so you can see its spend separately from human-driven Claude usage.
- `LINEAR_API_TOKEN` — from <https://linear.app/settings/api> on the OgenticAI workspace. Use a personal API key from a service account user (e.g. `reviewer-bot@ogenticai.com`) rather than a real human's account, so reviewer-bot writes are clearly attributable in Linear's audit log.

## 5. Smoke-test

Open a draft PR on `agent-reviewer` itself. The `self-review.yml` workflow won't run (it skips drafts), so flip it to **Ready for review**. Within ~60 s you should see:

- A sticky comment from `OgenticAI Reviewer[bot]` with a verdict table.
- A new GitHub Check `OgenticAI Reviewer / UAT`.

If the comment author shows as a human GitHub user instead of `OgenticAI Reviewer[bot]`, the App token wasn't minted correctly — check the Action logs for the `Mint GitHub App token` step.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `Resource not accessible by integration` | App permissions missing (e.g. Issues write). Update the App + reinstall on affected repos. |
| Comment posted but as a human | `OGENTICAI_REVIEWER_APP_*` secrets not set or empty — the Action falls back to `${{ secrets.GITHUB_TOKEN }}` (= the workflow runner). |
| `404 Not Found` on `gh api repos/.../check-runs` | The repo isn't in the App's selected list. Edit the install scope. |
| Linear writeback silently no-ops | `LINEAR_API_TOKEN` doesn't have access to the OgenticAI workspace, or the bot user was deactivated. |
