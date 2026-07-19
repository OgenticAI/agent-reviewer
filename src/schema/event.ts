/**
 * Inputs the agent receives at runtime — both from the GitHub event payload
 * (the Action's natural input) and from the Linear MCP (the ticket the PR
 * is being reviewed against).
 *
 * Kept narrow on purpose: the GitHub Action payload from `pull_request` events
 * carries dozens of fields we don't need. We pluck the few that matter into
 * `PrContext` so the prompt template, the renderer, and the tests all share
 * one shape.
 */

import { z } from "zod";

export const PrContext = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  /** Head commit SHA the verdict is computed against. */
  headSha: z.string().min(7),
  /** Branch name on the head fork, e.g. `david/oge-308-309-redaction-api`. */
  headRef: z.string().min(1),
  /** PR title. */
  title: z.string(),
  /** Full PR body (markdown). The parser reads the UAT block out of this. */
  body: z.string(),
  /** GitHub login of the PR author. */
  author: z.string().min(1),
  /** ISO-8601 string of when the PR was opened. */
  createdAt: z.string().datetime(),
  /**
   * The repository's default branch (OGE-1585). Per-repo config is read from
   * here and never from `headRef` — config decides whether the PR merges, so
   * reading it from the PR would let a contributor disarm their own gate.
   * Optional: when absent, no per-repo config is loaded.
   */
  defaultBranch: z.string().min(1).optional(),
});
export type PrContext = z.infer<typeof PrContext>;

export const LinearTicketContext = z.object({
  /** e.g. "OGE-308". */
  identifier: z.string().min(1),
  /** Linear's internal UUID. */
  id: z.string().min(1),
  title: z.string(),
  /** Markdown body of the ticket. The reviewer uses this to understand intent
   * the PR description may have abbreviated. */
  description: z.string(),
  /** Linear status name, e.g. "In Review". */
  status: z.string(),
  /** Optional URL back to the ticket — included in comments. */
  url: z.string().url(),
});
export type LinearTicketContext = z.infer<typeof LinearTicketContext>;
