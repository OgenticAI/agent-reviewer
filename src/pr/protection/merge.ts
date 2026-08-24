/**
 * Branch protection merge logic.
 *
 * The install-branch-protection script reads the current `branches/{branch}/protection`
 * config, merges in our required-status-check context, and PUTs back the result.
 * The merge MUST be additive — we never strip existing required reviews, code-owner
 * rules, admin enforcement, or other contexts. Doing so would silently weaken
 * security every time someone re-runs the script.
 *
 * This module is pure: input the current config + the context we want to add,
 * output the new config. Tests exhaustively cover the merge cases without
 * touching the network.
 *
 * GitHub's PUT shape (which this returns) and GET shape (which the script reads)
 * are *almost* the same but differ in nullables — we normalize on the way in.
 */

/**
 * Subset of GitHub's branch-protection schema we read + write. We model only
 * the fields we actually merge; everything else passes through verbatim.
 *
 * https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2022-11-28
 */
export interface BranchProtectionPut {
  /** Required status checks. `null` means "no required checks". */
  required_status_checks: {
    strict: boolean;
    /** Modern field — list of `{ context, app_id? }`. Preferred. */
    checks?: Array<{ context: string; app_id?: number | null }>;
    /** Legacy field — list of context strings. Still required by the API. */
    contexts: string[];
  } | null;
  /** Require admins to follow protection rules. We never silently flip this. */
  enforce_admins: boolean | null;
  required_pull_request_reviews: unknown | null;
  restrictions: unknown | null;
  required_linear_history?: boolean;
  allow_force_pushes?: boolean | null;
  allow_deletions?: boolean | null;
  block_creations?: boolean;
  required_conversation_resolution?: boolean;
  lock_branch?: boolean;
  allow_fork_syncing?: boolean;
}

export interface MergeProtectionInput {
  /** The repo's existing protection config (from `GET .../protection`), or
   *  null if no protection exists yet. */
  existing: BranchProtectionPut | null;
  /** The check name we want to require, e.g. `OgenticAI Reviewer / UAT`. */
  context: string;
  /** Optional app id that owns the check. When set, GitHub will verify the
   *  check came from this App and not, say, a forked workflow impersonating
   *  the name. Recommended in production. */
  appId?: number;
  /**
   * Whether to flip `strict` to true (require branches to be up-to-date with
   * base before merging). Defaults to whatever is already set; if no
   * existing protection, defaults to true.
   */
  strict?: boolean;
}

export interface MergeProtectionResult {
  /** The new PUT body. Pass directly to `repos.updateBranchProtection`. */
  next: BranchProtectionPut;
  /** True if `next` differs from `existing` — call site decides whether to PUT. */
  changed: boolean;
  /** Human-readable description of what changed. */
  notes: string[];
}

/**
 * Merge our required check into the existing protection, preserving everything
 * else. Returns `changed: false` when the context is already required.
 */
export function mergeProtection(input: MergeProtectionInput): MergeProtectionResult {
  const notes: string[] = [];

  // Default config when there's no existing protection. We're conservative —
  // enforce_admins null (don't flip), no required reviewers (don't add), only
  // our context. Operators who want stronger protection can layer their own
  // rules separately; we only add the one piece that's our responsibility.
  if (!input.existing) {
    notes.push("No existing branch protection — creating new with our required check.");
    return {
      next: {
        required_status_checks: {
          strict: input.strict ?? true,
          contexts: [input.context],
          checks: [{ context: input.context, app_id: input.appId ?? null }],
        },
        enforce_admins: null,
        required_pull_request_reviews: null,
        restrictions: null,
      },
      changed: true,
      notes,
    };
  }

  // Existing protection: merge our context in, preserving everything else.
  const existing = input.existing;

  const existingChecks = existing.required_status_checks?.checks ?? [];
  const existingContexts = existing.required_status_checks?.contexts ?? [];

  const alreadyRequired =
    existingContexts.includes(input.context) ||
    existingChecks.some((c) => c.context === input.context);

  // Decide on strict. Don't flip strict implicitly — if caller specified, use
  // their value; otherwise preserve the existing value (default true if no
  // required_status_checks block existed).
  const nextStrict =
    input.strict !== undefined
      ? input.strict
      : (existing.required_status_checks?.strict ?? true);

  // Build the merged checks list.
  const nextChecks = [...existingChecks];
  const nextContexts = [...existingContexts];
  if (!alreadyRequired) {
    nextChecks.push({ context: input.context, app_id: input.appId ?? null });
    nextContexts.push(input.context);
    notes.push(`Added "${input.context}" to required_status_checks.contexts`);
  } else {
    notes.push(`"${input.context}" was already in required_status_checks — no change.`);
  }

  if (nextStrict !== (existing.required_status_checks?.strict ?? true)) {
    notes.push(
      `Flipped required_status_checks.strict ${existing.required_status_checks?.strict} → ${nextStrict}`,
    );
  }

  const next: BranchProtectionPut = {
    ...existing,
    required_status_checks: {
      strict: nextStrict,
      contexts: nextContexts,
      checks: nextChecks,
    },
    // Pass-through everything else verbatim — these are the fields humans set
    // intentionally and we will not touch.
    enforce_admins: existing.enforce_admins,
    required_pull_request_reviews: existing.required_pull_request_reviews,
    restrictions: existing.restrictions,
  };

  return {
    next,
    changed: !alreadyRequired || nextStrict !== (existing.required_status_checks?.strict ?? true),
    notes,
  };
}

/**
 * Inverse of mergeProtection — used by the (rare) uninstall path. Removes our
 * context but leaves everything else alone. Returns `changed: false` if the
 * context wasn't required to begin with.
 */
export function removeFromProtection(input: {
  existing: BranchProtectionPut | null;
  context: string;
}): MergeProtectionResult {
  const notes: string[] = [];
  if (!input.existing) {
    return { next: nullProtection(), changed: false, notes };
  }
  const existing = input.existing;
  const checks = existing.required_status_checks?.checks ?? [];
  const contexts = existing.required_status_checks?.contexts ?? [];
  const present =
    contexts.includes(input.context) || checks.some((c) => c.context === input.context);
  if (!present) {
    return { next: existing, changed: false, notes };
  }
  notes.push(`Removed "${input.context}" from required_status_checks`);
  return {
    next: {
      ...existing,
      required_status_checks: existing.required_status_checks
        ? {
            strict: existing.required_status_checks.strict,
            contexts: contexts.filter((c) => c !== input.context),
            checks: checks.filter((c) => c.context !== input.context),
          }
        : null,
      enforce_admins: existing.enforce_admins,
      required_pull_request_reviews: existing.required_pull_request_reviews,
      restrictions: existing.restrictions,
    },
    changed: true,
    notes,
  };
}

function nullProtection(): BranchProtectionPut {
  return {
    required_status_checks: null,
    enforce_admins: null,
    required_pull_request_reviews: null,
    restrictions: null,
  };
}
