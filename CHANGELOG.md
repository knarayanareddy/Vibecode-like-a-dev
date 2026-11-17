# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles. Releases are also published through GitHub releases and tags.

## [Unreleased]

### Changed

- No unreleased changes recorded yet.

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
