/**
 * Resolve the Linear ticket a PR is reviewing against.
 *
 * Strategy (in order):
 *   1. Branch name pattern: `*\/oge-NNN-*` → "OGE-NNN" (case-insensitive).
 *      This is the canonical convention — Linear's `gitBranchName` field
 *      generates exactly this shape, and the ogentic-shield team uses it.
 *   2. PR body: any `OGE-NNN` substring or
 *      `https://linear.app/ogenticai/issue/OGE-NNN/...` URL.
 *   3. PR title: `feat(...): ... (OGE-NNN, OGE-MMM)` style. We take the first
 *      hit; if a PR addresses multiple tickets, the parent/primary should
 *      come first by convention.
 *
 * If multiple distinct ticket ids appear, we return *all* of them in the order
 * we found them. The Action picks the first as the "primary" for status
 * transitions but comments on all of them.
 */

const TICKET_RE = /\bOGE-(\d+)\b/gi;

const BRANCH_RE = /\boge-(\d+)\b/i;

export interface TicketResolution {
  /** All ticket ids found, in source order, deduped, normalized to UPPERCASE. */
  ticketIds: string[];
  /** Where each id was first seen — useful for debug logs. */
  source: "branch" | "body" | "title" | "none";
}

export function resolveTickets(input: {
  headRef: string;
  body: string;
  title: string;
}): TicketResolution {
  const seen = new Set<string>();
  const out: string[] = [];

  // 1) Branch first — the strongest signal.
  const branchMatch = BRANCH_RE.exec(input.headRef);
  let source: TicketResolution["source"] = "none";
  if (branchMatch) {
    const id = `OGE-${branchMatch[1]}`;
    out.push(id);
    seen.add(id);
    source = "branch";
  }

  // 2) Body — we walk the whole text and append any tickets not already seen.
  for (const match of input.body.matchAll(TICKET_RE)) {
    const id = `OGE-${match[1]}`;
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
      if (source === "none") source = "body";
    }
  }

  // 3) Title fallback. Rare but worth catching for `chore: bump deps (OGE-X)`.
  for (const match of input.title.matchAll(TICKET_RE)) {
    const id = `OGE-${match[1]}`;
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
      if (source === "none") source = "title";
    }
  }

  return { ticketIds: out, source };
}
