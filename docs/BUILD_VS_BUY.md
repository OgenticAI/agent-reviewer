# Build vs buy — why we built this

We surveyed the AI PR-review market in late April 2026 before scoping this project. Three exploration agents converged on the same conclusion: nothing on the market does the one thing we actually need — *review against the linked Linear ticket's UAT checklist with per-item verdicts, write back to both PR and Linear, gate the merge*.

## The off-the-shelf candidates

| Tool | What it does | Pricing | Linear (read + write back) | Per-item checklist verdicts | Self-host / OSS |
|---|---|---|---|---|---|
| **CodeRabbit** | Inline AI review + summary | Free / $12 Lite / $24 Pro | Yes (read) — Pro added native Linear "Issue Planner" Feb 2026; pulls ticket context. Writeback is one-way (status nudges), no per-checkbox commenting. | Partial — review instructions exist, no checkbox→verdict loop. | Enterprise self-host (~$15k/mo). Closed. |
| **Greptile** | Codebase-aware inline review | $1/review after 50 (March 2026 repricing) | GitHub-only. | No. | Closed. |
| **Sourcery** | Bugs/style/security review | Free / $12+ / Enterprise | Not advertised. | Rules-based. | Closed. |
| **Cody (Sourcegraph)** | Codebase-aware assistant; review secondary | Per-seat enterprise | No. | No. | Closed (SaaS + on-prem). |
| **Qodo Merge / PR-Agent** | Multi-agent review; v2 Feb 2026 | OSS free; SaaS paid | Generic via prompts; no native Linear. | Closest fit — accepts custom rubrics; stable verdicts need scaffolding. | Yes — MIT OSS, runs as Action with your LLM keys. |
| **Sweep** | Issue→PR generator | SaaS | GitHub Issues only. | N/A | OSS but ~dormant. |
| **Devin reviewer mode** | Autonomous engineer that reviews | $500+/mo | Slack/Linear chat surface, not checklist-driven. | No. | Closed. |

CodeRabbit is the closest commercial fit on Linear context. Qodo is the closest on customizable rubrics. Neither does both.

## Anthropic-native options

- **`anthropics/claude-code-action`** — mature, MCP-aware, supports Anthropic / Bedrock / Vertex. The natural substrate for an in-house reviewer because we can mount the Linear MCP directly and the prompt becomes the entire product.
- **Claude Agent SDK + Managed Agents** — beta in early 2026; designed for long-running async work. Overkill for a webhook-triggered reviewer.
- **Reference OSS** — [`besimple-oss/broccoli`](https://github.com/besimple-oss/broccoli) (MIT) is the closest blueprint: GitHub App + FastAPI on Cloud Run, already speaks Linear and GitHub webhooks, Claude-powered review. PR-generation-first, but the App + webhook shape is exactly what we'd build at scale. We borrow the shape; we don't fork.

## Linear integration angle

- Linear's official GitHub integration auto-links by branch/title and moves status from PR lifecycle events. It does NOT read PR review content or post structured comments back.
- Linear's webhooks + GraphQL API are the path for custom writeback. Auth via OAuth (admin scope) or personal API key.
- No widely-adopted "Linear UAT bot" exists. Real gap in the market.

## The decision

**Build, on top of `claude-code-action` + the existing Linear MCP**, distributed as a composite GitHub Action AND a Claude Code plugin so cowork sessions get the same logic locally. Reasons:

1. The one feature we need — *map every UAT checkbox to a verdict, comment back to both PR and Linear* — is not a product anyone ships.
2. The build is small (Action + MCP + prompt + ~600 LOC of TypeScript) and reuses Anthropic infra OgenticAI already pays for.
3. Shipping as a Claude plugin means every OgenticAI repo gets the review tool for free in cowork sessions, not just in CI.
4. Vendor risk: Greptile's March 2026 unilateral repricing is the cautionary tale. Owning the prompt + the storage means we don't get held hostage.

Trade-off acknowledged: we own prompt drift, idempotency, and stable-verdicts-across-runs. That's why this repo has 25+ tests on the deterministic surfaces (parser, renderer, resolver) and why the Action runs at temperature 0.

## Sources

- [CodeRabbit Documentation](https://docs.coderabbit.ai/) · [pricing](https://www.coderabbit.ai/pricing)
- [Qodo Merge / PR-Agent (OSS)](https://github.com/qodo-ai/pr-agent)
- [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
- [Claude Managed Agents (beta)](https://platform.claude.com/docs/en/managed-agents/overview)
- [Linear webhooks](https://linear.app/developers/webhooks)
- [`besimple-oss/broccoli` (OSS Linear↔GitHub↔Claude)](https://github.com/besimple-oss/broccoli)
