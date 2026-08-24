#!/usr/bin/env node
/**
 * The audit CLI (OGE-2425).
 *
 * Deliberately separate from `cli.ts`. That one is the pull-request reviewer and
 * it loads Octokit to do its job; an audit that clones a Bitbucket repository
 * has no use for a GitHub client, and importing one to acquire a tree would put
 * the first crack in the seam OGE-2424 just established.
 *
 * Subcommands land here as the stages are built:
 *   acquire → inventory → map → analyze → investigate → verify → closure → render
 */

import { acquire, AcquireError, writeSubject } from "./engine/audit/acquire.js";
import { buildInventory, writeInventory, COVERAGE_CAVEAT } from "./engine/audit/inventory.js";

const USAGE = `audit — codebase audit

  audit acquire   --from <source> --into <dir> [--replace]
  audit inventory --tree <dir> [--out <dir>]

    <source>  a clone URL, host/owner/repo, a local path, or a .zip / .tar.gz
    --into    where the tree lands; refuses an existing directory
    --replace overwrite an existing directory instead of refusing
    --tree    an acquired tree to enumerate
    --out     where inventory.json lands (default: beside the tree)

  Writes <dir>/../<name>.subject.json — the audit's identity. Every finding
  cites path@rev, so a re-audit can be diffed against this one.
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function runAcquire(args: string[]): Promise<number> {
  const from = flag(args, "--from");
  const into = flag(args, "--into");
  if (!from || !into) {
    process.stderr.write("acquire needs --from and --into\n\n" + USAGE);
    return 2;
  }

  const subject = await acquire({ from, into, replace: args.includes("--replace") });
  const subjectPath = writeSubject(into, subject);

  const revLine = subject.rev ?? `none (${subject.revProvenance})`;
  const languages = Object.entries(subject.langs)
    .sort(([, a], [, b]) => b - a)
    .map(([name, share]) => `${name} ${Math.round(share * 100)}%`)
    .join(" · ");

  process.stdout.write(
    [
      `acquired ${subject.origin}`,
      `  kind       ${subject.kind}`,
      `  revision   ${revLine}`,
      `  files      ${subject.files.toLocaleString()}`,
      `  lines      ${subject.loc.toLocaleString()}`,
      `  languages  ${languages || "(none detected)"}`,
      `  subject    ${subjectPath}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runInventory(args: string[]): Promise<number> {
  const tree = flag(args, "--tree");
  if (!tree) {
    process.stderr.write("inventory needs --tree\n\n" + USAGE);
    return 2;
  }

  const inventory = buildInventory(tree);
  const path = writeInventory(flag(args, "--out") ?? tree, inventory);

  const byLanguage = new Map<string, number>();
  for (const file of inventory.files) {
    byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + 1);
  }
  const languages = [...byLanguage]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");

  process.stdout.write(
    [
      `inventoried ${tree}`,
      `  files      ${inventory.files.length.toLocaleString()}  (the coverage denominator)`,
      `  lines      ${inventory.files.reduce((n, f) => n + f.loc, 0).toLocaleString()}`,
      `  languages  ${languages || "(none detected)"}`,
      `  excluded   ${inventory.excluded.join(", ")}`,
      `  inventory  ${path}`,
      "",
      `  ${COVERAGE_CAVEAT}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command === "acquire") return runAcquire(args.slice(1));
  if (command === "inventory") return runInventory(args.slice(1));

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // An AcquireError is a refusal we chose — say it plainly, without a stack
    // that makes a deliberate safety check look like a crash.
    if (error instanceof AcquireError) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
