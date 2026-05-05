/**
 * Single source of truth for the agent version. Used in the sticky-comment
 * marker, in audit-style logs, and in the Action's check name suffix.
 *
 * Marker discipline (see src/render/comment.ts): bumping the major version
 * here invalidates existing sticky comments and starts a new sticky thread.
 * Don't bump idly.
 */
export const REVIEWER_VERSION = "v1";
export const COMMENT_MARKER = `<!-- ogenticai-reviewer-${REVIEWER_VERSION} -->`;
