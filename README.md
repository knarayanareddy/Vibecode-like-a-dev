# vibecode like a dev

**A compiler for engineering discipline.** You bring a one-paragraph idea and a repository URL. It hands back a specification packet that a coding agent can execute without inventing the engineering that was never written down.

Not a prompt. Not a checklist. A packet with requirements, acceptance criteria, gates, architecture decisions, and a script that **fails the build when the spec and the code stop agreeing**.

```bash
git clone https://github.com/knarayanareddy/Vibecode-like-a-dev
cd Vibecode-like-a-dev

# new project
node factory/cli.mjs init my-app                 # writes profile.json to fill in
node factory/cli.mjs plan my-app/profile.json
node factory/cli.mjs compile my-app/profile.json -o specs

# existing project: infer the profile from the code you already have
node factory/cli.mjs adopt .                     # evidence + the questions only you can answer
node factory/cli.mjs compile profile.json -o specs

# brownfield change: a delta spec with a blast radius, a probe and a rollback
node factory/cli.mjs change specs changes/add-export.json -o changes/add-export

# agent integration: 8 tools over MCP instead of 34 files in context
node factory/cli.mjs mcp
```

Then hand `specs/` to Claude Code, Codex, Cursor, Lovable, Replit, or a human. Start at `specs/AGENTS.md`.

## Two ways to use it

**Path A — compile it (recommended).** The CLI is a deterministic compiler: no model calls, no network, no clock. The same profile always produces a **byte-identical** packet, so a regenerated spec diffs only where your intent changed, and a plan can be reviewed in a pull request.

**Path B — let your agent author it.** If you cannot run anything locally, paste [`prompts/bootstrap.md`](prompts/bootstrap.md) into Claude, Codex, Cursor or Lovable with your idea and this repository's URL. The agent reads `factory/policy.json`, `factory/routing.json` and `primitives/index.json`, computes the tier, selects practices and writes the packet in your repo. It is faster to start and it is *not* reproducible: use it when you must, and diff its selection against the CLI's when you can.

---

## The problem, stated precisely

Vibe-coded products fail for reasons that are not "the model wrote bad code". They fail because:

1. **Ambiguity gets filled by the model, silently.** A one-line idea admits hundreds of interpretations. The agent picks the most probable one, builds it well, and explains why it was right. Nobody notices until a user does.
2. **The engineering that experienced devs apply is invisible.** Bounded contexts, invariants, authorization on object reads, idempotent webhooks, migration rollback, mutation-tested assertions — none of it appears in a prompt, so none of it appears in the product.
3. **Nothing checks intent against reality.** The spec lives in a chat, the code lives in a repo, and there is no mechanism connecting them. The drift is invisible because each individual step was reasonable.

The third point is the one the industry has not solved. GitHub Spec Kit, AWS Kiro, BMAD and OpenSpec all made specs a *first-class artifact*. Thoughtworks still files spec-driven development under **Assess, not Adopt**, because specs drift: *"a spec can report success on work that no longer matches what anybody meant."*

This project starts where that criticism lands.

## The idea

Treat the spec as **compiled output**, the way a compiler turns source into an artifact that a machine can verify.

```
profile.json  ──►  planner  ──►  packet (requirements, gates, docs)
(idea, risk)      (deterministic)         │
                                          ▼
                            @req anchors + spec-check.mjs
                                          │
                              code that either matches or fails CI
```

Three consequences that make this different from a prompt template:

- **The plan is deterministic and auditable.** No model is called. The same profile always produces a byte-identical packet, and every practice carries the predicate that selected it plus the reason it exists. You can diff intent between two versions of a project, and review a plan like code. The reasoning is in [`docs/adr/0001`](docs/adr/0001-deterministic-compiler-not-a-prompt.md).
- **Rigor is computed, not requested.** A weekend prototype gets six practices and a single file. A payments service gets 31 practices, 21 gates and a mutation-score target. Ceremony has to be earned by risk.
- **The spec is enforced.** Every automated requirement carries an `@req REQ-xxx` anchor in the test that proves it. A shipped checker fails CI when a requirement marked `done` loses its test, when an anchor points at a requirement that does not exist, or when an anchor lives outside a test file.

## Four ways in

| You have | Command | What you get |
| --- | --- | --- |
| An idea and nothing else | `vld init` → `plan` → `compile` | A greenfield packet |
| A repository (local path or Git URL) and no spec | `vld adopt <repo-or-url> [--name … --idea "…"]` | A profile inferred from code, `docker-compose.yml`, `.env.example`, and SQL/ORM schemas, with evidence per field |
| An existing packet and a change to make | `vld change <packet> <change.json>` | A delta spec: ADDED / MODIFIED / REMOVED, blast radius, probe, rollback, `spec.after.json` |
| An agent that needs the library | `vld mcp` | 8 MCP tools so the agent queries selection instead of reading 34 files |

### `vld adopt` — meet the repo where it is

Adoption accepts either a local directory or a remote Git URL (`https://github.com/org/repo`, `https://github.com/org/repo/tree/branch`, `github:org/repo#branch`, SSH) via shallow clone. It reads polyglot manifests up to four levels deep (`package.json` including `@scope/*` packages, `pyproject.toml`/`requirements*.txt`, `go.mod` including `/vN` module paths, `Cargo.toml`, `Gemfile`, `composer.json`, `pubspec.yaml`), `docker-compose*.yml` service images, committed `.env.example` variable names (never live `.env` values), raw SQL & ORM migration schemas (`ON DELETE CASCADE`, tenant/PII columns), CI, deployment config and test tooling. It reports **every inference with the observation behind it and a confidence mark**, then asks only what code cannot answer.

```
  inferred
  ● kind                     web-app
                              dependency: react; dependency: react-dom
  ● traits                   auth, persistence
                              dependency: alembic
  ◐ risks.pii                true
                              backend/app/models.py: personal data column
  ◐ stage                    production
                              deployment config: deploy.yml

  only you can answer
  1. Is this domain regulated? Nothing in the code can establish that, and it changes the tier.
```

Two rules make it trustworthy: **runtime dependencies decide what the product is** (a dev-only `express` in a benchmark does not make an HTTP client an API server), and **nothing legal or organisational is inferred** — regulation, user scale and team size are always questions.

### `vld change` — the real-world case

A delta that only says what to add is a wish list. This one has four obligations:

```json
{
  "id": "add-csv-export", "risk": "high",
  "add":    [{ "key": "feature.export", "statement": "…", "failurePath": "…", "acceptance": ["…"] }],
  "modify": [{ "key": "api.error-envelope", "addAcceptance": ["…"] }],
  "remove": [{ "key": "ui.design-tokens", "why": "deferred until the component library is consolidated" }],
  "probe":  ["Export a board with two participants and compare row counts."],
  "rollback": "Remove the route; no schema change, so redeploying the previous image is enough."
}
```

| Output | What it forces you to face |
| --- | --- |
| `proposal.md` | The argument, the before/after, and the **blast radius**: areas touched, practices that enforce them, gates in the way, tests that become stray anchors |
| `design.md` | Human-reviewed implementation decisions, alternatives, risks and rollback boundaries |
| `tasks.md` | The work order: anchor first, then manifest, then gates, then probe |
| `evidence.md` + `evidence.json` | Human release/review narrative plus a deterministic register linking reviewed artifacts to every changed `REQ-` id; the register does **not** replace the delta or resulting manifest |
| `delta.json` | Machine-readable delta with base, impact and obligations — the authoritative change intent |
| `spec.after.json` | The resulting manifest, reviewable as a diff of intent before any code moves — the authoritative post-change requirements |

Impact is classified (`patch` / `minor` / `major`), and removing a requirement that a practice enforces at your tier is flagged rather than silently allowed. Appended criteria keep their existing `AC-` identifiers, because anchors already cite them.

Before archive, fill `evidence.md`, register reviewed artifact paths and affected `REQ-` ids in `evidence.json`, then run `vld change verify changes/add-csv-export --project .`. The verifier requires strict, module-locked artifact validation and coverage for every changed requirement. `vld change archive changes/add-csv-export specs` refuses incomplete evidence; once it passes, it folds the delta back into the profile as a `team` overlay, stores a compact evidence-link summary in change history, preserves the `REQ-` id your tests now anchor against, moves the change directory to `changes/archive/`, and recompiles. Running it twice produces the same bytes.

### `vld mcp` — stop pasting 34 files

An MCP server over stdio, zero dependencies, 8 tools:

| Tool | Answers |
| --- | --- |
| `compute_rigor` | What tier, from which signals, with which ceilings |
| `select_primitives` | Which practices apply, why, and what was deliberately skipped |
| `search_primitives` | IDF-weighted search with tier filtering and calibrated `activate: true` skill routing |
| `get_primitive` | One practice in full, read only when needed |
| `get_requirements` | Requirement templates with criteria, failure paths and anchors |
| `get_gates` | Cumulative definition of done for a tier |
| `plan_project` | The whole plan, compactly |
| `get_anchor_convention` | The `@req` ratchet and its commands |

The selection comes from the same policy as the CLI, so an agent cannot invent its own tier logic and drift from the plan. Add it to any MCP client:

```json
{ "mcpServers": { "vibecode": { "command": "node", "args": ["/path/to/factory/cli.mjs", "mcp"] } } }
```

## Optional platform layer — one tool, without one monolith

The compiler remains deliberately deterministic. Optional modules, bundles, agent handoffs and workflows add a broader product-to-release loop **without** putting a model call, credentials or arbitrary shell execution in `plan`, `compile` or `verify`.

```bash
# Start from a conservative, reviewable bundle. It only adds declared signals;
# it never lowers risk or replaces your project stage.
vld bundle apply startup-saas --profile profile.json

# Inspect or opt into the version-locked delivery disciplines.
vld module list
vld module enable product,architecture,delivery,review,qa --project .

# Generate validated, human-authored artifacts. Templates start as drafts;
# strict validation rejects placeholders, draft status and missing requirement evidence.
vld artifact init product-brief --project . --packet specs
vld artifact init architecture-decision auth-boundary --project . --packet specs
vld artifact validate product-brief --project . --packet specs --strict
# Strictly cross-check enabled artifact evidence against one compiled packet.
vld artifact verify --project . --packet specs

# Share advisory, reviewable delivery guidance without changing the compiler.
vld store init ../team-playbook --id team-playbook
# Commit ../team-playbook with Git, then pin its resolved commit in this project:
vld store add team-playbook https://github.com/acme/team-playbook.git --ref main --project .
vld store status --project .
vld store assets team-playbook --project .
vld store copy team-playbook review-guidance --project .
# A declared artifact-template must match the selected artifact type; the result records source provenance.
vld artifact init product-brief --from-store team-playbook/product-brief-template --project .
# Preview contacts the remote and validates it, but never changes this project.
vld store diff team-playbook --project .
# Copy the exact remote commit printed by diff only after review; update re-fetches it
# and refuses a changed remote rather than moving the pin silently.
vld store update team-playbook --acknowledge <full-40-character-commit> --project .

vld module verify --project .

# Export a bounded, one-way view for an already-adopted ecosystem. These files are
# never compiler inputs: profile, overlays, packet and change manifests stay authoritative.
vld export spec-kit specs --out integrations/spec-kit
vld export kiro specs --out integrations/kiro

# Generate handoffs for a local coding-agent environment. This installs files;
# it does not invoke a model or use credentials.
vld agent install codex --project .
vld agent install claude-code --project .
vld agent status --project .

# Preview a typed workflow first. Only --execute writes resumable .vld state.
vld workflow run discovery --profile profile.json
vld workflow run discovery --profile profile.json --execute
vld workflow complete discovery capture-intent \
  --evidence "Product owner reviewed users, non-goals and risk flags."
vld workflow run discovery --execute
```

| Layer | Purpose | Guardrail |
| --- | --- | --- |
| **Modules** | Product discovery, architecture, delivery, review and QA capabilities | SHA-256 locked under `.vld/modules.json`; dependency closure is explicit. |
| **Bundles** | `startup-saas` and `regulated-payments` starting points | May add traits, true risk signals and modules; cannot silently lower risk or replace a scalar decision. |
| **Agent adapters** | Generated Codex, Claude Code and GitHub Copilot handoffs | Generated files and enabled module set are drift-checked; the adapter never runs a model. |
| **Workflows** | Discovery, feature delivery and release readiness | Typed/resumable DAG; human and agent steps require explicit evidence; command steps can only run an allowlisted VLD argv, and artifact validation is an in-process typed gate—not a shell escape hatch. |
| **Shared stores** | Pin advisory Markdown and typed artifact templates from Git | `diff` fetches a validated candidate without mutating the project; an update requires the exact reviewed 40-character commit acknowledgement, records it in the lock, and cannot affect compiler or workflow state. |
| **Interoperability exports** | Bounded Spec Kit and Kiro layouts from a compiled packet | Generated one-way views carry source digest/provenance and state plainly that packet/change manifests remain authoritative. |
| **Manual workspaces** | One Git worktree/branch for each frozen mission package | Repository-wide exclusive lock, sibling managed root, current-mission gate and recovery-aware cleanup; this is not an agent executor or merge-conflict guarantee. |
| **Local Runtime state** | Durable lifecycle, leases and receipts for a frozen mission | Versioned ledger/snapshot, expected versions, idempotency and loopback-only API; it has no implicit process/model/network/credential authority. |
| **Scoped adapter host** | Deterministic fake runs and one explicit unconfined local argv | Separate closed policy, healthy M2 workspace + M3 lease gate, clean environment and host-owned receipt; no shell, Runtime writes, push, merge or candidate authority. CWD/policy flags are not OS confinement. |
| **Frozen delivery candidate** | Exact candidate tuple, detached packet integration, independent review and local queue | Runtime validates allocated branch/base ancestry and a live lease; a closed policy permits only in-process packet verification. It records bounded receipts and performs no project command, merge, push, PR, provider or credential action. |
| **Local Studio** | Browser dashboard and VS Code command entry over the loopback Runtime API | Per-response nonce CSP, manual in-memory bearer token and text-only rendering; Studio has no Git, agent, shell, workspace-file, merge or forge authority. |
| **Signed content catalog** | Curated, Git-fetched but Ed25519-verified inert content packages | An explicit local trust root verifies threshold-signed canonical index/package metadata, expiry, identity, compatibility and payload digests before cache/lock/copy; v1 never executes or enables content. |
| **Optional ACP/GitHub adapters** | Stable ACP v1 peer bridge, exact-SHA GitHub PR contract, and offline Runtime plan export | Provider HTTP code stays optional; Core shares only a data-only plan schema and never discovers credentials, auto-enables adapters, pushes, runs webhooks, or replaces branch protection. |

The result is one repository and one `vld` CLI, while the packet remains portable and small. Use the agent-facing modules where they help; use the compiler and generated gates as the authority. See [ADR-0002](docs/adr/0002-optional-platform-extensions.md) for the extension boundary and security model. For the researched, future VLD Platform path—Studio, mission runtime, agent scheduler, merge queue and signed catalog—see [the platform expansion study](docs/PLATFORM-EXPANSION-RESEARCH.md) and [implementation plan](docs/VLD-PLATFORM-IMPLEMENTATION-PLAN.md).

### Mission foundation — freeze implementation scope before a runtime exists

`vld mission` is the first implemented VLD Platform foundation. It is **not** an agent runner, workspace allocator or merge tool. It freezes a currently verified packet, the exact current Git target commit and the current Core-policy digest into a reviewable mission declaration. Every packet requirement must be assigned exactly once to a bounded work package before the declaration can be created. The short requirement list below is illustrative; use every `REQ-` ID in the selected packet.

`definition.json` is authored and reviewed by the team:

```json
{
  "schemaVersion": 1,
  "id": "report-export",
  "title": "Implement a traceable report export workflow",
  "workPackages": [{
    "id": "export-api",
    "title": "Implement report export API and tests",
    "requirements": ["REQ-001", "REQ-002"],
    "dependsOn": [],
    "resourceClaims": { "paths": ["src/export/**", "test/export/**"] }
  }]
}
```

```bash
# `specs` must already pass `vld verify`; `HEAD` is resolved to a full immutable commit.
vld mission init definition.json --packet specs --project .
vld mission validate missions/report-export/mission.json --project .
# Read-only: reports packet/policy/target drift but never retargets the mission.
vld mission status missions/report-export/mission.json --project .
```

Mission declarations live at `missions/<id>/mission.json` by default and remain outside compiler input. The command uses fixed-argv, read-only Git resolution only: it never creates a branch/worktree, starts an agent, invokes a model, reads credentials or changes a Git ref. See [ADR-0003](docs/adr/0003-mission-foundation-and-runtime-boundary.md) for the boundary.

### Safe manual workspaces — isolated files, not automatic execution

Once the mission is current and verified, allocate a declared package from the **primary Git checkout root**:

```bash
# Creates vld/report-export/export-api at the mission's immutable target commit.
# The checkout is a managed sibling outside this project, never under specs/ or missions/.
vld workspace create missions/report-export/mission.json export-api --project .
vld workspace status missions/report-export/mission.json --project .

# Normal removal refuses staged, unstaged, untracked and committed work.
vld workspace remove missions/report-export/mission.json export-api --project .
# Only after intentional review, use the exact ID printed by create/status to discard work:
vld workspace remove missions/report-export/mission.json export-api \
  --discard --acknowledge workspace-<exact-id> --project .

# Reap a dead lock and reconcile an interrupted removal without blindly deleting a branch.
vld workspace recover missions/report-export/mission.json --project .
```

The allocation ledger is `.vld/workspaces.json`; each repository's Git common directory has a short-lived exclusive lock during VLD-owned worktree/branch mutations. `status` only reports drift. `recover` favours preserving work: a remaining branch is retained, not silently deleted. Worktrees isolate working files and indexes, but they share Git refs and can still produce later merge conflicts; resource-claim overlap is only an advisory warning. These commands use fixed local Git argv only—they do **not** run project commands, agents/models, credentials, networks, pushes, PRs or merges. See [ADR-0004](docs/adr/0004-safe-manual-worktree-allocation.md) for the exact safety and recovery contract.

### Local Runtime — durable fake-run state before agents exist

The optional Runtime owns a versioned event ledger, derived snapshot, expected package versions, bounded leases and receipts. Its M3 state commands do **not** allocate a worktree, invoke an agent/model, execute a command, access a credential, contact a service, push or merge. Runtime state stays local and ignored under `.vld/runtime/`; the packet and mission declaration remain reviewable authority. The separately explicit M4 adapter command below is the only process surface.

```bash
# Initialize host-owned state. Packages without dependencies begin ready.
vld runtime init missions/report-export/mission.json --project .

# An operator allocates a ready package to an implementer identity. Save the one-time
# lease token: only its digest is recorded in the local ledger.
vld runtime allocate missions/report-export/mission.json export-api \
  --assignee agent-alpha --lease-ms 300000 --project .
vld runtime status missions/report-export/mission.json --project .

# A local control/API host binds only to 127.0.0.1 and prints an in-memory operator token once.
vld runtime serve missions/report-export/mission.json --project .
# Recovery replays only a known pending transaction, reaps a dead local lock and blocks expired leases.
vld runtime recover missions/report-export/mission.json --project .
```

The fixed M3 policy denies network, process execution, Git push/merge and credential access. The host validates the lifecycle (`ready → allocated → running → changes_ready → verifying → in_review → approved → queued → merged`), roles, independent review, expected version and lease token before a receipt is appended. The loopback JSON API requires a bearer token, caps request bodies and rejects non-loopback browser Origins. Actor identities are deterministic local/fake identities in M3—not an agent adapter or external human authentication system. See [ADR-0005](docs/adr/0005-local-runtime-host-and-fake-run-state.md) for boundaries and recovery semantics.

### Scoped adapter host — explicit fake or unconfined local process

M4 adds a separate, opt-in `runtime agent` surface. It requires **both** an M3 allocation/lease and an existing healthy M2 worktree. A reviewed, closed JSON policy selects either a deterministic process-free `fake` adapter or one exact `local-process` executable/argv. The Runtime, not the adapter, moves the package to `running`, writes metadata-only digest/byte-count/outcome evidence, then advances a successful run to `changes_ready` or blocks an unsuccessful run.

```bash
# First allocate the worktree and M3 package as above, then author/review a policy
# inside the project. This fake policy launches no host process.
cat > agent-policy.json <<'EOF'
{"schemaVersion":1,"id":"fake-review","adapter":"fake","mode":"write-workspace","capabilities":{"readWorkspace":true,"writeWorkspace":true,"runDeclaredCommands":false,"network":false,"streamEvents":true,"cancel":true,"reconnect":true,"sandbox":true,"credentialAccess":false,"gitPush":false,"gitMerge":false},"limits":{"durationMs":1000,"outputBytes":1024,"retryBudget":0},"environment":{},"command":{"script":"succeed","executable":null,"args":[]}}
EOF
vld runtime agent run missions/report-export/mission.json export-api \
  --policy agent-policy.json --lease-token "$LEASE_TOKEN" --project .
vld runtime agent status missions/report-export/mission.json --project .
```

`local-process` has no shell, PATH lookup or inherited environment; it gets only a fresh non-secret locale allowlist and VLD-derived IDs. It is nevertheless an **unconfined host process**: `read-only`, `network: false` and `credentialAccess: false` deny VLD authority and inherited environment values, but do **not** stop the executable from using files, credentials or network access available to the invoking OS user. A process CWD is **not** a sandbox, so this release rejects write-capable local-process policies and never treats those flags as OS enforcement. Fake runs are the deterministic CI path; a future sandbox adapter must prove outside-workspace filesystem denial, credential-fixture denial, network-egress denial and process-execution controls before VLD can grant sandboxed writes or claim enforced isolation. Neither adapter can submit a candidate, verify project checks, approve, push, merge, open a PR or change policy. See [ADR-0006](docs/adr/0006-scoped-agent-adapter-host.md).

### Frozen delivery candidates — exact local review handoff, not a merge engine

M5 adds an explicit Runtime-owned candidate/review surface after a successful M4 run. `submit` freezes the exact clean package-branch `HEAD`, allocation base, mission target, packet/policy digests and optional completed adapter receipt. `verify` creates a detached temporary integration worktree from the frozen target, integrates that exact SHA with fixed Git argv and runs only VLD's in-process packet verifier. The disposable worktree is removed before the receipt is committed. A different reviewer can approve only the same candidate/target/policy tuple; a release approver can then queue that tuple.

```bash
# The delivery policy is deliberately closed: no arbitrary project command and no merge/push/forge permission.
cat > delivery-policy.json <<'EOF'
{"schemaVersion":1,"id":"local-delivery-v1","verification":{"verifyPacket":true,"commands":[]},"review":{"independent":true},"queue":{"enabled":true},"merge":{"local":false,"push":false,"forge":false}}
EOF

# SHA must equal the healthy allocated worktree's current clean HEAD.
vld runtime delivery submit missions/report-export/mission.json export-api \
  --policy delivery-policy.json --lease-token "$LEASE_TOKEN" --sha "$CANDIDATE_SHA" --adapter-run "$AGENT_RUN_ID" --project .
vld runtime delivery verify missions/report-export/mission.json export-api \
  --policy delivery-policy.json --project .
vld runtime delivery approve missions/report-export/mission.json export-api \
  --policy delivery-policy.json --candidate "$CANDIDATE_ID" \
  --actor reviewer:reviewer-beta --reason "Reviewed frozen packet and integration receipt" --project .
vld runtime delivery queue missions/report-export/mission.json export-api \
  --policy delivery-policy.json --candidate "$CANDIDATE_ID" --actor release-approver:release-gamma --project .
```

`queued` is only an auditable local handoff. This M5 foundation cannot execute a project check, resolve a conflict, create a merge commit, push a branch, create a PR, call GitHub, read credentials or use ambient `gh` login. If frozen packet/target authority drifts, the Runtime blocks additional mutations and retains the immutable receipt history; start a new reviewed mission/runtime rather than reinterpreting approval. See [ADR-0007](docs/adr/0007-frozen-candidates-and-no-merge-m5-foundation.md).

### Local Studio — a visual Runtime client, not a second authority

M6 adds a local browser dashboard at the same loopback Runtime process and a lightweight VS Code command entry (`factory/studio/vscode`). It displays packet/policy digests, a mission board with dependencies/resource claims/lease health, bounded agent receipts, exact delivery receipts and degraded Runtime warnings. It can request only the already typed `allocate` and `recover` Runtime operations; Runtime still validates the caller role and every state transition.

```bash
# This starts the existing loopback-only Runtime API plus Studio.
# Copy the one-time token from the terminal and paste it into the dashboard.
vld studio serve missions/report-export/mission.json --project .
# Then open the printed http://127.0.0.1:PORT/studio URL.
```

The dashboard page contains no token, project path or receipt data until an authenticated request succeeds. It has a response-specific nonce CSP, no external assets/storage, no permissive CORS and renders every Runtime field as text rather than trusted HTML. The VS Code commands accept only an exact loopback Studio URL; its WebView keeps a pasted token in extension memory and accepts only a `refresh` message. Studio does **not** serve workspace files, run a Git/agent/shell command, submit delivery candidates, approve, merge, push, create PRs or access a forge. The existing CLI remains the full local workflow. See [ADR-0008](docs/adr/0008-local-studio-is-a-runtime-client.md).

### Signed content catalog — trusted metadata, inert payloads

M7 adds a separate signed catalog for curated content. Trust begins with a locally reviewed Ed25519 root file—not a Git remote. The root verifies threshold-signed, canonical JSON index and package metadata before VLD accepts a Git-fetched cache. Every package must declare `content-only`, a publisher identity, license, Core compatibility, release timestamp and bounded payload digests. V1 accepts only Markdown guidance/templates and JSON module/bundle/workflow/test-fixture/export-schema data; it cannot ship an executable adapter, shell command, plugin or enablement action.

```bash
# Review this public-key-only root file first. The initial trust decision is local.
vld catalog trust reviewed-root.json --project .
# Git is transport/cache only: signed index/package/payload checks decide trust.
vld catalog add team-catalog https://example.invalid/vld-content.git --project .
vld catalog status --project .
# Preview does not mutate the project; update requires this exact reviewed commit.
vld catalog diff team-catalog --project .
vld catalog update team-catalog --acknowledge "$CATALOG_COMMIT" --project .
# Copy is explicit and records immutable publisher/digest provenance under .vld.
vld catalog copy team-catalog review-content review-guidance \
  --out docs/catalog/review-guidance.md --project .
```

`catalog status` verifies the previously pinned root/index/cache offline. Root rotation needs the exact new root digest acknowledgement plus signatures meeting the currently trusted root threshold. Copying never enables a module, applies a bundle, runs a workflow, changes the compiler packet or executes content; use the existing explicit Core flows for those actions. Studio shows catalog trust/publisher/digest state when a catalog is configured. See [ADR-0009](docs/adr/0009-signed-content-only-catalog.md).

### Optional ACP v1 and GitHub adapters — protocol peers, not new authority

M8 adds two explicit integration boundaries under `factory/integrations`. The provider HTTP/ACP packages are not installed, imported or invoked by Core unless an operator deliberately selects them; Core shares only a data-only, dependency-free GitHub-plan schema and never gains provider access. The ACP package pins the stable `@agentclientprotocol/sdk` root entry point and rejects experimental/v2 use. Its host advertises no client filesystem, terminal, MCP, authentication, elicitation or credential capability; it converts only bounded ACP session metadata to a host receipt. An ACP peer remains read-only in the same limited sense as `local-process`: setting a CWD is **not** filesystem or network containment.

```bash
# Optional ACP dependency; this is never required for normal vld use or CI.
npm install --prefix factory/integrations/acp-v1
# A reviewed agent policy must explicitly set adapter: "acp-v1" and remain
# read-only, direct-argv, no-network/no-credential/no-push/no-merge.
vld runtime agent run missions/report-export/mission.json export-api \
  --policy policies/acp-read-only.json --lease-token "$LEASE" --project .
```

The GitHub package is a caller-injected REST client rather than a CLI credential store: it requires an in-memory token and an immutable plan built from an exact VLD candidate, independent approval and queued tuple. It can create/update a PR, inspect the same head SHA/base/check/review facts, and only request an exact-SHA merge when the reviewed plan enables it. It never reads ambient `gh`/environment credentials, pushes branches, runs a webhook server or substitutes for GitHub branch protection. Live use remains a manual disposable-account/repository exercise; normal CI uses recorded fixture responses only. See [ADR-0010](docs/adr/0010-optional-acp-and-github-provider-boundaries.md).

#### Runtime forge plan export — durable evidence, offline handoff

M8.1 adds a typed `forge-plan` Runtime ledger event and a deliberately safe export command. It can run **only** for an already queued candidate whose frozen candidate, passed verification, independent approval, queue receipt, target SHA, packet digest and policy digest still match. The event stores those receipt IDs and digests plus one digest-checked GitHub v1 plan; malformed, stale, mismatched, credential-like or host-path-bearing receipts fail closed. Repeating the exact authority tuple returns the original receipt rather than creating mutable metadata.

```bash
vld runtime forge plan-export missions/report-export/mission.json export-api \
  --candidate candidate-... --actor release-approver:release-operator \
  --repository example-org/report-export --head-ref vld/export-api \
  --checks packet-check,lint --out docs/review/export-api-github-plan.json \
  --project . --json
```

The command writes (or, without `--out`, prints) a deterministic reviewable plan with `allowMergeRequest: false`; `--dry-run` creates neither a Runtime receipt nor a file. It does not read environment or `gh` authentication, discover/store a credential, contact GitHub, push, create/update a PR, request merge, poll, accept webhooks, or transition anything remotely. The explicit local file is created without overwriting existing files or traversing symlinked directories, and its path is intentionally not stored in Runtime. A successful local receipt is evidence of an offline handoff—not evidence that any forge action occurred. GitHub authorization and branch protection remain final enforcement points. See [ADR-0010](docs/adr/0010-optional-acp-and-github-provider-boundaries.md).

## What you get

A tier-1 packet for a four-week MVP, 891 lines total:

| File | What it settles |
| --- | --- |
| `00-constitution.md` | The ten laws, definition of done, change protocol, which practices were selected **and which were skipped on purpose** |
| `01-product-brief.md` | User, job, scope, non-goals, measures, assumptions, open questions |
| `02-domain-model.md` | Ubiquitous language, bounded contexts, aggregates, invariants, state machines, events |
| `03-architecture.md` | Style decision with rejected alternatives, import rules, stack, ADRs, fitness functions |
| `04-contracts.md` | Interface inventory, conventions (IDs, money, time, pagination), error envelope, status codes |
| `05-verification.md` | Test layers, traceability table, gates, drift guard, review checklist |
| `06-delivery-plan.md` | Phases with exit criteria, commit protocol, stop rules, risk register |
| `07-agent-handoff.md` | A paste-ready brief, the loop, hard rules, escalation triggers, reviewer prompt |
| `spec.json` | The machine-readable manifest: requirements, criteria, gates, anchors, status |
| `spec-check.mjs` | A dependency-free drift guard you commit into the product repo |

Tier 0 collapses all of it into **one ~135-line file** — runnable, the primary journey and the product's own rules, nothing more — because a sketch does not deserve a binder.

## Try it: one profile, three tiers

The compiled example is committed, so you can read the output before running anything: [`examples/retro-board/spec/`](examples/retro-board/spec/).

```bash
# tier 1: a four-week MVP with auth and personal data → 14 requirements, 24 criteria, 8 gates
node factory/cli.mjs plan examples/retro-board/profile.json
node factory/cli.mjs plan examples/retro-board/profile.json --json | head -40

# tier 3: a production payout API (money, regulated, multi-tenant) → 31 practices, 21 gates
node factory/cli.mjs init /tmp/payout
# set "risks": {"payments": true, "regulated": true, "multiTenant": true}, "stage": "production"
node factory/cli.mjs plan /tmp/payout/profile.json

# tier 0: a one-week prototype → 6 practices, a single ~135-line file, no binder
node factory/cli.mjs init /tmp/sketch
# set "stage": "prototype", "kind": "cli", leave risks empty
node factory/cli.mjs compile /tmp/sketch/profile.json -o /tmp/sketch/specs
```

The profile is deliberately tiny. Everything else is derived:

```json
{
  "name": "retro-board",
  "idea": "A retrospective board for small engineering teams...",
  "kind": "web-app",
  "stage": "mvp",
  "users": { "scale": "small" },
  "traits": ["auth", "persistence", "realtime"],
  "risks": { "pii": true, "publicFacing": true },
  "constraints": { "team": 2, "weeks": 4, "stack": "typescript" }
}
```

Unknown traits and risk flags are **rejected**, not ignored — a router that silently drops a decision is worse than one that refuses.

## How rigor is decided

Tier is a function of risk signals and stage, with an explicit cap so prototypes stay throwaway.

| Tier | Score | Practices | Packet | Typical |
| --- | --- | --- | --- | --- |
| 0 sketch | 0 | 6 | single file, ≤140 lines | spike, throws away |
| 1 standard | 1-3 | 22 | full, ~900 lines | MVP with users |
| 2 production | 4-6 | 28 | full, ~1000 lines | real money or personal data at scale |
| 3 critical | 7+ | 34 | full, ~1100 lines | payments, regulated, multi-tenant |

Signals: money `+3`, regulated `+3`, tenant isolation `+2`, large scale `+2`, personal data / destructive writes / public surface / integrations / production stage `+1` each. Stage caps rigor (`mvp` → tier 1) unless a hard risk is present — a prototype of a payment flow is still a payment flow.

Every tier has a **hard line ceiling** enforced by `vld verify`. A packet that exceeds it fails, because the main criticism of this tool category is that the specs are too long to review. Trimming prose is allowed; trimming acceptance criteria or gates is not.

## The enforcement loop

This is the part that is not in the other tools.

```bash
# in the product repository, in CI, on every pull request
node specs/spec-check.mjs --repo .            # pending requirements are notices
node specs/spec-check.mjs --repo . --strict   # release CI: nothing ships unfinished
node specs/enforcement/gates.mjs --repo .     # one check per gate in the packet
```

```ts
// @req REQ-004
test('erasing a subject removes every owned row (AC-01)', async () => {
  // given a subject with rows in every table
  // when the deletion sweep runs
  // then a query across all tables returns zero rows
});
```

The ratchet is what makes it usable on day one:

| State | Result |
| --- | --- |
| `todo` + no anchor | notice (or failure under `--strict`) |
| `todo` + anchor | in progress |
| `done` + anchor in a test | pass |
| `done` + no anchor | **error** |
| anchor naming a requirement that does not exist | **error** |
| anchor only outside `tests/` | **error** |
| anchor suppressed by `@req-ignore` or `anchors.exclude` | not an anchor — counted and printed, never silent |
| packet over its tier line ceiling | **error** |
| recompile | `status` and `anchor` survive per requirement key |

### Two escape hatches, both loud

A spec document that *quotes* a marker must not count as an anchor, and a fixture that deliberately cites an unknown requirement must not fail the guard. Both cases are explicit:

```ts
// @req-ignore: this line demonstrates the marker, it is not a test
// @req REQ-004
```

or, for whole files, in `spec.json`:

```json
{ "anchors": { "exclude": ["factory/test/fixtures/**", "docs/**"] } }
```

Suppression is never silent: the checker prints `· N anchor(s) ignored` on every run, so a rule that hides work is visible in the output of the thing that checks for hidden work.

### Progress survives the policy

Regenerating a packet is normal — the catalog changes, the profile changes, a practice is added. Wiping the record of what was already built would make the tool useless on any project older than one release. So `status` (`done`, `blocked`) and the anchor travel with the requirement **key** across a recompile; requirements that disappear are named in the output and in `spec.json.history`. A recompile that changes nothing produces byte-identical output to a fresh compile, which is what makes the committed packet reviewable in a diff.

## This repository runs itself

The most useful test of this tool is whether it can describe the tool. `profile.json` at the repository root is this project's own profile, and `specs/` is the packet it generates — committed, so you can read the tool's opinion of itself.

```bash
npm run dogfood    # compile profile.json -> specs/, then guard this repo with its own checker
npm run stress     # ten product ideas through the pipeline, judged on more than exit codes
npm run check      # index + tests + example packet + self-guard + stress
```

What it produces today:

| | |
| --- | --- |
| profile inferred/defined as | `cli`, javascript, single-maintainer, production, `org-baseline` overlay |
| selection | 17 practices, tier 1, 9 gates |
| packet | 11 documents + `enforcement/`, 756 lines (ceiling 900) |
| `vld verify specs` | PASS — 6 EARS requirements, 8 criteria, 9 gates, 0 errors |
| `node specs/spec-check.mjs --repo . --strict` | PASS — 0 errors, 0 pending, 1 ignored |
| `node specs/enforcement/gates.mjs --repo . --strict` | PASS — 9 pass, 0 fail, 0 pending |

The interesting part is what it refused to accept. Running the tool on itself found four real defects that no unit test had:

1. `vld adopt -o nested/path.json` crashed with `ENOENT` when the directory did not exist. Fixed in the library, not the CLI.
2. The drift guard failed on this repository's own fixtures — test files that deliberately cite `REQ-999` to prove the guard rejects unknown requirements. That is the security policy it needed: `@req-ignore`, `anchors.exclude`, and a printed count.
3. Recompiling wiped `status` and anchors, so the tool's own packet lost its history the first time policy changed.
4. A no-op recompile wrote an empty `history` block, making an unchanged packet differ from a fresh one — caught by the "committed packet is in sync with the generator" check that now runs in CI.

And it forced two policy corrections: a local CLI was being told to apply OWASP ASVS (now gated on a network surface or a credential), and the catalog had no requirement of the form *"the product's own rules are pinned by tests"* — which is exactly what a spec tool owes its users, so `core.domain-invariants` is now always on, anchored to the very tests you are reading.

What this proves: the loop closes — profile in, packet out, guard passes, and the packet's own requirements are anchored in real tests. What self-hosting alone does not prove is whether routing and multi-arm enforcement hold up on outside tasks; the evaluation suites below measure both.

## Measured evaluations: routing and multi-arm outcomes

`npm run eval` runs four suites in CI on every commit — two deterministic library/packet checks and the two Tier-3 benchmarks from [`docs/LANDSCAPE.md`](docs/LANDSCAPE.md) §8:

```bash
node scripts/eval-library.mjs       # 34 practices x 36 profiles: self-recall, collisions, obligations, consequences
node scripts/eval-specificity.mjs   # 157 same-tier packet pairs: shared prose ceiling
node scripts/eval-routing.mjs       # 74 practitioner prompts -> expected practices (supports --driver mcp|openai|anthropic|cmd)
node scripts/eval-outcome.mjs       # 24 tasks x 3 arms: no-spec vs generic-spec vs vld-packet (--runner calibration|cmd|openai|anthropic)
```

### 1. MCP practice routing (`eval-routing.mjs`)

74 labelled practitioner prompts (34 single-practice, 14 distractor-heavy, 6 multi-practice, 12 colloquial, 8 off-topic negatives) across all 34 practices, enforcing CI floors of **precision ≥ 90%** and **recall ≥ 70%**:

| Configuration | Micro-precision | Micro-recall | F1 | Negative prompts quiet |
| --- | --- | --- | --- | --- |
| Uncalibrated top-10 search (`limit: 10`) | 9.7% | 100.0% | 17.7% | 0 / 8 |
| Title-only ablation (`summary + triggers + tags` stripped) | 58.2% | 63.9% | 60.9% | 8 / 8 |
| **`search_primitives({ activate: true })` (shipped)** | **94.7%** | **100.0%** | **97.3%** | **8 / 8** |

Practice metadata (`summary`, `triggers`, `tags`) contributes **+36.5pp precision** and **+36.1pp recall** over title matching, all **34/34** practices activate on their labelled prompts with **0** false-positive absorbers, and corrupting a practice's metadata fails CI (`factory/test/routing-eval.test.mjs`). Passing `--driver openai`, `--driver anthropic`, or `--driver cmd --cmd "<router>"` runs the identical 74-prompt benchmark with a live model in the loop choosing which `SKILL.md` practices to open from `primitives/index.json`.

### 2. Multi-arm outcome harness (`eval-outcome.mjs`)

24 executable software tasks across 5 categories (`greenfield` ×6, `brownfield` + `vld change` delta ×6, `bugfix` ×4, `refactor` ×4, `systems` ×4) and tiers 0–3, each evaluated across three arms (`no-spec`, a ~125-line `generic-spec`, and the compiled `vld-packet`) against hidden functional acceptance oracles, hidden review-defect probes (IDOR, non-atomic writes, replay/idempotency bugs, secret leakage, cursor duplication, architecture boundary leaks), and three post-merge drift mutations:

| Arm | Pre-review naive-patch block | Post-merge drift caught (overall) | Anchor / req-test drop | Secret / gate regression | Co-mutated semantic weaken | Markdown context tokens (mean) |
| --- | --- | --- | --- | --- | --- | --- |
| `no-spec` (ticket only) | 0.0% (0/24) | 0.0% (0/72) | 0.0% | 0.0% | 0.0% | 167 |
| `generic-spec` (~125 lines) | 0.0% (0/24) | 0.0% (0/72) | 0.0% | 0.0% | 0.0% | 728 |
| **`vld-packet` (`vld compile` + `vld change`)** | **100.0% (24/24)** | **63.9% (46/72)** | **100.0% (24/24)** | **91.7% (22/24)** | **0.0% (0/24)** | **15,816** |
| **Delta vs `no-spec`** | **+100.0pp** | **+63.9pp** | **+100.0pp** | **+91.7pp** | **+0.0pp** | **+15,649 tok** |
| **Delta vs `generic-spec`** | **+100.0pp** | **+63.9pp** | **+100.0pp** | **+91.7pp** | **+0.0pp** | **+15,088 tok** |

Three honest takeaways from those numbers:

- **What CI calibration proves deterministically (no live LLM called):** across all 24 tasks, a naive implementation that passes smoke tests is **0% blocked** before review under `no-spec` or `generic-spec` and **100% blocked** by `spec-check.mjs` + `enforcement/gates.mjs` under `vld-packet`. After merge, `vld-packet` catches **100%** of dropped requirement tests (`24/24`) and **91.7%** of credential/gate regressions (`22/24` — the 2 misses are tier-0 single-file sketches that omit `G1-SECRETS` by design).
- **What `vld-packet` explicitly fails to catch (`0.0%` on semantic weakening):** when a post-merge commit weakens an edge-case invariant *and* weakens the test assertion while leaving the `// @req REQ-xxx` comment intact, `spec-check` and `gates.mjs` pass (`0/24` caught). Anchors enforce test *presence* and gate *structure*, not assertion strength.
- **What requires a live agent run:** calibration runs starter/naive/reference fixtures (`100%` reference mergeable across all 3 arms) to verify oracle solvability, defect-probe sensitivity, gate catch rates and context token cost (`+15,088` markdown tokens over `generic-spec`). Measuring live LLM merge-rate lift, defect reduction and API dollar spend requires running a coding agent against the 72 isolated workspaces:

```bash
node scripts/eval-outcome.mjs --runner cmd --agent-cmd "claude -p 'Read TASK.md (and specs/AGENTS.md or SPEC.md if present) and complete the task.'" --out /tmp/outcome-claude.json
node scripts/eval-outcome.mjs --runner openai --model gpt-4o --out /tmp/outcome-gpt4o.json
node scripts/eval-outcome.mjs --runner anthropic --out /tmp/outcome-sonnet.json
```

#### Optional live-run protocol (never normal CI)

Run one provider/model/configuration at a time from the same commit, retain the complete `--out` JSON for each run, and compare its three paired arms—not a live run against calibration fixtures. Start with a bounded pilot such as `--tasks brownfield`, then run all 24 tasks only after setting a spend/time budget. The `cmd` runner executes `--agent-cmd` in each isolated workspace, pipes `TASK.md` to standard input, and sets `VLD_TASK_ID`, `VLD_ARM` and `VLD_TASK_FILE`; it is the right path for a locally authenticated CLI agent. The direct runners require `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (optional `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, or `EVAL_MODEL`). Export credentials in your own shell or secret manager—never place them in a profile, packet, export, artifact, report committed to Git, or this repository's CI.

Live output is empirical evidence for the exact agent version, command, model and date that produced it; it is not a deterministic release gate. Preserve the raw JSON plus a short human-authored run note naming that configuration and any retries/failures. The generated Spec Kit/Kiro exports are portability aids, not a fourth benchmark arm or competing requirement source.

#### Approval-gated GitHub benchmark

The **live-agent benchmark** workflow is `workflow_dispatch` only; it is not triggered by a push or pull request and is never a required merge check. Before allowing a run, repository administrators must create the protected `live-agent-benchmark` environment, require reviewers, and add the matching `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment secret (optional base-URL secrets are supported). An approved operator selects only `openai` or `anthropic`, supplies an exact model identifier and a bounded task filter. The workflow uploads `outcome-report.json` and `provenance.json` containing the commit, workflow run/attempt, runner image/OS, Node version, provider/model/task inputs and timestamp. Treat this artifact as outcome evidence for that exact configuration—not as evidence supplied by deterministic calibration.

## Does it hold up? Ten ideas, judged

`npm run stress` runs two suites: ten representative ideas, then twenty adversarial ones plus six profiles that must be **refused** cleanly. Together they score packets for things `verify` cannot see: does a Python service get pytest, does a library get told to rate-limit endpoints, does a packet point at a document it does not ship, can an idea forge a heading in a generated document, does a Rust project get handed `npm run lint`, how much of the idea actually reached the requirements.

The two runs found fourteen defects. The first wave: catalog insertions renumbered requirement ids and silently repointed anchors; a payments packet quoted a *retro board* example; a Go project was handed Vitest; tier-0 packets told the agent to read documents they do not contain; libraries were told to rate-limit their endpoints; and a tier-1 daemon had no observability obligation. All six are fixed, each with the test that would catch it again. Two coverage gaps closed with it: uploads and offline had no obligation at all.

The adversarial wave broke eight more: an idea could forge a document heading; a long idea pushed a tier-1 packet over its ceiling; unrecognised stacks were given invented npm commands; an `agent` without the `ai` trait had no model guardrails; payments declared as a feature but not as a risk earned neither the obligation nor the rigor; a tier-0 sketch could receive ten requirements; `compile -o <existing file>` crashed with a stack trace; and a library was told to enforce tenant isolation "at its data access layer". All fixed, all with a test.

The finding that is only partly fixed, because it is the product's actual boundary: **mean idea-vocabulary coverage is 50%** (it was 21% before the packet started deriving its vocabulary from the idea; the remaining half is the business logic no catalog can predict). The catalog knows engineering classes — payments, tenancy, pipelines, public libraries — not your business. So every normative sentence in an idea that no requirement covers is quoted back as an *unmapped obligation*, and `vld change` is how it becomes a requirement. Full results and method: [`docs/STRESS-TEST.md`](docs/STRESS-TEST.md).

## Why not just use Spec Kit / Kiro / BMAD / OpenSpec?

They solved the first half — making the spec a real artifact. What follows is what I took from each, and what I deliberately left. For a current, decision-oriented comparison of VLD with those tools plus Spec Kitty, GSD Core and Superpowers—including VLD's real gaps—see [the comparative study](docs/COMPARATIVE-STUDY.md).

| Project | Strongest idea | Why it is not enough here |
| --- | --- | --- |
| **GitHub Spec Kit** | Agent-agnostic markdown artifacts, `constitution → specify → plan → tasks` | Volume. Reviewers report ~1,300 lines of markdown for a date-display feature and "I'd rather review code than all these markdown files". No mechanism checks the spec afterwards. |
| **AWS Kiro** | Three files, EARS-style requirements, IDE-native | Spec drift is its documented Achilles heel; requirements and design do not update as implementation reveals constraints. IDE lock-in. |
| **BMAD-METHOD** | Scale-adaptive tracks, adversarial review, real planning for large features | 21 personas and heavy ceremony; practitioners report large token bills, steep learning curve, and overhead on small work. |
| **OpenSpec** | Change-based delta specs (ADDED/MODIFIED/REMOVED) for brownfield repos | Never calls a model itself, and has no notion of *which* engineering practices apply to a project. |
| **Tessl** | Spec-as-source, code marked generated | Closed, and the spec framework itself was wound down; the commercial energy moved to a registry. |
| **Agent Skills** | Progressive disclosure: metadata → body → references | A packaging format, not a selection or enforcement mechanism. |

**What I took:** Spec Kit's agent-agnostic artifacts and constitution idea; Kiro's insistence that requirements carry observable criteria and its lightness at small scope; BMAD's adversarial review and scale-adaptive instinct (implemented as a computed tier rather than a persona roster); OpenSpec's insight that change, not greenfield, is the real problem (on the roadmap); the Agent Skills packaging convention for the primitive library.

**What is new here:**

1. **Selection with reasons, including what was skipped.** Every packet says which practices were chosen, *why*, and which applicable ones were deliberately deferred. An unexplained checklist is cargo cult; a justified one can be argued with.
2. **Enforcement as a first-class output.** The packet ships its own drift guard. The spec is not a document that hopes to stay true; it is a check that fails when it stops being true.
3. **Rigor computed from risk, with a hard size ceiling.** Most frameworks let you pick a weight class and then bury you in it. Here the tier decides both how much practice and how many lines, and exceeding the line budget is a verification failure.
4. **Zero model calls to plan.** The compiler is deterministic JSON-in, packet-out. That makes plans reviewable in a pull request, reproducible in CI, and cheap to iterate on before you spend a single token on code.

## The primitive library

34 practices, each a self-contained `SKILL.md` with a trigger-shaped summary, the failure mode it prevents, a checklist, the red flags that say it is being skipped, a table of the excuses people make while skipping it, anti-patterns, and an `obligation:` line the compiler fills with this product's own nouns. Agents read `primitives/index.json` and open only what they need.

| Module | Primitives |
| --- | --- |
| **product** | product brief · non-goals and scope · user journeys as slices |
| **domain** | ubiquitous language (DDD) · bounded contexts · aggregates and invariants |
| **architecture** | style selection · ports and adapters · contract before implementation · ADRs · fitness functions · build vs buy |
| **data** | schema and forward-only migrations · data lifecycle |
| **testing** | TDD loop · test budget · acceptance traceability · contract tests · mutation testing · property-based testing |
| **security** | threat model · OWASP ASVS baseline · authorization model · secrets and supply chain |
| **reliability** | observability baseline · idempotency and retries |
| **delivery** | CI gates · release and rollback |
| **frontend** | design tokens · accessibility baseline · UI state model |
| **agent** | review protocol · handoff packet · spec drift guard |

```bash
node factory/cli.mjs index            # rebuild primitives/index.json
node factory/cli.mjs index --check    # fail if the index is stale
```

Adding a primitive is data, not code: write a `SKILL.md`, add a routing rule with a predicate and a reason, and the test suite refuses to let it be unreachable, duplicated, tier-inconsistent, or orphaned from the requirement catalog.

## Repository map

```
primitives/            34 practices, grouped by module, each with SKILL.md
  index.json           generated catalog agents traverse
prompts/
  bootstrap.md         agent-driven path: one prompt, no CLI
factory/
  lib/emit/vocabulary.mjs   the product's nouns: scored from the idea, grammatical or it falls back
  cli.mjs              init · plan · compile · verify · index
  policy.json          tiers, risk signals, gates, size ceilings
  routing.json         which practice applies when, and why
  catalog/
    requirements.json  27 requirement templates with acceptance criteria
  evals/
    routing-cases.json 74 labelled practitioner prompts across all 34 practices
    tasks/             24 executable multi-arm outcome tasks (greenfield, brownfield, bugfix, refactor, systems)
  lib/                 frontmatter, predicates, planner, emitter, verifier,
                       scan + adopt, change (delta specs), mcp (server),
                       routing-eval, outcome-eval
  templates/
    spec-check.mjs     the drift guard shipped into every packet
    gate-runner.mjs    the gate checker shipped into every packet
  schema/
    spec.schema.json   the manifest contract
  test/                Node test suite: data integrity, planning, reproducibility, adoption,
                       delta specs, overlays, gates, EARS, MCP protocol, routing & outcome evals
profile.json           this repository's own profile
specs/                 this repository's own compiled packet, guarded in CI
scripts/
  stress-test.mjs      ten ideas through the pipeline, judged beyond exit codes
  stress-adversarial.mjs  24 hostile packets and 6 inputs that must be refused
  eval-library.mjs     library health: self-recall@1, trigger collisions, dead weight
  eval-specificity.mjs  is a packet about this product, or a form letter with a name in it
  eval-routing.mjs     74-prompt MCP routing precision/recall + metadata ablation (--driver mcp|openai|anthropic|cmd)
  eval-outcome.mjs     24-task x 3-arm outcome harness (--runner calibration|cmd|openai|anthropic)
  lib/packet-audit.mjs    the shared judgement both suites use
examples/retro-board/  a profile and its compiled packet
examples/ideas/        ten representative profiles, plus adversarial/cases.json
docs/                  research notes, authoring guide, stress test, landscape survey, ADRs
```

```bash
npm test        # complete Node test suite
npm run eval    # library health + packet specificity + 74-prompt routing + 24-task outcome calibration
npm run stress  # 10 representative + 24 hostile ideas, and 6 refusals; scored on soundness
npm run check   # lint + index + tests + verify + self-guard + gates + eval + stress
```

### Supported runtime and platform scope

The dependency-free CLI and Node test suite support **Node 22** on Linux, macOS and Windows. CI runs the full portable `npm test` suite on `ubuntu-latest`, `macos-latest` and `windows-latest`; the Linux job additionally runs the shell-heavy package/install, Git-fixture and integration journey. Those portable checks validate CLI/runtime behavior, not OS sandbox equivalence: `local-process` and ACP peers are unconfined same-user host processes on every supported OS until a separately reviewed sandbox adapter proves enforced filesystem, credential, network and process isolation.

## Honest limitations

- **The selection heuristics are opinions.** The tier math is defensible; the practice priorities encode a particular view of software. Both are in `policy.json` and `routing.json` so you can disagree with them in a diff instead of in a review argument.
- **The drift guard needs honest statuses — and measured semantic drift catch is 0%.** Across the 24-task outcome suite, `spec-check.mjs` + `gates.mjs` catch **100%** of dropped requirement tests and **91.7%** of secret/gate regressions, and **0%** of co-mutated semantic weakenings where an edit weakens both the code and the test while keeping `@req` intact. Automatic detection of *semantic* drift still requires mutation testing (`G3-MUTATION`) or an independent reviewer.
- **CI runs deterministic calibration, not live paid model calls.** `eval-routing.mjs` and `eval-outcome.mjs` ship live `openai`, `anthropic` and arbitrary CLI-agent (`cmd`) runners, and run deterministic `mcp` / `calibration` baselines in CI so every PR is reproducible without API keys. Do not read calibration's `100%` reference mergeability or `+100pp` naive-gate catch as a claim about a specific LLM's first-pass merge rate until you run `--runner cmd|openai|anthropic` against that model and inspect the paired JSON report; note also the `+15,088`-token context cost over a generic spec, which ETH Zurich's AGENTBENCH cautions can hurt if an agent reads every document instead of following `specs/AGENTS.md` progressive disclosure.
- **Chat-only builders do not follow the loop.** Lovable and Replit are given a paste-ready brief and per-tool guidance, but they will not run `spec-check.mjs`. Treat their output as a first draft that a code agent or a human finishes.
- **Adoption infers, it does not understand.** A profile derived from code is a starting point with evidence, not a description of intent. Re-read the inferred fields before compiling; the questions it asks are the ones that matter.
- **Delta specs are declarative.** `vld change` produces the proposal, the manifest diff and the verification rules, but it cannot apply a migration or prove the blast radius is complete for you.
- **MCP tools select; they do not write.** The server answers "what applies and why". Composing the packet is still a compile (or a human/agent writing prose).
- **The CLI path assumes the profile describes the project honestly.** If you say `mvp` about a regulated product, you get a light packet. The `risks` fields exist because intent cannot be inferred.
- **The catalog knows classes, not businesses.** Measured over ten ideas, 50% of the idea's distinctive vocabulary reaches the requirements or the domain model — up from 21%, because the domain model now leads with the idea's own nouns and its own stated rules. The other half is genuinely absent: a log shipper's packet now lists `position`, `shipper` and `dead-letter` as terms (the vocabulary comes from the idea), but no requirement covers redaction or acknowledged-after-acceptance, because no catalog obligation says "log shipper". Naming a thing is not specifying it. Payments, tenancy, pipelines and public libraries are well covered because they are heavily conventional; a log shipper or a standup bot is a scaffold plus a checklist of the author's own rules. The packet says so out loud rather than pretending otherwise.
- **Tier 1 has very little headroom.** The tightest packet in the stress set sits at 872 of 900 lines. The ceiling is deliberate — length is this category's main failure — but it means a new tier-1 obligation requires trimming prose first.
- **Self-consistency is not effectiveness.** This repository passes its own guard, which shows the pipeline is coherent, not that the resulting software is better. The packet also describes a tool whose requirements are unusually easy to anchor because the tool is tested; other products will find that step harder, and nothing here measures that difficulty.
- **Distribution is tested, publication is still a release decision.** CI packs the exact tarball, installs it into an empty prefix, invokes its `vld` bin, then compiles/verifies/exports a packet and exercises a reviewed shared-store template flow. This catches omitted package files and bin drift without publishing or needing registry credentials.

## Roadmap

Shipped in v0.2: `vld adopt`, `vld change` (delta specs), `vld mcp`.
Shipped in v0.3: progress that survives recompiles, anchor suppression (`@req-ignore`, `anchors.exclude`), stable requirement ids across catalog changes, unmapped-obligation reporting, Go stack support, the always-on `core.domain-invariants` requirement, a self-spec packet guarded in CI, and a ten-idea stress run in `npm run check`.
Shipped in v0.4: per-product obligations and red-flag/anti-rationalization tables on all 34 practices, EARS-shaped requirement statements enforced by `verify` and `spec-check`, org → domain → team overlays with provenance, `vld change archive`, and `enforcement/gates.mjs` plus config fragments per gate (see [`docs/LANDSCAPE.md`](docs/LANDSCAPE.md) §8).
Shipped in v0.5: calibrated `search_primitives({ activate: true })` MCP routing + 68-prompt precision/recall & ablation benchmark (`eval-routing.mjs`, 94.3% precision / 100.0% recall in CI, plus live LLM drivers), and the 24-task × 3-arm outcome evaluation harness (`eval-outcome.mjs`, hidden acceptance oracles, review-defect probes, post-merge drift mutations, and live `cmd`/`openai`/`anthropic` agent runners).
Shipped in v0.6–v0.9: locked capability modules and bundles, agent handoffs, typed delivery workflows, verified Git-store templates, strict artifact evidence gates, and evidence-linked change archives.
Shipped in v0.10: a packed-install CI journey, reviewable Git-store refresh previews with exact-commit acknowledgement, and bounded `spec-kit` / `kiro` exports from a verified packet.
Shipped in v0.11: versioned `vld mission init|validate|status`, which freezes a verified packet, Core-policy digest and immutable Git target into complete requirement-linked work packages without starting an agent or changing Git state.
Shipped in v0.12: `vld workspace create|status|recover|remove`, a manually operated, repository-serialized Git worktree allocator derived only from a current frozen mission. It uses a sibling managed root, atomic recovery-aware locking and exact acknowledged discard; it does not add model/process execution, push, merge or GitHub integration.
Shipped in v0.13: optional `vld runtime` host state for a frozen mission: versioned JSONL receipts plus an atomically checked snapshot, leases, role/version/idempotency validation, expiry recovery and a bearer-protected loopback API.
Shipped in v0.14: `vld runtime agent run|status`, with deterministic fake runs and a policy-declared, direct-argv unconfined local-process adapter. The host requires an M2 workspace and M3 lease, never inherits parent credentials, and retains host-owned metadata-only receipts. It deliberately does not claim CWD, `read-only`, network or credential policy flags provide OS confinement, and has no candidate, verification, review, push, merge, PR or GitHub/ACP integration.
Shipped in v0.15: `vld runtime delivery submit|verify|approve|queue|status`, an exact-SHA local candidate/review foundation. It validates allocated-branch/base ancestry, uses one temporary detached integration worktree and a closed in-process packet check, records digest-bound independent review/queue receipts, and intentionally has no project-command, merge, push, PR, forge or credential capability.
Shipped in v0.16: `vld studio serve` and the Runtime `/studio` dashboard, plus a VS Code command-entry extension. The static local client displays Runtime packet/mission/lease/receipt state through the existing authenticated loopback API, has a nonce CSP and text-only rendering, and can request only typed Runtime allocation/recovery actions—never Git, an agent, a shell, merge or forge work.
Shipped in v0.17: `vld catalog trust|add|diff|update|status|copy`, a separately locked Ed25519 threshold-signed catalog of bounded inert content. An explicit local root validates canonical index/package metadata, expiry, compatibility, publisher and every payload digest before cache/lock/copy; Git transport cannot confer trust, and catalog content cannot execute or enable itself.
Shipped in v0.18: optional stable ACP v1 and GitHub REST adapter packages. ACP has a separately installed SDK boundary and bounded host event normalization; GitHub consumes an immutable candidate/approval/queue plan with caller-supplied in-memory credentials, exact head/base SHA checks and GitHub-enforced merge gates. Neither adds Core credentials, automatic process/network use, push, webhook or autonomous merge authority.

1. **Published live-agent comparison runs** — use the optional protocol above across Claude Code, Codex and open-weight coding agents, preserving raw JSON logs and configuration notes; do not treat an export as a competing source of requirements.
2. **`vld change --quick`** — for one-line changes that do not deserve a delta: an explicit, labelled path with no probe, for teams that accept the trade.
3. **Semantic drift detection** — `eval-outcome.mjs` now measures the gap directly (`0/24` co-mutated semantic weakenings caught by `@req` anchors alone); closing it requires wiring lightweight per-requirement mutation or property checks into `gates.mjs`.

## Prior art and reading

Full notes, links and dates in [`docs/RESEARCH.md`](docs/RESEARCH.md). The short version:

- Böckeler's critique of SDD tooling, and Thoughtworks' "Assess" ring, define the bar: **short specs, independent review, and something that checks**.
- The 2026 SDD benchmarks show spec *completeness* matters more than spec *volume* — which is why this project caps volume and focuses on criteria, gates and anchors.
- The field's stated open problem is drift. That is the one thing here that is not a repackaging.

## Contributing

Read [`docs/AUTHORING.md`](docs/AUTHORING.md) for the primitive contract, then [`AGENTS.md`](AGENTS.md) if you are an agent working in this repository. The rules are the ones the packet preaches: a failing test first, an anchor, an ADR for anything expensive to reverse, and no unreachable primitives.

MIT licensed.
