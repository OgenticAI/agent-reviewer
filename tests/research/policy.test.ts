/**
 * Research gating (OGE-1566).
 *
 * The two gates exist for different reasons and both are load-bearing:
 * `enabledByConfig` is the security control (the model composes search
 * queries, so repos handling PHI/MNPI must be able to keep the path closed),
 * and the `[human]`-item check is the cost/blast-radius control (no search
 * capability is even advertised on the overwhelming majority of reviews).
 */

import { describe, expect, it } from "vitest";

import { parseUatChecklist } from "../../src/parser/uat.js";
import {
  RESEARCH_MAX_USES,
  RESEARCH_SOURCE_ALLOWLIST,
  resolveResearchPolicy,
} from "../../src/research/policy.js";

function itemsFrom(...lines: string[]) {
  return parseUatChecklist(["## UAT checklist", "", ...lines.map((l) => `- [ ] ${l}`)].join("\n"))
    .items;
}

describe("resolveResearchPolicy", () => {
  it("is off by default even when the checklist has [human] items", () => {
    const policy = resolveResearchPolicy({
      items: itemsFrom("[human] Clinician sign-off on the mapping"),
      enabledByConfig: false,
    });
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toMatch(/default off/);
  });

  it("is off when the repo opted in but nothing needs a human", () => {
    const policy = resolveResearchPolicy({
      items: itemsFrom("`redact()` round-trips across all profiles"),
      enabledByConfig: true,
    });
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toMatch(/no \[human\]-marked items/);
  });

  it("is on only when the repo opted in AND a [human] item exists", () => {
    const policy = resolveResearchPolicy({
      items: itemsFrom("`redact()` round-trips", "[human] Clinician sign-off"),
      enabledByConfig: true,
    });
    expect(policy.enabled).toBe(true);
    expect(policy.reason).toMatch(/1 \[human\]-marked item/);
  });

  it("carries no domains or search budget when disabled", () => {
    // A disabled policy must not look like a usable one — the model layer
    // branches on `enabled` to decide whether to send a tools array at all.
    const policy = resolveResearchPolicy({ items: itemsFrom("anything"), enabledByConfig: false });
    expect(policy.allowedDomains).toEqual([]);
    expect(policy.maxUses).toBe(0);
  });

  it("exposes the allowlist and search cap when enabled", () => {
    const policy = resolveResearchPolicy({
      items: itemsFrom("[human] Legal review of the retention clause"),
      enabledByConfig: true,
    });
    expect(policy.allowedDomains).toBe(RESEARCH_SOURCE_ALLOWLIST);
    expect(policy.maxUses).toBe(RESEARCH_MAX_USES);
  });

  it("is empty-checklist safe", () => {
    const policy = resolveResearchPolicy({ items: [], enabledByConfig: true });
    expect(policy.enabled).toBe(false);
  });
});

describe("RESEARCH_SOURCE_ALLOWLIST", () => {
  it("lists bare hostnames — no scheme, no path, no wildcards", () => {
    // `allowed_domains` is matched server-side; a scheme or path here would
    // silently never match, disabling research without any error surfacing.
    for (const domain of RESEARCH_SOURCE_ALLOWLIST) {
      expect(domain, domain).not.toMatch(/^https?:\/\//);
      expect(domain, domain).not.toMatch(/[/*]/);
      expect(domain, domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(RESEARCH_SOURCE_ALLOWLIST).size).toBe(RESEARCH_SOURCE_ALLOWLIST.length);
  });

  it("covers the standards bodies behind the motivating tickets", () => {
    // OGE-355 (DSM-5/CPT), OGE-322 (docs), plus the accessibility and
    // security criteria the same shape shows up in.
    for (const required of ["hhs.gov", "cms.gov", "w3.org", "ietf.org", "nist.gov"]) {
      expect(RESEARCH_SOURCE_ALLOWLIST).toContain(required);
    }
  });
});
