# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles. Releases are also published through GitHub releases and tags.

## [Unreleased]

### Added

- **Safe-by-default forge delivery (roadmap 4.2):** governed `runtime forge execute` publishes **draft** pull requests unless `--ready` is passed and draft PRs can never merge (remote draft state is re-checked before the merge endpoint); the PR body gains `Sandbox receipts:` and `Evidence export:` sections; publishing is refused outright when the hash-chained evidence ledger fails verification (`FORGE_EVIDENCE_CHAIN_INVALID`) or an escalation packet (rigor tier >= 2 or money/regulated/destructiveWrites) lacks a human sign-off recorded on the independent review (`FORGE_HUMAN_SIGNOFF_REQUIRED`); the merge gate requires the `spec` status check by default.
- **Multi-turn mission planner & context assembly (extra, beyond the roadmap):** `vld mission plan` turns a verified packet into a mission definition through a bounded plan → validate → critique → refine model session (`factory/agents/planner.mjs`) whose every turn is gated by Core's `validateMissionDefinition` plus a full-coverage rule (each packet requirement assigned exactly once, repair turn on defects, fail-closed after `--max-turns`). `factory/lib/context.mjs` assembles the deterministic, digest-pinned, character-bounded packet context (project, requirements, product rules, gates, rule-lint, tier scope) with per-work-package slice bundles and explicit truncation reports. Keyless runs fall back to the deterministic `planMissionDefinitionFromPacket` output byte-identically; `--cassette-mode record|replay` gives the session the same record/replay parity as intake and review.

### Changed

- No other unreleased changes recorded yet.

## [0.21.0] - 2026-11-16

### Added

- **Dev environment & sandbox baseline (roadmap P0.1 & P0.2):** reproducible `.devcontainer` + `scripts/bootstrap.sh` (warning when Node sits under `/tmp` or `$HOME`), cross-platform sandbox preflight and conformance (`factory/lib/sandbox/*`, `vld doctor`), and CI-security invariants (40-character SHA-pinned actions, `contents: read`, `timeout-minutes`) in `.github/workflows/ci.yml`.
- **Per-test anchor scoping (roadmap P0.3):** table-driven `resolveAnchorScope` / `detectTestLanguage` pinning each `@req` to its own test body across 10 placements × 4 languages (40-case matrix) with an exact misplaced-anchor placement message.
- **Risk-aware assisted intake (roadmap P1.1–P1.5 & P3.1):** deterministic risk-hint scanner (`factory/risk-hints.json`, `examples/risk-corpus.json`, `scripts/eval-risk-scanner.mjs` — 0.965 recall / 0.969 precision), CCPA overlay (10 shipped regulatory regimes), profile inference + rule-lint (contradiction and latency-window pairs), ≤7-question assisted intake (ADR 0013) with hallucinated-quote rejection and scanner-vs-model `needs-human` disagreements, dependent-question unlocking over MCP and the Studio Runtime API (`get_questions`/`answer` with `provenance: user | waived`), provider-agnostic `createModelClient` (anthropic / openai / openai-compatible / direct-argv command; 429 `Retry-After` backoff, cassette record & replay, token/cost budgets, secret redaction), runtime contracts + runtime server question APIs, and labelled routing/rule eval suites.
- **Executed verification (roadmap P2.1–P2.5):** machine-readable test-report parsers (Node TAP, Vitest/Jest JSON, JUnit XML, Go `-json` NDJSON) with requirement-to-execution mapping (`vld verify --run`, `--report`, `--require-report`), zero-dependency `@vld/analysis` AST non-tautology & subject-coupling checker for JS/TS, Python, Go and Rust (rejecting Adversarial Test F tautologies, reflexive comparisons and swallowed assertions), sandboxed test and mutation runners, executed `G0-RUN` / `G0-CHECK` / `G0-SMOKE` gates with `--static-only` and `--require-executed`, tier-2 `G2-MUTATION` gate (≥60% kill floor; ≥75% at tier 3) parsing Stryker, Gremlins and cargo-mutants reports with dated waivers, the honest verdict hierarchy (`anchored-only` → `static-asserted` → `executed-passed` → `executed-verified` → `mutation-verified`), SHA-pinned `vld ci init` workflows that run tests for execution proof and require the report, and `enforcement/summary.mjs` tables distinguishing `PASS-EXECUTED` from `PASS-STATIC` / `SKIPPED-UNAVAILABLE` / `WAIVED`.
- **Studio assisted-intake Q&A panel:** `vld runtime serve`'s Studio dashboard renders pending profile questions and records answers or dated waivers through the authenticated Runtime API (`provenance: user`), refreshing dependent questions after each answer.
- **CHANGELOG discipline:** this file now records every release surface change.

### Changed

- `vld verify` and packet `spec-check.mjs` never call anchors "verified": a static anchor pass reports `static-asserted` (or `anchored-only`) with an explicit hint to run `--run` or `--report` for execution proof, and `done` without a passing test in the report is an error naming the failed, skipped or unrun test.
- Outcome-harness live model runners (`--runner openai|anthropic`) route through the shared `createModelClient` (bounded retries, secret redaction, optional `VLD_MODEL_CASSETTE_DIR` cassette replay) instead of hand-rolled fetch calls, and report token/cost telemetry per arm.

## [0.20.0] - 2026-11-16

### Added

- **Polyglot compiler & 10 stack profiles (`factory/stacks/*.json`):** first-class support for TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#/.NET, Ruby, and PHP, including multi-service `constraints.stack` maps, polyglot `vld adopt`, stack-native `@req` anchor & import verification in `spec-check.mjs`, and custom `--packet-dir` packet placement.
- **Compiler expressiveness & regulatory depth (Phase 1):** first-class custom business rules (`profile.rules[]` -> `REQ-C01…` EARS obligations + `eval-rules.mjs` at 96.1% F1), deterministic undeclared-risk & regulatory-regime hints (`factory/risk-hints.json`), expanded domain vocabulary scoring, `agent.autonomy-limits` primitive (`G2-AUTONOMY`), and 5 new regulatory overlays (`coppa`, `ferpa`, `sox`, `dora`, `eu-ai-act` — 9 total with `gdpr`, `hipaa`, `pci-dss`, `soc2`).
- **Sandboxed execution engine & autonomous `vld build` (ADR 0011, Phase 2):** zero-dependency 5-backend confinement (`oci` with `seccomp-default.json`, `bwrap`, `linux-ns`, `darwin-seatbelt`, `node-permission`), 8-probe live conformance suite (`vld sandbox probe|conformance`), v2 `sandboxed-cli` and stdio `sandboxed-acp` adapters with SHA-256 execution receipts, receipt- and resource-claim-gated delivery verification, secret-redacted bounded self-repair (`factory/lib/repair.mjs`), `vld mission rebase`, and end-to-end `vld build`.
- **Team governance, forge execution, drift & hash-chained evidence (ADR 0012, Phase 3):** session-isolated 6-category independent review protocol (`vld review`, Studio `approve`/`queue` actions), opt-in governed GitHub v1 execute mode (`vld runtime forge execute`), continuous spec-drift detector & workflow generator (`vld drift`), 10-stack `G3-MUTATION` & `semantic-oracles.json`, SHA-256 hash-chained `.vld/evidence/evidence.jsonl` (`vld evidence`), and disabled-by-default local anonymous telemetry (`vld telemetry`).
- **Benchmarks, case studies, DX & supply chain (Phase 0.1/0.4 & Phase 4):** 18-idea stress corpus with oracle parity and double-compile byte identity, 34-task outcome harness with Wilson 95% confidence intervals and split structural/behavioral reporting, 3 polyglot production case studies (`examples/case-studies/`), VitePress docs structure, concise metric-verified `README.md`, `vld doctor`, `vld init --interactive`, `vld migrate`, CycloneDX 1.5 SBOM (`sbom.cdx.json`), and SHA-pinned OIDC `release.yml`.

### Security

- Enforced credential/env scrubbing, symlink traversal blocking, network egress denial, and cryptographic workspace receipt verification across sandboxed agent and verifier executions.
- Added tamper-evident SHA-256 hash chaining and automatic secret redaction for audit records, plus explicit memory-only token handling for GitHub v1 execute mode.

### Upgrade notes

- Requires Node.js 22 or newer (`.nvmrc` pinned to `22`). Run `vld migrate` in existing VLD repositories to upgrade legacy profiles, v1 runtime policies, and compiled packets to `v0.20.0` with automatic `.bak` backups, then run `vld doctor`.

## [0.19.0]

### Added

- Optional local Runtime, Studio, signed catalog, GitHub v1 plan, typed workflow, MCP, and evaluation capabilities around the deterministic compiler.

### Security

- Hardened Runtime loopback/API contracts, generated packet guards, managed writes, catalog verification, provider identity checks, and portable validation coverage.

### Upgrade notes

- Node.js 22 or newer remains required. Run `npm run check` after upgrading; generated packets are part of the reviewable source contract.

## Earlier releases

See Git tags prior to `v0.19.0` for earlier milestone history.
