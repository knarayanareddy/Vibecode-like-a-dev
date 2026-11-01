# Security and Reliability Remediation Plan

**Status:** Complete
**Scope:** Store path containment, Runtime locking/delivery authority/lease handling, agent-output handling, ACP process lifecycle, API idempotency, optional-adapter CI, and supported Node versions.

This plan addresses the nine review findings without changing the compiler's deterministic profile-to-packet authority. Runtime and adapter state remain operational data under `.vld/`.

## Success criteria

- A store asset or copy target cannot traverse a pre-existing intermediate symlink outside its trusted root.
- Lock acquisition never treats a partially published owner record as stale, and stale recovery cannot run concurrently with a cooperating mutation or another recovery.
- Generic Runtime transitions cannot manufacture verified/reviewed/queued/merged delivery state; those stages require their typed receipt APIs.
- A valid lease heartbeat cannot leave an adapter completion or failure receipt unable to settle the package.
- Durable receipts contain fixed, allowlisted output metadata rather than arbitrary process output.
- ACP abort/timeout always reaches local process termination, waits for exit, and escalates when the peer ignores `SIGTERM`.
- An idempotent allocation retry returns the same caller-held lease capability without persisting that capability in the Runtime ledger.
- The stable ACP bridge runs in a dependency-isolated CI job against its fake peer.
- Declared Node support matches source features, contributor documentation, and CI.

### Boundary note

The Node standard library exposes these store operations by path rather than
POSIX directory descriptors with `openat`/`O_NOFOLLOW`. The implementation
therefore rejects every **pre-existing** symlink component and atomically
creates/replaces the final output entry, but still assumes the project and
store parents are not being concurrently replaced by a hostile same-user
writer. Recovery guards likewise coordinate VLD participants and fail closed
for malformed/crashed recovery state; their stale guard requires deliberate
operator inspection rather than automatic deletion.

## Phase A — Filesystem containment and locking

- [x] Add a shared, fail-closed helper for directories whose existing path components must not be symlinks.
- [x] Canonicalize and verify store asset parents before manifest hashing and asset reads.
- [x] Create copy output directories only through non-symlinked components; reject a symlinked target or parent.
- [x] Add tests for an intermediate source symlink and an intermediate copy-output symlink.
- [x] Introduce a recovery guard around workspace and Runtime lock recovery.
- [x] Treat malformed or partially written lock owner content as unsafe/corrupt, not stale.
- [x] Keep a mutation/recovery guard held from owner inspection through stale-lock removal.
- [x] Add lock tests for malformed owners and concurrent-recovery protection.

## Phase B — Runtime authority, leases, and retries

- [x] Restrict generic transitions to non-evidentiary operational transitions only.
- [x] Reject direct delivery-state transitions and direct merge transitions.
- [x] Preserve the typed candidate, verification, approval, queue, and forge-plan paths as the sole receipt-producing delivery routes.
- [x] Add negative tests for every previously generic delivery bypass.
- [x] Preserve the existing durable heartbeat version semantics, but settle the agent from a freshly read version and retry bounded compare-and-swap conflicts.
- [x] Settle agent completion/failure using a fresh Runtime state check, with a durable receipt and deterministic block fallback.
- [x] Add a concurrent-heartbeat agent-run test.
- [x] Require callers of idempotent allocation to supply a high-entropy lease token; persist only its digest.
- [x] Return the caller-held capability on retry and test a dropped API response/replay.

## Phase C — Process output and ACP lifecycle

- [x] Replace persisted arbitrary output summaries with fixed, allowlisted receipt metadata.
- [x] Retain output digest and bounded byte count for evidence without claiming that regexes can identify every secret.
- [x] Update ADR and tests to state the precise boundary.
- [x] Refactor ACP cancellation so cancellation request, local disconnect, termination, exit wait, and kill escalation are bounded independently.
- [x] Add fake-peer tests for cancellation and a peer that ignores `SIGTERM`.

## Phase D — Supply-chain coverage and support contract

- [x] Give the optional ACP package a committed lockfile for reproducible CI installation.
- [x] Add a dedicated ACP bridge CI job that installs only the adapter dependency tree and runs its fake-peer test.
- [x] Align root/optional package engines, `AGENTS.md`, and CI on Node 22.
- [x] Run focused regression tests, `npm run check`, adapter tests, package dry-run, and diff hygiene.

## Completion checklist

- [x] All remediation tests pass locally.
- [x] `npm run check` passes.
- [x] Optional ACP bridge test passes from a clean adapter install.
- [x] CI configuration has a dedicated ACP bridge job.
- [x] Documentation uses no absolute redaction guarantee.
- [x] Review the final diff for capability/token/path leakage.
