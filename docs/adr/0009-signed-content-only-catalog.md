# ADR-0009: Signed content-only catalog

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** VLD maintainers

## Context

Existing Git-backed stores pin advisory Markdown but do not establish a publisher
trust root or signature threshold. A catalog must make curated modules, bundles,
templates and workflow declarations reviewable without converting a Git remote or
an extension package into executable authority.

The compiler, Runtime, Studio and agent adapters already have deliberately narrow
trust boundaries. A catalog must not bypass those boundaries by shipping a command,
a plugin, a workflow shell escape, a hidden compiler input, or an ambient
credential/process capability.

## Decision

M7 adds a separate catalog lock under `.vld/catalog.json` and a separately trusted
root at `.vld/catalog-root.json`.

1. Initial root trust is an explicit local `vld catalog trust root.json` decision;
   the root is never discovered from a remote. Root keys are Ed25519 public keys
   with explicit roles and a threshold. Rotation requires the exact new-root digest
   acknowledgement and signatures meeting the currently trusted root threshold.
2. A Git remote is only a transport/cache. `catalog-index.json` and every
   `catalog-package.json` are verified over canonical key-sorted JSON with the
   trusted threshold before their data is used. Index/package expiry, root version,
   identity, revocation state, core compatibility, payload bytes/digests, regular
   file status and safe paths all fail closed.
3. Version 1 accepts only bounded inert payloads: Markdown guidance/artifact
   templates and JSON module/bundle/workflow/test-fixture/export-schema content.
   Every package capability list must be exactly `content-only`. No executable,
   adapter, script, symlink, path traversal, oversized payload or arbitrary
   workflow command is accepted.
4. `catalog diff` fetches/verifies a temporary candidate and makes no project
   mutation. `catalog update` requires the exact reviewed Git commit, re-verifies
   it, then atomically swaps cache and writes the lock. Offline `catalog status`
   verifies the existing trusted root/cache/lock without a network request.
5. `catalog copy` is explicit and copy-only. It does not enable modules, apply a
   bundle, execute a workflow or affect compiler inputs. A separate
   `.vld/catalog-copies.json` records publisher, root, commit, package/version,
   payload digest and output provenance.

## Consequences

- Publisher identity, root/index/payload digests and trust decision are visible in
  CLI status and, where a Runtime is running, Studio's evidence view.
- Catalog data can be reviewed and copied, but existing explicit Core/module/
  workflow flows retain their authority.
- Any future executable adapter catalog needs a new ADR covering separate-process
  RPC, explicit grants, isolation, version/digest pinning, crash containment,
  revocation and human enablement; it is not an extension of this format.
