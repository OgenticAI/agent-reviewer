# Chaos test A — failure-mode → neutral Check (OGE-391)

Throwaway PR. Branch references OGE-99999 (non-existent ticket); the reviewer's
linear.getIssue() will throw, the CLI will exit non-zero, and the action's
ERROR → neutral mapping should fire (`.github/actions/review/action.yml:129`).

Expected: `OgenticAI Reviewer / UAT` Check resolves to `neutral`, NOT `failure`.
Tracker: https://linear.app/ogenticai/issue/OGE-391
