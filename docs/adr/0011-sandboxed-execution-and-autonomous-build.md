# ADR 0011: Sandboxed Execution, Receipt-Gated Verification and Autonomous Build

- Status: Accepted
- Date: 2026-11-16
- Supersedes in part: Unconfined-only constraint notes in ADR 0006, ADR 0007 and ADR 0010 (while retaining all schema v1 restrictions unchanged)

## Context

ADRs 0006, 0007 and 0010 intentionally prohibited `local-process` and `acp-v1`
adapters from receiving VLD workspace-write authority and prohibited `delivery-policy`
v1 from running project test commands because a process working directory is not an
operating-system sandbox. To move VLD from specification compilation plus dry-run
orchestration to autonomous spec-governed execution, VLD needs:

1. Real, empirically verified confinement of filesystem reads/writes, host
   credentials, network egress, child process spawning and runtime duration.
2. Cryptographic receipts binding every sandboxed execution to its policy digest,
   backend confinement class, before/after workspace digests and exit status.
3. Receipt-gated candidate submission, sandboxed verifier execution, bounded repair
   loops on failed checks, safe mission rebase when target refs or packets evolve,
   and a single `vld build` entry point.

## Decision

1. **Frozen v1 contracts remain unchanged.** `agent-policy` v1 (`fake`,
   `local-process`, `acp-v1`) and `delivery-policy` v1 retain every restriction from
   ADRs 0006, 0007 and 0010. `local-process` and bare `acp-v1` remain labelled
   unconfined host processes with `writeWorkspace: false` and `sandbox: false`.
2. **Tiered sandbox engine (`factory/lib/sandbox/`).** Introduce zero-dependency
   backends probed dynamically at runtime rather than assumed from binary presence:
   - `oci` (`docker` or `podman`): `--network=none --read-only --cap-drop=ALL
     --security-opt=no-new-privileges --security-opt=seccomp=seccomp-default.json`
     with a single bind mount for the allocated workspace (`ro` or `rw`).
   - `bwrap` (Bubblewrap): `--unshare-all --die-with-parent` with read-only runtime
     mounts, empty `tmpfs` over home/temp directories and scoped workspace bind.
   - `linux-ns` (`unshare --user --map-root-user --net --mount --pid --fork`):
     private network namespace with no external interfaces, private mount namespace
     masking host home/temp/credential directories with empty `tmpfs`, read-only
     enforcement in `read-only` mode, scrubbed environment, process-group termination
     and Node `--permission` defense-in-depth for Node executables.
   - `darwin-seatbelt` (`sandbox-exec`): generated deny-default profile denying
     network egress and filesystem writes outside the workspace and masking user
     credential directories.
   - `node-permission` (portable runtime confinement for Node >=22): `--permission`
     scoped strictly to required read paths and optional workspace write path,
     denying child process spawning, worker escalation and network access via a
     frozen preload guard.
3. **Eight-probe live conformance suite.** Before a backend is reported healthy by
   `vld sandbox conformance`, it must pass eight live negative/positive probes:
   outside-workspace read denial, outside-workspace write denial, read-only workspace
   mutation denial, write-workspace mutation capture, credential/environment scrub,
   symlink-escape denial, outbound network egress denial, and undeclared child spawn
   plus wall-clock timeout termination.
4. **Schema v2 policies and receipt-gated writes.** `agent-policy` v2 adds
   `sandboxed-cli` and `sandboxed-acp` adapters requiring an active sandbox backend,
   and `delivery-policy` v2 adds sandboxed verifier commands, drift-guard and gate
   enforcement, resource-claim path enforcement, and `requireSandboxReceipt: true`.
5. **Repair loop, mission rebase, and `vld build`.** `factory/lib/repair.mjs`
   performs bounded verify-diagnose-repair iterations with duplicate-failure stall
   detection; `rebaseMission` updates a mission's target ref and/or recompiled packet
   without losing requirement coverage; `factory/lib/build.mjs` composes compile,
   mission planning, workspace isolation, sandboxed execution, verification and
   repair into an auditable `build-report.json`.
6. **Core/runtime separation preserved.** No compiler module (`planner`, `emit`,
   `verify`, `profile`, `indexer`, `enforcement`) imports `factory/lib/sandbox/`,
   `repair.mjs` or `build.mjs`.

## Consequences

- Linux hosts with unprivileged user namespaces, Bubblewrap, or OCI runtimes achieve
  kernel-enforced filesystem and network isolation with zero npm dependencies.
- macOS and Windows hosts fail closed when an OS namespace backend is explicitly
  requested, and report the exact confinement tier (`os-container`, `os-namespace`,
  `os-seatbelt`, `runtime-permission`) in every receipt rather than overclaiming.
- Every candidate mutation and verification step leaves a tamper-evident digest trail
  consumable by Phase 3 independent review, GitHub delivery and evidence ledgers.
