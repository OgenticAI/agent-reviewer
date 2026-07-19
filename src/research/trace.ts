/**
 * Reads what the server-side search actually did out of a response's content
 * blocks (OGE-1566).
 *
 * Deliberately structural — it takes `unknown[]` and narrows by shape rather
 * than importing Anthropic SDK types. Two reasons: `src/review.ts` stays a
 * pure module with no SDK dependency, and these parsers stay unit-testable
 * against hand-written fixtures with no network and no API key.
 *
 * Two things are extracted, for two different jobs:
 *
 *   - `queries` — every search string the model composed. This is the **audit
 *     trail**. Because the model writes the query and Anthropic dispatches it
 *     server-side, we cannot inspect it before it leaves; logging it after the
 *     fact is the only visibility available. See `research/policy.ts`.
 *
 *   - `citedUrls` — every URL that came back from a search. This is the
 *     **allowlist for citations**: a verdict may only cite a source that
 *     actually appeared in results, so the model cannot invent a plausible
 *     URL to dress up a claim it made from memory.
 */

/** What the server-side search did during one review run. */
export interface ResearchTrace {
  /** Search strings the model composed, in order. Logged for audit. */
  queries: string[];
  /** URLs returned by searches. The permitted citation set. */
  citedUrls: string[];
  /**
   * Search errors, by code (e.g. `max_uses_exceeded`, `unavailable`).
   *
   * Server-tool failures arrive as HTTP 200 with an error object in the result
   * block — they never throw. Silently dropping them would make "research
   * found nothing" and "research never ran" indistinguishable in the logs.
   */
  errors: string[];
}

export const EMPTY_TRACE: ResearchTrace = { queries: [], citedUrls: [], errors: [] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Concatenate the text blocks of a response — the model's actual JSON verdict.
 *
 * When server tools run, `content` interleaves `server_tool_use` and
 * `web_search_tool_result` blocks between the text. Naively reading
 * `content[0].text` would pick up an empty preamble or crash on a tool block,
 * so join every text block and let the caller's JSON parse sort it out.
 */
export function extractText(content: unknown[]): string {
  return content
    .filter(isRecord)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Pull the search trace out of a response's content blocks.
 *
 * Shapes handled (per the Messages API server-tool contract):
 *   { type: "server_tool_use", name: "web_search", input: { query } }
 *   { type: "web_search_tool_result", content: [ { type: "web_search_result", url } ] }
 *   { type: "web_search_tool_result", content: { error_code: "..." } }
 *
 * Note the asymmetry in that last pair: a **successful** result block carries
 * an array, an **errored** one carries a bare object. Indexing without
 * checking `Array.isArray` first is the standard way to get this wrong.
 */
export function extractResearchTrace(content: unknown[]): ResearchTrace {
  const queries: string[] = [];
  const citedUrls = new Set<string>();
  const errors: string[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === "server_tool_use") {
      const input = block.input;
      if (isRecord(input) && typeof input.query === "string") {
        queries.push(input.query);
      }
      continue;
    }

    if (block.type !== "web_search_tool_result") continue;

    const inner = block.content;
    if (Array.isArray(inner)) {
      for (const result of inner) {
        if (isRecord(result) && typeof result.url === "string") {
          citedUrls.add(result.url);
        }
      }
    } else if (isRecord(inner)) {
      // Error shape — HTTP 200 with an error object, not a thrown exception.
      const code = inner.error_code;
      errors.push(typeof code === "string" ? code : "unknown_error");
    }
  }

  return { queries, citedUrls: [...citedUrls], errors };
}
