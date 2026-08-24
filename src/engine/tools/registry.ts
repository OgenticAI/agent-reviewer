/**
 * The reviewer's client-side tool registry (OGE-1552).
 *
 * Tools are **injected**, never baked into the loop. That keeps the loop
 * itself trivially testable with fake tools, and it means shipping the loop
 * with an empty registry is a behavioural no-op — the whole point of landing
 * this before any actual tool exists.
 *
 * Client-side means *we* execute them and feed results back, as distinct from
 * Anthropic's server-side tools (web search, web fetch), which run on
 * Anthropic's infrastructure and need no loop at all. See `research/policy.ts`
 * for that path — mixing the two up is the easiest mistake to make here.
 *
 * Security posture for anything added to this registry:
 *
 *   The reviewer's process holds ANTHROPIC_API_KEY, LINEAR_API_TOKEN, and a
 *   GitHub App private key. A tool that executes PR-authored code in that
 *   process is a credential-exfiltration path, not a capability upgrade. Read
 *   tools (file reads, log fetches, HTTP GETs against an allowlist) are fine.
 *   Anything that runs code the PR author controls belongs in a separate,
 *   secretless job — see OGE-1557. That safe side now exists: `tools/exec.ts`
 *   provides the single `run_command` tool, added to the registry ONLY behind
 *   `sandbox_enabled` (OGE-1584) and fail-closed if any secret is in its env.
 */

/** A JSON Schema object describing a tool's input. */
export type ToolInputSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

/**
 * The result of running a tool. `isError` maps to `tool_result.is_error`,
 * which tells the model the call failed so it can adapt rather than treating
 * an error string as data.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ReviewTool {
  definition: ToolDefinition;
  /**
   * Execute the tool. Implementations must resolve rather than throw wherever
   * possible — a thrown error is caught by the loop and converted into an
   * error result, but returning one directly gives a better message.
   */
  execute(input: unknown): Promise<ToolResult>;
}

/** Name → tool. Empty by default; capability tickets add entries. */
export type ToolRegistry = ReadonlyMap<string, ReviewTool>;

export const EMPTY_REGISTRY: ToolRegistry = new Map();

export function makeRegistry(tools: ReviewTool[]): ToolRegistry {
  const map = new Map<string, ReviewTool>();
  for (const tool of tools) {
    if (map.has(tool.definition.name)) {
      // A duplicate name would mean one tool silently shadows another, and the
      // model would get a schema for one implementation and the behaviour of
      // the other. Fail at construction instead.
      throw new Error(`Duplicate tool name in registry: ${tool.definition.name}`);
    }
    map.set(tool.definition.name, tool);
  }
  return map;
}

/** The `tools` array to send to the API, or undefined for an empty registry. */
export function toolDefinitions(registry: ToolRegistry): ToolDefinition[] | undefined {
  if (registry.size === 0) return undefined;
  return [...registry.values()].map((t) => t.definition);
}
