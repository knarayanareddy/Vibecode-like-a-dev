# Security, CI and portability implementation plan

**Status:** Implemented locally; awaiting hosted macOS/Windows CI matrix

This plan implements the six highest-value follow-up improvements identified in the Runtime/CI review. It keeps the compiler dependency-free and keeps paid, non-deterministic agent evaluation outside pull-request gating.

## Success criteria

- `local-process` and ACP documentation, policy errors and CLI help state that they are **unconfined host processes**, not filesystem/network sandboxes.
- Tests establish the current unconfined boundary and define the required sandbox acceptance probes before any sandboxed write/network claim can be enabled.
- Every third-party GitHub Action is pinned to a reviewed full commit SHA; CI has least-privilege read-only permissions and Dependabot maintains action-pin updates.
- CI preserves all existing coverage but runs independent evaluation/stress work in parallel and has one stable `check` summary job.
- The portable CLI/runtime test suite runs on macOS and Windows in addition to the complete Linux job, and the support policy says exactly what is validated.
- Calibration evidence remains separate from live-agent outcome evidence; a manually dispatched, approval-gated benchmark captures reproducible provenance and full JSON reports without becoming a PR gate.
- Contributor instructions contain no manually maintained test count.

## Phase 1 — Unconfined process boundary

- [x] Replace “read-only local process” wording in public CLI/README/ADR policy messages with precise host-authority language.
- [x] Preserve direct-argv, clean-environment and Runtime-state protections, while explicitly marking filesystem/network/credential denial as unenforced without an OS sandbox.
- [x] Add a controlled test proving an unconfined child retains same-user access to an external fixture and loopback network despite declarative denial flags.
- [x] Add sandbox-adapter acceptance criteria: deny out-of-workspace reads/writes, credential fixture access, network egress and undeclared process execution; require tests before a sandboxed capability is advertised.

## Phase 2 — CI supply-chain hardening

- [x] Pin `checkout`, `setup-node`, and artifact actions to reviewed immutable SHA revisions with release comments.
- [x] Set workflow `permissions: contents: read`.
- [x] Add Dependabot configuration for grouped GitHub Actions updates.

## Phase 3 — CI feedback and portability

- [x] Retain the complete Linux integration/distribution journey in separate parallel jobs.
- [x] Move independent library/specificity/routing/outcome evaluation commands into a matrix job.
- [x] Move ordinary/adversarial stress commands into a matrix job.
- [x] Add macOS and Windows portable `npm test` smoke coverage.
- [x] Add an always-run aggregate `check` job so branch protection has one stable complete-coverage result.
- [x] Document the supported OS/test scope and current adapter caveats.

## Phase 4 — Outcome evidence

- [x] Keep deterministic calibration in ordinary CI and retain its explicit non-live wording.
- [x] Add a `workflow_dispatch` live benchmark with a protected `live-agent-benchmark` environment, provider/model/task inputs, no PR trigger, and read-only repository permissions.
- [x] Record commit, runner image, Node version, model input and full `--out` JSON report as an artifact.
- [x] Document environment approval/secrets setup and prohibit interpreting calibration as live-model lift.

## Phase 5 — Contributor hygiene and validation

- [x] Remove the stale static test count from `AGENTS.md`.
- [x] Add regression tests for policy/help/documentation assertions.
- [x] Run focused boundary tests, `npm run check`, workflow syntax checks, package dry-run and diff hygiene.
- [x] Validate the optional ACP adapter from its committed lockfile.

## Completion checklist

- [x] All tests and `npm run check` pass.
- [x] Workflow static validation passes.
- [x] Optional ACP bridge passes after a clean `npm ci`.
- [x] The final diff contains no credentials, test-only secrets, or unpinned action tags.
- [ ] CI passes on Linux, macOS and Windows after merge.
