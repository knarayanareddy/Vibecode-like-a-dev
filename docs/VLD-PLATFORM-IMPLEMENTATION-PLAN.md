# VLD Platform implementation plan

**Status:** Active implementation plan. Phases 1–3, the safe M4 adapter-host foundation, the closed M5 candidate/review foundation, an M6 local Studio foundation, an M7 signed content-catalog foundation, the M8 optional ACP/GitHub contract foundation and M8.1's typed offline Runtime forge-plan handoff are implemented in VLD 0.19.0: mission authority, manual worktree safety, optional local Runtime state, deterministic fake runs, a constrained read-only direct-argv local-process adapter, exact candidate receipt identity, detached packet integration, independent local review/queue receipts, a CSP-protected local Runtime dashboard/VS Code command entry, a threshold-signed inert catalog, fixture-tested ACP v1/GitHub provider boundaries, and replay-validated plan-export receipts. A write-capable sandbox adapter, a production ACP peer integration, project command verifier, merge manager, Runtime forge mutation endpoint, full approval/store surfaces and executable adapter catalog are still unimplemented.

**Companion research:** [PLATFORM-EXPANSION-RESEARCH.md](PLATFORM-EXPANSION-RESEARCH.md)
**Current baseline:** VLD 0.19.0, deterministic Core with packets, gates, evidence, typed workflows, locked modules/stores, agent handoffs, MCP, bounded exports, versioned mission/workspace foundations, a recovery-aware local Runtime ledger/API, an opt-in M4 adapter host, an M5 no-merge local candidate/review host, an M6 local Runtime client, an M7 content-only catalog, M8 opt-in protocol/provider packages and M8.1's data-only Runtime forge-plan receipt/export with no credential or remote execution authority.


## Implementation progress

- [x] **M0 boundary:** [ADR-0003](adr/0003-mission-foundation-and-runtime-boundary.md) and [ADR-0005](adr/0005-local-runtime-host-and-fake-run-state.md) separate deterministic Core/mission authority from optional local Runtime state: no Core command runs an agent/model/Runtime, and M3 Runtime has no execution authority.
- [x] **M1 initial mission foundation:** Core validates schema-versioned, complete requirement-linked work-package declarations; it freezes a verified packet digest, Core-policy digest and immutable Git target; `init`, `validate` and read-only `status` have real-Git and public-CLI tests.
- [x] **M2 manual worktree safety foundation:** `workspace create|status|recover|remove` allocates only a current verified mission package at its frozen commit, uses an atomic common-Git lock and sibling managed root, validates a repository-bound ledger, reports drift and preserves work during recovery. It has real-Git, symlink/state/lock/concurrency, public-CLI and packed-install coverage. [ADR-0004](adr/0004-safe-manual-worktree-allocation.md) fixes its narrow authority boundary.
- [x] **M3 local Runtime host:** `runtime init|status|allocate|heartbeat|transition|recover|serve` owns versioned fake-run state, policy digest, leases, expected versions, receipts and a bearer-protected loopback API. It has policy/role/lease/recovery/API/public-CLI tests and no execution authority. [ADR-0005](adr/0005-local-runtime-host-and-fake-run-state.md) defines the trust boundary.
- [x] **M4 adapter-host foundation:** `runtime agent run|status` has a deterministic fake adapter and a strictly policy-declared direct-argv local process adapter. It verifies an M2 workspace plus M3 lease, owns transitions/receipts, excludes parent credentials and retains only redacted output. [ADR-0006](adr/0006-scoped-agent-adapter-host.md) records why unsandboxed local processes are read-only.
- [x] **M5 candidate/review foundation:** `runtime delivery submit|verify|approve|queue|status` freezes exact branch/base/target/packet/policy identities, uses a Runtime-locked detached integration worktree for only an in-process packet check, and writes independent review/queue receipts. It has no project-command, merge, push, PR, forge or credential authority. [ADR-0007](adr/0007-frozen-candidates-and-no-merge-m5-foundation.md) records the boundary.
- [x] **M6 local Studio foundation:** `studio serve` and Runtime `/studio` provide a static, accessible mission/receipt dashboard through the existing authenticated loopback API; a VS Code command entry opens the dashboard or a read-only inspector. The UI has no Git/agent/shell/merge/forge authority and retains no token. [ADR-0008](adr/0008-local-studio-is-a-runtime-client.md) records the boundary.
- [x] **M7 signed content-catalog foundation:** `catalog trust|add|diff|update|status|copy` pins an explicit local Ed25519 trust root and verifies threshold-signed canonical index/package metadata and bounded inert payloads before cache/lock/copy. It has no executable/plugin/enablement authority. [ADR-0009](adr/0009-signed-content-only-catalog.md) records the boundary.
- [x] **M8 ACP/GitHub contract foundation:** optional nested packages pin the stable ACP v1 SDK boundary and a caller-injected GitHub REST contract. Both use fixture-only tests, exact immutable identities and explicit installation/in-memory credentials; neither adds Core credential, automatic push, webhook or Runtime forge authority. [ADR-0010](adr/0010-optional-acp-and-github-provider-boundaries.md) records the boundary.
- [x] **M8.1 typed offline forge-plan handoff:** Core shares only a data-only GitHub-plan schema; Runtime records a replay-validated `forge-plan` receipt bound to candidate/verification/approval/queue IDs, digests and frozen SHA facts. `runtime forge plan-export` builds a merge-disabled plan from current queued evidence and optionally writes a new local review file without credential, `gh`, environment-auth, network, push, PR, merge, poll or webhook access. [ADR-0010](adr/0010-optional-acp-and-github-provider-boundaries.md) records the boundary.
- [ ] **Sandbox / full provider / merge onward:** a write-capable sandbox adapter, production ACP peer exercise, project verifier, merge lane manager, Runtime forge mutation endpoint, full approval/store Studio surfaces and executable adapter catalog remain intentionally unimplemented until their preceding phase gates below are completed.

## 1. Objective and success definition

Build a local-first VLD Platform that carries work from a verified VLD packet through isolated agent implementation to a reviewed merge, without compromising the deterministic compiler boundary.

```text
verified packet
  → declared mission/work packages
  → isolated worktrees and scoped runs
  → candidate commit + declared checks
  → independent review / approval
  → guarded merge queue + receipt
```

### Product success criteria

- [x] An operator can create a mission from a **verified** packet and inspect each package's linked `REQ-` IDs.
- [x] The manual workspace foundation can allocate independent Git worktrees to concurrent work packages without assigning the same workspace/branch twice; a future Runtime must separately own leases and scheduling.
- [ ] An approved agent adapter can work only inside its allocated workspace and declared capability policy.
- [ ] An agent can submit a candidate commit but cannot transition its own package to approved or merged.
- [ ] A candidate is verified against its exact candidate SHA, exact target SHA, packet digest and policy digest before merge.
- [ ] If the target changes, approval/verification is invalidated and a new integration candidate is checked.
- [ ] A reviewer can trace requirement → work package → run → candidate SHA → checks → review/evidence → merge receipt.
- [ ] Existing `plan`, `compile`, `verify`, `change`, packet checkers and gates work without Runtime, Studio, network access or agent credentials.
- [ ] Third-party catalog content cannot execute code or alter compiler inputs; executable adapters remain explicitly enabled and isolated.

### Explicit non-goals for the first platform release

- [ ] Do **not** build a text editor, IDE fork, model provider, general CI service or Git hosting service.
- [ ] Do **not** move model/API calls, credentials, network access or arbitrary shell execution into `plan`, `compile` or `verify`.
- [ ] Do **not** make raw transcripts, personal tokens or agent credentials required evidence artifacts.
- [ ] Do **not** support arbitrary in-process third-party JavaScript plugins.
- [ ] Do **not** automatically merge to a protected/default branch without explicit policy and a forge-level authorization path.
- [ ] Do **not** solve cross-repository or cross-mission concurrency with Git worktrees alone.

---

## 2. Architecture decisions that gate all implementation

These checklists are Phase 0 deliverables. No runtime dependency, agent SDK, web server, UI or provider credential support should merge before they are accepted in an ADR.

### 2.1 Trust-boundary ADR

- [ ] Write a new ADR that names **Core**, **Runtime**, **Studio**, **agent adapter**, **forge adapter** and **catalog client** as distinct trust zones.
- [ ] State that Core remains deterministic and model/provider free; Runtime can be optional and operational.
- [ ] State that Core packet/change/artifact evidence remains authoritative over all Runtime state and generated UI views.
- [ ] Define whether mission declarations are versioned project artifacts and where operational state is stored/ignored.
- [ ] Define the retention/redaction policy for event streams, agent output, review text and failure diagnostics.
- [ ] Define the package topology and release policy before adding dependencies. Proposed names such as `vibecode-like-a-dev-runtime` and `vibecode-like-a-dev-studio-vscode` are provisional until registry availability/licensing is checked.
- [ ] Record an explicit decision on local-only first release vs a remote/team Runtime; default to local-only.
- [ ] Require a threat-model sign-off and test-plan sign-off for each capability-expanding phase.

### 2.2 Runtime policy model

Policy is data validated by the host, not prompt prose interpreted by an agent.

- [ ] Define immutable policy fields: actor identity/type, mode, allowed workspace roots, read/write scope, allowed command classes, network permission, secret references, Git push permission, merge permission, maximum duration, retry budget and human-approval requirements.
- [ ] Define policy inheritance: Core profile risk tier → organization/team policy → mission/work-package policy → one-time human approval. A lower layer may only narrow, never silently broaden, a restriction.
- [ ] Define a canonical JSON encoding and SHA-256 digest for every effective policy.
- [ ] Define an approval receipt schema containing approver, timestamp, requested capability, candidate/target SHA where relevant, reason and policy digest.
- [ ] Define an explicit `deny`/`ask`/`allow` disposition for every privileged operation.
- [ ] Prohibit policy payloads from carrying shell snippets, credentials or executable code.

### 2.3 Actor separation

- [ ] Define actor roles: `operator`, `planner`, `implementer`, `reviewer`, `release-approver`, `runtime`, `forge`.
- [ ] Make the Runtime the sole writer of state transitions and receipts.
- [ ] Prohibit one actor/run from both submitting and approving the same candidate unless a deliberately low-risk policy exception is recorded and human-approved.
- [ ] Prohibit agent adapters from invoking `merge`; they may submit candidates and evidence only.
- [ ] Ensure humans can take over/recover any blocked or expired work package.

### 2.4 State and storage decision

| State class | Proposed location | Git status | Owner |
| --- | --- | --- | --- |
| Mission declaration and work-package plan | `missions/<mission-id>/mission.json` plus optional authored context | Versioned/reviewed | Core schema validation + human |
| Runtime event ledger, leases, process metadata and temporary allocations | `.vld/runtime/` | Ignored | Runtime only |
| Worktrees | Runtime-managed sibling directory, outside packet path | Ignored | Runtime only |
| Candidate/review/merge receipt selected as evidence | Existing change artifact/evidence link or declared mission receipt | Versioned only when policy requires | Runtime writes; Core verifies reference |
| UI preferences/session tokens | User config/keychain | Never committed | Studio/OS |

- [ ] Specify the initial storage interface (`MissionStore`) before choosing an implementation.
- [ ] Supply a deterministic JSONL implementation for tests and recovery fixtures.
- [ ] Evaluate SQLite behind the interface only. The inspected Node 22 runtime exposes experimental `node:sqlite`, but VLD's Node 20+ support floor does not guarantee it.
- [ ] Ensure a storage implementation never writes runtime state into a compiled packet directory.
- [ ] Use atomic create/write/rename semantics and record schema versions for every persisted file.
- [ ] Define migration and downgrade behavior; reject unknown future schema versions rather than guessing.

### 2.5 Phase 0 tests and exit gate

- [ ] Unit-test canonical policy digesting, narrowing-only inheritance and every invalid field.
- [ ] Unit-test all legal/illegal role/transition combinations as a transition matrix.
- [ ] Test schema rejection for prototype pollution keys, unknown fields where closed schemas are intended, path traversal, newline/control-character injection and secret-like values.
- [ ] Test JSONL persistence/restart/migration fixtures and simulated interrupted writes.
- [ ] Add an ADR conformance test that proves Core commands neither import Runtime packages nor require network/model credentials.
- [ ] Run the existing full `npm run check` suite unchanged.

**Phase 0 exit:** ADR accepted; data contracts are versioned; deterministic/fake test fixtures exist; no feature runtime is released.

---

## 3. Repository, package and test topology

Keep the current core package lightweight. Runtime/UI dependencies belong in optional packages or clearly isolated directories, not in the compiler import graph.

```text
factory/                         # Existing deterministic Core
  lib/
    missions.mjs                 # Proposed shared pure mission schema/validation
    runtime-policy.mjs           # Proposed pure policy helpers
    runtime-contracts.mjs        # Proposed JSON envelopes/types, no I/O
  test/
    missions.test.mjs
    runtime-policy.test.mjs

packages/                        # Proposed, absent until ADR accepts topology
  runtime/                       # Optional local service + scheduler + store
    src/{api,store,scheduler,workspaces,adapters,merge}/
    test/{unit,integration,security,fixtures}/
  studio-vscode/                 # Optional VS Code extension/WebView client
  adapter-acp/                   # Optional ACP v1 adapter, separate dependency boundary
  forge-github/                  # Optional GitHub adapter, separate provider boundary
```

### Packaging checklist

- [ ] Decide whether the repository adopts npm workspaces or keeps independently packaged subdirectories; document the selected build/publish path.
- [ ] Ensure the root `vibecode-like-a-dev` tarball includes only intended Core/public files.
- [ ] Ensure Runtime/Studio dependencies are not installed when a user installs only Core.
- [ ] Add independent `npm pack`/isolated-install journeys for every publishable package.
- [ ] Add a platform-bundle smoke test only after individual package journeys pass.
- [ ] Pin development tooling through lockfiles/CI policy without adding credential-bearing configuration to the repository.
- [ ] Keep all optional dependency imports behind explicit entry points; Core import tests must prove they are unreachable.

### Test layers used throughout this plan

| Layer | Purpose | Runs in normal CI? |
| --- | --- | --- |
| Pure unit | Schemas, reducers, state transitions, digesting, path/argv validation | Yes |
| Deterministic integration | Temporary Git repos, fake clock/process/agent/forge, local HTTP loopback | Yes |
| Adversarial/security | Injection, malformed events, races, stale leases, crash recovery, malicious catalog | Yes |
| Contract | Stable JSON RPC/adapter/forge request and response fixtures | Yes |
| Distribution | Packed-install, CLI/extension packaging and upgrade migration | Yes |
| Optional live integration | Real installed agent CLI, Docker, ACP peer, GitHub test repo | Manual or separately protected workflow; never default CI |
| Usability/e2e | Studio WebView/browser visual and interaction scenarios | Yes with mocks where feasible; manual release smoke for VS Code host |

Every new production behavior needs at least one success test, one validation failure test, one recovery/rollback test where it mutates state, and one authorization/negative test.

---

## 4. Phase 1 — Mission and work-package foundation

### 4.1 Goal

Create a versioned, Core-validated mission declaration that turns a verified packet into bounded work packages. This phase creates no live agent execution.

### 4.2 Proposed contract

```json
{
  "schemaVersion": 1,
  "id": "add-report-export",
  "packet": { "path": "specs", "digest": "sha256-..." },
  "target": { "ref": "refs/heads/main", "commit": "<40-hex>" },
  "policyDigest": "sha256-...",
  "workPackages": [
    {
      "id": "wp-api",
      "title": "Implement authenticated CSV export endpoint",
      "requirements": ["REQ-014", "REQ-019"],
      "dependsOn": [],
      "resourceClaims": { "paths": ["src/export/**", "test/export/**"] },
      "executionPolicy": "implementation-standard",
      "reviewPolicy": "independent-review"
    }
  ]
}
```

The final schema differs slightly (`corePolicyDigest`, no execution/review policy fields) but the Phase 1 invariants and scope are now:

- [x] Mission and package IDs are normalized and unique; packages form an acyclic, complete requirement partition.
- [x] Packet paths are project-bounded and symlink-safe; packet digest must match a verified packet.
- [x] Every packet requirement is assigned exactly once, and each dependency references another declared package.
- [x] The requested target ref is resolved to a full immutable commit at creation; status reports target/policy/packet drift rather than retargeting.
- [x] Resource claims are project-relative advisory data, never executed globs.
- [x] Mission data rejects unknown fields and contains no tokens, arbitrary command, model prompt override or executable extension.
- [ ] Workflow/change/artifact context linkage is a later additive schema decision; mission data must not become change-archive authority.

### 4.3 Implemented checklist

- [x] Add a pure dependency-free mission schema/validator and deterministic mission construction under the Core boundary.
- [x] Add `vld mission init`, `validate` and read-only `status`, JSON output, overwrite protection and no-partial-write behavior. There is no `mission plan`/dry-run model generator.
- [x] Build packages only from a verified packet and explicit human-authored definition, requiring complete requirement assignment.
- [x] Store the declaration outside `specs/` by default and never accept it as compiler input.
- [x] Add exact requirement coverage reporting plus project-relative/symlink-safe path handling.
- [ ] Add an authored evidence-reference convention to the change archive only after a separate authority/retention decision.

### 4.4 Implemented extensive test checklist

**Schema and invariants**

- [x] Accept valid packet-bound missions and reject missing/malformed packet authority, unknown/duplicate/missing requirement IDs, duplicate package IDs, dependency cycles, unsafe paths and unknown fields.
- [x] Reject invalid/unresolved Git targets and require full 40-character frozen commits.
- [x] Assert status reports packet, policy and target drift without silently changing the mission.
- [x] Assert mission commands do not allocate worktrees, start Runtime/model code or mutate Git refs.

**Lifecycle and compatibility**

- [x] Assert overwrite refusal, explicit force behavior and no partial mission output on invalid input.
- [x] Run direct real-Git and public CLI mission tests, the full deterministic suite and a packed-install mission journey.
- [ ] A v1-to-v2 migration, property/fuzz DAG suite and change-archive integration wait for a schema change that needs them.

**Phase 1 exit:** complete. A reviewed, versioned mission can be created and validated from a verified packet while deterministic Core remains independent of Runtime/Studio.

---

## 5. Phase 2 — Safe concurrent worktree manager

### 5.1 Goal

Allocate one isolated Git workspace per work package and make all Git mutations recoverable. This phase supports manual work in a worktree before it supports agents.

### 5.2 Implemented command surface

```text
vld workspace create <mission> <package> [--project .] [--json]
vld workspace status <mission> [--project .] [--json]
vld workspace recover <mission> [--project .] [--json]
vld workspace remove <mission> <package> [--discard --acknowledge <workspace-id>] [--project .] [--json]
```

`create`, `recover` and `remove` are the only mutating commands. Their JSON output is a report, never an execution receipt for an agent. There is deliberately no generic `--execute`, project-command flag or model/provider option. A dry-run allocator is deferred: `status` is the non-mutating inspection surface, and a future Runtime can add a planned/leased allocation preview only with its policy model.

### 5.3 Implemented worktree safety contract

- [x] Require a non-bare Git working repository, resolve its common Git directory, and require the command to run from the primary checkout root. This creates one ledger path per common Git directory rather than one ledger per linked worktree or caller subdirectory.
- [x] Require a current, verified mission and allocate its declared package from the mission's immutable full target commit, never directly from a moving ref.
- [x] Derive and validate a deterministic `vld/<mission-id>/<package-id>` branch and reject existing branch/path collisions. A healthy matching allocation is idempotent; drifted/pending state requires recovery.
- [x] Place worktrees in a deterministic sibling root outside the checkout: `<project-parent>/.vld-worktrees/<project>-<common-git-digest>/...`. Existing symlinks/non-directories are rejected; neither a packet nor a mission path is used as a workspace root.
- [x] Keep a schema-versioned, repository-bound `.vld/workspaces.json` ledger with allocation ID, mission digest/file, package, branch, worktree, frozen base/target commit, advisory resource claims, lifecycle state and bounded removal receipts. State has an allowlist and deterministic branch/path validation.
- [x] Serialize every VLD workspace mutation with `O_EXCL` JSON lock-file creation in the Git common directory. Owner PID/token inspection distinguishes live from recoverable locks; only `recover` can reap a dead/malformed regular lock. Symlink/unsafe lock types fail closed.
- [x] Use that same repository lock for package assignment, `git worktree` registration/removal and branch deletion, so concurrent VLD processes cannot allocate one package twice.
- [x] Reconcile against `git worktree list --porcelain` before idempotent creation, status, recovery and removal. Status also warns about unrecorded worktrees under the managed root.
- [x] Support separately declared missions sharing one primary checkout only for this narrow manual allocation capability; the lock serializes VLD's branch/worktree mutations. It does **not** provide Runtime leases, scheduler ownership, remote-runner coordination, shared-ref isolation or merge-conflict prevention.
- [x] Treat overlapping resource claims as an advisory warning which explicitly says worktrees do not prevent a later merge conflict.
- [x] Refuse normal removal for staged, unstaged, untracked or committed work. `--discard` requires the exact allocation ID and records a bounded receipt before returning success.
- [x] Persist `removing` intent before Git mutation. Recovery restores a still-healthy worktree or finalizes a disappeared worktree while retaining any remaining branch.
- [ ] Add Runtime lease holder/run ID, candidate/evidence preservation and automated lease expiry only in the later Runtime phase; this manual phase deliberately has no agent/candidate authority.

### 5.4 Implemented extensive test checklist

**Real-Git fixture and normal paths**

- [x] Build temporary Git repositories with configured identity, a verified packet and a complete frozen mission fixture.
- [x] Allocate one and then two packages; assert branch, frozen base SHA, sibling path, ledger and `git worktree list --porcelain` agree, and uncommitted files do not cross worktrees.
- [x] Assert matching allocation idempotency and advisory overlap warnings without claiming merge safety.
- [x] Exercise `workspace create`, `status` and `remove` through the public CLI as part of the mission journey.

**Safety, locking and recovery**

- [x] Spawn competing CLI allocators for one package; assert one allocation record/worktree and a safe lock diagnostic for any loser.
- [x] Inject a live-PID lock and a dead-PID lock; assert active mutation blocks and only `recover` reaps the stale lock.
- [x] Simulate removal interrupted while the worktree remains and after it is removed; assert recovery respectively restores allocation or retains the branch and writes a receipt.
- [x] Reject invocation from a nested directory/linked-worktree control path so the ledger cannot split across a common Git directory.
- [x] Reject unknown state fields and unsafe state records before mutation. Replace a registered worktree with a symlink and assert status/remove block without touching the outside sentinel.
- [x] Reject ordinary removal for untracked, staged, unstaged and committed work; assert discard needs the exact ID and clean removal unregisters both worktree and branch.
- [x] Run targeted real-Git tests, public CLI tests, the full deterministic suite, full check and a packed-install journey in CI.

**Deliberately deferred Runtime tests**

- [ ] Fake-clock lease expiration, holder/run identity, retries and scheduler transition races belong to the Runtime host, not this Git-only foundation.
- [ ] Agent process crash, candidate commit/evidence retention, integration verification and merge/forge behavior remain later phase tests.
- [ ] Cross-clone/remote-runner arbitration needs an explicit remote Runtime design; the common-Git lock cannot solve it.

**Phase 2 exit:** complete. Manual development can allocate/recover/clean declared packages end to end with no model, arbitrary command, push, merge, Runtime or credential path. The next gate is a separate Runtime authority design, not expanding this allocator opportunistically.

---

## 6. Phase 3 — Mission Runtime host and state machine

### 6.1 Goal

Introduce an optional local Runtime that owns deterministic fake-run transitions, leases and receipts before any process/model adapter exists. The Runtime is a separate optional surface: deterministic Core remains usable with it absent.

### 6.2 Implemented M3 contract

- [x] `vld runtime init|status|allocate|heartbeat|transition|recover` works only from a primary Git checkout and a current, verified frozen mission for initialization/allocation/normal transitions.
- [x] A closed local-only policy freezes a policy digest and denies network, process execution, credential access, Git push and Git merge. No policy field can carry a shell command, token or plugin.
- [x] The Runtime is the sole writer of `.vld/runtime/<mission-id>/events.jsonl` and its derived `state.json` snapshot. Mission/packet authority remains outside this ignored operational state.
- [x] Ledger events are schema-versioned, contiguous and replayed into state; a snapshot must exactly match its ledger. A pending digest record makes an interrupted event/snapshot transaction recoverable only when it is known unapplied or known complete.
- [x] Packages start `ready` only when dependencies permit them. The host validates the fixed lifecycle `planned → ready → allocated → running → changes_ready → verifying → in_review → approved → queued → merged`, controlled `blocked → ready`, expected versions and terminal immutability.
- [x] Allocation creates a run ID and one-time lease token. Only the token digest is persisted; only the assigned implementer can heartbeat/advance active work, and an expired lease is blocked during recovery.
- [x] Fixed role rules prevent an implementer ID from approving its own package. `operator`, `runtime`, `implementer`, `reviewer`, `release-approver` and fake `forge` roles are host-validated event labels; M3 does not claim external identity authentication.
- [x] Mutations support bounded idempotency keys and replay a durable receipt rather than applying a retry twice.
- [x] `vld runtime serve` provides a small JSON endpoint at `/v1/runtime`, loopback IP only, with per-launch in-memory bearer identity tokens, strict request envelopes/body cap, method-specific closed parameters, redacted errors and non-loopback Origin rejection.
- [x] `recover` alone can reap a dead-PID regular lock, reconcile a known pending transaction and block expired leases. It never deletes a worktree, branch, candidate or evidence.

### 6.3 Explicit M3 limits

- [x] No agent/model/process launch, shell command, sandbox, network egress, credential lookup, worktree mutation, push, merge, PR, candidate submission, verification execution, review artifact ingestion, GitHub, ACP or Studio is included.
- [x] No LAN/remote/team API, external user identity provider, persistent API credential store or cross-machine lease coordination is included.
- [ ] M4 supplies an opt-in process/fake-agent adapter only after this host contract; M5 binds actual candidate/verification/review/merge authority; M6 supplies Studio.

### 6.4 Extensive implemented test checklist

**Policy, transition and lease matrix**

- [x] Validate closed policy/actor schemas, deny every capability-expanding field and verify stable policy digesting.
- [x] Exercise ready/planned dependency state, allocation, heartbeat, expected-version conflict, deterministic idempotency replay, implementer progression, independent review denial/approval, queue/merge fixture transition and dependent readiness.
- [x] Assert wrong token, wrong holder, stale mission target, role escalation, self-review and terminal re-transition fail before a receipt is appended.
- [x] Assert lease token material never appears in the JSONL ledger or public status.

**Durability and recovery**

- [x] Initialize/reopen a real temporary Git mission and compare the replayed snapshot to its ledger.
- [x] Simulate stale PID lock, interrupted pending transaction, expired lease and snapshot corruption; recovery handles only known pending/stale cases and corruption fails closed.
- [x] Assert Runtime initialization does not allocate a worktree or launch a process.

**Loopback API security**

- [x] Reject non-loopback bind, missing/invalid bearer token, hostile browser Origin, unknown parameter and operator impersonation of a reviewer.
- [x] Test a valid loopback CORS request, body envelope, allocation, shutdown and redaction of project paths from status output.

**Distribution and regression**

- [x] Exercise Runtime initialization/allocation/status through the public CLI and packed-install CI journey.
- [x] Run full deterministic Core checks with Runtime unused, proving Core does not need a listener, network, credential or model.

**Phase 3 exit:** complete for deterministic fake-run host state. The next gate is M4's separately authorized process/fake-agent adapter; do not add execution authority to the Runtime ledger itself.

---

## 7. Phase 4 — Agent scheduler and adapters

### 7.1 Goal

Run a selected installed coding agent inside an allocated worktree under a typed capability policy, while retaining existing generated handoffs for users who do not opt into Runtime execution.

### 7.2 Adapter contract

```text
capabilities() -> declared capability set
start(runSpec) -> adapter run identity
observe(runId, cursor) -> ordered structured events
cancel(runId) -> cancellation receipt
reconnect(runId) -> current status or explicit unsupported result
```

`runSpec` must be a validated data object, not a shell string. It references mission/package/packet/policy digests, workspace, approved prompt/context reference, resource limits, capability grants, non-secret configuration references and environment allowlist.

### 7.3 Scheduler checklist

- [x] Define closed capability names: `readWorkspace`, `writeWorkspace`, `runDeclaredCommands`, `network`, `streamEvents`, `cancel`, `reconnect`, `sandbox`, credential and Git fields; unknown/broadening fields are rejected.
- [x] Implement a fake adapter with finite deterministic success/failure/silent sequences for normal CI tests.
- [x] Implement a local-process adapter with one policy-declared direct argv, immediate absolute executable validation and no `sh -c`, `eval`, interpolation or PATH search.
- [x] Construct a digest-only context from VLD-controlled frozen mission/packet/work-package authority; do not persist a raw prompt/transcript.
- [x] Pass only a fresh non-secret locale allowlist plus VLD-derived identifiers; never inherit the parent environment or a credential handle.
- [x] Set CWD to a validated M2 allocated worktree immediately before launch.
- [x] Enforce duration/output/retry limits, process-group termination where supported, cancellation and redacted timeout/cancellation receipts.
- [x] Keep Git push/merge/network/credential capabilities disabled. A portable CWD is not a sandbox, so unsandboxed `local-process` is read-only; a write capability is rejected until a later sandbox adapter proves isolation.
- [x] Make the local-process mode read-only; fake runs are process-free deterministic state fixtures.
- [x] Preserve current `vld agent install` handoffs and document that handoff mode does not imply Runtime execution.

### 7.4 ACP v1 adapter checklist

- [x] Add ACP only in a separate optional package/dependency boundary: `factory/integrations/acp-v1` pins the SDK and Core dynamically loads it only for an explicit `acp-v1` policy (M8 foundation).
- [x] Use only the stable ACP v1 SDK root API/entry point; contract tests assert unstable/v2 imports are absent (M8 foundation).
- [x] Perform v1 version/auth/reconnect capability negotiation and reject peer facts that exceed the read-only, anonymous policy (M8 foundation).
- [x] Map bounded ACP session-update metadata into normalized host progress events; peer events cannot transition Runtime state or persist prompt/transcript content (M8 foundation).
- [x] Use protocol contract fixtures in normal CI plus an opt-in package test against a stable fake stdio peer; no proprietary account is required.
- [x] Document fallback to local-process/handoff adapters for non-ACP agents (M8 foundation).

### 7.5 Extensive test checklist

**Process adapter**

- [x] Use fixture executables that succeed, ignore termination, emit oversized output and malformed structured events; fake scripts cover success/failure/silent paths without a process.
- [x] Verify argv is preserved as discrete arguments; a semicolon remains a literal arg and cannot start a second command.
- [x] Verify CWD is the validated allocated worktree; a missing/unsafe workspace is refused before spawn.
- [x] Verify policy validation rejects write/network/credential/broad environment capability before spawn.
- [x] Seed a parent secret environment variable and assert it is absent from the fixture; only explicit locale/VLD identifiers are present.
- [x] Verify output is capped/redacted; token-like text and absolute host paths do not appear in durable receipts/status.
- [x] Verify timeout/cancel terminates the process group where supported and the Runtime host records a receipt then blocks unsafe work.
- [x] Verify retry count is bounded and does not create a candidate submission (M4 has no candidate authority).

**Agent workflow safety**

- [ ] Fake an agent attempting to submit a candidate for a different package/worktree; reject it.
- [ ] Fake an agent attempting direct `approve`, `queue`, `merge` or policy broadening; reject it.
- [ ] Fake a candidate with wrong base/branch, uncommitted workspace or unknown SHA; reject it.
- [ ] Verify human/independent reviewer evidence is mandatory for policies that require it.
- [ ] Verify a Runtime-disabled project still uses the existing handoff workflow successfully.

**ACP**

- [x] Test v1 initialization/capability negotiation success plus v2/auth/reconnect-capability rejection (M8 foundation test).
- [x] Test malformed/unknown update and stop messages at the closed VLD normalizer; duplicate/out-of-order fake-stdio peer cases remain to add.
- [ ] Test session reconnect/cancel behavior against a full fake peer and conversion of peer transport errors to stable VLD errors (bridge has bounded failure/cancel mapping; end-to-end fixture remains to add).
- [x] Assert stable root import/pinned SDK and absence of v2/unstable imports/features in Core/bridge source (M8 foundation test).

**Optional manual live tests**

- [ ] Run each supported installed agent CLI in an ephemeral fixture repo with a disposable credential/account and fixed spend/time budget.
- [ ] Record command/version/model/configuration without recording credentials; retain raw output only in a protected local result location.
- [ ] Verify the same user journey through an ACP-capable peer when one is available.

**M4 foundation exit:** complete for deterministic fake runs and opt-in read-only direct-argv local processes. They require a frozen lease/workspace, never involve Core model calls or broad credential inheritance, and emit host-owned redacted receipts. A write-capable sandbox adapter and ACP v1 remain separate future gates; do not treat a working-directory setting as confinement.

---

## 8. Phase 5 — Verification, independent review and merge-lane manager

### 8.1 Goal

Turn a candidate commit into a frozen, independently reviewed and revalidated merge candidate. Start conservative: local Git integration and an optional GitHub PR adapter; never claim to replace forge branch protection.

### 8.2 Candidate and receipt contract

- [x] Freeze `{missionId, packageId, candidateSha, baseSha, targetRef, targetSha, packetDigest, policyDigest, adapterRunId, generatedAt}` through a Runtime-owned candidate receipt (M5 foundation).
- [x] Reject candidate SHA that is not the clean allocated-worktree branch HEAD, is not descended from its frozen base, or is not reachable from the allocated branch (M5 foundation).
- [x] Define a closed policy-derived verification surface: M5 permits only an in-process VLD packet check and an empty command list; no agent-supplied shell string or project executable exists (M5 foundation).
- [x] Store the built-in check identity, bounded output digest/redacted summary and candidate/target SHA (M5 foundation; command exit/environment fields await a sandboxed project-check adapter).
- [x] Bind review approval to candidate SHA, target SHA, policy digest and reviewer identity; Runtime's current-mission guard fail-closes further mutation when packet/target authority changes (M5 foundation).
- [x] Persist a closed, versioned Runtime `forge-plan` receipt only after replaying the exact queued candidate, passed verification, independent approval and queue tuple. It binds each receipt ID/digest plus candidate/target SHA and packet/policy digest to a digest-checked, merge-disabled GitHub v1 plan (M8.1).
- [ ] Emit a final merge receipt with local merge commit or forge PR/merge identifier, target result SHA and linked evidence references (deferred: no merge authority in this release).

### 8.3 Merge queue checklist

- [x] Create a temporary detached integration worktree from the frozen target SHA under Runtime control and the repository-wide workspace lock (M5 foundation).
- [x] Integrate the exact candidate commit using fixed Git argv; record a conflict result rather than asking an agent to silently resolve it (M5 foundation).
- [x] Run the VLD packet checker in the integration worktree; project-declared checks remain deferred until a sandboxed verifier exists.
- [x] Transition to `in_review` only after the required built-in check completes; transition to `approved` only through independent reviewer role validation (M5 foundation).
- [x] Queue one approved immutable candidate tuple through release-approver role validation (M5 foundation; multi-candidate ordering is deferred).
- [ ] Re-read target SHA immediately before merge. If changed, discard prior integration result, return to verifying and create a new candidate tuple (deferred: M5 has no merge).
- [ ] Local Git adapter may create a merge commit only when explicit policy permits. Default branch push must be opt-in (deferred: M5 has no merge/push).
- [x] Optional GitHub v1 contract creates/updates a PR, reads exact head/check/review facts and can request an exact-SHA merge only after an immutable candidate/approval/queue plan gate; it remains outside Runtime delivery mutations and GitHub authorization/branch protection remains authoritative (M8 foundation).
- [x] Keep provider credentials out of Core/M5: the optional GitHub client accepts only caller-supplied in-memory tokens and never reads ambient `gh` or environment credentials (M8 foundation).
- [x] Export a deterministic, merge-disabled GitHub v1 review plan from a queued Runtime tuple through `runtime forge plan-export`; the command records no credential/path/provider response and does no remote action (M8.1).
- [ ] Make queue cancellation/retry/manual takeover idempotent and receipted (M5 receipt writes use Runtime's atomic pending-transaction recovery, but no cancellation/takeover surface exists yet).

### 8.4 Extensive test checklist

**Local integration worktree**

- [x] Verify a clean candidate integrates and the VLD packet check runs in the disposable integration workspace, not the primary/work-package workspace (M5 foundation test).
- [x] Verify a failing integrated packet-digest check blocks transition and preserves a bounded diagnostic digest/summary (M5 foundation test).
- [ ] Verify merge conflict blocks automatically; no agent is asked to resolve it without a new explicit allocation (conflict fixture deferred).
- [x] Verify candidate SHA mismatch is refused; rewritten-history/wrong-base fixtures remain to add.
- [ ] Advance target after verification; assert approval is invalidated, a new integration candidate is required and old receipt remains immutable (Runtime currently fail-closes on stale mission authority; explicit invalidation fixture deferred).
- [ ] Queue two candidates that touch disjoint/overlapping areas; assert deterministic ordering and target revalidation after the first merge (deferred: no merge queue ordering yet).
- [x] Runtime receipt writes use the existing pending-transaction recovery protocol; integration cleanup is `finally`-based. Crash fixtures around integration/merge remain to add.

**Approval and authorization**

- [x] Reject implementation identity approving its own candidate under independent-review policy (M5 foundation test).
- [ ] Test allowed explicitly low-risk exception only with a human approval receipt and visible status (not supported by the closed policy).
- [x] Reject direct agent adapter merge request regardless of candidate status: no adapter merge API/capability exists (M5 foundation).
- [ ] Test revoked/expired approval, altered evidence and altered packet/policy digest rejection (deferred with richer verifier/review policy).

**GitHub provider contract**

- [x] Test fixture-injected provider requests/responses for PR create/update, exact head SHA, checks, reviews and exact merge response (M8 foundation).
- [x] Reject responses missing expected branch/SHA/PR identity and reject a tampered immutable forge-plan digest (M8 foundation test).
- [x] Normalize no-token/rate-limit/network/malformed/ambiguous-merge failures without ambient auth or remote calls in CI (M8 foundation test); webhook replay fixture remains to add.
- [x] Test Runtime forge-plan receipt validation/replay against valid exact tuples, altered plan digests/tuple fields, stale mission authority, credential/path rejection and a CLI-written review plan; prove the safe plan cannot invoke a merge request (M8.1 test).
- [ ] Use an optional manually triggered ephemeral GitHub repository test with least-privilege test credentials; never run it in ordinary CI.
- [x] Preserve GitHub branch protection as an external enforcement point: the optional client only requests the exact-SHA merge after plan gates and never pushes/claims authorization (M8 foundation/ADR).

**Phase 5 exit:** merges are exact-SHA, revalidated, independently approved and recoverable; all local paths are deterministic and provider paths are contract tested.

---

## 9. Phase 6 — VLD Studio (VS Code extension and local dashboard)

### 9.1 Goal

Deliver the interactive one-stop surface over Runtime's local API. Studio displays/requests actions; Runtime remains the authority.

### 9.2 UX scope checklist

- [x] Add a VS Code command entry point for VLD Studio: open the exact local dashboard URL or a read-only Runtime inspector (M6 foundation).
- [x] Add a read-only packet/requirements view showing packet digest, Core policy digest, current/stale state and package requirement IDs (M6 foundation; browser file links remain deliberately unavailable).
- [x] Add a mission board showing package state, dependencies, resource claims, agent/run identity, lease health and blocked cause (M6 foundation; raw worktree paths remain intentionally hidden).
- [x] Add a run inspector for bounded/redacted adapter summaries and candidate/verification/review/queue receipt identities (M6 foundation; project command checks are not available).
- [ ] Add approval UI that displays precisely requested privilege/candidate/target digest and requires an explicit operator decision/reason when policy requires it (deferred until a typed Runtime approval endpoint and policy inputs exist).
- [x] Add an evidence/review view joining package `REQ-` IDs with candidate/verification/review/queue receipt SHA/digest identities (M6 foundation; artifact coverage remains deferred).
- [x] Add a local queue/verification projection from Runtime delivery receipts (M6 foundation; target movement, ordering and forge links require later merge/provider work).
- [ ] Add store/catalog view that reuses existing diff/acknowledgement semantics; it must never hide source digest or force update (deferred).
- [x] Provide a browser dashboard from the same loopback Runtime process and authenticated `/v1/runtime` API, not a parallel backend.
- [x] Support accessibility basics: native keyboard controls, visible focus styling, readable state/blocked text and non-color-only status (M6 foundation).
- [x] Display disconnected/degraded state clearly while preserving all existing CLI workflows (M6 foundation).

### 9.3 Studio security checklist

- [x] Studio gets the Runtime URL/token through a local manual channel; the one-time token is never embedded in project configuration, browser/WebView HTML, URL, storage or logs (M6 foundation).
- [x] Browser dashboard and VS Code WebView use a strict CSP with nonce scripts; the WebView accepts only a closed `refresh` postMessage schema (M6 foundation).
- [x] Studio never executes Git/agent commands directly; its two enabled controls request only existing typed Runtime `allocate`/`recover` operations (M6 foundation).
- [x] Browser and WebView render Runtime/agent/receipt strings as text nodes, never trusted HTML (M6 foundation).
- [x] Browser dashboard is served by the existing loopback-only Runtime process, retains Origin checks and has no CORS wildcard (M6 foundation).
- [x] Enabled buttons name the typed action and are disabled from Runtime-provided advisory capabilities; Runtime independently authorizes every request (M6 foundation).

### 9.4 Extensive test checklist

**UI unit/contract**

- [x] Test dashboard projection for mission/package/receipt fields, blocked causes and disconnected/error handling through unit/Runtime API fixtures (M6 foundation); exhaustive package-state visual fixtures remain to add.
- [x] Test browser action encoding through the existing typed Runtime API and Runtime rejection of an unauthorized transition (M6 foundation); all stable error fixtures remain to add.
- [x] Test the dashboard has no transition primitive and Runtime rejects an operator transition that policy forbids (M6 foundation).
- [x] Test requirement/candidate/receipt projections preserve their exact identifiers via Runtime status rendering (M6 foundation); long/missing-path fixtures remain to add.

**WebView/browser security**

- [x] Test static browser renderer excludes HTML sinks and uses text nodes; hostile-output corpus fixtures remain to add (M6 foundation).
- [x] Test CSP, rejected unknown VS Code postMessage messages and no token/project-path disclosure in the served page (M6 foundation).
- [x] Test loopback Runtime rejects an unauthorized browser Origin for both API and Studio routes (M6 foundation).

**End-to-end**

- [ ] Run mocked-runtime browser/e2e scenarios: packet → mission → allocate → fake run → candidate → verify → independent review → queue → merge receipt.
- [ ] Run VS Code extension-host smoke tests with a fixture workspace, mocked Runtime and disconnected Runtime.
- [ ] Verify keyboard-only approval/rejection and visible focus/order behavior.
- [ ] Run a manual release smoke in supported VS Code versions/platforms; record extension/package version and result.

**Phase 6 exit:** Studio provides a secure, accessible visual path across every Runtime state without becoming a second authority or executing privileged actions itself.

---

## 10. Phase 7 — Curated signed content catalog

### 10.1 Goal

Evolve locked shared stores into a curated catalog of inert, schema-validated content. Executable adapters are explicitly deferred until their separate-process runtime is mature.

### 10.2 Content catalog v1 checklist

- [x] Restrict v1 payload types to bounded Markdown guidance/artifact templates and JSON modules/bundles/workflows/test fixtures/export schemas; all package capabilities must be exactly `content-only`.
- [x] Define canonical package metadata: name/version/license/Core compatibility/payload paths+bytes+digests/publisher/release timestamp/replacement/revocation/capabilities/signatures (M7 foundation).
- [x] Define explicit local root trust with Ed25519 threshold keys and signed, acknowledged key rotation; use canonical key-sorted signed index/package metadata rather than unsigned discovery (M7 foundation).
- [x] Verify payload digest, signature/trust policy, regular-file/safe-path bounds, schema and Core compatibility before cache/lock/copy; catalog v1 has no install/enable operation.
- [x] Reuse candidate preview and exact reviewed Git-commit acknowledgement before an atomic refresh (M7 foundation).
- [x] Lock catalog package identity/version/publisher/payload digests and record copied-output provenance in a separate project lock (M7 foundation).
- [x] Support offline verification of trusted root/index/cache/lock through `catalog status` (M7 foundation).
- [x] Reject expired, revoked, untrusted, malformed, incompatible or signature/digest-altered metadata without mutating local cache/locks (M7 foundation).
- [x] Make publisher identity, content/index/root digest and trust decision visible in CLI status and Studio when a catalog is configured (M7 foundation).

### 10.3 Executable adapters: deferred boundary checklist

- [x] Do not accept executable adapters in catalog v1: payload schema/extensions and `content-only` capabilities reject them before cache/lock/copy.
- [ ] Before admitting adapters, design a separate-process RPC protocol, explicit capability grants, version/digest pinning, installation isolation, crash containment and revocation/disable behavior.
- [ ] Prove an adapter process cannot import or mutate Core compiler policy/packet internals directly.
- [ ] Require explicit local enablement for every executable adapter even if a catalog signature is trusted.
- [ ] Add an adapter provenance/permission review view before any production adapter catalog launch.

### 10.4 Extensive test checklist

**Cryptographic and metadata validation**

- [x] Verify a valid threshold-signed index/package fixture pins exact cache/lock identity and copies only with provenance (M7 foundation test).
- [x] Reject altered payload/index digest, invalid signature and incompatible Core range without lock mutation (M7 foundation test); unknown-key/threshold/expiry/revocation fixtures remain to add.
- [x] Test acknowledged old-root-signed key rotation and offline cached verification/digest-drift detection (M7 foundation test); rollback/freeze fixture remains to add.
- [x] Verify signatures use canonical key-sorted serialization through stable canonical signing helpers (M7 foundation test fixture signs/reloads separately ordered JSON).

**Content safety**

- [x] Enforce safe relative paths, regular non-symlink bounded payloads, strict JSON/Markdown extension types and inert copy-only semantics; shell text is content, never executed (M7 foundation). Malformed/oversized/symlink corpus fixtures remain to add.
- [x] Validate catalog workflow payloads with VLD's typed/allowlisted workflow validator, so arbitrary `run` commands are rejected (M7 foundation).
- [x] Catalog copy cannot enable a module/apply a bundle/run a workflow or alter compiler inputs; only explicit existing Core flows retain those authorities (M7 foundation).
- [x] Test signed diff preview leaves the lock unchanged and update rejects any commit differing from the acknowledged candidate (M7 foundation test).

**Supply-chain/release**

- [x] Use runtime-generated independent Ed25519 test keys/fixtures; no private signing key is committed.
- [ ] Run a packed-install journey that validates catalog verification with no network after fixture cache preparation.
- [x] Add a catalog trust incident runbook covering quarantine, inert-content containment, pinned rollback, copied-output audit and threshold-signed root rotation.

**Phase 7 exit:** curated content is signed, pinned, reviewable and fail-closed; no catalog content can execute code or bypass Core policy.

---

## 11. Cross-phase test program and release gates

### 11.1 Required CI lanes

- [ ] **Core lane:** existing `npm run check`, including no-Runtime/no-network regression assertions.
- [ ] **Runtime unit lane:** policy, schema, event reducer, leases, API envelope and adapter contracts.
- [ ] **Runtime integration lane:** temporary Git repos, fake clocks/processes/agents/forge and loopback Runtime.
- [ ] **Concurrency lane:** repeated multi-process lock/allocation/recovery/merge-queue race scenarios; run enough repetitions to expose flaky locking.
- [ ] **Security lane:** argv/path/environment injection, malformed events, origin/token, log redaction, artifact/catalog tampering and authorization-negative tests.
- [ ] **Studio lane:** extension/web UI unit and mock-Runtime end-to-end tests.
- [ ] **Packaging lane:** isolated `npm pack`/install for Core and each optional package; extension package/install smoke.
- [ ] **Compatibility lane:** minimum supported Node version, Git version/platform matrix, offline/local-only mode and a current Node version.

### 11.2 Test fixture rules

- [ ] All normal-CI agents are fake deterministic binaries/peers; no external model calls, real credentials or uncontrolled network.
- [ ] All Git tests use throwaway repositories with local `file://` remotes or fixtures; no production branch/ref.
- [ ] All GitHub/forge tests use mocks/recorded fixtures in CI; an ephemeral sandbox repository is only a protected manual job.
- [ ] Tests own their temp directory, process group, listener and worktree root; cleanup failures must fail the test rather than leak state into a later test.
- [ ] Fault injection can stop a process at each durable-write/mutation boundary.
- [ ] Time-dependent code uses an injected clock/lease scheduler in unit/integration tests.
- [ ] Security fixtures include dangerous-looking values but never real secrets.

### 11.3 Quality bar before each release

- [ ] All existing and new tests pass on supported platforms/Node versions.
- [ ] New state-mutating command has dry-run/status/recover semantics where applicable and tests for failure atomicity.
- [ ] JSON APIs have versioned fixtures and stable documented error codes.
- [ ] No test requires an interactive model credential, external network or a local host-specific path by default.
- [ ] Coverage is reviewed for transition/authorization/cleanup branches; numerical coverage is not accepted in place of adversarial scenarios.
- [ ] A pack/install journey exercises the released artifact, not only source checkout imports.
- [ ] Documentation contains exact trust boundaries, permission prompts, recovery and rollback steps.
- [ ] Threat-model regression review explicitly lists any new process/network/filesystem/credential authority.

### 11.4 Manual release checklist

- [ ] Perform a clean-machine/local user journey with no Runtime enabled; verify VLD Core remains useful.
- [ ] Perform a full fake-agent journey with Runtime and Studio in a disposable repository.
- [ ] Perform a scoped real-agent pilot in a disposable repository using a separate account/budget; record outcome as empirical evidence, not CI proof.
- [ ] Verify stopping/restarting Runtime during a live pilot yields a recoverable blocked state, not an implicit merge or deletion.
- [ ] Verify review/approval trail is understandable to someone who did not run the agent.
- [ ] Verify every published package/extension's license, provenance, digest and release notes.

---

## 12. Suggested execution order and milestones

| Milestone | Delivers | Why it comes here | Blocks |
| --- | --- | --- | --- |
| M0: Boundary ADR | Trust model, schemas, test harness design | Prevents Core/runtime authority confusion | All implementation |
| M1: Mission foundation | Versioned mission/work-package declarations | Gives every later layer stable IDs/requirement links | Workspaces, Runtime |
| M2: Worktree safety | Manual isolated package workspaces + recovery | Proves Git safety before agents run | Scheduler, merge queue |
| M3: Runtime host | Leases, transitions, receipts, fake agent | Establishes host authority and observability | Live adapters, Studio |
| M4: Process adapter | Scoped local-agent execution | First end-to-end agent vertical | ACP/real agent pilot |
| M5: Merge queue | Candidate/integration/review/merge receipts | Completes idea-to-verified-merge path | Forge adapter |
| M6: Studio | Visual local control center | Makes the now-proven Runtime accessible | Optional desktop shell |
| M7: Signed content catalog | Curated inert content distribution | Builds on existing stores without executable plugins | Future adapter catalog |
| M8: ACP + GitHub adapter | Portable sessions and remote PR flow | Adds integrations to a tested host contract | Team/remote use |
| M9: Remote runners/desktop/adapter catalog | Scale and distribution | Only after local security/recovery is proven | Enterprise roadmap |

A useful product beta can ship after **M6**: a user can compile, create a mission, run a selected local agent in an isolated worktree, inspect/review evidence in Studio, and merge through a guarded local/PR path. M7–M9 broaden integrations and distribution; they should not delay proving the local workflow.

---

## 13. Risk register and stop rules

| Risk | Early signal | Mitigation / stop rule |
| --- | --- | --- |
| Core becomes coupled to Runtime dependencies | `compile` imports Runtime or tests require a listener | Stop merge; restore optional dependency boundary and add import/pack regression test. |
| Worktree manager causes data loss | Any fixture loses uncommitted work or deletes an unowned worktree | Stop feature rollout; disable automatic cleanup and require explicit recovery/discard until root cause is fixed. |
| Scheduler turns into shell execution surface | Adapter API accepts shell strings or inherited environment | Stop; redesign around typed argv/capabilities and add injection tests before proceeding. |
| Agent self-approval/merge loophole | Actor identity not tied to candidate/receipt | Stop merge queue release; enforce host role matrix and independent review test. |
| UI bypasses Runtime | Studio invokes Git/spawn directly or stores authority state | Stop; move operation behind local API and contract test it. |
| Catalog becomes a supply-chain RCE path | Content can execute hooks or adapter loads in-process | Keep catalog content-only; defer executable category pending isolation/provenance design. |
| Remote/real-agent pilot is flaky or expensive | Nondeterministic results mask state bugs | Return to fake deterministic fixtures; do not make live runs a release gate. |
| Scope expands into a replacement IDE/forge | Feature requests require editor/graph/host reimplementation | Keep integration boundary; reassess product charter rather than silently absorbing scope. |

---

## 14. Definition of done for the platform initiative

The initiative is complete for its first one-stop, local-first release only when all items below are true:

- [ ] A verified VLD packet is the required starting authority for a mission.
- [ ] Mission packages, policy and evidence are reviewable and tied to stable requirement IDs.
- [ ] Runtime is the only source of operational state transitions and writes durable/recoverable receipts.
- [ ] Worktrees are lock-protected, isolated, recoverable and safely cleaned up.
- [ ] A scoped agent run can produce a candidate but cannot grant itself new capability, approve or merge.
- [ ] Verification and review bind to immutable candidate/target/policy/packet digests.
- [ ] Merge queue revalidates after target movement and respects external branch protection.
- [ ] Studio shows the complete trail and cannot bypass Runtime authorization.
- [ ] Content catalog is signed/pinned/reviewable/inert; executable adapters remain isolated and explicit.
- [ ] Core remains deterministic and passes its existing full check with Runtime/Studio unavailable.
- [ ] All normal CI tests are deterministic and credential-free; optional real-agent/forge tests remain isolated and documented.
- [ ] Packed distribution journeys and recovery/security adversarial suites pass for every released package.

## Sources informing this plan

- [VLD Platform expansion research](PLATFORM-EXPANSION-RESEARCH.md) — architecture rationale and ecosystem research.
- [VLD optional platform-extension ADR](adr/0002-optional-platform-extensions.md) — existing module/workflow/store boundary.
- [Spec Kitty multi-agent orchestration](https://github.com/spec-kitty/spec-kitty/blob/main/docs/architecture/multi-agent-orchestration.md) — host/provider separation and validated lifecycle ownership.
- [Spec Kitty Git worktree architecture](https://github.com/spec-kitty/spec-kitty/blob/main/docs/architecture/git-worktrees.md) — lane isolation and cross-mission caveat.
- [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) — self-hosted agent control center and sandbox/workspace trade-offs.
- [Agent Client Protocol TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) — ACP v1/v2 status and protocol boundary.
- [The Update Framework specification](https://github.com/theupdateframework/specification) and [Sigstore Cosign](https://github.com/sigstore/cosign) — signed metadata, digest and trust-root patterns.
