# Workspace, Filesystem Safety, and Usability Implementation Plan

**Status:** Awaiting hosted CI
**Scope:** Workspace lock reliability, generated-output filesystem safety, symlink-safe enforcement scans, live-benchmark provenance validity, determinism documentation, and installed-CLI onboarding.

## Goals and non-goals

- [x] Preserve fail-closed behavior for unsafe filesystem nodes, malformed locks, and untrusted generated output.
- [x] Make normal concurrent workspace allocation deterministic: a lock that disappears during an `EEXIST` reinspection is retried rather than misclassified as an unsafe `null` type.
- [x] Ensure VLD-generated files cannot be redirected through symbolic links.
- [x] Ensure lint, anchor verification, and generated enforcement scripts do not traverse symbolic links outside a repository or recurse through cycles.
- [x] Produce parseable live-benchmark provenance artifacts.
- [x] Align published determinism and installation instructions with executable behavior.
- [x] Do not weaken workspace ownership, output overwrite, catalog, agent-process, or Runtime authority boundaries.
- [x] Do not make live-provider evaluation an automatic CI or pull-request check.

## 1. Workspace-lock contention recovery

### Design

- [x] Separate the lock inspection result for a real lock from a missing node.
- [x] On `open(..., 'wx')`/`EEXIST`, re-inspect the path.
  - [x] Preserve `WORKSPACE_LOCKED` for an active valid owner.
  - [x] Preserve stale-lock recovery requirements for an inactive regular lock.
  - [x] Preserve `INVALID_WORKSPACE_LOCK` for symlinks, directories, malformed owners, and other unsafe nodes.
  - [x] Retry a bounded number of times only when the lock disappeared between `EEXIST` and reinspection.
- [x] Keep exclusive creation as the ownership primitive; do not replace it with a check-then-create lock scheme.
- [x] Add a narrow test seam only if necessary to deterministically exercise the post-`EEXIST` missing-lock interleaving without exposing it as public CLI authority.

### Acceptance checks

- [x] A disappearing competing lock retries and either acquires the lock or returns a normal active/stale-lock result.
- [x] No retry path follows a symbolic link or deletes a lock owned by another process.
- [x] Existing concurrent-allocator, stale-lock, recovery-guard, and Windows lock tests remain green.

## 2. Generated-write symlink containment

### Design

- [x] Introduce one internal filesystem helper for managed write paths.
  - [x] Resolve lexical containment beneath a declared root.
  - [x] Walk existing ancestor components with `lstat` and reject symbolic links and non-directories.
  - [x] Reject a symbolic-link or non-regular destination file.
  - [x] Create missing directories one component at a time only after validating the existing chain.
- [x] Apply it to agent handoff output and persisted agent state.
- [x] Apply it to packet emission and carried-forward packet state.
- [x] Preserve valid explicit output directories while rejecting a symlinked output root or symlinked descendants.

### Acceptance checks

- [x] Agent installation rejects a symlinked `.agents`/`.claude` parent without writing outside the project.
- [x] Agent installation rejects a symlinked state path.
- [x] `emitPacket(..., { force: true })` rejects a symlinked output root, generated file, and nested generated directory.
- [x] Normal fresh and force regeneration still preserve progress and byte-for-byte determinism.

## 3. Symlink-aware repository scans

### Design

- [x] Use `lstat` in all four recursive walkers: root lint, packet verification, generated spec checker, and generated gate runner.
- [x] Skip symbolic-link entries rather than following them.
- [x] Keep ordinary unreadable-file behavior and ignored-directory handling unchanged.
- [x] Regenerate committed packet templates after modifying generated template sources.

### Acceptance checks

- [x] An external linked file is not parsed, scanned for anchors, or treated as a gate input.
- [x] A directory link loop terminates safely.
- [x] `verifyPacket`, generated `spec-check.mjs`, generated `gates.mjs`, and lint retain expected results for normal repositories.

## 4. Live benchmark provenance validity

### Design

- [x] Replace the literal backslash-plus-`n` suffix with a real newline.
- [x] Prefer a committed helper script if it makes generation independently testable; keep workflow inputs and secrets environment-only.
- [x] Validate the generated artifact shape and JSON parsing in a normal Node test.

### Acceptance checks

- [x] A provenance artifact generated with fixture environment values parses as JSON.
- [x] It includes the documented immutable run inputs and optional runner-image fields.
- [x] The benchmark remains manual, approval-environment gated, SHA-pinned, and artifacted.

## 5. Determinism contract documentation

### Design

- [x] Replace stale `generatedAt` exception language in contributor guidance.
- [x] State the actual no-clock/no-randomness/no-environment contract for compiled packets.
- [x] Keep runtime receipts and manually generated benchmark provenance clearly separate from compiler packet determinism.

### Acceptance checks

- [x] Documentation contains no claim that packet `generatedAt` is stripped by CI.
- [x] Tests assert emitted packet files carry no timestamp-shaped `generatedAt` field and remain byte-identical for identical input.

## 6. Installed CLI quick start

### Design

- [x] Add Node 22+ and the supported npm installation command near the README quick start.
- [x] Show the equivalent `vld` commands for installed users.
- [x] Retain source-checkout commands as the contributor/source-development path.

### Acceptance checks

- [x] README advertises Node 22+, a supported npm/GitHub package install command, and a `vld` invocation.
- [x] README remains consistent with `package.json` `engines` and `bin` declarations.

## Validation matrix

- [x] Focused tests: agents, emitter/verification, workspace locking, lint/scan behavior, generated enforcement scripts, CI workflow policy, and README/package contract.
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run check`
- [x] `npm pack --dry-run`
- [x] `git diff --check`
- [x] Isolated ACP v1 installation/test, if root test workflow requires it.
- [ ] Hosted CI: Linux core/integration/package/ACP/evaluation/stress and macOS/Windows portable test suite.

## Completion checklist

- [x] Implementation and regression tests are committed.
- [x] Generated packet/template outputs are synchronized where required.
- [x] Local validation matrix passes.
- [ ] Hosted CI passes on all required jobs.
- [x] Temporary diagnostics are not retained.
