import { describe, expect, it } from "vitest";

import {
  mergeProtection,
  removeFromProtection,
  type BranchProtectionPut,
} from "../../src/protection/merge.js";

const OUR_CHECK = "OgenticAI Reviewer / UAT";

function existingWith(overrides: Partial<BranchProtectionPut> = {}): BranchProtectionPut {
  return {
    required_status_checks: {
      strict: true,
      contexts: ["CI / build", "CI / test"],
      checks: [
        { context: "CI / build", app_id: null },
        { context: "CI / test", app_id: null },
      ],
    },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 1 },
    restrictions: null,
    ...overrides,
  };
}

describe("mergeProtection", () => {
  describe("when no existing protection", () => {
    it("creates a fresh config requiring only our check", () => {
      const r = mergeProtection({ existing: null, context: OUR_CHECK });
      expect(r.changed).toBe(true);
      expect(r.next.required_status_checks?.contexts).toEqual([OUR_CHECK]);
      expect(r.next.required_status_checks?.strict).toBe(true);
      expect(r.next.enforce_admins).toBeNull();
      expect(r.next.required_pull_request_reviews).toBeNull();
    });

    it("respects strict=false when caller asks for it", () => {
      const r = mergeProtection({ existing: null, context: OUR_CHECK, strict: false });
      expect(r.next.required_status_checks?.strict).toBe(false);
    });

    it("includes app_id when provided", () => {
      const r = mergeProtection({ existing: null, context: OUR_CHECK, appId: 12345 });
      expect(r.next.required_status_checks?.checks?.[0]).toEqual({
        context: OUR_CHECK,
        app_id: 12345,
      });
    });
  });

  describe("when existing protection has other required checks", () => {
    it("appends our context without removing existing ones", () => {
      const r = mergeProtection({ existing: existingWith(), context: OUR_CHECK });
      expect(r.changed).toBe(true);
      expect(r.next.required_status_checks?.contexts).toEqual([
        "CI / build",
        "CI / test",
        OUR_CHECK,
      ]);
      expect(r.next.required_status_checks?.checks).toHaveLength(3);
    });

    it("preserves enforce_admins and required_pull_request_reviews verbatim", () => {
      const r = mergeProtection({ existing: existingWith(), context: OUR_CHECK });
      expect(r.next.enforce_admins).toBe(true);
      expect(r.next.required_pull_request_reviews).toEqual({
        required_approving_review_count: 1,
      });
    });

    it("preserves the existing strict value when caller doesn't override", () => {
      const r = mergeProtection({
        existing: existingWith({
          required_status_checks: {
            strict: false,
            contexts: ["CI / build"],
            checks: [{ context: "CI / build", app_id: null }],
          },
        }),
        context: OUR_CHECK,
      });
      expect(r.next.required_status_checks?.strict).toBe(false);
    });

    it("flips strict when caller explicitly overrides", () => {
      const r = mergeProtection({
        existing: existingWith({
          required_status_checks: {
            strict: false,
            contexts: ["CI / build"],
            checks: [{ context: "CI / build", app_id: null }],
          },
        }),
        context: OUR_CHECK,
        strict: true,
      });
      expect(r.next.required_status_checks?.strict).toBe(true);
      expect(r.notes.some((n) => n.includes("strict"))).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("is a no-op when our context is already required", () => {
      const r = mergeProtection({
        existing: existingWith({
          required_status_checks: {
            strict: true,
            contexts: ["CI / build", OUR_CHECK],
            checks: [
              { context: "CI / build", app_id: null },
              { context: OUR_CHECK, app_id: null },
            ],
          },
        }),
        context: OUR_CHECK,
      });
      expect(r.changed).toBe(false);
      expect(r.next.required_status_checks?.contexts).toEqual(["CI / build", OUR_CHECK]);
    });

    it("doesn't duplicate our context if it's only in `checks` and not `contexts`", () => {
      // Some real-world responses have one but not the other; we should treat
      // either as "already required".
      const r = mergeProtection({
        existing: existingWith({
          required_status_checks: {
            strict: true,
            contexts: [],
            checks: [{ context: OUR_CHECK, app_id: 999 }],
          },
        }),
        context: OUR_CHECK,
      });
      expect(r.changed).toBe(false);
    });
  });
});

describe("removeFromProtection", () => {
  it("removes our context but keeps the others", () => {
    const r = removeFromProtection({
      existing: existingWith({
        required_status_checks: {
          strict: true,
          contexts: ["CI / build", OUR_CHECK],
          checks: [
            { context: "CI / build", app_id: null },
            { context: OUR_CHECK, app_id: null },
          ],
        },
      }),
      context: OUR_CHECK,
    });
    expect(r.changed).toBe(true);
    expect(r.next.required_status_checks?.contexts).toEqual(["CI / build"]);
    expect(r.next.required_status_checks?.checks).toHaveLength(1);
  });

  it("is a no-op when our context wasn't required", () => {
    const r = removeFromProtection({
      existing: existingWith(),
      context: OUR_CHECK,
    });
    expect(r.changed).toBe(false);
  });

  it("returns null protection when existing was null", () => {
    const r = removeFromProtection({ existing: null, context: OUR_CHECK });
    expect(r.changed).toBe(false);
    expect(r.next.required_status_checks).toBeNull();
  });
});
