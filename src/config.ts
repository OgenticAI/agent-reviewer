/**
 * Per-repo reviewer configuration (OGE-1585).
 *
 * Every repo currently gets an identical cold prompt. A repo cannot say
 * "migrations under db/ are verified against the schema snapshot" or "ignore
 * generated/**", so the same item classes punt UNVERIFIABLE in every repo,
 * forever. CodeRabbit's `path_instructions` and OpenHands' repo-instruction
 * files both exist for exactly this.
 *
 * ── Two design decisions worth stating ──────────────────────────────────────
 *
 * **Loaded from the default branch, never the PR head.** This is a trust
 * boundary, not a convenience: config sets `fail_on` and `override_policy`, so
 * reading it from the PR would let a contributor weaken their own merge gate
 * in the same commit the gate is judging. Qodo makes the same split — their
 * approval-affecting setting "cannot be set via comments, requires file
 * commit".
 *
 * **Existing agent guidance is auto-ingested.** Kodus' insight: most of the
 * per-repo value is already sitting in files other tools left behind. Every
 * OgenticAI factory repo already has a `CLAUDE.md`, and `AGENTS.md` is a
 * cross-vendor convention — reading those costs the operator nothing and is
 * the single cheapest win in this ticket.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A glob → instruction pair, CodeRabbit's shape. */
export const PathInstruction = z.object({
  glob: z.string().min(1),
  instructions: z.string().min(1),
});
export type PathInstruction = z.infer<typeof PathInstruction>;

/**
 * Keyword-triggered guidance, OpenHands' microagent shape. Matched against
 * checklist item text, so a repo can attach "how to verify this class of
 * criterion" without listing every file it might touch.
 */
export const Recipe = z.object({
  triggers: z.array(z.string().min(1)).min(1),
  instructions: z.string().min(1),
});
export type Recipe = z.infer<typeof Recipe>;

export const ReviewerConfig = z.object({
  /** Overrides the action input of the same name. */
  fail_on: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  path_instructions: z.array(PathInstruction).optional(),
  recipes: z.array(Recipe).optional(),
  /**
   * Who may invoke `/uat-override`, beyond GitHub's collaborator check.
   *
   * Comment-unreachable by construction — it lives in a committed file on the
   * default branch, so nobody can widen their own override rights from the PR
   * conversation surface.
   */
  override_policy: z
    .object({
      allowed_actors: z.array(z.string()).optional(),
      allowed_teams: z.array(z.string()).optional(),
    })
    .optional(),
});
export type ReviewerConfig = z.infer<typeof ReviewerConfig>;

export const CONFIG_PATH = ".agent-reviewer.yml";

/** Files whose content is injected as always-on repo guidance, in order. */
export const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Cap on injected guidance, so a long CLAUDE.md cannot crowd out the diff. */
export const GUIDANCE_MAX_CHARS = 4000;

export const EMPTY_CONFIG: ReviewerConfig = {};

/**
 * Parse config text. Returns the empty config for anything unusable — a
 * malformed config must not take down the review, it should just not apply.
 */
export function parseReviewerConfig(text: string): {
  config: ReviewerConfig;
  error?: string;
} {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { config: EMPTY_CONFIG, error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null || raw === undefined) return { config: EMPTY_CONFIG };
  const parsed = ReviewerConfig.safeParse(raw);
  if (!parsed.success) {
    return { config: EMPTY_CONFIG, error: `schema: ${parsed.error.message}` };
  }
  return { config: parsed.data };
}

/** Glob match shared with the diff packer — `**` spans separators, `*` does not. */
function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

/** Instructions whose glob matches at least one changed file. */
export function matchingPathInstructions(
  config: ReviewerConfig,
  changedFiles: string[],
): Array<{ glob: string; instructions: string; files: string[] }> {
  const out: Array<{ glob: string; instructions: string; files: string[] }> = [];
  for (const pi of config.path_instructions ?? []) {
    const files = changedFiles.filter((f) => matchesGlob(f, pi.glob));
    if (files.length > 0) out.push({ glob: pi.glob, instructions: pi.instructions, files });
  }
  return out;
}

/**
 * Recipes whose trigger words appear in any checklist item.
 *
 * Case-insensitive substring, matched against item text rather than the diff:
 * a recipe describes how to verify a *kind of criterion*, so the criterion is
 * the right thing to match on.
 */
export function triggeredRecipes(config: ReviewerConfig, checklistTexts: string[]): Recipe[] {
  const haystack = checklistTexts.join("\n").toLowerCase();
  return (config.recipes ?? []).filter((r) =>
    r.triggers.some((t) => haystack.includes(t.toLowerCase())),
  );
}

/**
 * Whether an actor may invoke `/uat-override`.
 *
 * Returns true when no policy is configured — this narrows the existing
 * collaborator gate, it never widens it. The caller still applies the GitHub
 * permission check; both must pass.
 */
export function isOverrideAllowed(
  config: ReviewerConfig,
  actor: string,
  teams: string[] = [],
): boolean {
  const policy = config.override_policy;
  if (!policy) return true;
  const actors = policy.allowed_actors ?? [];
  const allowedTeams = policy.allowed_teams ?? [];
  if (actors.length === 0 && allowedTeams.length === 0) return true;
  return (
    actors.some((a) => a.toLowerCase() === actor.toLowerCase()) ||
    allowedTeams.some((t) => teams.includes(t))
  );
}

/**
 * Reads a file at a git ref. The orchestrator supplies a GitHub-backed
 * implementation; tests supply a map. Returns null when the file is absent.
 */
export interface RefFileReader {
  readAtRef(path: string, ref: string): Promise<string | null>;
}

export interface LoadedConfig {
  config: ReviewerConfig;
  /** Guidance files found, in `GUIDANCE_FILES` order, already clamped. */
  guidance: Array<{ path: string; content: string }>;
  /** Non-fatal problems worth surfacing in the run log. */
  warnings: string[];
}

/**
 * Load per-repo config and guidance **from the default branch**.
 *
 * The `ref` argument is the default branch, never the PR head, and the caller
 * has no other option by design — `fail_on` and `override_policy` decide
 * whether the PR merges, so reading them from the PR would let a contributor
 * disarm the gate in the same commit it is judging.
 *
 * Every failure is a warning, not a throw: a repo with a broken config gets an
 * unconfigured review, not a red Action.
 */
export async function loadRepoConfig(
  reader: RefFileReader,
  defaultBranch: string,
): Promise<LoadedConfig> {
  const warnings: string[] = [];

  let config = EMPTY_CONFIG;
  try {
    const text = await reader.readAtRef(CONFIG_PATH, defaultBranch);
    if (text !== null) {
      const parsed = parseReviewerConfig(text);
      config = parsed.config;
      if (parsed.error) warnings.push(`${CONFIG_PATH} ignored — ${parsed.error}`);
    }
  } catch (err) {
    warnings.push(`could not read ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const guidance: Array<{ path: string; content: string }> = [];
  for (const path of GUIDANCE_FILES) {
    try {
      const text = await reader.readAtRef(path, defaultBranch);
      if (text && text.trim()) guidance.push({ path, content: clampGuidance(text) });
    } catch (err) {
      warnings.push(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { config, guidance, warnings };
}

/** Trim repo guidance to the injection budget, saying so when it truncates. */
export function clampGuidance(text: string, max = GUIDANCE_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? trimmed
    : `${trimmed.slice(0, max)}\n… [truncated at ${max} chars]`;
}
