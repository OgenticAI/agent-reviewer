/**
 * Repo map assembly (OGE-1582) — tags → rank → render, in one call.
 *
 * Builds the ranked, token-budgeted symbol map the prompt injects before the
 * tool loop, so a repo-wide claim is answered from a standing map instead of
 * being paid for one tool iteration at a time.
 */

import { estimateTokens } from "../tokens.js";
import {
  seedIdentifiers,
  filesMatchingIdentifiers,
  rankFiles,
} from "./rank.js";
import { renderRepoMap, type RenderedMap } from "./render.js";
import { TagCache, type RepoFile } from "./tags.js";

export interface BuildRepoMapArgs {
  files: RepoFile[];
  /** Files the diff touched — the primary personalization seed. */
  diffTouchedFiles: string[];
  /**
   * Free text describing what the run is looking for; identifiers found in it
   * boost matching files' rank.
   *
   * On the PR path these are the UAT checklist items. Nothing here knows that
   * — it extracts identifiers from arbitrary text — which is exactly why an
   * audit can seed the same ranker from its question set instead.
   */
  seedTexts: string[];
  /** The packed diff, sized to scale the map budget inversely. */
  diffText: string;
  baseTokens?: number;
  /** Optional shared cache so mtime-unchanged files aren't re-parsed. */
  cache?: TagCache;
}

export function buildRepoMap(args: BuildRepoMapArgs): RenderedMap {
  const cache = args.cache ?? new TagCache();
  const tags = cache.tagsForAll(args.files);

  const ids = seedIdentifiers(args.seedTexts);
  const identifierFiles = filesMatchingIdentifiers(tags, ids);
  const seeds = [...new Set([...args.diffTouchedFiles, ...identifierFiles])];

  const ranked = rankFiles({ tags, seeds });
  return renderRepoMap({
    ranked,
    tags,
    ...(args.baseTokens !== undefined ? { baseTokens: args.baseTokens } : {}),
    diffTokens: estimateTokens(args.diffText),
  });
}

export { TagCache } from "./tags.js";
export type { RepoFile, Tag } from "./tags.js";
export type { RenderedMap } from "./render.js";
