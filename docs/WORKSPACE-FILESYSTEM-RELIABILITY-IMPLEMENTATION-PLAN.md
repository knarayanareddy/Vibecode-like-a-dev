# Workspace, Filesystem Safety, and Usability Implementation Plan

**Status:** Implementing  
**Scope:** Workspace lock reliability, generated-output filesystem safety, symlink-safe enforcement scans, live-benchmark provenance validity, determinism documentation, and installed-CLI onboarding.

## Goals and non-goals

- [ ] Preserve fail-closed behavior for unsafe filesystem nodes, malformed locks, and untrusted generated output.
- [ ] Make normal concurrent workspace allocation deterministic: a lock that disappears during an `EEXIST` reinspection is retried rather than misclassified as an unsafe `null` type.
- [ ] Ensure VLD-generated files cannot be redirected through symbolic links.
- [ ] Ensure lint, anchor verification, and generated enforcement scripts do not traverse symbolic links outside a repository or recurse through cycles.
- [ ] Produce parseable live-benchmark provenance artifacts.
- [ ] Align published determinism and installation instructions with executable behavior.
- [ ] Do not weaken workspace ownership, output overwrite, catalog, agent-process, or Runtime authority boundaries.
- [ ] Do not make live-provider evaluation an automatic CI or pull-request check.

## 1. Workspace-lock contention recovery

### Design

- [ ] Separate the lock inspection result for a real lock from a missing node.
- [ ] On `open(..., 'wx')`/`EEXIST`, re-inspect the path.
  - [ ] Preserve `WORKSPACE_LOCKED` for an active valid owner.
  - [ ] Preserve stale-lock recovery requirements for an inactive regular lock.
  - [ ] Preserve `INVALID_WORKSPACE_LOCK` for symlinks, directories, malformed owners, and other unsafe nodes.
  - [ ] Retry a bounded number of times only when the lock disappeared between `EEXIST` and reinspection.
- [ ] Keep exclusive creation as the ownership primitive; do not replace it with a check-then-create lock scheme.
- [ ] Add a narrow test seam only if necessary to deterministically exercise the post-`EEXIST` missing-lock interleaving without exposing it as public CLI authority.

### Acceptance checks

- [ ] A disappearing competing lock retries and either acquires the lock or returns a normal active/stale-lock result.
- [ ] No retry path follows a symbolic link or deletes a lock owned by another process.
- [ ] Existing concurrent-allocator, stale-lock, recovery-guard, and Windows lock tests remain green.

## 2. Generated-write symlink containment

### Design

- [ ] Introduce one internal filesystem helper for managed write paths.
  - [ ] Resolve lexical containment beneath a declared root.
  - [ ] Walk existing ancestor components with `lstat` and reject symbolic links and non-directories.
  - [ ] Reject a symbolic-link or non-regular destination file.
  - [ ] Create missing directories one component at a time only after validating the existing chain.
- [ ] Apply it to agent handoff output and persisted agent state.
- [ ] Apply it to packet emission and carried-forward packet state.
- [ ] Preserve valid explicit output directories while rejecting a symlinked output root or symlinked descendants.

### Acceptance checks

- [ ] Agent installation rejects a symlinked `.agents`/`.claude` parent without writing outside the project.
- [ ] Agent installation rejects a symlinked state path.
- [ ] `emitPacket(..., { force: true })` rejects a symlinked output root, generated file, and nested generated directory.
- [ ] Normal fresh and force regeneration still preserve progress and byte-for-byte determinism.

## 3. Symlink-aware repository scans

### Design

- [ ] Use `lstat` in all four recursive walkers: root lint, packet verification, generated spec checker, and generated gate runner.
- [ ] Skip symbolic-link entries rather than following them.
- [ ] Keep ordinary unreadable-file behavior and ignored-directory handling unchanged.
- [ ] Regenerate committed packet templates after modifying generated template sources.

### Acceptance checks

- [ ] An external linked file is not parsed, scanned for anchors, or treated as a gate input.
- [ ] A directory link loop terminates safely.
- [ ] `verifyPacket`, generated `spec-check.mjs`, generated `gates.mjs`, and lint retain expected results for normal repositories.

## 4. Live benchmark provenance validity

### Design

- [ ] Replace the literal backslash-plus-`n` suffix with a real newline.
- [ ] Prefer a committed helper script if it makes generation independently testable; keep workflow inputs and secrets environment-only.
- [ ] Validate the generated artifact shape and JSON parsing in a normal Node test.

### Acceptance checks

- [ ] A provenance artifact generated with fixture environment values parses as JSON.
- [ ] It includes the documented immutable run inputs and optional runner-image fields.
- [ ] The benchmark remains manual, approval-environment gated, SHA-pinned, and artifacted.

## 5. Determinism contract documentation

### Design

- [ ] Replace stale `generatedAt` exception language in contributor guidance.
- [ ] State the actual no-clock/no-randomness/no-environment contract for compiled packets.
- [ ] Keep runtime receipts and manually generated benchmark provenance clearly separate from compiler packet determinism.

### Acceptance checks

- [ ] Documentation contains no claim that packet `generatedAt` is stripped by CI.
- [ ] Tests assert emitted packet files carry no timestamp-shaped `generatedAt` field and remain byte-identical for identical input.

## 6. Installed CLI quick start

### Design

- [ ] Add Node 22+ and the supported npm installation command near the README quick start.
- [ ] Show the equivalent `vld` commands for installed users.
- [ ] Retain source-checkout commands as the contributor/source-development path.

### Acceptance checks

- [ ] README advertises `npm install -g vibecode-like-a-dev`, Node 22+, and a `vld` invocation.
- [ ] README remains consistent with `package.json` `engines` and `bin` declarations.

## Validation matrix

- [ ] Focused tests: agents, emitter/verification, workspace locking, lint/scan behavior, generated enforcement scripts, CI workflow policy, and README/package contract.
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run check`
- [ ] `npm pack --dry-run`
- [ ] `git diff --check`
- [ ] Isolated ACP v1 installation/test, if root test workflow requires it.
- [ ] Hosted CI: Linux core/integration/package/ACP/evaluation/stress and macOS/Windows portable test suite.

## Completion checklist

- [ ] Implementation and regression tests are committed.
- [ ] Generated packet/template outputs are synchronized where required.
- [ ] Local validation matrix passes.
- [ ] Hosted CI passes on all required jobs.
- [ ] Temporary diagnostics are not retained.
