/**
 * Read-only HTTP fetch, allowlisted (OGE-1556).
 *
 * Closes two categories of punt (8 mentions) plus the "renders cleanly on
 * GitHub" slice — a string that appears verbatim in *both* of the repo's own
 * test fixtures:
 *
 *   OGE-722: "requires post-publish verification on PyPI."
 *   OGE-310: "requires external verification of package metadata."
 *   OGE-1196: "Badge resolution, actual GitHub rendering … require human
 *              verification outside the diff."
 *
 * ── Why an allowlist, not arbitrary URLs ────────────────────────────────────
 *
 * The URL would come from model output, and the model's input includes a
 * PR-authored diff and checklist. An unrestricted fetcher inside a process
 * holding ANTHROPIC_API_KEY, LINEAR_API_TOKEN, and a GitHub App private key is
 * a server-side request forgery primitive: a PR could name
 * `http://169.254.169.254/…` (cloud metadata) or an internal host and have the
 * reviewer fetch it and paste the result into a public PR comment.
 *
 * Blocking private IP ranges is the usual mitigation, and it is genuinely hard
 * to do correctly — DNS rebinding, IPv6-mapped IPv4, redirects, `0.0.0.0`,
 * decimal-encoded hosts. An allowlist sidesteps the whole class: the only
 * reachable hosts are ones we named, and none of them are ours.
 *
 * The cost is real and worth stating: general link-checking ("every badge in
 * the README resolves") is NOT covered by this tool, because it needs
 * arbitrary hosts. That case stays UNVERIFIABLE.
 */

import type { ReviewTool, ToolResult } from "./registry.js";

/**
 * Hosts the reviewer may fetch.
 *
 * Admission rule: a host belongs here only if it is a public, read-only
 * publisher of package or repository metadata, and fetching it can leak
 * nothing an attacker could not fetch themselves. Nothing internal. Nothing
 * that accepts credentials.
 */
export const HTTP_HOST_ALLOWLIST: readonly string[] = [
  "pypi.org",
  "registry.npmjs.org",
  "crates.io",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "img.shields.io",
];

/** Cap on fetched body size — one call must not blow the context budget. */
export const HTTP_MAX_BYTES = 32 * 1024;

/** Per-request timeout. A hung fetch must not stall the review. */
export const HTTP_TIMEOUT_MS = 10_000;

export class HostNotAllowedError extends Error {
  constructor(host: string) {
    super(
      `Host not allowed: ${host}. Allowed: ${HTTP_HOST_ALLOWLIST.join(", ")}. ` +
        `General link-checking is not supported — leave such items UNVERIFIABLE.`,
    );
    this.name = "HostNotAllowedError";
  }
}

/**
 * Validate a URL against the allowlist.
 *
 * Exact host match, not a suffix match: `endsWith("pypi.org")` would also
 * accept `evil-pypi.org`, which is the classic way this check is written
 * wrong.
 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostNotAllowedError(String(raw));
  }
  if (url.protocol !== "https:") {
    throw new HostNotAllowedError(`${url.protocol}// (https only)`);
  }
  if (!HTTP_HOST_ALLOWLIST.includes(url.hostname)) {
    throw new HostNotAllowedError(url.hostname);
  }
  return url;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: "error" }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Build the HTTP toolset.
 *
 * `fetchImpl` is injectable so tests exercise every branch — allowlist
 * rejection, non-200, timeout, oversized body — without network access.
 */
export function makeHttpTools(fetchImpl: FetchLike = globalThis.fetch as FetchLike): ReviewTool[] {
  return [fetchUrlTool(fetchImpl)];
}

function fetchUrlTool(fetchImpl: FetchLike): ReviewTool {
  return {
    definition: {
      name: "fetch_url",
      description:
        "Fetch a URL from an allowlisted public metadata host (PyPI, npm, crates.io, " +
        "api.github.com, raw.githubusercontent.com, shields.io) and return its body. Use this " +
        "to check published package metadata or a raw file on a branch. Arbitrary hosts are " +
        "refused — general link-checking is not supported.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute https URL on an allowlisted host" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async execute(input): Promise<ToolResult> {
      const raw =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).url
          : undefined;
      if (typeof raw !== "string" || raw.length === 0) {
        return { content: "fetch_url requires a non-empty `url`.", isError: true };
      }

      let url: URL;
      try {
        url = assertAllowedUrl(raw);
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      try {
        // `redirect: "error"` matters: a 302 from an allowlisted host to an
        // internal one would otherwise walk straight around the allowlist.
        const response = await fetchImpl(url.toString(), {
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          return {
            content: `HTTP ${response.status} from ${url.hostname}${url.pathname}`,
            isError: true,
          };
        }
        const body = await response.text();
        const truncated = body.length > HTTP_MAX_BYTES;
        return {
          content: truncated
            ? `${body.slice(0, HTTP_MAX_BYTES)}\n… [truncated at ${HTTP_MAX_BYTES} bytes]`
            : body,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: controller.signal.aborted
            ? `Timed out after ${HTTP_TIMEOUT_MS}ms fetching ${url.hostname}`
            : `Fetch failed: ${message}`,
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
