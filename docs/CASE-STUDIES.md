# Production Case Studies

Three complete, self-verifying polyglot case studies live under [`examples/case-studies/`](../examples/case-studies/) alongside the original TypeScript reference app [`examples/retro-board/`](../examples/retro-board/). Every case study compiles deterministically from its `profile.json` and passes `vld verify --repo . --strict --require-assertions` against real product source and test suites.

## 1. Regulated Fintech Payout Ledger (Go · Tier 3 · PCI-DSS + SOX + DORA)

- **Path:** `examples/case-studies/01-fintech-payout-go/`
- **Stack:** Go (`go.mod`, `internal/ledger/ledger.go`, `internal/ledger/ledger_test.go`)
- **Governance:** Rigor tier 3, overlays `pci-dss`, `sox`, `dora`, custom rules `REQ-C01` (dual-control approval above EUR 10,000) and `REQ-C02` (idempotent settlement posting with balanced debit/credit legs).
- **What it proves:** Native Go test discovery (`**/*_test.go`), real Go module import verification, `t.Fatalf` assertion checking, SOX segregation-of-duties + DORA resilience gate mapping, and custom business rule traceability.

## 2. Clinical Triage Copilot (Python · Tier 3 · HIPAA + GDPR + EU AI Act)

- **Path:** `examples/case-studies/02-clinical-triage-python/`
- **Stack:** Python + FastAPI (`pyproject.toml`, `src/triage/engine.py`, `tests/test_triage.py`)
- **Governance:** Rigor tier 3, overlays `hipaa`, `gdpr`, `eu-ai-act`, active `agent.autonomy-limits` primitive (`G2-AUTONOMY`), and custom rule `REQ-C01` (mandatory clinician sign-off before emitting an urgent disposition).
- **What it proves:** Native Python `pytest` discovery (`tests/**/test_*.py`), non-stdlib import verification, EU AI Act human-oversight and HIPAA PHI encryption requirements, and bounded agent step/kill-switch verification.

## 3. Polyglot Multi-Service SaaS Platform (TypeScript + Go + Rust · Tier 2 · GDPR)

- **Path:** `examples/case-studies/03-polyglot-saas-platform/`
- **Stack:** Multi-service `constraints.stack` map combining `web` (TypeScript), `api` (Go), and `worker` (Rust) in one repository.
- **Governance:** Rigor tier 2, `gdpr` overlay, multi-tenant authorization, webhook ingestion, and custom rule `REQ-C01` (per-tenant export quota enforcement).
- **What it proves:** Simultaneous three-language anchor scanning across `.test.ts`, `_test.go`, and Rust `tests/*.rs` from a single compiled `spec.json` with zero cross-language false positives.

## Reproduce Locally

```bash
for dir in examples/case-studies/*/; do
  node factory/cli.mjs verify "${dir}spec" --repo "$dir" --strict --require-assertions
done
```
