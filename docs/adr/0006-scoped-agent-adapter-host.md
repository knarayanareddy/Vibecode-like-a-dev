# ADR-0006: Agent adapters are explicit, scoped, and cannot treat a working directory as a sandbox

**Status:** accepted

## Context

M3 established a local Runtime authority for mission lifecycle, leases and receipts, but deliberately never started an agent or process. M4 needs a narrow route for deterministic tests and an opt-in local adapter without making Core call a model, inherit accidental credentials, or let an adapter write Runtime state.

A process launched with a worktree as its current directory is **not** thereby confined to that directory. It can ordinarily traverse the local filesystem with the invoking user's privileges. Calling that setup a sandbox would be misleading and would permit a coding agent more authority than a VLD policy claims.

## Decision

### 1. A second closed policy is required for every adapter invocation

`agent-policy` is data-only and separate from the M3 Runtime policy. It has a canonical digest and closed fields for one adapter, a fixed capability set, duration/output/retry budgets, a four-key non-secret environment allowlist, and a command descriptor.

The policy cannot contain a shell snippet, credential field, network grant, Git push/merge grant, arbitrary environment passthrough, plugin, inherited `PATH`, or caller-selected executable. The local process form identifies one already-resolved absolute executable and an argv array. The host invokes it with `spawn(..., { shell: false })`; no `sh -c`, `eval`, string interpolation, or PATH search is used.

### 2. Runtime remains lifecycle authority

The M4 host starts only an already allocated package with a healthy M2 workspace and a live M3 lease token. It constructs a digest-only context reference from frozen mission/packet/policy data, moves the package to `running`, then records an `agent-run` Runtime ledger receipt before it either advances to `changes_ready` or blocks the package.

An adapter can emit normalized progress metadata only. It cannot transition a package, broaden a policy, submit a candidate, approve, queue, merge, push, open a PR, run project verification, or make a network request. Receipt output retains only a digest, byte count and fixed outcome label. Arbitrary stdout/stderr is never persisted: pattern redaction is display-only and is not treated as a proof that a value is credential-free. Host paths, argv, environment, lease tokens and prompt transcripts are not persisted.

### 3. Two intentionally different M4 adapters

- **`fake`** is deterministic, process-free, and is the default test adapter. Its finite scripts exercise success, failure, cancellation and receipt/state behavior without an agent account or process.
- **`local-process`** launches exactly its policy-declared argv in the allocated worktree, with a fresh minimal environment containing only VLD-derived non-secret identifiers plus approved locale keys. It enforces a duration budget, output cap/redaction, cancellation and process-group termination where supported.

The process adapter is **read-only** in this release. Because no portable filesystem sandbox has been introduced, a policy that asks it for `write_workspace` or claims sandboxing is rejected before spawn. This is a safety constraint, not a claim that a CWD can confine an unsandboxed binary. A future write-capable adapter must use a separately reviewed sandbox provider and prove its filesystem/process/network boundary before its policy can grant writes.

Existing `vld agent install` handoffs remain separate generated documentation; installing one neither configures nor launches a Runtime adapter.

## Consequences

**Gained**

- A deterministic fake run and a real, opt-in, direct-argv local process path can be exercised without Core dependencies, model calls, credentials or network.
- Runtime receipts bind adapter/policy/context/workspace digests and metadata-only execution facts to the allocated run.
- Accidental parent environment secrets, shell injection and CWD substitution are refused or excluded by construction.
- Failed, timed-out and cancelled adapter executions leave a host-owned receipt and a blocked package rather than a self-certified success state.

**Deferred**

- Write-capable coding-agent processes until an actual sandbox adapter exists.
- ACP v1 transport integration, provider/model-specific adapters, persistent process reconnection, candidate SHA submission, verification, review, merge, GitHub/forge operations and Studio.
- Remote/team scheduling and persistent external identity authentication.

## Alternatives rejected

- **Use a worktree CWD as a sandbox.** It is not an OS boundary and cannot honestly support a write grant.
- **Pass a formatted command string to a shell.** That makes task, package and policy text command-injection surfaces.
- **Forward `process.env`.** It leaks unrelated tokens and credentials into an adapter.
- **Let the adapter call lifecycle transition APIs directly.** It bypasses lease/version/role checks and makes agent output operational authority.
- **Persist raw logs for debugging.** Raw output can contain tokens, paths and prompt content; the receipt keeps only a digest, byte count and fixed outcome label.
