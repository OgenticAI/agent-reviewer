/**
 * Single source of truth for the agent version. Used in the sticky-comment
 * marker, in audit-style logs, and in the Action's check name suffix.
 *
 * Marker discipline (see src/render/comment.ts): bumping the major version
 * here invalidates existing sticky comments and starts a new sticky thread.
 * Don't bump idly.
 */
export const REVIEWER_VERSION = "v3";
export const COMMENT_MARKER = `<!-- ogenticai-reviewer-${REVIEWER_VERSION} -->`;

/**
 * Marker for the UAT-checklist linter's advisory comment (OGE-1559).
 *
 * Deliberately distinct from `COMMENT_MARKER`: the linter comment and the
 * verdict sticky are two different messages with two different lifecycles, and
 * sharing a marker would make them fight over the same comment slot — each run
 * overwriting the other's body.
 */
export const LINT_COMMENT_MARKER = `<!-- ogenticai-reviewer-lint-${REVIEWER_VERSION} -->`;
