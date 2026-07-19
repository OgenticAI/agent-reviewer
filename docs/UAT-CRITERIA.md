# Writing UAT criteria a pre-merge reviewer can check

The OgenticAI Reviewer reads your PR's `## UAT checklist` and decides, item by
item, whether the diff delivers it. It runs **before merge**, against the code
as it exists in the pull request.

Most items it can't verify aren't a reviewer problem. They're criteria aimed at
a different verifier — a person, after deploy, with production access. This
page is how to write ones that land.

**The rule of thumb:**

> An acceptance criterion should name an **observable artifact that exists at
> merge time**.

`redact() round-trips across all three profiles, covered by test_round_trip` is
checkable. `Redaction works correctly in production` is not — not because it's
a bad thing to want, but because nothing in a pre-merge diff can settle it.

---

## Before / after

Every "before" below is a real criterion from a real ticket, with the
reviewer's actual response.

### Post-merge and operator actions

**OGE-588** — all eight items were operator-side post-merge steps, so the
verdict came back with an empty table:

> "All 8 UAT items are operator-side post-merge actions (merge, PyPI token
> setup, tag push, runtime verification)."

| ❌ Before | ✅ After |
|---|---|
| Merge the PR once CI is green | *(delete — the merge is the gate, not a criterion)* |
| Push the v0.2.0 tag | The release workflow triggers on a `v*` tag |
| Package is published to PyPI | `pyproject.toml` declares the 3.13 classifier and the `publish` job |
| Set up the `PYPI_API_TOKEN` secret | The publish workflow reads `PYPI_API_TOKEN` from secrets |

The pattern: assert the **mechanism** exists in the diff, and verify the
**outcome** in the ticket after rollout.

### Live accounts and production data

**OGE-728**:

> "UAT items 1-4 require manual reproduction with real Drive accounts and
> cannot be verified from the diff alone."

**OGE-850**:

> "All three UAT items are end-to-end runtime behavior tests that require live
> integrations, production data, and human evaluation of agent responses."

| ❌ Before | ✅ After |
|---|---|
| Sync works against a real Google Drive account | Shared-drive pagination is covered by `test_sync_paginates_shared_drives` |
| Query returns correct results on production data | The temporal filter uses `sourceModifiedAt`, covered by a fixture with out-of-order docs |

Note what is **not** being suggested: giving the reviewer production
credentials. That's a security decision, not a capability gap. Split the item
— assert the logic in a test here, verify live behaviour in the ticket.

### Documentation clarity and human judgment

**OGE-322**:

> "Item 3 is unverifiable as documentation clarity requires human judgment."

**OGE-355**:

> "Item 3 (test-suite pass counts) and item 5 (clinician sign-off) are
> unverifiable from the diff alone."

These are **correct punts**. Don't rewrite them into something fake — mark
them, see below.

---

## `[human]`: who signs, not what's skipped

Some criteria genuinely need a person. Declare them:

```markdown
- [ ] [human] Clinician confirms the PHI categories match DSM-5 practice
```

A `[human]` item is **excluded from the merge gate**, so declaring one costs
you nothing. Marking honestly is better than leaving a criterion the reviewer
will punt on anyway.

**`[human]` does not mean the reviewer ignores it.** Most such criteria bundle
two things:

1. **An attestation** — a licensed person putting their name to it.
   Undelegatable. This is why the verdict stays `UNVERIFIABLE`.
2. **A factual question** — do these 15 category names actually correspond to
   DSM-5 categories or HIPAA Safe Harbor identifiers? Entirely researchable.

The reviewer narrows (2) so the signer's job shrinks from *figure this out* to
*confirm this*. That only works if you write a **specific question against a
named standard**:

| ❌ Vague | ✅ Specific |
|---|---|
| `[human]` Clinician review | `[human]` Clinician confirms the 15 PHI categories match HIPAA Safe Harbor |
| `[human]` Design looks right | `[human]` Design review: empty state matches the Figma spacing spec |
| `[human]` Docs are clear | `[human]` A first-time contributor can follow README §Setup unaided |

Use `[human]` for: sign-off and approval, visual and design judgment, "reads
clearly", anything needing a licence or an accountable person.

Don't use it as a shortcut for a criterion you could have written checkably.
The linter won't catch that; a reviewer will.

---

## What the reviewer can now check

Since Reviewer v2 it reads more than the diff. Criteria that used to be
hopeless are now fine:

| The reviewer can… | So this is checkable |
|---|---|
| Read any file in the repo | "The new helper is called from `orgs-list`" |
| Search the repo | "No caller still uses the deprecated flag" |
| See CI check-run status | "The test suite passes on this commit" |
| Read CI job logs | "All 225 tests pass" · "The benchmark stays under 200ms" |
| Fetch package registries | "`pyproject.toml` version matches the published one" |
| Search standards sources | *(on `[human]` items, to brief the signer)* |

Still out of reach: anything post-merge, anything needing production
credentials, and general link-checking against arbitrary hosts.

---

## A worked checklist

```markdown
## UAT checklist

- [ ] `shield.redact(text, profile)` returns `(redacted_text, token_mapping)`
- [ ] Round-trip covered by `test_round_trip` across all 3 profiles
- [ ] `redact_categories` defaults to identifying-only per profile
- [ ] The full suite passes on this commit
- [ ] [human] Clinician confirms the therapy categories match HIPAA Safe Harbor
```

Five items: four the reviewer settles from the diff, the repo, and CI; one
declared for a person, phrased as a specific question against a named standard.

---

## The linter

The reviewer lints your checklist when the PR opens or its description is
edited, and comments if items can't be checked pre-merge. It's **advisory** —
it never blocks the merge. If it flags something you believe is right, it's
wrong; open an issue.

## Where else this applies

Acceptance criteria live as checkboxes on the Linear ticket
(`.claude/LINEAR-INTEGRATION.md` §8) and are often generated by the factory's
Story Writer before anyone opens a PR. **Fixing them at the ticket is better
than fixing them at the PR** — otherwise the same shape gets regenerated next
sprint.
