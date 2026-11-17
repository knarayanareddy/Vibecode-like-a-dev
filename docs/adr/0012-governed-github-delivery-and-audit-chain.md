# ADR 0012: Governed GitHub Delivery, Independent Review, Continuous Drift and Hash-Chained Evidence

- Status: Accepted
- Date: 2026-11-16
- Extends: ADR 0007, ADR 0008, ADR 0010, ADR 0011

## Context

Phase 2 provides OS/runtime-sandboxed execution and receipt-gated verification. For
regulated and production engineering teams to trust autonomous delivery in CI and
during audits, four governance controls must bind to those execution receipts:

1. **Independent review (`3.1`):** an agent session that produced a diff cannot review
   it without sharing its own blind spots, and high-rigor tiers need human approval
   accessible from both CLI and local Studio.
2. **Governed GitHub execute mode (`3.2`):** ADR 0010 established offline plan export
   and narrow REST primitives in `factory/integrations/github-v1`. Teams also need an
   explicit `--execute` CLI/runtime workflow that opens/updates a PR, posts redacted
   requirement and receipt evidence, verifies remote checks/reviews on the exact head
   SHA, optionally requests merge when the policy allows, and records an immutable
   receipt without ever persisting credentials.
3. **Continuous drift & polyglot mutation gates (`3.3`):** repositories drift between
   releases via unanchored changes, weakened assertions, skipped tests, and single-stack
   mutation configs.
4. **Tamper-evident audit ledger & opt-in telemetry (`3.4`):** compliance reviewers
   need an append-only SHA-256 hash chain over lifecycle facts and transparent,
   strictly opt-in local telemetry containing zero code, paths or identifiers.

## Decision

1. **Structured independent review (`factory/lib/review.mjs`, `primitives/agent/review-protocol`).**
   `prepareReviewPacket` emits a context-isolated review bundle containing only the
   governing `spec.json` requirements, the unified Git diff, and a static risk scan
   (assertion reduction, test skips, new dependencies, new environment variables).
   `validateReviewReport` enforces distinct author vs reviewer identity, explicit
   coverage of all six review categories (`scope`, `coverage`, `failurePaths`,
   `assertionStrength`, `boundaries`, `reversibility`), requirement citations on every
   finding, and human sign-off when rigor tier >= 2 or money/regulated/destructive
   risks are active. Studio exposes typed `approve`, `queue` and `evidence` methods
   on `/v1/runtime` gated by actor role and self-review prohibition.
2. **Governed `github-v1` execute mode.** `executeGitHubDelivery` and
   `executeRuntimeForgePlan` stay strictly opt-in: offline `plan-export` remains the
   default and never reads tokens or touches the network. When invoked with an explicit
   in-memory token (`--token` or explicit `GITHUB_TOKEN` opt-in), VLD pins requests to
   `https://api.github.com`, verifies PR head/base/SHA identity against the reviewed
   plan before publishing evidence comments or requesting merge, never stores the
   token or raw provider body, and appends a redacted execution fact to `evidence.jsonl`.
3. **Continuous drift & polyglot `G3-MUTATION` (`factory/lib/drift.mjs`).** Detect
   unanchored requirements, orphan anchors, untracked source changes, weakened/skipped
   tests, profile/packet drift, and missing tier-3 semantic oracles across all ten
   supported language stacks, paired with a SHA-pinned read-only GitHub Actions
   workflow template (`vld drift init-workflow`).
4. **Hash-chained evidence & opt-in telemetry (`factory/lib/evidence.mjs`).** Append
   canonical JSON records to `.vld/evidence/evidence.jsonl`, each linking `prevHash`
   and its own SHA-256 `hash`, verifiable offline via `vld evidence verify` and
   surfaced in Studio. Telemetry defaults to `enabled: false`, never makes automatic
   network calls, stores only anonymous numeric/enum metrics when explicitly enabled,
   and supports one-command disable and purge.

## Consequences

- Every release candidate carries an independently verifiable chain from compiled spec
  through sandboxed execution, independent review, drift check, and GitHub PR/merge.
- Existing offline M5/M6/M8 contracts remain untouched when `--execute` and telemetry
  are not enabled.
