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
| `tasks.md` | The work order: anchor first, then manifest, then gates, then probe |
| `delta.json` | Machine-readable delta with base, impact and obligations |
| `spec.after.json` | The resulting manifest, reviewable as a diff of intent before any code moves |

Impact is classified (`patch` / `minor` / `major`), and removing a requirement that a practice enforces at your tier is flagged rather than silently allowed. Appended criteria keep their existing `AC-` identifiers, because anchors already cite them.

When the change has shipped, `vld change archive changes/add-csv-export specs` folds the delta back into the profile as a `team` overlay, preserves the `REQ-` id your tests now anchor against, moves the change directory to `changes/archive/`, and recompiles. Running it twice produces the same bytes.

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
vld store update team-playbook --project .  # explicit refresh after review

vld module verify --project .

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

The result is one repository and one `vld` CLI, while the packet remains portable and small. Use the agent-facing modules where they help; use the compiler and generated gates as the authority. See [ADR-0002](docs/adr/0002-optional-platform-extensions.md) for the extension boundary and security model.

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

## Does it hold up? Ten ideas, judged

`npm run stress` runs two suites: ten representative ideas, then twenty adversarial ones plus six profiles that must be **refused** cleanly. Together they score packets for things `verify` cannot see: does a Python service get pytest, does a library get told to rate-limit endpoints, does a packet point at a document it does not ship, can an idea forge a heading in a generated document, does a Rust project get handed `npm run lint`, how much of the idea actually reached the requirements.

The two runs found fourteen defects. The first wave: catalog insertions renumbered requirement ids and silently repointed anchors; a payments packet quoted a *retro board* example; a Go project was handed Vitest; tier-0 packets told the agent to read documents they do not contain; libraries were told to rate-limit their endpoints; and a tier-1 daemon had no observability obligation. All six are fixed, each with the test that would catch it again. Two coverage gaps closed with it: uploads and offline had no obligation at all.

The adversarial wave broke eight more: an idea could forge a document heading; a long idea pushed a tier-1 packet over its ceiling; unrecognised stacks were given invented npm commands; an `agent` without the `ai` trait had no model guardrails; payments declared as a feature but not as a risk earned neither the obligation nor the rigor; a tier-0 sketch could receive ten requirements; `compile -o <existing file>` crashed with a stack trace; and a library was told to enforce tenant isolation "at its data access layer". All fixed, all with a test.

The finding that is only partly fixed, because it is the product's actual boundary: **mean idea-vocabulary coverage is 50%** (it was 21% before the packet started deriving its vocabulary from the idea; the remaining half is the business logic no catalog can predict). The catalog knows engineering classes — payments, tenancy, pipelines, public libraries — not your business. So every normative sentence in an idea that no requirement covers is quoted back as an *unmapped obligation*, and `vld change` is how it becomes a requirement. Full results and method: [`docs/STRESS-TEST.md`](docs/STRESS-TEST.md).

## Why not just use Spec Kit / Kiro / BMAD / OpenSpec?

They solved the first half — making the spec a real artifact. What follows is what I took from each, and what I deliberately left.

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
  test/                178 tests: data integrity, planning, reproducibility, adoption,
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
npm test        # 178 tests
npm run eval    # library health + packet specificity + 74-prompt routing + 24-task outcome calibration
npm run stress  # 10 representative + 24 hostile ideas, and 6 refusals; scored on soundness
npm run check   # lint + index + tests + verify + self-guard + gates + eval + stress
```

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
- **Not published to npm yet.** Clone and use `node factory/cli.mjs`. The `bin` entry is ready.

## Roadmap

Shipped in v0.2: `vld adopt`, `vld change` (delta specs), `vld mcp`.
Shipped in v0.3: progress that survives recompiles, anchor suppression (`@req-ignore`, `anchors.exclude`), stable requirement ids across catalog changes, unmapped-obligation reporting, Go stack support, the always-on `core.domain-invariants` requirement, a self-spec packet guarded in CI, and a ten-idea stress run in `npm run check`.
Shipped in v0.4: per-product obligations and red-flag/anti-rationalization tables on all 34 practices, EARS-shaped requirement statements enforced by `verify` and `spec-check`, org → domain → team overlays with provenance, `vld change archive`, and `enforcement/gates.mjs` plus config fragments per gate (see [`docs/LANDSCAPE.md`](docs/LANDSCAPE.md) §8).
Shipped in v0.5: calibrated `search_primitives({ activate: true })` MCP routing + 68-prompt precision/recall & ablation benchmark (`eval-routing.mjs`, 94.3% precision / 100.0% recall in CI, plus live LLM drivers), and the 24-task × 3-arm outcome evaluation harness (`eval-outcome.mjs`, hidden acceptance oracles, review-defect probes, post-merge drift mutations, and live `cmd`/`openai`/`anthropic` agent runners).

1. **Published live-agent comparison runs** — run `eval-outcome.mjs --runner cmd` across Claude Code, Codex and open-weight coding agents, plus head-to-head arms exported into Spec Kit and Kiro layouts, and commit the raw JSON run logs.
2. **Exports** — `spec-kit` and `kiro` formats from one source of truth, so the packet is portable rather than a new ecosystem.
3. **`vld change --quick`** — for one-line changes that do not deserve a delta: an explicit, labelled path with no probe, for teams that accept the trade.
4. **Semantic drift detection** — `eval-outcome.mjs` now measures the gap directly (`0/24` co-mutated semantic weakenings caught by `@req` anchors alone); closing it requires wiring lightweight per-requirement mutation or property checks into `gates.mjs`.

## Prior art and reading

Full notes, links and dates in [`docs/RESEARCH.md`](docs/RESEARCH.md). The short version:

- Böckeler's critique of SDD tooling, and Thoughtworks' "Assess" ring, define the bar: **short specs, independent review, and something that checks**.
- The 2026 SDD benchmarks show spec *completeness* matters more than spec *volume* — which is why this project caps volume and focuses on criteria, gates and anchors.
- The field's stated open problem is drift. That is the one thing here that is not a repackaging.

## Contributing

Read [`docs/AUTHORING.md`](docs/AUTHORING.md) for the primitive contract, then [`AGENTS.md`](AGENTS.md) if you are an agent working in this repository. The rules are the ones the packet preaches: a failing test first, an anchor, an ADR for anything expensive to reverse, and no unreachable primitives.

MIT licensed.
