# Verdict outcome telemetry (OGE-1592)

`puntRate` measures how often the reviewer declines to answer. On its own it
cannot tell **better verification** from **bolder guessing**: a run that swaps
honest `UNVERIFIABLE` punts for confident wrong `PASS`es scores *better* on
punt rate. Outcome telemetry is the second number that makes that failure
visible.

The core idea is BitsAI-CR's **Outdated Rate**, and its appeal is that it needs
no human annotation: a finding counts as acted-on when the code it pointed at
changes in a later commit. We compute the same signal by diffing the previous
sticky sidecar's cited files against the paths changed in the current push.

## The outcomes

Computed per item, each run, in `src/metrics/outcomes.ts`:

| Outcome | Meaning |
|---|---|
| `acted-on` | A negative verdict (`FAIL`/`PARTIAL`/`UNVERIFIABLE`) flipped positive **and** a file the previous verdict cited changed. The reviewer said something and someone acted on it. |
| `unexplained-flip` | Flipped positive with **no** cited file touched. The alarm case: either the original finding was noise, or this run is guessing where the last one investigated. **This is the class to review.** |
| `overridden` | A human force-passed the item via `/uat-override`. A real outcome, and distinct — it means the reviewer was ignored, not agreed with. |
| `outstanding` | Still negative. |
| `unchanged` | Was already positive. |
| `new` | No counterpart in the previous verdict (first review, or a new item). |

`acted-on` and `unexplained-flip` are reported **separately on purpose**.
Collapsing them into one "resolved" number would hide exactly the failure this
telemetry exists to catch.

## Rates, in the hidden metrics block

Rendered into the same `<!-- ogenticai-reviewer-metrics … -->` comment as
`puntRate` (`src/metrics/verdict-metrics.ts`):

- `actedOnRate` = `acted-on / (acted-on + unexplained-flip)`. `null` when
  nothing flipped — a rate over an empty denominator is undefined, not `0`, and
  `0` would read as total failure on a PR where nothing regressed.
- `overrideRate` = `overridden / total items`.

Both are omitted entirely on a first review, when there is no previous verdict
to compare against.

## Labeled rows for the eval set

With `--output-json PATH`, the CLI also writes `PATH.outcomes.jsonl` — one JSON
object per line, append-friendly across runs and repos, consumable directly as
[OGE-1589](https://linear.app/ogenticai/issue/OGE-1589) eval fixtures:

```json
{"repo":"OgenticAI/agent-reviewer","pr":62,"headSha":"…","ticketId":"OGE-308","itemId":2,"itemText":"renders cleanly on GitHub","status":"PASS","previousStatus":"UNVERIFIABLE","outcome":"acted-on","confidence":0.9,"changedEvidencePaths":["README.md"],"generatedAt":"2026-07-19T…Z"}
```

The schema is deliberately flat and stable: anything reading these rows will
outlive the module that writes them.

## Path matching is intentionally loose

The model writes repo-relative paths; `git` may report them prefixed (monorepo
roots) or moved (renames). A cited path matches a changed path when either ends
with the other. Qodo's own docs warn that fulfillment is usually indirect —
match at file level, not diff level. A missed match degrades an `acted-on` into
an `unexplained-flip`, which errs toward flagging rather than toward silence.

## Follow-ups at merge

Before merge, an `UNVERIFIABLE` item is a live question — filing a ticket for it
would be noise on every push. At merge (`REVIEWER_PR_MERGED=true`), that question
shipped unanswered, so `runWriteback()` promotes still-`UNVERIFIABLE` items into
child issues alongside the existing `FAIL`/`PARTIAL` ones, reusing the same
idempotent path in `src/linear/writeback.ts`. `[human]` items are included
deliberately: merging means the code went out without the sign-off its author
said it needed.
