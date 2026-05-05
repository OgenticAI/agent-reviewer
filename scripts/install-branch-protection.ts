#!/usr/bin/env tsx
/**
 * Stub for OGE-340 — installs the branch-protection rule that requires the
 * `OgenticAI Reviewer / UAT` Check on the default branch of one or more repos.
 *
 * Currently this file is intentionally a stub: the logic ships in OGE-340
 * (merge-gate ticket). This file holds the place + documents the intent so
 * the OGE-340 work has an obvious landing spot.
 *
 * Planned usage:
 *
 *   tsx scripts/install-branch-protection.ts \
 *     --repo OgenticAI/ogentic-shield \
 *     --branch main \
 *     --check 'OgenticAI Reviewer / UAT'
 *
 * Behaviour requirements (per OGE-340):
 *   - MERGE existing branch protection (don't overwrite it). Read current
 *     `required_status_checks.contexts`, append the new one, PUT back.
 *   - Idempotent: running twice is a no-op.
 *   - Never disable `enforce_admins` or `required_pull_request_reviews` if
 *     those were already on.
 */

console.error(
  "scripts/install-branch-protection.ts is a placeholder for OGE-340. " +
    "See https://linear.app/ogenticai/issue/OGE-340 for the implementation ticket.",
);
process.exit(64);
