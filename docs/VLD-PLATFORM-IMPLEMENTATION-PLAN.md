# VLD Platform implementation plan

**Status:** Proposed implementation plan — no Mission Runtime, Studio, scheduler, merge manager or signed catalog is implemented by this document.

**Companion research:** [PLATFORM-EXPANSION-RESEARCH.md](PLATFORM-EXPANSION-RESEARCH.md)
**Current baseline:** VLD 0.10.0, deterministic Core with packets, gates, evidence, typed workflows, locked modules/stores, agent handoffs, MCP and bounded exports.

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

- [ ] An operator can create a mission from a **verified** packet and inspect each package's linked `REQ-` IDs.
- [ ] The platform can allocate independent Git worktrees to concurrent work packages without assigning the same workspace/branch twice.
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

The final schema may differ, but these invariants are required:

- [ ] Mission ID and package IDs are stable, normalized and collision-resistant within their scopes.
- [ ] Packet path is project-bounded; packet digest matches a successful `vld verify` result.
- [ ] Every listed requirement exists in that exact packet and is unique per package unless an explicit shared-read dependency is declared.
- [ ] Dependency graph is acyclic and all referenced packages exist.
- [ ] Target is resolved to an immutable commit at mission creation, not merely a mutable branch name.
- [ ] Resource claims are normalized advisory declarations, never shell globs that get executed.
- [ ] Mission creation records selected workflow/change/artifact context by digest/reference, not by copying mutable authority.
- [ ] Mission declaration contains no token, arbitrary command, model prompt override or executable extension.

### 4.3 Implementation checklist

- [ ] Add a pure mission schema/validator and deterministic canonical serializer under Core.
- [ ] Add `vld mission init`, `vld mission validate`, `vld mission status --json` and dry-run/overwrite protections.
- [ ] Build work packages only from a verified packet and explicit human-provided partition/description input.
- [ ] Add an optional `vld mission plan` helper that suggests a partition but writes nothing without explicit confirmation; it must remain deterministic or be visibly marked as external/human-authored.
- [ ] Store mission declaration outside `specs/` and never accept it as Core compiler input.
- [ ] Add requirement-to-work-package coverage reporting, including unassigned and multiply-assigned requirement warnings.
- [ ] Add project-relative path checks and symlink-safe resolution for all mission paths.
- [ ] Document how mission evidence links into the existing change archive without making mission state the archive authority.

### 4.4 Extensive test checklist

**Schema and invariants**

- [ ] Accept a minimal valid mission tied to a verified test fixture packet.
- [ ] Reject missing, changed or malformed packet digest.
- [ ] Reject unknown, duplicate and disabled/removed `REQ-` IDs.
- [ ] Reject duplicate IDs, self-dependencies, dependency cycles and dependencies on absent packages.
- [ ] Reject mutable/unresolved target references and non-40-character commit IDs.
- [ ] Reject absolute/outside-project paths, `..` traversal, symlink escapes and control characters.
- [ ] Reject unknown policy IDs/digest mismatch and secret-like prohibited fields.
- [ ] Verify canonical serialization is byte-stable across key-order variation.

**Lifecycle and compatibility**

- [ ] Assert that `init` refuses to overwrite an existing mission without `--force` and that failed validation writes no partial file.
- [ ] Test mission status after a packet is recompiled with an incompatible digest; status must be stale/blocked rather than silently retargeted.
- [ ] Test packet requirement changes, removed requirements and change archive integration.
- [ ] Test schema version rejection and a deliberate v1-to-v2 migration fixture when a future version is introduced.
- [ ] Add property/fuzz tests over generated package DAGs to verify validator termination and correct cycle detection.

**Core regression**

- [ ] Verify `vld plan`, `compile`, `verify`, `change`, existing workflow commands and generated checkers do not observe a mission unless explicitly invoked.
- [ ] Run `npm run check` and a packed-install Core journey.

**Phase 1 exit:** a reviewed, versioned mission can be created/validated from a verified packet with complete test coverage of all validation branches.

---

## 5. Phase 2 — Safe concurrent worktree manager

### 5.1 Goal

Allocate one isolated Git workspace per work package and make all Git mutations recoverable. This phase supports manual work in a worktree before it supports agents.

### 5.2 Command surface

```text
vld workspace create <mission> <package> [--project .] [--dry-run]
vld workspace status <mission> [--project .] [--json]
vld workspace recover <mission> [--project .] [--json]
vld workspace remove <mission> <package> [--discard --acknowledge <lease-or-worktree-id>]
```

The exact names may change, but every mutating command needs JSON output, dry-run where meaningful, exact target identification and an idempotency/recovery story.

### 5.3 Worktree design checklist

- [ ] Verify the project is a Git worktree/repository and resolve the common Git directory safely.
- [ ] Resolve and store the target commit before allocation; never allocate from a moving branch name alone.
- [ ] Create deterministic-but-unique branch names such as `vld/<mission-id>/<package-id>` after validating they do not collide.
- [ ] Place worktrees under a configurable runtime-managed sibling root; reject a path inside packet, mission source or arbitrary user directory.
- [ ] Create an allocation record: workspace ID, path, branch, base SHA, mission/package IDs, creation time, holder/run ID, lease state and cleanup eligibility.
- [ ] Obtain a repository-wide mutation lock before branch/worktree/ref changes. Use atomic file/directory locking with owner/process/start-time metadata and stale-lock inspection; do not rely on an in-memory mutex.
- [ ] Hold a narrower allocation lock while assigning a package so two Runtime processes cannot allocate it twice.
- [ ] Detect existing `git worktree` registrations and reconcile them before creation/removal.
- [ ] Define a single mutation-capable mission per clone for the first release. Reject or mark blocked a competing mission; document a separate-clone/remote-runner path.
- [ ] Treat resource claim overlap as a warning/policy decision, not proof that packages are conflict-free.
- [ ] Require clean worktree state before normal removal. `--discard` must require an exact allocation acknowledgement and record why work was discarded.
- [ ] Preserve candidate commit/ref and evidence before cleanup; never delete a workspace merely because a process exited.
- [ ] Add `recover` that reconciles state with `git worktree list --porcelain`, branch/ref existence and lease age before deciding anything.

### 5.4 Extensive test checklist

**Git fixture suite**

- [ ] Create temporary bare/origin and working repositories with configured identity, commits, branches and a packet/mission fixture.
- [ ] Create one worktree; assert path, branch, base SHA, allocation ledger and `git worktree list --porcelain` agree.
- [ ] Create two non-conflicting package worktrees; assert uncommitted changes in one never appear in the other.
- [ ] Attempt double allocation of the same package/branch/path concurrently; assert exactly one succeeds and no partial allocation remains.
- [ ] Attempt allocation while a foreign/unknown worktree registration occupies the desired location; assert a clear refusal.
- [ ] Test detached HEAD, absent Git, bare repository, invalid Git directory, unresolved target and dirty-primary policy cases.

**Locking, race and crash tests**

- [ ] Spawn independent Node child processes contending for repository and package locks; verify mutual exclusion, bounded waiting and deterministic loser diagnostics.
- [ ] Simulate a process crash after lock acquisition, after branch creation and after worktree creation. Verify `recover` distinguishes active vs stale state and never performs blind deletion.
- [ ] Test stale lock ownership with PID reuse/unknown PID and require explicit safe recovery semantics rather than assuming a lock is stale solely by elapsed time.
- [ ] Simulate interrupted allocation-record write; verify atomicity or recovery refusal with no hidden orphan.
- [ ] Race `remove`, `recover` and `create`; verify no branch/worktree is removed while an active allocation owns it.

**Cleanup and safety tests**

- [ ] Reject normal removal with staged, unstaged or untracked work; ensure files remain untouched.
- [ ] Require exact `--acknowledge` on forced discard and assert the receipt records base/candidate state.
- [ ] Verify normal removal unregisters the Git worktree and leaves only permitted branch/ref state.
- [ ] Verify cleanup never follows a symlink outside the managed worktree root.
- [ ] Verify a worktree inside the authoritative packet directory and a packet inside a worktree management directory are refused.

**Manual verification**

- [ ] Run two ordinary terminal sessions in separate worktrees and demonstrate independent tests/edits.
- [ ] Run a second mission from a separate clone; document the supported invocation and boundaries.

**Phase 2 exit:** allocation, recovery and cleanup are race-tested and leave no unsafe Git mutation path; manual development can use work packages end to end.

---

## 6. Phase 3 — Mission Runtime host and state machine

### 6.1 Goal

Introduce an optional local Runtime that owns transitions, leases, receipts and a loopback-only API. Use a fake deterministic adapter first; do not start real agents yet.

### 6.2 Runtime responsibilities

- [ ] Load and validate a mission against the current verified packet/policy before scheduling.
- [ ] Calculate package readiness from dependency states and policy.
- [ ] Enforce the state machine: `planned → ready → allocated → running → changes_ready → verifying → in_review → approved → queued → merged`, plus controlled `blocked`/rework transitions.
- [ ] Mint a unique run ID and lease on allocation; track heartbeats, expiration and owner identity.
- [ ] Append canonical events and immutable receipts; derive views/status from the event ledger rather than trusting an editable UI state field.
- [ ] Enforce idempotency keys on mutating API calls so retries do not duplicate allocations/transitions.
- [ ] Expose a local JSON API/event stream for Studio only after authentication/authorization checks.
- [ ] Bind only to loopback (or a local socket where supported); generate a per-launch secret token; do not provide a LAN listener by default.
- [ ] Stop gracefully: reject new work, wait/cancel according to policy, flush ledger and release only owned leases.

### 6.3 API contract checklist

- [ ] Specify versioned JSON request/response envelopes with `requestId`, `ok`, stable `errorCode` and redacted diagnostic fields.
- [ ] Specify read endpoints for mission, package, run, receipt, lock and health state.
- [ ] Specify mutation endpoints for allocate, heartbeat, submit-candidate, transition, approve, block, recover and shutdown.
- [ ] Require expected state/version/lease token for every mutation to prevent lost updates.
- [ ] Return no arbitrary host path, environment or raw secret in error bodies.
- [ ] Publish JSON fixtures as contract tests; avoid generated API behavior that changes undocumented fields.

### 6.4 Extensive test checklist

**Transition matrix**

- [ ] Test every legal state transition and all illegal source/target pairs.
- [ ] Test every transition under each relevant actor role, including self-review/self-merge denial.
- [ ] Test dependency readiness, cancellation, blocking, rework and terminal-state immutability.
- [ ] Test expected-version and idempotency-key replay behavior.
- [ ] Test a package cannot be allocated with an invalid/stale packet or policy digest.

**Durability and recovery**

- [ ] Restart Runtime at every transition point and assert rehydrated state/receipts match pre-restart state.
- [ ] Simulate truncated/corrupt event tail; verify fail-closed diagnosis and non-destructive repair/recovery command.
- [ ] Test duplicate, out-of-order and malformed adapter events; preserve monotonic sequence/receipt rules.
- [ ] Test clock skew/expired heartbeat and ensure a package never receives two live leases.
- [ ] Test graceful stop, forced kill and orphaned process recovery.

**Local API security**

- [ ] Reject non-loopback bind configuration unless an explicit future remote mode is enabled.
- [ ] Reject missing, wrong, expired and reused tokens.
- [ ] Test Origin checks and CORS denial using browser-like requests.
- [ ] Fuzz JSON bodies, oversized payloads and unknown methods; verify bounded error behavior/no crash.
- [ ] Test that API read responses redact environment, secret references and unsafe raw agent output.

**Phase 3 exit:** deterministic fake runs can be allocated, advanced, recovered and inspected through a secured local API with all transitions host-validated.

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

- [ ] Define adapter capability names: `read_workspace`, `write_workspace`, `run_declared_commands`, `network`, `stream_events`, `cancel`, `reconnect`, `sandbox` and any future capability only after ADR review.
- [ ] Implement a fake adapter with scripted, deterministic event sequences for all normal CI tests.
- [ ] Implement a local-process adapter with direct argv spawning (`spawn`/`execFile` semantics), binary allowlist and absolute/validated executable resolution. Never use `sh -c`, `eval` or interpolated command strings.
- [ ] Construct agent context from VLD-controlled packet/work-package material; record a prompt/context digest rather than persisting sensitive raw content by default.
- [ ] Pass only a strict environment allowlist and explicitly referenced credential handles; never inherit the whole parent environment by default.
- [ ] Set working directory to the allocated worktree and validate it immediately before launch.
- [ ] Enforce duration, output-size, process-tree and retry limits; record timeout/cancellation receipts.
- [ ] Keep agent write authority limited to the worktree. Git push and merge are distinct disabled-by-default capabilities.
- [ ] Make `plan`/analysis modes read-only when the adapter supports them.
- [ ] Preserve current `vld agent install` handoffs and document that handoff mode does not imply Runtime execution.

### 7.4 ACP v1 adapter checklist

- [ ] Add ACP only in a separate optional package/dependency boundary.
- [ ] Use the stable ACP v1 API/entry point; reject/disable experimental v2 features by default.
- [ ] Perform capability negotiation and reject a requested run when peer capabilities do not satisfy policy.
- [ ] Map ACP sessions/events into VLD's normalized run/event/receipt model without allowing peer events to transition mission state directly.
- [ ] Use protocol fixtures and a fake ACP peer for normal CI; do not require a proprietary agent account.
- [ ] Document fallback to local-process/handoff adapters for non-ACP agents.

### 7.5 Extensive test checklist

**Process adapter**

- [ ] Use fixture executables that succeed, fail, exit before stream setup, ignore termination, emit huge output, emit malformed structured events, remain silent and spawn a child process.
- [ ] Verify argv is preserved as discrete arguments; malicious task/package text cannot inject a shell flag or second command.
- [ ] Verify CWD is the assigned worktree and attempts to substitute another CWD are refused.
- [ ] Verify policy denial occurs before process spawn for missing write/network/command capability.
- [ ] Verify only allowlisted environment keys reach the fixture; seed secret environment variables in the parent and assert they are absent.
- [ ] Verify output is size-bounded/redacted and that raw token-like strings do not appear in receipts/API responses.
- [ ] Verify timeout/cancel terminates the entire process group where supported, leaves a durable receipt and releases/reconciles lease safely.
- [ ] Verify retry policy does not duplicate candidate submission and stops at budget.

**Agent workflow safety**

- [ ] Fake an agent attempting to submit a candidate for a different package/worktree; reject it.
- [ ] Fake an agent attempting direct `approve`, `queue`, `merge` or policy broadening; reject it.
- [ ] Fake a candidate with wrong base/branch, uncommitted workspace or unknown SHA; reject it.
- [ ] Verify human/independent reviewer evidence is mandatory for policies that require it.
- [ ] Verify a Runtime-disabled project still uses the existing handoff workflow successfully.

**ACP**

- [ ] Test v1 initialization/capability negotiation success and missing-capability rejection.
- [ ] Test malformed, unknown, duplicate and out-of-order protocol messages.
- [ ] Test session reconnect/cancel behavior and conversion of peer errors to stable VLD errors.
- [ ] Assert v2/unstable imports/features are not selected by default.

**Optional manual live tests**

- [ ] Run each supported installed agent CLI in an ephemeral fixture repo with a disposable credential/account and fixed spend/time budget.
- [ ] Record command/version/model/configuration without recording credentials; retain raw output only in a protected local result location.
- [ ] Verify the same user journey through an ACP-capable peer when one is available.

**Phase 4 exit:** a fake and one real opt-in local-process agent can complete a scoped work package without Core model calls or broad credential inheritance; ACP v1 is separately contract-tested if released.

---

## 8. Phase 5 — Verification, independent review and merge-lane manager

### 8.1 Goal

Turn a candidate commit into a frozen, independently reviewed and revalidated merge candidate. Start conservative: local Git integration and an optional GitHub PR adapter; never claim to replace forge branch protection.

### 8.2 Candidate and receipt contract

- [ ] Freeze `{missionId, packageId, candidateSha, baseSha, targetRef, targetSha, packetDigest, policyDigest, adapterRunId, generatedAt}` when an agent submits work.
- [ ] Reject candidate SHA that is not reachable from the package's allocated branch/worktree according to policy.
- [ ] Define declared verification commands as policy/packet-derived structured argv, not agent-supplied shell strings.
- [ ] Store check results with command identity, exit code, output digest/redacted summary, environment class and candidate/target SHA.
- [ ] Bind review approval to candidate SHA, target SHA, policy digest and reviewer identity; invalidate it on any material change.
- [ ] Emit a final merge receipt with local merge commit or forge PR/merge identifier, target result SHA and linked evidence references.

### 8.3 Merge queue checklist

- [ ] Create a temporary integration worktree from the frozen target SHA under Runtime control.
- [ ] Integrate the exact candidate commit using a selected safe strategy; record conflict/error result rather than asking an agent to silently resolve it.
- [ ] Run VLD packet checkers/gates and project-declared checks in the integration worktree.
- [ ] Transition to `in_review` only after required checks complete; transition to `approved` only through role/policy validation.
- [ ] Queue approved candidates in a deterministic order with explicit dependency/order policy.
- [ ] Re-read target SHA immediately before merge. If changed, discard prior integration result, return to verifying and create a new candidate tuple.
- [ ] Local Git adapter may create a merge commit only when explicit policy permits. Default branch push must be opt-in.
- [ ] GitHub adapter creates/updates a PR, reads permitted status/review facts and requests merge only when both VLD policy and GitHub authorization/branch protection permit it.
- [ ] Keep provider credentials in OS keychain/explicit secret reference; never use an accidental global `gh` session as an implicit product credential.
- [ ] Make queue cancellation/retry/manual takeover idempotent and receipted.

### 8.4 Extensive test checklist

**Local integration worktree**

- [ ] Verify a clean candidate integrates and all VLD/project fixture checks run in the integration workspace, not the primary/work-package workspace.
- [ ] Verify one failing gate/check blocks transition and preserves diagnostic digest/summary.
- [ ] Verify merge conflict blocks automatically; no agent is asked to resolve it without a new explicit allocation.
- [ ] Verify candidate SHA mismatch, rewritten branch history and wrong base SHA are refused.
- [ ] Advance target after verification; assert approval is invalidated, a new integration candidate is required and old receipt remains immutable.
- [ ] Queue two candidates that touch disjoint/overlapping areas; assert deterministic ordering and target revalidation after the first merge.
- [ ] Simulate crash before/after integration branch creation, check execution, merge and receipt write; assert recovery is idempotent and no double merge occurs.

**Approval and authorization**

- [ ] Reject implementation actor approving its own candidate under independent-review policy.
- [ ] Test allowed explicitly low-risk exception only with a human approval receipt and visible status.
- [ ] Reject direct agent adapter merge request regardless of candidate status.
- [ ] Test revoked/expired approval, altered evidence and altered packet/policy digest rejection.

**GitHub provider contract**

- [ ] Test provider requests/responses against recorded/mock fixtures for PR create/update, head SHA, checks, reviews, mergeability and merge result.
- [ ] Reject responses missing expected repository/branch/SHA identity.
- [ ] Test rate-limit, auth failure, network timeout, ambiguous merge result and webhook replay handling.
- [ ] Use an optional manually triggered ephemeral GitHub repository test with least-privilege test credentials; never run it in ordinary CI.
- [ ] Verify GitHub branch protection remains an external enforcement point even if VLD incorrectly requests a merge.

**Phase 5 exit:** merges are exact-SHA, revalidated, independently approved and recoverable; all local paths are deterministic and provider paths are contract tested.

---

## 9. Phase 6 — VLD Studio (VS Code extension and local dashboard)

### 9.1 Goal

Deliver the interactive one-stop surface over Runtime's local API. Studio displays/requests actions; Runtime remains the authority.

### 9.2 UX scope checklist

- [ ] Add a VS Code activity-bar view or command entry point for VLD Studio.
- [ ] Add a read-only packet/requirements view showing packet digest, selected policies, status and direct file links.
- [ ] Add a mission board showing package state, dependencies, resource-claim warnings, current worktree, agent/run identity and lease health.
- [ ] Add a run inspector with structured events, bounded/redacted logs, command/check status and clear blocked/error causes.
- [ ] Add approval UI that displays precisely requested privilege/candidate/target digest and requires an explicit operator decision/reason when policy requires it.
- [ ] Add evidence/review view joining `REQ-` IDs, candidate SHA, gate results, artifact coverage and reviewer receipt.
- [ ] Add merge queue view showing target movement, queue order, verification status and forge link where available.
- [ ] Add store/catalog view that reuses existing diff/acknowledgement semantics; it must never hide source digest or force update.
- [ ] Provide a browser dashboard using the same Runtime API/authorization model, not a parallel backend.
- [ ] Support accessibility basics: keyboard traversal, focus management, readable status text and non-color-only state.
- [ ] Display degraded/read-only state clearly when Runtime is absent; preserve existing CLI workflows.

### 9.3 Studio security checklist

- [ ] Studio obtains Runtime connection information/token through a local trusted channel; tokens are never embedded in committed workspace configuration or WebView HTML.
- [ ] WebView uses a strict content-security policy, nonce-based scripts and narrow message validation.
- [ ] Studio never executes Git/agent commands directly; it asks Runtime to evaluate a typed request.
- [ ] Studio never renders agent/model output as trusted HTML; sanitize/escape all content.
- [ ] Browser dashboard is loopback-only in local mode, validates Origin and has no permissive CORS wildcard.
- [ ] Privileged buttons always display the exact action and policy effect; disable actions that Runtime says are unauthorized.

### 9.4 Extensive test checklist

**UI unit/contract**

- [ ] Test rendering of every package state, blocked reason, missing Runtime, stale packet and revoked token response.
- [ ] Test client request encoding against Runtime JSON fixtures and all stable error codes.
- [ ] Test a UI cannot create a transition that Runtime rejects; UI should refresh from authoritative state.
- [ ] Test requirement/candidate/receipt trace links point to the exact IDs/SHAs, including long values and missing/deleted paths.

**WebView/browser security**

- [ ] Test escaping of hostile agent output including HTML, script tags, markdown links, Unicode controls and fake approval text.
- [ ] Test Content Security Policy, rejected unknown `postMessage` messages and token non-disclosure in logs/UI errors.
- [ ] Test loopback Origin/CORS behavior from an unauthorized browser origin.

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

- [ ] Restrict v1 payload types to Markdown guidance, JSON modules/bundles, typed artifact templates, workflow declarations, test fixtures and export schemas.
- [ ] Define canonical catalog package manifest: name, version, license, Core compatibility range, payload paths/digests, publisher identity, signature/bundle, release timestamp, replacement/revocation metadata and capabilities (`content-only` for v1).
- [ ] Define a root-of-trust file and threshold/key-rotation process. Use a TUF-inspired signed-index design; do not implement ad hoc unsigned update discovery.
- [ ] Verify content digest, signature/trust policy, schema and compatibility before any copy/install/enable action.
- [ ] Reuse and preserve the existing candidate diff + exact acknowledgement update flow.
- [ ] Lock catalog package identity/version/digests in the consuming project and include provenance in copied artifacts/exports.
- [ ] Support offline verification from a previously trusted root/index/cache where possible.
- [ ] Reject expired, revoked, untrusted or malformed metadata without mutating local locks/content.
- [ ] Make publisher identity, content digest and trust decision visible in CLI/Studio.

### 10.3 Executable adapters: deferred boundary checklist

- [ ] Do not accept executable adapters in catalog v1.
- [ ] Before admitting adapters, design a separate-process RPC protocol, explicit capability grants, version/digest pinning, installation isolation, crash containment and revocation/disable behavior.
- [ ] Prove an adapter process cannot import or mutate Core compiler policy/packet internals directly.
- [ ] Require explicit local enablement for every executable adapter even if a catalog signature is trusted.
- [ ] Add an adapter provenance/permission review view before any production adapter catalog launch.

### 10.4 Extensive test checklist

**Cryptographic and metadata validation**

- [ ] Verify valid signed index/package fixtures install successfully and produce exact locks.
- [ ] Reject altered payload digest, altered manifest, invalid signature, unknown key, insufficient signature threshold, expired metadata, wrong version, revoked artifact and incompatible Core range.
- [ ] Test root/key rotation, rollback/freeze attack detection and offline cached verification fixtures.
- [ ] Verify canonical serialization rules so signature verification is not dependent on JSON key ordering.

**Content safety**

- [ ] Feed catalog content containing shell snippets, path traversal paths, symlinks, oversized files, malformed JSON and malicious Markdown; verify it is inert, bounded and rejected/safely rendered according to type.
- [ ] Assert catalog workflows cannot introduce arbitrary `run` commands beyond VLD's typed/allowlisted workflow rules.
- [ ] Assert catalog modules/templates cannot become compiler inputs or mutate a packet without the explicit existing Core flow.
- [ ] Test diff preview has no project mutation and update refuses any commit/index that differs from the acknowledged target.

**Supply-chain/release**

- [ ] Use independent test keys and fixtures; never commit private signing keys.
- [ ] Run a packed-install journey that validates catalog verification with no network after fixture cache preparation.
- [ ] Add an incident runbook: revoke, quarantine, pin rollback, audit affected locks and rotate trust metadata.

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
| M7: ACP + GitHub adapter | Portable sessions and remote PR flow | Adds integrations to a tested host contract | Team/remote use |
| M8: Signed content catalog | Curated extension distribution | Builds on existing stores without executable plugins | Future adapters catalog |
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
