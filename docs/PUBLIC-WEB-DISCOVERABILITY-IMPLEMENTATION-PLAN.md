# Public Web Discoverability — Phases 1–2 Implementation Plan

**Status:** Phase 1 and its hosted validation are complete. Phase 2 implements a dedicated, human-authored readiness artifact with deterministic local initialization and validation; branch validation is recorded with the implementation.
**Decision:** Add an explicit, deterministic planning capability for public websites, then a packet-linked human readiness record. Neither phase crawls a site, evaluates rankings, calls a model, installs a browser, uses credentials, or makes a live SEO score authoritative.

## Objective

For a project that is both a public `web-app` and explicitly opted in, VLD selects a narrowly scoped `product.public-web-discoverability` practice and produces one concrete requirement covering indexability boundaries, canonical/metadata ownership, structured-data truthfulness, and local verification evidence.

The feature is deliberately a Phase 1 compiler capability inspired by the architecture patterns—not copied runtime code—of [`AgriciDaniel/claude-seo`](https://github.com/AgriciDaniel/claude-seo) (reviewed at `6be93f45064ffbadced572b5d5c95f55fd263af0`).

## Boundary and non-goals

- The new profile input is `discoverability: { "enabled": true }`.
- It is **not inferred** by `vld adopt`; public reachability is a product decision.
- Selection additionally requires `kind: "web-app"` and `risks.publicFacing: true`.
- It does not promise rankings, traffic, indexing by a third party, AI citations, or an SEO score.
- It adds no dependencies, network access, browser automation, search-provider API, plugin installation, or credential handling.
- It does not change existing profiles or packets that do not opt in.
- Phase 2 adds only a human-authored, digest-linked local readiness artifact. An external-report adapter remains out of scope and would require a separate reviewed design.

## Implementation checklist

### 1. Closed input contract

- [x] Add `discoverability` to the profile allowlist.
- [x] Accept only an object with the single boolean member `enabled`.
- [x] Reject missing/non-boolean `enabled`, unknown nested members, and invalid profile shapes.
- [x] Preserve the byte output of existing profiles by not adding a default serialized field.
- [x] Expose the same profile field through every MCP planning-tool schema and `profileFrom` conversion.

### 2. Deterministic practice and requirement

- [x] Add `product.public-web-discoverability` under `primitives/product/`.
- [x] Include specific checklists, red flags, and anti-rationalizations for public-route boundaries, canonical/metadata ownership, truthful structured data, and regression evidence.
- [x] Add an automated `web.discoverability` catalog requirement with falsifiable acceptance criteria and a failure path.
- [x] Route the primitive only when all three conditions hold: public web-app, public-facing risk, explicit enablement.
- [x] Regenerate `primitives/index.json`; do not hand-edit it.

### 3. Documentation and tests

- [x] Document the opt-in and its authority boundary in the README.
- [x] Test positive selection and requirement generation.
- [x] Test every negative condition independently: no opt-in, non-public web app, and non-web application.
- [x] Test strict profile validation and MCP/CLI planning parity.
- [x] Ensure existing packet fixtures remain unchanged unless they explicitly opt in.

## Acceptance criteria

- [x] For an opted-in public web app, the selected primitive and `web.discoverability` requirement appear in `buildPlan`, CLI planning, and MCP planning output.
- [x] The same profile without any one prerequisite does not select the primitive or requirement.
- [x] `vld adopt` does not silently enable discoverability.
- [x] Generated acceptance criteria require locally reviewable evidence, not a dynamic rank/citation claim.
- [x] No compiler code path gains external I/O, a dependency, a model call, or a credential surface.

## Phase 2 implementation checklist

- [x] Add a dedicated `vld discoverability-readiness init|validate` command rather than extending the product brief.
- [x] Require the existing explicit public-web profile opt-in and a compiled packet containing `web.discoverability`.
- [x] Record and validate a SHA-256 digest of the exact local packet manifest so stale readiness records fail closed.
- [x] Generate a human-authored template for canonical-origin policy, indexable and excluded route inventories, metadata/social and structured-data evidence, local verification, human review, and requirement links.
- [x] Keep the result explicitly advisory: validation checks local record structure and linkage only, not reviewer identity or third-party outcomes.
- [x] Add focused adversarial regressions for absent/disabled profiles, malformed evidence, Draft placeholders, and stale packet content.
- [x] Document commands, required sections, refresh procedure, and no-network/no-provider authority boundary in `docs/DISCOVERABILITY-READINESS.md`.

## Validation matrix

- [x] Focused profile/planner/MCP regression tests (46 passing assertions/tests).
- [x] Focused Phase 2 readiness regressions: eligible init/strict validation, CLI JSON contract, absent/disabled profiles, malformed evidence, missing human-review value, stale packet digest, and symlink refusal (5 passing tests).
- [x] `npm run index -- --check`.
- [x] `npm test` (286 passing tests on 2026-11-02).
- [x] `npm run check` (lint, index, tests, verification, guard/gates, eval, and stress suites; passed on 2026-11-02).
- [x] Explicit positive compile and `verify` smoke test.
- [x] `git diff --check`.
- [x] Hosted CI green on Linux, macOS, Windows, minimum Node 22, and latest Node 22 (run `41458026147` for the merged Phase 1/remediation baseline).
