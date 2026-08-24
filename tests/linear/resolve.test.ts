import { describe, expect, it } from "vitest";

import { resolveTickets } from "../../src/pr/linear/resolve.js";

describe("resolveTickets", () => {
  it("extracts the ticket from the canonical branch name", () => {
    const r = resolveTickets({
      headRef: "david/oge-308-309-redaction-api",
      body: "",
      title: "feat(redaction): add Shield.redact()",
    });
    expect(r.ticketIds).toEqual(["OGE-308"]);
    expect(r.source).toBe("branch");
  });

  it("appends additional tickets from the body without duplicating the branch one", () => {
    const r = resolveTickets({
      headRef: "david/oge-308-309-redaction-api",
      body: "Closes [OGE-308](https://linear.app/ogenticai/issue/OGE-308) and [OGE-309](...)",
      title: "feat(redaction)",
    });
    expect(r.ticketIds).toEqual(["OGE-308", "OGE-309"]);
  });

  it("falls back to the body when the branch has no oge- prefix", () => {
    const r = resolveTickets({
      headRef: "feature/some-thing",
      body: "Closes OGE-999",
      title: "x",
    });
    expect(r.ticketIds).toEqual(["OGE-999"]);
    expect(r.source).toBe("body");
  });

  it("falls back to the title last", () => {
    const r = resolveTickets({
      headRef: "main",
      body: "no ticket here",
      title: "chore: bump deps (OGE-42)",
    });
    expect(r.ticketIds).toEqual(["OGE-42"]);
    expect(r.source).toBe("title");
  });

  it("returns an empty list when no ticket can be found", () => {
    const r = resolveTickets({ headRef: "main", body: "x", title: "y" });
    expect(r.ticketIds).toEqual([]);
    expect(r.source).toBe("none");
  });

  it("normalizes case: oge-1, OGE-1, Oge-1 all collapse to OGE-1", () => {
    const r = resolveTickets({
      headRef: "feature/Oge-1-thing",
      body: "see oge-1 and OGE-1",
      title: "x",
    });
    expect(r.ticketIds).toEqual(["OGE-1"]);
  });

  it("does not match OGE-NNN as a literal placeholder string", () => {
    // The plan and templates contain literal "OGE-NNN" as a placeholder.
    // \d+ requires at least one digit, so it won't match "NNN".
    const r = resolveTickets({
      headRef: "main",
      body: "OGE-NNN is a placeholder",
      title: "x",
    });
    expect(r.ticketIds).toEqual([]);
  });

  it("preserves source order when multiple ids appear in body", () => {
    const r = resolveTickets({
      headRef: "main",
      body: "Closes OGE-50 and also OGE-10 — and again OGE-50",
      title: "x",
    });
    expect(r.ticketIds).toEqual(["OGE-50", "OGE-10"]);
  });
});
