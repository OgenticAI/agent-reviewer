Closes [OGE-308](https://linear.app/ogenticai/issue/OGE-308/redaction-wrapper-redact-unredact-api) and [OGE-309](https://linear.app/ogenticai/issue/OGE-309/redact-categories-configuration-documentation). First v0.2 milestone PR.

## Summary

Adds the v0.2.0 **redaction primitive** — substitutes identifying entities with deterministic tokens before an LLM call, then restores them on the response. Implements the *"anonymity = masking who, not how big"* principle: identifiers leave, numbers/ratios/clinical content survive by default.

Unblocks [OGE-134](https://linear.app/ogenticai/issue/OGE-134) (Sizer finance redaction).

## How it works

```python
from ogentic_shield import Shield

shield = Shield(profiles=["shield-finance"])
text = "Goldman Sachs is advising John Smith on the acquisition at $47/share, 5.2x EBITDA."

redacted, mapping = shield.redact(text)
# → "[Sponsor_a3f9b1] is advising [Person_b7e0c4] on the acquisition at $47/share, 5.2x EBITDA."
#   ✅ Numbers preserved (LLM can still do math)
#   ✅ "Who" redacted (sponsor + person masked)

response = call_external_llm(redacted)
original = Shield.unredact(response, mapping)
```

### Token properties

- **Format**: `[Person_a3f9b1]` — friendly category prefix + 6-char hex
- **Within one call**: same value → same token (LLM sees coherent references)
- **Across calls**: per-call salt → no cross-document linkage via rainbow lookup
- **Reversible**: only via the returned `RedactionMapping` — nothing in the token itself reveals the original

### Per-profile defaults

| Profile | Default `redact_categories` |
|---------|----------------------------|
| `shield-finance` | `Person, Address, Sponsor, Email, Phone, Ssn` |
| `shield-legal` | defaults + `CaseNumber, BatesNumber` |
| `shield-therapy` | defaults + `DateOfBirth, InsuranceId, MedicalLicense` |

Override per call: `redact_categories=["Email", "Person"]`. Power users can pass raw entity types (e.g. `"INSTITUTION_NAME"`).

## Files

| File | Change |
|------|--------|
| [src/ogentic_shield/redaction.py](src/ogentic_shield/redaction.py) | **new** — `redact_text()`, `unredact_text()`, category maps, profile defaults |
| [src/ogentic_shield/models.py](src/ogentic_shield/models.py) | + `RedactionMapping` dataclass |
| [src/ogentic_shield/shield.py](src/ogentic_shield/shield.py) | + `Shield.redact()` / `Shield.unredact()` methods |
| [src/ogentic_shield/__init__.py](src/ogentic_shield/__init__.py) | exports + `__version__ = "0.2.0.dev0"` |
| [tests/test_redaction.py](tests/test_redaction.py) | **new** — 27 tests covering all the above |
| [tests/cli/test_cli.py](tests/cli/test_cli.py) | version test now reads `__version__` dynamically |
| [README.md](README.md) | new "Redaction (Detection ≠ Redaction)" section + roadmap update |

## Verified locally

- `ruff check src/ tests/` → all checks passed
- `mypy src/` → no issues found in 26 source files
- `pytest tests/ -v` → **225/225 passing** (was 198; +27 redaction tests)

## Acceptance criteria

OGE-308:
- [x] `shield.redact(text, profile)` returns `(redacted_text, token_mapping)`
- [x] `shield.unredact(text, mapping)` restores original values
- [x] Deterministic token format `[Category_<6hex>]`
- [x] Default `redact_categories` = identifying-only
- [x] Composable with existing `Shield.analyze()` pipeline
- [x] Round-trip tests across all 3 profiles

OGE-309:
- [x] `redact_categories` parameter on `redact()`
- [x] Profile-aware defaults (each profile knows its identifying-only categories)
- [x] Documentation: principle explanation + usage examples in README
- [x] Tests for category inclusion/exclusion behavior

## UAT checklist

- [ ] `from ogentic_shield import Shield; s = Shield(profiles=["shield-finance"]); s.redact("...")` works
- [ ] Numbers/dollar amounts visibly preserved in the redacted output for finance
- [ ] `Shield.unredact(response, mapping)` exactly reverses round-trip
- [ ] README "Redaction" section renders cleanly on GitHub
