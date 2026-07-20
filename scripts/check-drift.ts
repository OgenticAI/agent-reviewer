#!/usr/bin/env node
/**
 * Fail CI when `main` has drifted from the tag consumers pin (OGE-1667).
 *
 * Gathers the git facts and hands them to the pure `assessDrift`, which owns
 * every threshold and message. Nothing here decides policy.
 *
 * Usage:
 *   tsx scripts/check-drift.ts [--tag v2] [--max-commits 10] [--max-age-days 14]
 *
 * Exit 0 = current or within thresholds. Exit 1 = stale / unreleased.
 *
 * Requires full history and tags — `actions/checkout` with `fetch-depth: 0`.
 * A shallow clone silently reports zero commits ahead, which would turn this
 * check into a permanent green light.
 */

import { execFileSync } from "node:child_process";

import { assessDrift, DEFAULT_THRESHOLDS, formatDrift } from "../src/release/drift.js";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function main(): void {
  const tag = arg("tag", "v2");
  const thresholds = {
    maxCommitsAhead: Number(arg("max-commits", String(DEFAULT_THRESHOLDS.maxCommitsAhead))),
    maxAgeDays: Number(arg("max-age-days", String(DEFAULT_THRESHOLDS.maxAgeDays))),
  };

  // Guard the shallow-clone footgun explicitly rather than reporting a
  // confident zero. `--is-shallow-repository` is cheap and unambiguous.
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    console.error(
      "[drift:FAIL] Shallow clone — commit counts would be wrong and this check " +
        "would report a false all-clear. Use actions/checkout with fetch-depth: 0.",
    );
    process.exit(1);
  }

  // `^{}` dereferences an annotated tag to the commit it points at.
  const tagSha = git(["rev-parse", `${tag}^{}`]);
  const tagIso = tagSha ? git(["log", "-1", "--format=%aI", tagSha]) : null;

  // `<tag>..main` counts commits reachable from main but not the tag. Correct
  // even when the tag is not an ancestor of main — the squash-merge case that
  // made a naive ancestor check misleading here before.
  const ref = git(["rev-parse", "--verify", "origin/main"]) ? "origin/main" : "main";
  const aheadRaw = tagSha ? git(["rev-list", "--count", `${tag}..${ref}`]) : null;

  const result = assessDrift(
    {
      tag,
      commitsAhead: aheadRaw ? Number(aheadRaw) : 0,
      tagDate: tagIso ? new Date(tagIso) : null,
      now: new Date(),
    },
    thresholds,
  );

  console.error(formatDrift(result));

  // Surface it on the run summary too, so it's visible without opening logs.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      const { appendFileSync } = require("node:fs") as typeof import("node:fs");
      appendFileSync(
        summary,
        `### Release drift\n\n${result.failed ? "**FAILED**" : "OK"} — ${result.message}\n`,
      );
    } catch {
      // A summary write failure must never change the check's outcome.
    }
  }

  process.exit(result.failed ? 1 : 0);
}

main();
