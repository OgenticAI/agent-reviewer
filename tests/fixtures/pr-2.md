Closes [OGE-316](https://linear.app/ogenticai/issue/OGE-316/audit-event-emission-for-ogentic-audit-integration) and [OGE-317](https://linear.app/ogenticai/issue/OGE-317/ogentic-audit-integration-contract-shield-audit-interface). Wave 2 of the v0.2 milestone.

> **Stacked on PR #1.** Base branch is `david/oge-308-309-redaction-api`. Once #1 merges to `main`, GitHub will auto-retarget this PR to `main`.

## Summary

Adds **chain-of-custody audit emission** to ogentic-shield. Every `Shield.analyze()` and `Shield.redact()` call now produces a structured `ShieldAuditEvent` and ships it to a pluggable `AuditBackend`. The backend protocol is the formal contract that `ogentic-audit` (and any third-party SIEM) will implement.

## Privacy invariants

- **No raw text, ever** — only `sha256:`-prefixed input hash.
- **No entity text** — `entities_detected` carries only `{category, category_group, confidence, layer, start, end}`. Spans are kept (forensics need them) but the substring is never serialized.
- Backends inherit these guarantees by construction; they cannot accidentally learn the input.

## How it works

```python
from ogentic_shield import Shield, FileAuditBackend

shield = Shield(
    profiles=["shield-finance"],
    audit_backend=FileAuditBackend("/var/log/shield-audit.jsonl"),
)

shield.analyze("Goldman Sachs is acquiring TargetCo at \$5M.")
# → emits a single shield.analyze event

shield.redact("Goldman Sachs is acquiring TargetCo from John Smith at \$5M.")
# → emits a single shield.redact event with redaction_applied=true,
#   categories_redacted=[...], tokens_emitted=N
```

Or via `ogentic-shield.yaml`:

```yaml
audit:
  backend: file       # null | stderr | file
  path: /var/log/shield-audit.jsonl
```

## Surfaces added

| Symbol | Where | Purpose |
|--------|-------|---------|
| `ShieldAuditEvent` | `models.py` | Dataclass — full event schema |
| `AuditBackend` (Protocol) | `audit.py` | The contract `ogentic-audit` implements |
| `NullAuditBackend` | `audit.py` | Default no-op |
| `StderrAuditBackend` | `audit.py` | JSON to stderr (dev) |
| `FileAuditBackend` | `audit.py` | JSON-lines to disk (auto-creates dirs) |
| `CallbackAuditBackend` | `audit.py` | Wraps a `Callable` for OTel/Datadog/etc. |
| `FanoutAuditBackend` | `audit.py` | Broadcast + per-child failure isolation |
| `Shield(..., audit_backend=...)` | `shield.py` | Wire-up |
| `AuditConfig`, `build_audit_backend` | `config.py` | YAML → backend |
| `_version.py` | new | Single source of truth, breaks circular imports |

## Failure isolation

Audit emission is on the hot path *after* the user's result is computed. `safe_emit()` catches every exception, logs at `ERROR`, and returns. A failing audit sink can never abort `analyze()` / `redact()`. The `FanoutAuditBackend` extends this guarantee per-child — one bad sink can't starve the rest.

## One-event-per-call invariant

Refactored Shield internals so `redact()` no longer routes through `analyze()` for emission purposes. `_run_analysis()` is the new internal that runs the pipeline silently; the two public methods each emit *exactly one* event, of the correct type (`shield.analyze` vs `shield.redact`).

## Files

| File | Change |
|------|--------|
| `src/ogentic_shield/audit.py` | **new** |
| `src/ogentic_shield/_version.py` | **new** |
| `src/ogentic_shield/models.py` | + `ShieldAuditEvent` |
| `src/ogentic_shield/shield.py` | accept `audit_backend`, emit on analyze/redact |
| `src/ogentic_shield/config.py` | + `AuditConfig` + `build_audit_backend()` |
| `src/ogentic_shield/__init__.py` | exports + `__version__` from `_version` |
| `tests/test_audit.py` | **new** — 25 tests |
| `ogentic-shield.yaml` | sample `audit:` block |
| `README.md` | new "Audit Events" section + backend contract |

## Verified locally

- `ruff check src/ tests/` → all checks passed
- `mypy src/` → no issues found in 28 source files
- `pytest tests/ -v` → **250/250 passing** (was 225; +25 audit tests)

## Acceptance criteria

OGE-316:
- [x] Structured audit event emitted on every `analyze()` and `redact()` call
- [x] Input text never stored in audit event (hash only) — covered by `test_event_payload_contains_no_raw_text`
- [x] Pluggable event backend (callback interface)
- [x] Default file/stderr backend shipped
- [x] Event schema documented in README

OGE-317:
- [x] `AuditBackend` Protocol defined (runtime-checkable)
- [x] `NullAuditBackend` and `FileAuditBackend` implementations (also Stderr/Callback/Fanout)
- [x] Shield accepts `audit_backend` parameter (constructor + config)
- [x] Interface documented for ogentic-audit implementors (README "Implementing your own backend")

## UAT checklist

- [ ] `Shield(audit_backend=FileAuditBackend("/tmp/x.jsonl"))` → `.analyze(...)` writes one line
- [ ] Each line is valid JSON, no raw entity text appears
- [ ] `shield.redact(...)` emits `event_type: shield.redact` (not `analyze`)
- [ ] A backend that raises does not break the calling code
- [ ] YAML `audit: {backend: file, path: ...}` produces a `FileAuditBackend`
