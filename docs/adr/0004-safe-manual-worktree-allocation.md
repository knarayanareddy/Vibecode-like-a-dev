# ADR-0004: Workspace allocation is a narrow, repository-serialized manual capability

**Status:** accepted

## Context

A versioned mission freezes a verified VLD packet, a Core-policy digest, exact requirement ownership and an immutable Git target. It deliberately does not mutate Git. Manual implementation can nevertheless benefit from one isolated working directory and branch for each declared work package before a future Runtime, agent adapter or merge queue exists.

`git worktree` isolates working files, index and uncommitted changes. It does **not** make all Git state private: worktrees share a common Git directory and refs, and isolated edits can still conflict when integrated. A worktree manager that treats every checkout independently could allocate the same branch twice, overwrite a recovery record, or delete work after a crash. Conversely, a generic task runner or an agent-controlled cleanup operation would expand the Core authority boundary far beyond this need.

## Decision

### 1. Workspaces are available only from a current, verified mission

`vld workspace create <mission.json> <package>` first requires `mission status` to be current: the packet and Core policy validate, and the mission target ref still resolves to the frozen full commit. It allocates only a declared package and creates its branch from that immutable commit. There is no retargeting, inferred work package or branch based only on a mutable ref.

The resulting branch and directory are deterministic and constrained:

- branch: `vld/<mission-id>/<package-id>`;
- worktree: a sibling managed root, `<project-parent>/.vld-worktrees/<project-name>-<common-git-dir-digest>/<mission-id>/<package-id>`;
- workspace ledger: `<primary-project-root>/.vld/workspaces.json`.

The managed root is outside the primary checkout. Path components are checked without following symlinks; state records must match the deterministic branch/path shape. A workspace command must run from the primary Git checkout root, not a nested directory or linked worktree, so one common Git directory cannot acquire divergent ledgers.

### 2. One common-Git lock serializes every allocation mutation

The Git common directory holds `vld-workspaces.lock`. Atomic exclusive creation of the JSON lock file includes a PID and unguessable token, avoiding an ownerless directory-creation window. Mutating commands acquire this repository-wide lock before checking state or calling fixed-argument Git worktree/branch commands. A live PID blocks mutation. Only `vld workspace recover` may remove a dead-PID/malformed **regular** lock; symlink or other unsafe lock filesystem types are refused.

This lock serializes VLD's own allocation, removal and recovery bookkeeping. It cannot serialize unrelated Git users, shared-ref updates, remote operations or a future merge queue. Worktree isolation is therefore explicitly not presented as a merge-conflict or total-concurrency guarantee.

### 3. Cleanup preserves work by default and records recovery intent first

Normal `workspace remove` requires a healthy registered worktree, no staged/unstaged/untracked changes, and no branch commit beyond the frozen base. Destructive removal needs both `--discard` and the exact workspace ID acknowledgement. Each allocation lifetime gets a fresh ID, so an acknowledgement from a previously removed/recreated workspace cannot authorize the new one. Before Git mutation, the ledger records a `removing` intent. If interruption leaves a worktree, `recover` restores the allocation; if the worktree disappeared, it finalizes a bounded receipt and preserves any remaining branch instead of silently deleting it.

`workspace status` is non-mutating. It reports mission drift, healthy/missing/drifted allocations, unallocated packages and unrecorded worktrees under the managed root. A malformed ledger, branch/path drift or symlinked registered worktree blocks cleanup until explicit recovery/manual investigation; it is never treated as permission to remove an arbitrary path.

### 4. This remains outside Core and is not a Runtime

This phase invokes only locally installed Git with fixed argv. It never starts an agent/model, executes a project command, accesses a network service or credential, pushes, merges, creates a PR, grants capabilities, schedules a run, writes Runtime state, accepts a candidate or approves work.

The Core packet compiler and mission foundation stay deterministic and Git-read-only. A future Runtime still needs separate authority for leases, agent lifecycle, candidate/ref receipts, integration verification, approvals and merging.

## Consequences

**Gained**

- Manual work packages can begin from an auditable packet/target boundary in separate working directories.
- VLD-owned Git mutations are serialized across processes that share one common Git directory.
- State and lock recovery favour preserving branches and edits over automatic cleanup.
- The command works in a packed, dependency-free CLI installation and needs neither provider credentials nor a server.

**Given up for this phase**

- No agent execution, Runtime lease/holder, automatic retry, scheduler transition, candidate state, review, merge queue, push or forge integration.
- No claim that separate worktrees eliminate shared-reference races or later merge conflicts.
- No support for using a secondary linked worktree as a separate VLD workspace-control root.
- Resource claims remain advisory overlap warnings, not file locks or a conflict proof.

## Alternatives rejected

- **Let every linked worktree write its own `.vld/workspaces.json`.** One common Git directory would then have competing authorities and could allocate the same branch/package through different state files.
- **Use an in-memory mutex or only Git's per-command lock.** Neither protects the multi-step state + branch + worktree sequence across VLD processes.
- **Use an ownerless lock directory.** Recovery can race the interval between directory creation and owner-file creation. Atomic exclusive file creation makes the ownership record part of acquisition.
- **Automatically force-remove dirty or committed work.** A crashed process is not consent to destroy edits; destructive cleanup must name the exact allocation ID.
- **Put the managed worktree below the project checkout.** This risks accidental inclusion in packet/project paths and blurs primary versus allocated file authority.
- **Turn this into an agent runner now.** Workspace mutation is a bounded Git capability; process execution and approval authority require the later Runtime policy/adapter design.
