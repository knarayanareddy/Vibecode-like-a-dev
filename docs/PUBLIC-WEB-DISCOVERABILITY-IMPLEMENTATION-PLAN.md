# Public Web Discoverability — Phase 1 Implementation Plan

**Status:** Implemented; local validation complete (hosted CI pending branch push)
**Decision:** Add an explicit, deterministic planning capability for public websites. It turns reviewed discoverability intent into requirements and engineering guidance; it does **not** crawl a site, evaluate rankings, call a model, install a browser, use credentials, or make a live SEO score authoritative.

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
- A future reviewed phase may add a human-authored readiness artifact, and only after that an explicitly configured external-report adapter. Neither is part of Phase 1.

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

## Validation matrix

- [x] Focused profile/planner/MCP regression tests (46 passing assertions/tests).
- [x] `npm run index -- --check`.
- [x] `npm test` (261 passing tests).
- [x] `npm run check` (lint, index, tests, verification, guard/gates, eval, and stress suites).
- [x] Explicit positive compile and `verify` smoke test.
- [x] `git diff --check`.
- [ ] Hosted CI green on Linux, macOS, Windows, minimum Node 22, and latest Node 22 (after branch push).
