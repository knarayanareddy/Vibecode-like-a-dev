# ADR-0003: Mission foundation is versioned Core data; runtime execution remains optional

**Status:** accepted

## Context

VLD now has deterministic packets, requirement anchors/gates, typed workflows, reviewed evidence, locked modules/stores and agent handoffs. To take a project from a verified packet through parallel work and reviewed merge, it needs a durable way to declare bounded work packages and freeze the packet/Git authority that later automation must respect.

The risk is turning a compiler into an unbounded agent runner. An editable task file must not gain the ability to execute arbitrary shell commands, invoke models, inherit credentials, mutate Git branches or mark its own work as approved. The existing Core path (`plan -> compile -> verify`) must remain portable, reproducible and usable without a Runtime, UI, provider account or network.

## Decision

### 1. A mission is a versioned declaration, not a runtime or agent

VLD introduces a schema-versioned mission document under a project-controlled `missions/<mission-id>/mission.json` path. Its initial authority is intentionally narrow:

- mission ID/title and deterministic work-package graph;
- exact packet `spec.json` digest and project-relative packet path;
- exact Git target ref and full resolved commit;
- digest of the VLD Core policy used when the mission was frozen;
- work-package-to-`REQ-` assignment, dependencies and advisory project-relative resource claims.

`vld mission init` can create a mission only from a currently verified packet and an existing Git commit. It resolves the Git ref itself, requires every requirement to be assigned exactly once, writes atomically, and never creates a branch/worktree or starts a process. `validate` and `status` report packet/policy/target drift without mutating authority.

Mission declarations are explicit project artifacts intended for review and commit. They are not compiler inputs: a mission cannot change a profile, overlay, packet, policy, module, workflow or change lifecycle.

### 2. Core remains isolated from a future Runtime

The mission schema and validation helpers are pure/dependency-free Core code. They make no model call, network call, credential lookup, local listener, agent launch, worktree allocation, Git ref mutation, merge decision or arbitrary shell execution. The only Git operation in the foundation is a fixed-argv read-only `git rev-parse --verify <safe-ref>^{commit}` used to freeze/inspect a target commit.

A future optional Runtime may own operational state under `.vld/runtime/`, leases, worktree allocation, agent adapter supervision, approvals and merge receipts. It will require a separate ADR, package/dependency boundary, capability model, threat model and fake-agent tests. Runtime state must never become packet/compiler authority.

### 3. State transitions will be host-owned

This foundation deliberately has no lifecycle status that an agent can mutate. Future transition events must be validated by the Runtime host, bind actor identity and policy/packet/candidate digests, and separate implementation from review/merge authority. No agent adapter may self-approve or self-merge.

## Consequences

**Gained**

- A later scheduler has reviewed, stable work-package IDs and requirement assignments rather than inferring tasks from mutable prose.
- Packet/policy/target drift is visible before any worktree or agent is allocated.
- The current CLI adds a useful manual planning surface without expanding process or credential authority.
- Mission definitions can be tested with temporary Git repositories and verified packet fixtures, without live models or external services.

**Given up for this phase**

- No concurrent execution, worktrees, leases, retries, process adapter, ACP integration, web server, VS Code extension, merge queue, GitHub provider or signed catalog is provided yet.
- Resource claims are advisory warnings/future scheduling inputs; they are not proof that two changes cannot conflict.
- A frozen Git ref can become stale. `mission status` reports that fact; it does not silently retarget a mission.
- The policy digest records the Core policy snapshot; it is not yet the future Runtime capability policy.

## Alternatives rejected

- **Let an agent generate/change a mission while executing.** That obscures the reviewed packet/target scope and permits scope escalation.
- **Store mission state only under `.vld/`.** Versioned assignment/evidence context should be reviewable; transient operational state needs a different retention/trust boundary.
- **Start with a generic YAML shell workflow.** A task declaration must not become an arbitrary command execution mechanism.
- **Have `mission init` create a branch or worktree.** Workspace mutation needs a dedicated lock/recovery design and must follow, not precede, the safe worktree phase.
- **Allow unassigned or duplicate requirements by default.** The initial foundation prioritizes auditable complete ownership. Future scoped/change missions can add a separately specified coverage model rather than silently dropping obligations.
