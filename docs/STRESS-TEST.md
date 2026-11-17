# 18-Idea Stress Test & Adversarial Corpus

`npm run stress` exercises the deterministic compiler across **18 diverse product ideas** (`examples/ideas/*.json`, verified against `examples/ideas/expected.json`) and **30 adversarial profiles** (`examples/ideas/adversarial/cases.json`).

## What Every Idea Must Satisfy

1. **Oracle parity:** exact match on rigor tier (`0`–`3`), resolved stack profile(s), active regulatory overlays, mandatory requirements, mandatory primitives, and active CI gates.
2. **Byte-identical double compilation:** compiling the same profile into two separate directories produces byte-for-byte identical Markdown, `spec.json`, `spec-check.mjs`, and `enforcement/gates.mjs`.
3. **Document budget & specificity:** every packet document stays under the 200-line ceiling (140 lines for tier-0 single-file sketches) and binds the idea's extracted domain vocabulary (`68%` corpus vocabulary precision).
4. **Native stack test discoverability:** synthetic `@req` test anchors generated at each stack's canonical test layout pass `spec-check.mjs --strict --require-assertions` across single-stack and multi-service repos.
5. **Zero false-positive risk hints:** well-formed profiles trigger zero spurious risk-flag warnings.

## Corpus Matrix (18 Ideas · 10 Stacks · 8 Overlays · Tiers 0–3)

| ID | Domain | Kind | Tier | Stack(s) | Regulatory Overlays |
| --- | --- | --- | --- | --- | --- |
| `01-photo-sorter` | Local photo organizer | `cli` | 0 | `python` | — |
| `02-bike-market` | Peer-to-peer marketplace | `web-app` | 2 | `typescript` | `gdpr` |
| `03-standup-bot` | Team async check-in bot | `automation` | 1 | `javascript` | — |
| `04-clinic-bookings` | Patient appointment portal | `web-app` | 3 | `csharp` | `hipaa` |
| `05-payout-ledger` | Merchant settlement ledger | `api` | 3 | `go` | `pci-dss` |
| `06-habit-sync` | Offline-first mobile tracker | `mobile` | 1 | `kotlin` | — |
| `07-events-etl` | Streaming analytics pipeline | `data-pipeline` | 2 | `python` | — |
| `08-flags-sdk` | Feature-flag evaluation SDK | `library` | 1 | `rust` | — |
| `09-docs-assistant` | Internal RAG knowledge assistant | `agent` | 2 | `typescript` | — |
| `10-log-shipper` | Daemon shipping NDJSON logs | `cli` | 2 | `go` | — |
| `11-telehealth-triage` | AI symptom triage service | `agent` | 3 | `python` | `hipaa`, `gdpr`, `eu-ai-act` |
| `12-junior-coders` | K-12 coding classroom app | `web-app` | 3 | `php` | `coppa`, `gdpr` |
| `12b-campus-registrar` | University transcript portal | `web-app` | 3 | `java` | `ferpa` |
| `12c-sox-treasury` | Corporate treasury close system | `api` | 3 | `csharp` | `sox` |
| `13-incident-responder` | Autonomous financial SRE agent | `agent` | 3 | `go` | `dora`, `eu-ai-act` |
| `14-polyglot-commerce` | Multi-service storefront & checkout | `web-app` | 3 | `typescript` + `go` + `python` | `pci-dss`, `gdpr` |
| `14b-ruby-invoices` | B2B recurring invoicing SaaS | `web-app` | 2 | `ruby` | `gdpr` |
| `15-edge-telemetry` | High-throughput edge collector | `data-pipeline` | 2 | `rust` | — |

## Adversarial Suite (`scripts/stress-adversarial.mjs`)

All **30 adversarial cases** pass cleanly: prompt-injection attempts inside `idea` and `rules`, Unicode bidirectional overrides, oversized payloads, contradictory stage/risk combinations, path traversal strings, and malformed schemas are either neutralized during compilation (24 cases) or deterministically rejected with exit code `2` (6 cases).
