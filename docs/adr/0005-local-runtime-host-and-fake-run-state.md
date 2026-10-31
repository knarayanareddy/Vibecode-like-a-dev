# ADR-0005: The optional Runtime owns operational transitions through a local durable ledger

**Status:** accepted

## Context

M1 freezes packet, Core-policy and target authority in a mission. M2 safely allocates manual Git worktrees, but intentionally has no scheduler, lease, process, candidate, approval or merge authority. Without a host-owned operational ledger, a future agent or UI could write arbitrary lifecycle fields, retry an action into duplicate allocation, or lose the distinction between an expired run and an approved candidate.

The Runtime must add this authority without making the deterministic Core compiler depend on a server, provider account, credential, network or model. It also must not imply that M3 launches an agent: process execution, adapter supervision, candidate submission, verification and merge remain later capabilities.

## Decision

### 1. Runtime is an optional local host, never compiler authority

The M3 Runtime lives in isolated modules (`runtime-policy`, `runtime-contracts`, `runtime`, and `runtime-server`). `plan`, `compile`, `verify`, mission validation and packet checkers do not import or require it. Runtime state is ignored at `.vld/runtime/<mission-id>/`, outside packet and mission declaration authority.

`vld runtime` accepts only a primary Git checkout root and a mission whose packet/policy/target authority is currently valid for initialization, allocation, heartbeat and normal transition. The runtime ledger stores the frozen mission and policy digests; any changed mission revision or stale target blocks new allocation/transition rather than retargeting operational state.

### 2. The event ledger, not a mutable status file, is authoritative

A runtime directory contains:

- `events.jsonl`: a versioned, contiguous event ledger;
- `state.json`: an atomically written derived snapshot which must match the ledger exactly;
- `pending.json`: a short recovery intent for an event/snapshot transaction;
- `runtime.lock`: a local `O_EXCL` mutation lock.

Every mutation records an event first in a recovery-aware transaction, then atomically replaces the full ledger and derived snapshot. A pending transaction can be safely classified as unapplied or completed from event digests; any other mismatch fails closed. Snapshot/ledger divergence is diagnosed, not guessed away. Runtime recovery alone can reap a dead-PID regular lock, complete a known pending transaction, and block an expired lease. It does not delete a worktree, branch, candidate or evidence.

Events contain actor label, package, source/target state, version and receipt metadata. Lease tokens are one-time values returned to the caller but only their SHA-256 digest is recorded, so restart validation can verify a token without persisting it. API status intentionally omits the digest, local paths and host environment.

### 3. State transitions and leases are host-validated data rules

M3 has a fixed local-only policy: network, process execution, Git push/merge and credential access are all `false`. It has no policy shell field or command list. The host validates actor/package state/version, lease expiry/token and role matrix before it appends an event:

- an `operator`/host allocates a ready package to an `implementer` and creates a bounded lease;
- only the assigned implementer can heartbeat and advance `allocated -> running -> changes_ready` with a live lease;
- host advances verification/readiness, an independent `reviewer` approves, a `release-approver` queues and a `forge` role merges in deterministic fixtures;
- an implementer ID cannot approve its own package;
- terminal `merged` is immutable; dependency packages become ready only after their declared dependencies merge.

The local CLI is an operator/development control surface. The loopback API maps bearer tokens held only in server memory to fixed actor identities; callers cannot supply an actor role in JSON to impersonate a reviewer. A future real identity/agent/forge adapter must bind that identity independently; M3's fake actor roles do not authenticate an external person or agent.

### 4. The only M3 listener is loopback and deliberately small

`vld runtime serve` uses Node's built-in HTTP server on `127.0.0.1` or `::1` only. It creates a per-launch local token unless the operator explicitly supplies one, requires bearer authentication, caps JSON bodies, accepts one closed request envelope at `/v1/runtime`, validates method-specific parameters, redacts failures, and rejects non-loopback browser Origins. It serves neither project files nor a UI and accepts no caller-provided command/path/network target.

## Consequences

**Gained**

- Runtime state, leases and transitions become recoverable host receipts rather than editable agent/UI state.
- Allocation and state updates can use expected versions and idempotency keys, limiting retry/lost-update bugs.
- Deterministic fake-run workflows, restart/ledger corruption fixtures and loopback API contract tests can run without an external agent, credential or network.
- Existing handoff/workspace commands remain useful when Runtime is not initialized.

**Given up for M3**

- No agent/model/process launch, shell command, sandbox, network egress, credential lookup, candidate submission, verification execution, review artifact ingestion, push, PR, merge or GitHub/ACP integration.
- No remote/team listener, remote runner, multi-machine lease arbitration, user-account authentication or persistent API credential store.
- No claim that a fake `forge` transition is a real merge; M5 must bind verified candidate/base/target SHAs and external branch protection.
- No automatic worktree allocation/removal from the Runtime yet; M2 remains a separate explicit manual Git capability.

## Alternatives rejected

- **Let agents or Studio write a package status field.** That bypasses role/version/lease validation and cannot provide durable receipts.
- **Make the packet or mission JSON Runtime state.** Versioned specification authority and ephemeral operations have different retention, mutation and trust boundaries.
- **Use an append-only write without recovery metadata.** A crash between ledger and snapshot writes leaves ambiguous state; the pending digest record makes only known states recoverable.
- **Start a LAN listener or accept arbitrary CORS origins.** Local Runtime control is sensitive even before it can run an agent; remote/team operation needs a later threat model.
- **Add a process adapter in the same increment.** State/lease correctness must be proven with fake deterministic events before adding shell, environment, credential or model authority.
