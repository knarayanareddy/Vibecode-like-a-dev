# Research: making VLD a complete developer control plane

**Research snapshot:** 31 October 2026
**Question:** Can VLD grow from a deterministic specification compiler into a one-stop product covering interactive use, agent execution, parallel workspaces, merge control and a governed extension catalog—without losing its deterministic trust boundary?

## Decision in one page

**Yes, it is feasible, but it should be built as a layered VLD Platform rather than as a monolithic “new IDE.”** The sensible product is a local-first **developer control plane**:

1. VLD Core remains the deterministic source of policy, packets, gates and evidence.
2. An optional VLD Runtime owns mission state, agent runs, worktree allocation and merge-queue decisions.
3. A VLD Studio extension/dashboard makes that state interactive in the editor and browser.
4. Pluggable agent and forge adapters talk to external tools through explicit capability contracts.
5. A signed registry evolves the existing locked stores into a safe catalog of inert content and reviewed adapters.

That would address every vertical in the question from one product surface, while deliberately **not** reimplementing a text editor, a model provider, Git hosting or arbitrary plugin execution. Those are commodity systems with large security and maintenance costs. “One stop shop” should mean one place to start, inspect, govern and complete work—not one process that owns every primitive beneath it.

The key architectural rule is non-negotiable:

> **No agent, UI, store or marketplace asset may change VLD Core's policy/packet authority or bypass a verified state transition.**

This is a substantial platform expansion, not a small CLI feature. It is viable because VLD already has much of the correct foundation; the missing components should be added outside its deterministic compiler path. The staged engineering checklist and test gates are in [VLD-PLATFORM-IMPLEMENTATION-PLAN.md](VLD-PLATFORM-IMPLEMENTATION-PLAN.md).

---

## 1. What VLD already has—and why that changes the answer

The premise is not that VLD starts from a plain specification CLI. The current repository already provides the control-plane pieces that most agent runtimes need:

| Existing VLD surface | Current role | Platform implication |
| --- | --- | --- |
| `plan`, `compile`, `verify` | Deterministic profile/policy/overlay → packet pipeline | The runtime must consume a verified packet; it must never regenerate or silently reinterpret it. |
| Requirement IDs, test anchors, drift checks and gates | Structural evidence and regression boundary | A work package can be tied to exact `REQ-` IDs and the merge queue can run the generated checks. |
| Changes, artifacts and evidence links | Reviewed lifecycle and archive controls | A runtime can retain run/review receipts as evidence without replacing `delta.json` or `spec.after.json`. |
| Modules, bundles, lock files and bounded shared stores | Governed optional process material | This is the seed of a registry/catalog, with a stricter trust policy for anything executable. |
| Typed resumable workflows | Human, agent-handoff, validation, approval and gate steps persisted in `.vld/workflows/` | The existing DAG is the right input to a mission/work-package planner. It should not become an arbitrary shell runner. |
| Codex, Claude Code and GitHub Copilot handoffs | Generated handoff files; no model execution in Core | These become first adapters, not evidence that Core should embed provider credentials. |
| MCP server | Agent-facing query surface over the same policy | The runtime and editor can query VLD instead of duplicating selection logic. |
| One-way Kiro and Spec Kit exports | Bounded interoperability views with digest/provenance | The Studio can integrate adopted ecosystems while retaining VLD as the authority. |

In particular, the existing workflow implementation is intentionally safe: executable steps use a small allowlist of VLD commands via argv, while agent handoffs and approvals need explicit evidence. That restriction should be retained. A scheduler belongs in a separate execution plane with its own policy and tests, not in `compile` or `verify`.

---

## 2. External research and lessons worth adopting

This study examined primary-source repository documentation and package metadata on 31 October 2026. It assesses implementation patterns, not vendor productivity claims.

| Area | What the source documents | Design lesson for VLD |
| --- | --- | --- |
| **Host/provider separation** | Spec Kitty states that the host owns workflow state, lane validation and Git-safe mutations; external providers run agents through a host API. Its core does not need an in-core `orchestrate` command. | Separate the authoritative VLD Mission API from replaceable schedulers/model runners. An agent must not mutate a mission JSON file directly. |
| **Parallel worktree execution** | Spec Kitty gives each execution lane a worktree and documents the isolation benefit. It also explicitly warns that lane worktrees do not provide a cross-mission lock for mutations in one primary checkout. | Use worktrees for one mission's work packages, but also implement repository-wide mutation locking and require a separate clone/runner for independent concurrent missions. Do not assume `git worktree` solves all races. |
| **Control center and sandboxes** | OpenHands Agent Canvas presents a self-hosted control center that can switch agent backends and run conversations in local, VM or Docker environments. Its README warns that agents can have full filesystem access and that conversations sharing a host workspace share files. | A dashboard is feasible, but scheduling must allocate a distinct worktree and, when policy requires it, a distinct sandbox per run. The UI must make the execution boundary visible. |
| **Interactive agent permissions** | OpenCode distinguishes a full-access build agent from a read-oriented plan agent that denies edits by default and asks before shell commands. | VLD needs explicit capability scopes and approval prompts, not just an “autonomous” checkbox. Planning, editing, command execution, network access, push and merge are distinct grants. |
| **Editor/agent interoperability** | The Agent Client Protocol (ACP) TypeScript SDK describes a standard protocol between code editors and coding agents. Its v1 entry point is stable; v2 is explicitly experimental. | Implement ACP v1 as an optional runtime adapter/client boundary after validating capability negotiation. Do not make experimental ACP v2 a product baseline. Retain process-based handoffs for non-ACP agents. |
| **Git UX is a product in its own right** | GitButler provides stacked/parallel branches, conflict handling, forge integration and an operation timeline; its workspace-model documentation describes graph mutations as more involved than a linear rebase. | Start VLD's merge experience as a conservative queue built on ordinary Git/PRs. Do not try to build a general Git graph editor or a GitButler replacement. |
| **IDE distribution** | The VS Code extension manager is separately packaged; Tauri provides a cross-platform desktop application route. | A VS Code extension plus local dashboard is the lowest-risk interactive path. A Tauri desktop shell should be optional and later, not a prerequisite for useful UI. |
| **Registry trust** | TUF is a standard update-framework specification; Sigstore/Cosign demonstrates digest-based signing, identity verification and transparency-log approaches for artifacts. | Use signed index metadata and content digests from the first public catalog. Do not turn a Git URL into an executable extension source. |
| **What not to adopt blindly** | Continue's repository announces it is read-only/no longer actively maintained. | Do not choose an archived IDE-agent codebase as VLD's product foundation. Build a narrow extension over VLD's own stable contracts. |

### Source-specific observations

#### Spec Kitty is the closest orchestration reference

Its [multi-agent orchestration design](https://github.com/spec-kitty/spec-kitty/blob/main/docs/architecture/multi-agent-orchestration.md) is especially relevant. It keeps mission state with the host and makes automation call a constrained host API for `start-implementation`, `start-review`, transitions, history, acceptance and merge. It also recommends independent implementation/review agents and deterministic fake-agent end-to-end testing before enabling real agent CLIs.

Its [worktree document](https://github.com/spec-kitty/spec-kitty/blob/main/docs/architecture/git-worktrees.md) contributes an important caution often skipped in product plans: worktrees share the Git database and are not enough to protect independent missions that concurrently mutate the primary checkout. VLD should improve on that by making its lock scope explicit from day one.

#### OpenHands and OpenCode make the safety bar clear

[OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) demonstrates the desired “mission control” experience: a local/self-hosted control center, pluggable agent backends, long-running automation and optionally separate Docker environments. Its warning about direct host filesystem access is a reason to make isolation/policy a first-class VLD feature rather than a setup note.

[OpenCode](https://github.com/anomalyco/opencode) demonstrates two smaller but useful UX choices: selectable agents and plan-vs-build permissions. VLD should adopt the permission model, not attempt to copy an agent's provider/model stack.

#### ACP is the portable agent boundary; MCP remains the query boundary

The [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) is Apache-2.0 licensed and publishes a stable v1 entry point. It is suitable for interoperable live-session control where both the agent and editor support ACP. VLD's current MCP server solves a different problem: giving an agent safe access to VLD policy/packet context. A full platform should support both:

- **MCP:** agent asks VLD for requirements, selected practices and current packet facts.
- **ACP/process adapter:** VLD Runtime starts/observes an agent session that works in an allocated workspace.

The two protocols are complementary; neither should be overloaded to become a state database.

---

## 3. Recommended product architecture

### 3.1 Make VLD a layered product, not a monolith

```text
┌──────────────────────────────── VLD Studio ────────────────────────────────┐
│ VS Code extension / local browser cockpit                                  │
│ packet + requirements | mission board | worktree diff | approvals | gates │
└──────────────────────────── authenticated local RPC ───────────────────────┘
                                      │
┌──────────────────────────────── VLD Runtime ───────────────────────────────┐
│ Mission state machine · scheduler · run ledger · worktree manager          │
│ review/merge queue · policy/approval engine · adapter supervisor           │
│  ├─ ACP adapter       ├─ local process adapter       ├─ Docker/VM adapter  │
│  └─ GitHub/forge adapter                             └─ notification hook │
└──────────────────────────── uses, never alters ────────────────────────────┘
                                      │
┌────────────────────────────────── VLD Core ────────────────────────────────┐
│ profile + policy + overlays → verified packet → anchors/gates/evidence      │
│ deterministic plan / compile / verify · modules · stores · artifacts · MCP │
└────────────────────────────────────────────────────────────────────────────┘
                                      │
┌──────────────────────────── Repository and providers ──────────────────────┐
│ Git + worktrees · CI · GitHub/GitLab PRs · chosen coding agents · models   │
└────────────────────────────────────────────────────────────────────────────┘
```

**Core stays dependency-light and deterministic.** Runtime, Studio and optional adapters can have their own packages and release cadence. They may be shipped as a coordinated `vld platform` bundle, but failure or absence of those extras must not make `vld compile` nondeterministic or network-dependent.

### 3.2 Authoritative state vs operational state

This boundary prevents a dashboard from becoming a second source of truth.

| Data | Location | Authority | Retention |
| --- | --- | --- | --- |
| Profile, overlays, packet, changes, reviewed artifact links | Current repository artifacts | **VLD Core** | Committed/reviewed per existing lifecycle |
| Mission/work-package declaration, target branch, allowed requirements, resource claims | Versioned `vld-mission.json` (or an equivalent declared artifact) | **VLD Core validation + human review** | Committed; digest recorded in every run |
| Runtime allocation, heartbeats, process IDs, stream offsets, temporary worktree paths | `.vld/runtime/` or a local runtime database, ignored by Git | **VLD Runtime** | Local/remote operational retention; never packet authority |
| Append-only run/review/merge receipt | Runtime ledger plus a selected evidence link/attestation when required | Runtime writes receipt; Core verifies selected evidence references | Retain immutable digest/reference, not raw secrets or full model transcripts by default |
| UI layout, filters and local tokens | User-local config/keychain | Studio only | Never checked in |

A SQLite-backed local ledger is a reasonable option because the Node 22 runtime examined supports experimental `node:sqlite`; VLD's declared Node 20+ floor does not by itself guarantee that facility. VLD should first hide storage behind a `MissionStore` interface and support a JSONL test implementation. It should not couple the mission model to an experimental runtime API.

### 3.3 The mission state machine

A small, validated state machine is more valuable than prematurely sophisticated automation.

```text
planned
  -> ready                 (packet is verified; work packages have REQ links)
  -> allocated             (host has assigned a clean workspace and lease)
  -> running               (adapter reports a live run)
  -> changes_ready         (agent submits immutable candidate commit/result)
  -> verifying             (host runs declared checks in a clean environment)
  -> in_review             (different reviewer or human receives candidate)
  -> approved              (review/evidence policy is satisfied)
  -> queued                (candidate frozen at SHA and awaits target branch)
  -> merged                (forge/local merge receipt verified)

running / verifying / in_review -> blocked
in_review -> allocated          (rework; a new candidate SHA is required)
queued -> verifying             (target moved; rebase/integration check needed)
```

Rules that should be enforced by the host, not prompts:

- Every work package names allowed `REQ-` IDs, dependency IDs, an execution policy and an expected output/ref.
- A run gets a short-lived lease. A stale heartbeat returns the package to `ready` only after a recorded recovery decision.
- An agent may submit a candidate; it cannot mark itself approved or merged.
- Transitions include actor identity, policy digest, packet digest, worktree/commit IDs and result digest.
- Work package completion must include the existing VLD gate/check result and any required artifact/review evidence.
- Direct edits to runtime files do not transition state. Only the Runtime API does.

This intentionally mirrors the valuable host/provider split documented by Spec Kitty while retaining VLD's stricter policy/packet authority.

---

## 4. How each missing vertical should be implemented

### A. Interactive IDE: build **Studio**, not a fresh editor

**Recommended first surface:** a VS Code extension that contributes a VLD activity bar, command palette commands and a WebView dashboard; it communicates with a locally started VLD Runtime. It should open the user's real files/diffs in VS Code rather than embed a second editor.

Studio's first useful views are:

1. **Mission overview:** profile risks, packet digest, active change, requirements and gates.
2. **Work board:** packages by state, agent identity, lease/heartbeat, dependencies and blockers.
3. **Run inspector:** streamed tool/status events, approval requests, redacted errors and links to the exact worktree/commit.
4. **Evidence/review panel:** test/gate results, artifact coverage and immutable candidate SHA before approval.
5. **Merge queue:** target head, candidate order, required checks, rebase status and human release approval.
6. **Catalog/store panel:** locked source, candidate diff, signer/identity, exact acknowledgement required for update.

The local service must bind loopback only, use a per-launch random token, verify `Origin`, and never expose an unauthenticated filesystem/command API to browser code. The extension should request privileged actions through Runtime policy, not call `git` or spawn agents itself.

**Do not do first:** fork VS Code, build a code editor, embed a model chat product, or make the browser UI the authority. A later Tauri shell can package the same web UI for users who prefer a standalone desktop control center, but it should reuse the local RPC contract.

### B. Native concurrent-agent scheduler: own the state machine, not the model

Add an optional `vld runtime` with a narrow adapter contract, conceptually:

```text
capabilities() -> { plan, edit, shell, stream, cancel, reconnect, sandbox }
start(runSpec) -> runId
observe(runId) -> ordered events
cancel(runId) -> receipt
```

`runSpec` must be typed, not a shell command string. It contains:

- immutable mission/work-package ID and packet digest;
- allocated workspace path and branch/ref;
- approved task prompt assembled from VLD-owned inputs;
- explicit capability grants and resource limits;
- an environment-variable **allowlist**, never a copied parent environment;
- adapter/model identity and a non-secret configuration reference.

Start with two adapters:

1. **Process adapter** for an installed local coding-agent CLI. It uses `execFile`/spawn with an argv array, a command allowlist and structured event capture; no `sh -c`.
2. **ACP v1 adapter** for agents that advertise compatible capabilities. Capability negotiation is mandatory. ACP v2 must remain opt-in/experimental until the protocol and test coverage settle.

The scheduler itself should be deterministic about package readiness, dependencies, leases, concurrency limits and retries. The model's choice of edits is probabilistic, but state ownership must not be.

A model/provider SDK should not be added to VLD Core. Users may supply their existing Claude Code, Codex, OpenCode or ACP-compatible agent credentials through that tool's normal configuration. VLD records a non-secret provider/run identity and receipts, not API keys or raw credentials.

### C. Worktree allocator: make isolation and cleanup real

Implement `vld workspace` as a narrow Git worktree manager, not as a generic shell automation feature.

**Create preconditions**

- Repository is Git-backed and target ref resolves to an immutable commit.
- Primary checkout is clean, or the operator provides an explicit isolated-run policy.
- Runtime obtains a repository mutation lock before `git worktree`, branch or ref operations.
- Branch name is derived from a collision-resistant mission/package ID, e.g. `vld/<mission>/<package>`.
- Worktree path is under a runtime-managed directory that is excluded from accidental commit discovery.

**Allocation records** include worktree path, source SHA, branch, package ID, holder/run ID, expiration, allocated-file intents and cleanup policy. A shared path cannot be allocated twice. Package file globs/code-owner areas can make collisions visible before assignment, but must be described as advisory: two tasks can conflict semantically even if their file sets do not overlap.

**Cleanup preconditions**

- Worktree must be clean and candidate refs preserved/archived, or an explicit human `--discard` confirmation is required.
- Removal records a receipt and calls `git worktree prune` only as a cleanup action; it must not erase unresolved work automatically.
- A crashed process is recovered by inspecting Git state and a stale lease, not by blindly deleting a directory.

For cross-mission parallelism, the first release should schedule only one mutation-capable mission per clone. A remote runner or a separate clone is the correct escalation path. This directly addresses the concurrency caveat in Spec Kitty's own worktree documentation.

### D. Merge-lane manager: a conservative queue, not autonomous `main`

A safe VLD merge manager can offer one-stop completion without becoming a forge replacement.

1. Agent creates a candidate commit in its worktree; it does **not** push or merge protected branches by default.
2. Runtime freezes `{candidate SHA, packet digest, policy digest, target SHA}` and runs VLD/project checks in a clean integration worktree or CI.
3. A separate reviewer agent or human attaches review evidence. Required VLD artifacts/gates must pass.
4. `vld merge enqueue` creates/updates a PR through a provider adapter, or prepares a local merge candidate. The branch-protection/approval rules of the forge remain authoritative when one exists.
5. Just before merge, Runtime compares the target head. If it moved, it rebuilds the integration candidate and reruns declared checks; the old approval does not silently apply to a different SHA.
6. Only an approved, exact-SHA candidate is merged; Runtime writes a receipt with merge commit/PR URL/check digests and updates the mission state.

Start with a generic local-Git adapter and a GitHub PR adapter. GitLab/Bitbucket should be later adapters behind the same forge interface. Never rely on the user's globally configured `gh` credentials as a hidden product dependency; use an explicit provider configuration and least-privilege token/keychain reference when remote automation is enabled.

### E. Marketplace-scale catalog: evolve stores, but make execution much stricter

VLD's current stores already do several things a safe catalog needs: pinned Git snapshots, digest validation, candidate diff preview and exact-commit acknowledgement. Build the public catalog in two separate tiers.

| Tier | Permitted payload | Installation/verification policy |
| --- | --- | --- |
| **Content catalog (first)** | Markdown guidance, JSON modules/bundles, typed templates, workflow declarations, test fixtures and export schemas | Canonical manifest; content digest; publisher identity/signature; policy-compatible schema validation; explicit lock and reviewed update. No executable hook. |
| **Adapter catalog (later)** | Agent, forge, sandbox or notification adapters | Signed package plus provenance; separate process boundary; declared capabilities; explicit local enablement and version/digest lock. Never load third-party JavaScript into Core's process. |

A useful registry manifest should bind name, version, normalized content digests, compatible Core API range, publisher identity, signature/bundle, license, required capabilities and revocation/replacement data. The client should pin a root of trust and validate threshold-signed index metadata; a TUF-inspired role/update model is appropriate. Sigstore-style identity/transparency verification can be offered where operating environments support it, but offline digest/signature verification must remain possible.

**Do not ship an arbitrary plugin marketplace first.** Node code loaded into the CLI has the user's filesystem, Git and possibly agent credentials. A code-bearing adapter must execute out-of-process and be given a deliberately small RPC/capability token. Content-only assets must remain unable to influence Core policy/packet/compiler or run arbitrary workflow commands.

---

## 5. Security, governance and operational requirements

A one-stop shop increases the blast radius. The following requirements are baseline, not polish.

| Threat or failure mode | Required design response |
| --- | --- |
| Prompt injection in issue text, repository files or a catalog asset | Treat all task/repository/catalog text as untrusted data. Only the Runtime creates commands, transitions and capability grants. The agent cannot convert text into broader permissions. |
| Agent deletes files, exfiltrates secrets or runs unexpected commands | Capability policy separates read, edit-worktree, command class, network, secrets, push and merge. Default plan mode is read-only. Use sandbox adapters for elevated/networked work; log grants and approvals. |
| Two agents edit one checkout or state interleaves | Allocate one worktree per package, use repository/mutation locks, leases and host-validated transitions. Use separate clones/runners for separate concurrent missions. |
| Agent self-approves/merges its own output | Actor separation in state machine; human or independently configured reviewer; immutable candidate SHA; merge policy check. |
| Target branch advances after validation | Recreate/rebase integration candidate and rerun checks; approvals bind to candidate and target SHAs. |
| Malicious/compromised marketplace item | Signed/digested locks, reviewed candidate diff, local trust policy, revocation, no arbitrary in-process code. |
| Runtime UI becomes an exposed local RCE endpoint | Loopback/Unix socket only; random launch token; origin checking; no broad CORS; privileged operations require server-side policy and user confirmation. |
| Credentials leak through logs or receipts | Credential references and environment allowlist only; redaction before persistence; short retention for raw streams; no token values in Git artifacts. |
| Provider outage / runtime crash | Durable append-only event receipts, idempotency keys, leases, explicit recovery/reconciliation commands, and no implicit destructive cleanup. |
| Deterministic compiler becomes model-dependent | Keep model execution, network calls and runtime state out of plan/compile/verify. Test that Core works with Runtime/Studio absent. |

The risk tier already computed by VLD should control runtime defaults. For example, a high-risk profile could require sandboxing, a human approval before write, an independent reviewer, a protected-branch PR and a release-evidence artifact; a low-risk profile could permit one local agent in a worktree after explicit operator start. This makes VLD's existing policy engine a differentiator instead of a document generator.

---

## 6. Delivery plan and acceptance criteria

### Phase 0 — Charter the boundary before implementation

Create an ADR that explicitly approves an optional execution plane and documents:

- Core/Runtime/Studio trust boundaries and the no-model-in-Core rule;
- actor and capability policy model;
- local-vs-remote state/telemetry policy;
- provider credential ownership and log-redaction rules;
- Git/forge mutation authority and recovery behavior;
- third-party catalog scope and signing/revocation model.

**Exit criterion:** a threat-model review approves the boundary and a fake-agent test plan exists. Do not add a runtime dependency or agent SDK before this ADR.

### Phase 1 — Repo-native mission and worktree foundation

Deliver a declared mission/work-package schema with `REQ-` links, dependency graph, policy digest and state-machine validation. Add a local `vld workspace create|status|recover|remove` manager with repository locking, safe cleanup and fake-Git tests.

**Exit criteria:**

- A no-agent, no-network path creates and recovers worktrees deterministically.
- Parallel packages cannot receive the same workspace/branch.
- Invalid/stale state and unsafe cleanup leave Git state untouched.
- A separate-clone rule is enforced or clearly rejected for concurrent mission mutation.
- `npm run check` still proves Core behavior is unchanged.

### Phase 2 — Runtime host and fake-agent scheduler

Introduce `vld runtime` with the state store, loopback-only API, leases, policy evaluation, event receipts and a fake deterministic agent adapter. Add a process adapter behind explicit opt-in; do not call any model from CI.

**Exit criteria:**

- The host alone validates every state transition.
- Restart/recovery is idempotent and tested.
- The same fake-agent fixture produces repeatable state/receipt results.
- Agent output cannot alter packet authority or invoke arbitrary host shell commands.
- Secret-redaction and environment allowlist tests pass.

### Phase 3 — VLD Studio for VS Code and browser cockpit

Build the Studio extension over the local Runtime API. Provide mission board, packet/requirement traceability, worktree navigation, approval prompts and gate views. The browser dashboard should reuse the same API; it is not a second backend.

**Exit criteria:**

- No Studio action bypasses Runtime policy.
- User can inspect the requirement → work package → candidate SHA → gate/review/merge trail in one click chain.
- Studio works with Runtime disabled by falling back to the existing CLI/read-only packet view.
- Local authentication/origin/permission tests pass.

### Phase 4 — ACP and forge/merge adapters

Add ACP v1 capability negotiation and a GitHub PR adapter. Implement the conservative merge queue and temporary integration verification. Keep the current Codex/Claude/Copilot handoffs as supported paths rather than forcing ACP adoption.

**Exit criteria:**

- An adapter cannot request capabilities it did not declare/receive.
- A target-head change invalidates the old merge candidate and reruns checks.
- Default agent credentials cannot push/merge protected branches.
- Review/approval separation is mechanically checked.

### Phase 5 — Curated, signed content catalog

Launch a first-party or tightly curated index containing only inert modules, templates and workflows. Add signature/root-rotation/revocation tests and retain existing store diff/acknowledgement behavior. Adapter publishing comes later, after out-of-process capability isolation exists.

**Exit criteria:**

- Tampered content, expired/revoked metadata and untrusted signers fail closed.
- A catalog update is reviewable before state changes.
- Catalog assets cannot affect Core compiler input or execute commands.

### Phase 6 — Optional desktop, remote runners and broader catalog

Only after the local product has real use, consider a Tauri desktop wrapper, remote runners, sandbox pools, additional forges and signed third-party adapters. These are scale/distribution projects, not prerequisites for a complete local workflow.

---

## 7. Scope decisions: what “one stop shop” should and should not mean

| Desired user outcome | VLD should own | VLD should integrate with |
| --- | --- | --- |
| Start a feature from an idea | Profile/policy selection, packet, mission, work packages, policy and evidence | Existing issue trackers as optional intake adapters |
| See/edit the work interactively | Studio experience, requirements/gates/mission context and safe commands | VS Code/editor file editing and diff UI |
| Run several agents safely | Scheduling policy, workspaces, leases, receipts, approvals and adapter contract | Existing coding agents/models and optional sandbox/container infrastructure |
| Coordinate Git work | Worktree lifecycle, candidate validation, queue state and receipt trail | Git itself; GitHub/GitLab/Bitbucket PRs and branch protection |
| Extend practices/workflows | Signed content catalog, locks, compatibility checks and trust policy | Publisher tooling and optional external registries |
| Use an organization control center | Local-first Runtime/Studio; later self-hosted remote runner | Identity provider, secrets store, CI and chat/notification tools |

The product can therefore honestly say: **“From idea to verified merge, VLD gives you one governed workspace.”** It should not promise: “VLD replaces your editor, Git host, model provider, CI and security platform.” The second promise makes reliability worse, not better.

---

## 8. Recommended next decision

Proceed, but frame the initiative as **VLD Platform / VLD Studio** with the following initial commitment:

> Build a local-first Mission Runtime and VS Code Studio that turn VLD's existing deterministic packet, typed workflows, modules, evidence and gates into an interactive, multi-agent, worktree-isolated path from verified plan to reviewed merge—while Core remains model-free and third-party assets remain governed.

The smallest valuable vertical slice is **not** a marketplace or a custom IDE. It is:

1. verified packet → declared work packages;
2. safe worktree allocation and local mission board;
3. manually started process-agent run with scoped permissions;
4. exact candidate SHA → existing VLD gates → independent review → local/PR merge receipt.

That slice proves the product can complete a change end-to-end. It also establishes the contracts required for ACP, richer UI, remote agents, merge providers and a catalog without giving those layers authority over the compiler.

---

## Sources and research notes

Primary sources inspected on 31 October 2026:

- [VLD README](../README.md) and current `factory/lib/workflows.mjs`, `factory/lib/agents.mjs`, `factory/lib/stores.mjs`, `factory/lib/exports.mjs`, `factory/lib/mcp.mjs` — existing Core and platform boundaries.
- [Spec Kitty multi-agent orchestration](https://github.com/spec-kitty/spec-kitty/blob/main/docs/architecture/multi-agent-orchestration.md) and [Git worktrees architecture](https://github.com/spec-kitty/spec-kitty/blob/main/docs/architecture/git-worktrees.md) — host/provider split, lane states, worktree isolation and cross-mission caveat.
- [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) — self-hosted control center, multiple backends, automations and sandbox/shared-workspace warnings.
- [OpenCode](https://github.com/anomalyco/opencode) — build/plan agent distinction and interactive permissions.
- [Agent Client Protocol TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) and [npm package metadata](https://registry.npmjs.org/%40agentclientprotocol%2Fsdk/latest) — stable ACP v1 and experimental v2 status.
- [GitButler](https://github.com/gitbutlerapp/gitbutler) and [workspace model](https://github.com/gitbutlerapp/gitbutler/blob/master/crates/WORKSPACE_MODEL.md) — parallel/stacked Git UX and graph mutation complexity.
- [VS Code extension manager](https://github.com/microsoft/vscode-vsce) and [Tauri](https://github.com/tauri-apps/tauri) — extension and optional desktop distribution paths.
- [The Update Framework specification](https://github.com/theupdateframework/specification) and [Sigstore Cosign](https://github.com/sigstore/cosign) — registry signing/update and digest-verification models.
- [Continue](https://github.com/continuedev/continue) — repository notice that it is read-only/no longer actively maintained; included as a non-foundation example.

This is an architecture and feasibility study, not a commitment to implement every phase or a claim that external tools improve model output. Any runtime, credential, extension or remote-execution implementation requires its own ADR, threat model and end-to-end tests before release.
