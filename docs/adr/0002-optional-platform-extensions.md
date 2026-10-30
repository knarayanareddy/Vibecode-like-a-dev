# ADR-0002: Optional platform extensions stay outside the deterministic compiler

**Status:** accepted

## Context

VLD's core value is narrower than a general agent framework: a project profile is compiled into a small, reviewable packet with stable requirement IDs, static evidence checks and generated gates. Adjacent tools add useful capabilities that VLD did not previously offer:

- coding-agent-specific skills, presets, bundles and workflow composition;
- proposal/design/task/change lifecycles;
- product, architecture, delivery, review and QA disciplines.

Putting all of those into every packet would undo the line-budget discipline and turn a reproducible compiler into a prompt collection. Allowing a workflow to run arbitrary shell strings or an agent to mark its own approval would also make a governance feature a privilege-escalation path.

## Decision

VLD keeps its existing `profile -> plan -> packet -> verify` path pure. It adds four optional extension surfaces, all under the same repository and `vld` CLI:

1. **Modules** are builtin, versioned manifests for capability disciplines. Projects opt in through `.vld/modules.json`, which locks a SHA-256 digest of each enabled manifest. Dependency closure is explicit and deterministic.
2. **Bundles** may only add traits, true risk signals, overlays and absent constraints to a profile. They also enable declared modules. A bundle may not lower risk, replace a project scalar or change a stage silently.
3. **Agent adapters** generate version-locked skills/commands for supported environments. They do not invoke a model, receive credentials or change VLD policy. A modified generated file or changed module set is reported as drift.
4. **Workflows** are typed DAGs persisted under `.vld/workflows/`. Human input, agent handoffs and approvals need explicit evidence. Builtin command steps invoke only an allowlisted `vld plan`, `vld compile` or `vld verify` argv through `execFileSync`, never a shell; a separate typed artifact-validation step invokes the in-process structural verifier for an explicit artifact list. Runtime output is represented by a digest, not stored as unbounded or potentially sensitive text.
5. **Shared stores** are read-only Git snapshots of a small `vld-store.json` manifest and declared advisory Markdown assets. `vld store add` clones a repository without executing a shell, records its resolved commit plus manifest and asset digests in `.vld/stores.json`, and `vld store status` detects local cache drift without contacting the network. A verified asset may be copied into a project, or an explicitly typed `artifact-template` may seed the matching human-authored artifact with source provenance. Updating a snapshot is explicit. Store assets do not alter a profile, packet, policy, module, or workflow definition.

The `.vld/` directory is project state, not compiled packet content. It is intended to be reviewed and committed when a team wants repeatable process state. The portable `specs/` packet remains independently runnable in a downstream repository.

## Consequences

**Gained**

- VLD can support product-to-release workflows, bundles and Coding-agent handoffs without weakening its compiler or its generated CI guards.
- A project can prove which extension definitions it enabled, detect source drift and refresh generated handoffs deliberately.
- Workflows are resumable, do not self-certify human/agent work, and cannot execute an arbitrary shell command through a workflow file.
- Teams can share reviewed delivery guidance and templates through Git while pinning a particular commit and detecting changed local snapshots.
- Product teams can start with `startup-saas` or `regulated-payments` but still see every added risk and module in version control.

**Given up**

- VLD does not automatically run cloud models. Users choose their agent application, account and permission model.
- Workflows do not promise to discover a repository's own test command. Product test execution remains a declared project gate, not a generic unsafe shell hook.
- Modules and shared stores provide protocols, templates and handoffs, not a claim that a generated or human-authored brief, architecture document or review is semantically correct.
- Stores are deliberately advisory and read-only: they cannot supply executable workflows, policy, modules or compiler inputs. An imported template is a starting document, not an authoritative artifact or requirement source. The existing deterministic `vld change` lifecycle remains the source of truth for requirement deltas.

## Alternatives rejected

- **Make the compiler call a model.** This breaks reproducibility and makes policy selection depend on a provider, credentials and an opaque runtime.
- **Copy a large role/prompt library into every packet.** It overwhelms the packet's budget and treats all projects as if they need the same ceremony.
- **Use arbitrary YAML shell workflows.** A project-controlled data file must not become a way to execute `sh -c` commands through a governance tool.
- **Let agent handoffs complete approvals automatically.** Evidence and accountable judgement are deliberately separate from agent output.
