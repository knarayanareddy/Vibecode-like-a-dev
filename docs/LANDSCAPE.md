# The landscape, and where this project actually sits

A survey of the projects this one overlaps with, the evidence about whether any of it works, and a measured answer to the question *"is this thin and boilerplate?"*

Surveyed October 2026. Claims about other projects come from their own documentation, release notes and independent comparisons; claims about this repository are measured by scripts in `scripts/` and reproducible with `npm run check`.

**Short answer: you are half right.** The *specification* half of this project is measurable boilerplate — 90% of a compiled packet is byte-identical across two completely unrelated products. The *selection, rigor and enforcement* half is not: no surveyed tool computes rigor from risk, ships a drift guard, or binds requirements to test anchors. The gap is real, it is specific, and most of it is fixable without abandoning the design.

---

## 1. Six families of prior art

Anything relevant falls into one of six groups. This project only competes in the first and sixth.

| Family | What it is | Representatives | Overlap with us |
| --- | --- | --- | --- |
| **A. Spec frameworks** | Turn intent into specs, plans and tasks for an agent | Spec Kit, Kiro, OpenSpec, BMAD, Spec Kitty, GSD | High on documents, none on rigour |
| **B. Practice libraries** | Curated engineering knowledge as agent-readable skills | addyosmani/agent-skills, Superpowers, mattpocock/skills, Karpathy skills | **Direct** — our 34 primitives are a smaller version of these |
| **C. Enforcement** | Make architectural intent executable | ArchUnit, dependency-cruiser, import-linter, depguard, Nx, CodeQL, Pact, OPA/Conftest | Low today, and it is where our differentiation lives |
| **D. Generators** | Scaffold a repository from a template | Nx generators, Yeoman, cookiecutter, `create-*` | Low — we emit documents, they emit code |
| **E. Requirements engineering** | Formalise what a requirement *is* | EARS, ISO/IEC 29148, ISO/IEC 25010, arc42, C4, ADR/MADR | Low-medium — we use the vocabulary, not the standard |
| **F. Evidence** | Does any of this work? | AGENTBENCH, Specification Gap, Meter mergeability, DORA 2026 | **Decisive** — it judges our claims |

---

## 2. Family A — spec frameworks

| Tool | What it actually is | Notable mechanism | What to take |
| --- | --- | --- | --- |
| **GitHub Spec Kit** (~115k★, v1.0.1 Aug 2026, 30+ agents) | CLI that installs slash commands; constitution → specify → clarify → plan → tasks → implement | **Presets, extensions, bundles, workflows**: stackable, priority-ordered customisation without forking; a three-layer constitution (organisation → domain → team) | Our `catalog/` + `routing.json` is a hard fork in comparison. Presets would let a team overlay its own obligations without editing our JSON. |
| **OpenSpec** (~56–67k★, MIT) | Change-centric: `specs/` is truth, `changes/<name>/` is a proposal, archive merges deltas | **Delta specs**: `## ADDED / ## MODIFIED / ## REMOVED Requirements`, merged at archive time. v1.0 moved to dynamic instructions assembled from context + rules + templates | This is what our `vld change` approximates. Their **archive** step — the delta folded back into the source of truth — we do not have. |
| **Kiro** (AWS, GA Nov 2025) | Agentic IDE; requirements.md, design.md, tasks.md per feature | **EARS syntax** for requirements, steering files, hooks, per-feature isolation | EARS is a real, adopted notation (Rolls-Royce; Airbus, Bosch, Intel, NASA, Siemens). Our requirement statements are prose. |
| **BMAD** (~50k★, v6.11) | Multi-persona agile simulation: analyst, PM, architect, dev, QA hand files to each other | Persona separation forces the *questions* to be asked in sequence | Our open-questions list is a trace of that, but we never simulate the roles that ask them. |
| **Spec Kitty** | Spec Kit fork with git worktree orchestration for parallel agents | Worktree-per-spec | Relevant later: parallel agents on one spec is our unhandled case. |
| **GSD Core** (~8–9k★) | Context-engineering loop: discuss → plan (blocking research gates) → execute in waves → verify | Fresh-context subagents per phase, `VERIFICATION.md`, cross-AI review | "Blocking gates" is closer to our gates than anything else in the category. |
| **Superpowers** (~270k★) | Skills library + methodology: brainstorm → plan → subagent execution → TDD → review | Mandatory TDD gate, two-stage review (spec compliance, then quality) | Their review gate is a **second reader**; ours is a **test anchor**. Both are needed. |
| **Task Master** (~28k★) | PRD → ordered tasks | Task dependency graph | Repo inactive since April 2026; the category eats its own. |
| **Ralph loop / Smart Ralph** | Loop the agent until the PRD is done, fresh context each iteration | Git as memory | Complements a spec; does not replace one. |
| **Tessl** (commercial, $125M raised) | Was spec-as-source; **the framework was removed at CLI v0.50.3**, now a spec registry and governance platform | Clear the fate of the most ambitious bet in the category | A caution, not a template. See §7. |

**The category's shared maturity model** (from independent comparisons): *spec-first* (specs seed code, then rot) → *spec-anchored* (specs and code evolve together, tests enforce) → *spec-as-source* (only specs are edited). We sit at **spec-anchored**, which is where OpenSpec also sits and where Tessl retreated from. That is the right place to be, and it is a claim we can defend with `spec-check.mjs`.

**The category's shared complaint** is verbosity: every comparison names review overload from stacked markdown. Our line ceilings are a direct, if partial, answer.

---

## 3. Family B — practice libraries (our real competition)

| Library | Size | Anatomy | Evals | What we lack |
| --- | --- | --- | --- | --- |
| **addyosmani/agent-skills** (~73–91k★) | 25 skills, full lifecycle | frontmatter → overview → when to use → process → **anti-rationalization table** → **red flags** → verification | **Yes**: trigger, routing and behavioural evals in CI | The three things in bold, and the evals |
| **Superpowers** (~270k★) | ~14 core skills, deep inner loop | skills chained into one disciplined loop | Pressure-testing, eval suite in a separate repo | Chain depth: our practices are independent, not sequenced |
| **mattpocock/skills** (~243k★) | 25 skills for a daily loop | alignment, domain language, TDD, debugging, module design | Author states there is no automated eval | — |
| **Karpathy `CLAUDE.md`** | one file | always-on pitfalls | none | Nothing; this is the antidote to us, not a competitor |
| **This project** | 34 practices, 2,187 lines (median 64), 198 checklist items | failure mode → when → practice → checklist → anti-patterns → why it works → cost | **none** | — |

Two additions from the best of these are cheap and high-value:

- **Anti-rationalization tables.** A row per excuse an agent will make ("the change is too small for a test", "I'll add tests after"), with the counter. This attacks the exact failure our anchor system catches after the fact.
- **Red flags.** A short list of things that mean *stop*, written in the imperative.

Neither exists in our 34 practices. Both are prose, and both fit inside the 500-line guidance we already follow.

---

## 4. Family C — enforcement

| Layer | Tools | Consequence for us |
| --- | --- | --- |
| Structure | dependency-cruiser, Nx boundaries, ArchUnit, ArchUnitNET, NetArchTest, import-linter, depguard | A practice like *no framework imports in domain code* is enforceable today. We only write it down. |
| Semantics | CodeQL, custom AST rules | Out of scope for us; worth linking. |
| Interfaces | Pact, Specmatic, schema snapshots | Our `api.contract` requirement has no shipped mechanism. |
| Policy | OPA, Conftest | Could express our gates as code rather than prose checkboxes. |

A 2026 essay names the gap exactly: *"the missing product is an architecture compiler… one architectural rule might become a dependency rule, a CodeQL query, an OPA policy and a runtime observability check"* ([bencoding](https://bencoding.com/2026/10/19/the-bottleneck-has-moved-why-ai-engineering-needs-to-grow-up/)). Their point and ours are the same, from the other direction: they start from enforcement and lack the selection layer; we start from selection and lack the enforcement targets.

Our `enforces:` field is a *pointer* to that idea. It is not an implementation, and 13 of our 34 practices point at nothing.

---

## 5. Family F — the evidence (this is the uncomfortable part)

| Study | Finding | What it means for us |
| --- | --- | --- |
| **AGENTBENCH** (ETH Zurich, 138 repos) | LLM-generated context files **reduce** task success by 0.5–2% and raise cost **>20%** (+3.9 steps); human-written files help **~4%**; broad architectural overviews act as *distraction* | A 900-line packet that is 90% identical prose is precisely "broad architectural overview". This is the strongest argument against our current output shape. |
| **Two-agent ablation** (17 tasks, 288 runs) | Context strategy does not measurably move correctness (≤10–15pp); agents fail on *implementation skill*, not missing repository knowledge | A spec cannot fix "can't wire this feature". It can fix "built the wrong feature". Set expectations accordingly. |
| **The Specification Gap** (multi-agent, 53 tasks) | Success falls monotonically with spec detail removed: single-agent 88.6% → 55.8%; split 58.2% → 24.6%; restoring the full spec recovers 89% | **This is our best evidence.** Specification completeness is the dominant predictor of integration success. Nothing beats a complete, specific spec. |
| **Meter mergeability** | Agent solutions are merged at roughly **half** the rate of human golden solutions when a maintainer reviews them | Tests passing ≠ accepted. Our gates should target *reviewability*, not just green CI. |
| **Microsoft / dotnet-runtime** | Agent PRs of 1–50 lines succeed 76–80%; performance work 54.5%; "excellent at well-specified changes, poor at architecting" | Scope discipline is a real lever, and our tier caps are a crude version of it. |
| **DORA 2026** | ~39% first-year ROI, 8-month payback, with a "verification tax"; 35–40% gains on simple tasks, <10% on legacy | The enforcement layer is where the cost sits. Charge for it honestly. |
| **Skill activation as precision/recall** | Adding *one sentence* to each description moved micro-recall from 46.3% → 67.3%; a broad "router" skill absorbed four specialists (precision 0.40) | Library metadata needs measurement, not judgment. We now measure it. |
| **AGENTS.md adoption** | ~96.6k root files (June 2026), Linux Foundation governance, 180+ member orgs | The format won. Our packets must be *additive* to that, not a parallel universe. |

The synthesis: **completeness of specification helps; volume of generic prose does not.** Our current output confuses the two.

---

## 6. What this repository measures right now

Run `node scripts/eval-library.mjs`, `node scripts/eval-specificity.mjs` and the stress suites to reproduce.

| Metric | Value | Verdict |
| --- | --- | --- |
| Practices | 34, 3,293 lines, median 98 | Each practice is a page an agent can act on, not a paragraph |
| Checklist items | 203 (6 per practice), **170 red flags**, **170 anti-rationalization rows** | The anatomy that was missing is now the largest section of every skill |
| Practices with a consequence | **34 of 34**: 22 declare `enforces`, 8 bind a policy gate, 4 are `advisory: true` with a written reason | `eval-library` fails on a practice with no consequence and no reason |
| Catalog requirements | 27, **all 27** enforced by a practice | The 6 orphans (`core.primary-journey`, `core.domain-invariants`, `ai.guardrails`, `delivery.audit-trail`, `data.uploads`, `mobile.offline`) were assigned to the practices that actually teach them |
| Per-practice obligations | **821 of 821** selected practice/state pairs carry a filled, product-specific sentence inside the compiled packet | Checked by compiling every profile, not by reading the library |
| Routing rules | 34, of which 12 are `always: true` | The packet skeleton is unconditional; the rest discriminate |
| Library discoverability | **self-recall@1 100%** (34/34 practices rank first for their own title via the real MCP search) | Works |
| Trigger collisions | **8 → 0** after this pass | Two practices claiming "rollback" or "coverage" is a routing bug, now fixed |
| Dead weight | 0 practices never selected across 36 profiles | Works |
| **Packet specificity** | **31% mean shared prose** across 31 full packets and 157 same-tier pairs; worst pair 47%; 3 documents under 26%. Was **84%** → **53%** → **32%** → **31%**. Target was 35% | **Target met on the mean and on the worst pair**, which is now under the old 50% floor |

That last row was the whole argument in one number: a physiotherapy booking service and an insurance claims API used to receive the same 847 lines, and the 94 that differed carried only the requirement set, the gates and the stack.

**How the number moved, in five passes.**

1. **Split constitution from specification** (84% → 53%). Each document gained a generated "what this law obliges here" reading, and vocabulary, surfaces, ADRs and gate readings were derived from the profile instead of written once.
2. **Product-language requirement definitions** (53% → 53% on the old metric, but it fixed correctness). Every one of the 27 catalog requirements now carries a `definition` template with product slots (`{primary}`, `{aSecondary}`, `{db}`, `{project}`), so *how* a requirement is phrased belongs to the catalog and *which* requirement exists belongs to the planner. `eval-library` now fails if a requirement has no definition or one that never names the product.
3. **A vocabulary that is actually grammatical** (the reason the metric was not previously trustworthy). The old extractor picked the longest frequent word, which produced packets saying *"a change to how a yesterday behaves"* and *"a engineering"*. `factory/lib/emit/vocabulary.mjs` scores candidates by syntax (a determiner in front of a word is evidence; a participle or an adjective is a veto), collapses plurals across English and German, and has three explicit confidence levels — `idea`, `weak`, `kind` — so a one-word idea falls back to the noun its kind implies rather than inventing one. Six tests in `factory/test/vocabulary.test.mjs` pin the failure modes.
4. **Per-practice obligations, from the library into the packet** (32% → 31%, worst pair 50% → 47%). Every `SKILL.md` now carries an `obligation:` line with product slots, filled by the same filler the catalog definitions use, and printed in the constitution's practice table and in every single-file packet. A practice no longer arrives as a title and a filename; it arrives as a sentence about this product.
5. **Counting prose, not structure.** The metric now separates what a packet *says about a product* (sentences, bullets, table data rows) from what is identical on purpose (headings, table header rows, fenced examples, the shipped guard). Structure is measured and reported alongside, so the exemption cannot hide growth.

**What the residual 31% is.** Kind-level agreement, and it is defensible: two data pipelines with the same trait fingerprint really should share their pipeline invariants, their stage state machine and their architecture style. The worst pair today is two tier-1 web apps with identical traits (47%) sharing their gate checklist and their practice bindings. Getting below that means either finer catalog granularity than 27 requirements, or deriving gate wording from the requirement set — both a different project from "stop the packet being a form letter", which is done.

Two consequences followed from the original 90%, and both still hold as design constraints:

1. **The packet was doing two jobs with one artefact.** A *constitution* is legitimately stable; a *specification* must not be. They are now separate layers in the same file: stable law on the left, a generated obligation on the right.
2. **What differentiates us is not on disk.** The selection, the rigor score, the skipped-with-reason list, the anchors, the guard — those are the product. The documents are the *rendering* of it. The specificity work made the rendering earn its place; it did not make the rendering the product.

---

## 7. Anti-patterns observed in the field (things not to copy)

- **Tessl built the most ambitious version and withdrew it.** Spec-as-source needs generated code to be good enough that nobody edits it. It was not. Do not chase spec-as-source until enforcement makes hand-editing unnecessary.
- **BMAD ships breaking changes in minor versions.** A tool that owns your process cannot churn your process. Our catalog changes must stay backward-compatible for ids and keys — the stable-id work is the right instinct, applied once.
- **The verbosity tax is universal.** Every comparison names it. Our ceilings are the defence; raising them is a failure, not a feature.
- **A router description that absorbs its specialists.** We just found eight of these by measurement. Every addition to the library must be re-measured.
- **Generated context files that hurt.** Do not grow the packet to look thorough. Grow the *requirements* and the *enforcement*, and shrink the prose.

---

## 8. What "extensive and all-encompassing" would actually mean

Ordered by value per unit of work. Each has an acceptance test, because that is the only kind of roadmap this repository believes in.

### Tier 1 — makes the existing design honest (weeks, not months)

1. **Split constitution from specification.** ✅ *first pass, 2026-10-30.* The stable layer (laws, DoD, gates) stays law; every document now carries a generated "what this obliges here" reading, and requirement phrasing, vocabulary, surfaces, ADRs and gate readings are derived per product.  
   *Acceptance:* two unrelated tier-3 packets share <35% of lines, and `verify` still passes for both. **Status: met on the mean and on the worst pair — 31% overall, worst pair 47%, `verify` green.** The worst pair remains two tier-1 web apps with identical traits sharing their gate checklist; see §6 for why that remainder is kind-level rather than prose-level.
2. **Per-practice specificity obligations.** ✅ *done, 2026-10-30.* Every `SKILL.md` carries an `obligation:` template with product slots (`{project}`, `{primary}`, `{aSecondary}`, `{db}`); `derive.templateFiller` fills it once per packet, and it appears in the constitution's practice table and in the practices section of every single-file packet.  
   *Acceptance:* a packet contains at least one product-specific sentence per selected practice, checked mechanically. **Met: `eval-library` compiles all 36 profiles and asserts 821 of 821 selected practice/packet pairs contain the filled sentence, with no unfilled slot.**
3. **Anti-rationalization and red flags in all 34 practices.** ✅ *done, 2026-10-30.* Every practice now has `## In this product` (the filled obligation), `## Red flags` (5 observable signals) and `## Anti-rationalization` (5 excuses × what is actually true × what to do instead): 170 red flags and 170 rows in total, median skill length 64 → 98 lines.  
   *Acceptance:* every `SKILL.md` has both; the eval checks for them. **Met: `validatePrimitives` fails on a missing section or fewer than three entries, and `eval-library` reports a per-practice `skill depth` count.**
4. **Close the enforcement gap.** ✅ *done, 2026-10-30.* Six orphan requirements were assigned to the practices that teach them; eight practices that only advised now bind the policy gate they make real; four that cannot be machine-checked declare `advisory: true` with a reason. Finding a typo in a gate id is now a failing test, and a nested YAML block (which the flat parser used to drop silently, hiding a declared gate) is a validation error.  
   *Acceptance:* `eval-library` reports 0 practices with no consequence, or an explicit `advisory: true` with a reason. **Met: 34/34 have a consequence — 22 `enforces`, 8 gates, 4 advisory — and the four advisory reasons are printed in the eval output.**

### Tier 2 — makes the library a system rather than a list

5. **Presets/overlays** (Spec Kit's best idea): organisation → domain → team layering over our catalog and routing, without forking JSON. ✅ *done, 2026-10-30.* Three shipped layers (`org-baseline`, `health-data` which extends it, `two-person-review`), resolved org → domain → team regardless of the order a profile lists them, merged with per-claim provenance (`catalog`, `overlay:<id>`). An overlay can add requirements and gates, force practices, force a tier and append an acceptance criterion; `verify` checks provenance in both directions.  
   *Acceptance:* an overlay adds one requirement and one gate to a compiled packet, with provenance recorded in `spec.json`. **Met: `spec.overlays[]` records layer and adds, `REQ-006`/`G1-INCIDENT` carry `origin: overlay:org-baseline`, and the `clinic-bookings` fixture resolves 3 layers.**
6. **Archive step for `vld change`** (OpenSpec's best idea): a delta that is applied is *folded back* into the packet's source of truth, with history preserved. ✅ *done, 2026-10-30.* `vld change archive` writes the delta as a `team` overlay beside the profile, appends it to `profile.json`, moves the change to `changes/archive/<id>/`, records it in `changes/history.json` and recompiles.  
   *Acceptance:* apply → archive → recompile is idempotent; history shows the merge. **Met: the tree is byte-identical after archiving twice, the added requirement keeps its `REQ-` id so `@req` anchors survive, and the profile's `project.profile` is preserved so a second archive works.**
7. **Executable gates.** For each tier, ship the *mechanism* where one exists: dependency-cruiser/ArchUnit rule fragments, OPA/Conftest policies, contract-test skeleton, mutation-test config. ✅ *done, 2026-10-30.* Every gate the planner can emit has a registered rule in `factory/gates/gates.json` and a shipped fragment where a real tool owns the check (`gitleaks.toml`, `policy/authz.rego`, `contracts/contract.test.ts`, `mutation.config.json`); the packet gets `enforcement/gates.mjs`, one dependency-free check per gate, plus `enforcement/README.md` naming what each check cannot prove. Gates no machine can check become attestation files with required fields.  
   *Acceptance:* a generated packet contains at least one runnable enforcement file per applicable gate, and `spec-check` runs them. **Met with one correction: `spec-check` did not take over the gates — `enforcement/gates.mjs` is its own command, run beside `spec-check` in the generated CI and in this repository's own CI. It checks structure (files, commands, anchors, record fields, credential shapes), and says so.**
8. **EARS-shaped requirement statements** for the automated catalogue, so each maps to a scenario mechanically. ✅ *done, 2026-10-30.* All 27 catalogue statements were rewritten to the five EARS patterns (`The … shall`, `When …, … shall`, `While …, … shall`, `If … then … shall`, `Where …`), clause order WHERE → WHILE → WHEN → `shall`, with `[CLARIFY]` left as the marker for a template whose slot a profile cannot fill. `verify` and `spec-check` share one parser, so a packet and its checker cannot disagree.  
   *Acceptance:* every catalogue requirement parses against the five EARS patterns; `verify` rejects one that does not. **Met: the catalogue mix is 8 ubiquitous / 18 event / 1 state, and `verify` fails on a run-on sentence, a missing subject, or two `shall`s.**

### Tier 3 — the thing that makes all claims checkable

9. **The evaluation harness.** ✅ *done, 2026-10-30.* Two axes, both shipped and wired into CI: *library + routing* (`eval-library.mjs`, `eval-specificity.mjs`, `eval-routing.mjs`) and *multi-arm outcome* (`factory/lib/outcome-eval.mjs` + `scripts/eval-outcome.mjs` across **24 executable tasks** in `factory/evals/tasks/` — 6 greenfield, 6 brownfield with `vld change` deltas, 4 bugfix, 4 refactor, 4 systems across tiers 0–3). Each task runs identically across three arms (`no-spec`, `generic-spec`, `vld-packet`) against hidden acceptance oracles, hidden review-defect probes, and three post-merge drift mutations (`anchor-drop`, `gate-regression`, `semantic-weaken`), supporting both deterministic CI `--runner calibration` and live `--runner cmd|openai|anthropic` agent execution.  
   *Acceptance:* the outcome harness runs on ≥20 tasks, reports with/without deltas, and `README` quotes its numbers or stops making claims. **Met: 24 tasks × 3 arms run in `npm run eval` and CI, reporting paired `vld-packet` minus `no-spec` and `generic-spec` deltas (+100.0pp pre-review naive-patch gate block, +63.9pp post-merge drift catch — 100.0% anchor-drop, 91.7% credential/gate regression, 0.0% co-mutated semantic weakening — at +15,088 markdown context tokens over a generic spec), and `README.md` separates deterministic calibration proof from live-agent runs rather than claiming unmeasured model lift.**
10. **Model-in-the-loop routing eval** for the MCP layer: labelled prompts → expected practices, precision and recall with CI thresholds (recall ≥0.7, precision ≥0.9), because metadata changes move recall by ~20 points. ✅ *done, 2026-10-30.* `factory/evals/routing-cases.json` ships 74 practitioner prompts (single-practice, distractor-laden, multi-practice, colloquial and negative off-topic queries) covering all 34 practices; `factory/lib/mcp.mjs` exposes calibrated `search_primitives({ activate: true })` alongside exploratory search; `scripts/eval-routing.mjs` supports both deterministic `mcp` routing in CI and live `--driver openai|anthropic|cmd` LLM tool selection, plus a title-only metadata ablation check and a mutation regression test in `factory/test/routing-eval.test.mjs`.  
    *Acceptance:* a change to a practice description that breaks routing fails CI. **Met: CI enforces micro-precision ≥0.90 and micro-recall ≥0.70 (measured: 94.7% precision, 100.0% recall, 97.3% F1, 8/8 negative prompts quiet; stripping `summary + triggers + tags` drops precision 94.7% → 58.2% and recall 100.0% → 63.9%), and `routing-eval.test.mjs` proves a corrupted practice metadata entry flips `ok: false`.**

### What I would *not* build

- A prettier document renderer, until tier 1 is done.
- Guidance-mode hooks or an IDE.
- More than ~40 practices. The ceiling is the point; depth beats breadth.
- Spec-as-source codegen.

---

## 9. Resilience engineering — what real open-source codebases do when heuristics meet messy repositories

Stress-testing this system across three realistic polyglot domains (`trialbridge-reimburse` clinical trials in Python/FastAPI, `gridpulse-dispatch` VPP energy settlements in TypeScript/Next.js, and `portclear-coldchain` cold-chain customs & duty escrow in Go + React/TS) exposed the exact failure modes that break first-generation spec tools in the field. Studying the live source trees of six adjacent open-source projects turned each point fix into a structural mechanism:

| Reference codebase | Mechanism in their source | Failure mode it prevents | How `vibecode-like-a-dev` implements it |
| --- | --- | --- | --- |
| **`specfy/stack-analyser`** & **`railwayapp/railpack`** (`src/rules/*`, `docker/component.ts`, `dotenv/matcher.ts`) | Typed, ecosystem-bounded multi-channel rules combining manifests, `docker-compose.yml` service `image:` tags, and `.env` variable prefixes across nested workspace folders | Single-channel blind spots: `@`-scoped npm prefix stripping, Go `/v5` module path misses, or databases/queues declared only in `docker-compose.yml` | `factory/lib/adopt.mjs` normalises `@scope/pkg` symmetrically, matches `/` module segments on boundaries (`github.com/jackc/pgx/v5` matches `pgx`, never `apgx`) up to depth 4, inspects `docker-compose*.yml` images and committed `.env.example` key names (never reading live `.env` secrets), and detects raw SQL (`ON DELETE CASCADE`, `TRUNCATE`, `DROP TABLE`) alongside Prisma/Drizzle/SQLAlchemy/Rails cascades |
| **`yamadashy/repomix`** (`src/cli/actions/remoteAction.ts`, `urlRedact.ts`) | First-class remote Git URL intake into isolated temp directories with credential redaction, branch parsing, and cleanup | Forcing users to manually clone brownfield repositories before evaluating or adopting them; leaking temp paths or credentials into artefacts | `vld adopt <repo-or-url>` accepts `https://github.com/org/repo(/tree/branch)`, `github:org/repo#branch`, SSH, and `file://` Git URLs via shallow `--depth 1 --single-branch` clone with `GIT_TERMINAL_PROMPT=0`, `--` flag-injection defence, credential redaction, and `finally` temp cleanup |
| **`Fission-AI/OpenSpec`** (`src/core/validation/validator.ts`, `purpose-placeholder.ts`) | Code-fence masking (`buildCodeFenceMask`) + placeholder rejection so starter templates cannot satisfy validation while still containing `<...>` or `TBD` | **The starter-template paradox:** shipping helpful templates makes gates pass when an agent copies the blank template unedited (`<person or role>`, `YYYY-MM-DD`) | `factory/templates/gate-runner.mjs` (`attest`) strips fenced code blocks, inline backticks (so CLI examples like `` `npm i -g pkg@<previous>` `` pass), and template blockquotes, then fails any attestation file that still contains unfilled `<...>`, `YYYY-MM-DD`, or `TODO`/`TBD` slots |
| **`github/spec-kit`** (`templates/commands/analyze.md`, `converge.md`) | Read-only cross-artifact audit flagging unresolved `[CLARIFY]` / `TODO` markers before release while permitting them during authoring | Ambiguous placeholder clauses surviving into "green" release CI | Both `vld verify` (`factory/lib/verify.mjs`) and generated `spec-check.mjs` surface `[CLARIFY]` / `[NEEDS CLARIFICATION]` markers as warnings during authoring and hard errors under `--strict` |
| **`obra/superpowers`** (`skills/verification-before-completion`, `skills/writing-skills`) | Fresh execution evidence over "spec theatre", red-green TDD on skills/checks, and symptom-oriented trigger descriptions (CSO) | **Hollow test anchors:** an agent placing `// @req REQ-002` above an empty `test('...', () => {})` or `func TestX(t *testing.T) {}` with zero assertions; or Go/Java tests outside `tests/` going unseen | `spec-check.mjs`, `verify.mjs`, and `gate-runner.mjs` share unified polyglot test discovery (`*_test.{py,go,rb,rs,exs}`, `*Test.{java,kt,cs,php}`), `get_anchor_convention` ships idiomatic examples across 6 languages, and `spec-check.mjs` flags assertion-free `@req` test files (failing CI under `--require-assertions`) |
| **Deterministic NP-chunking** (`factory/lib/emit/vocabulary.mjs`) | Morphological veto of hyphenated compound modifiers + multi-modifier determiner chains + invariant `-s`/`-ics` stems | Pre-nominal modifiers (`cross-border`, `append-only`, `multi-tenant`, `role-based`) crowding real nouns out of the 6-slot Ubiquitous Language glossary, or `customs` singularising to `custom` / pluralising to `customses` | `COMPOUND_MODIFIER` vetoes attributive hyphenated modifiers while preserving domain nouns (`cold-chain`, `line-item`), `DET_CHAIN` skips up to 3 pre-nominal modifiers to anchor the head noun, and `INVARIANT_S_NOUN` preserves `customs`, `logistics`, `analytics`, `series`, `goods` |

---

## 10. Verdict

**"Thin and boilerplate": originally fair about the artefacts, wrong about the mechanism — and now measured and stress-hardened on every claim it makes.**

- **No longer thin:** all 34 practices carry filled product obligations, 170 red flags, 170 anti-rationalization rows and an explicit consequence (22 enforce requirements, 8 bind gates, 4 declared advisory); layered `org → domain → team` overlays, `vld change archive`, EARS requirement parsing and `enforcement/gates.mjs` + tool config fragments (`gitleaks.toml`, Rego, contract-test skeletons, mutation config) + starter attestation templates (guarded against unfilled copy-paste) are shipped and self-hosted in CI.
- **No longer boilerplate:** mean shared prose across 157 same-tier packet pairs dropped from **84% → 31%** (worst pair **47%**, ratcheted in CI by `eval-specificity.mjs`).
- **Measured — with the boundary stated plainly:** MCP skill activation hits **94.7% micro-precision / 100.0% micro-recall** across 74 prompts (+36.5pp precision and +36.1pp recall from practice metadata over title-only), and the 24-task × 3-arm outcome harness proves **100.0% vs 0.0%** pre-review gate rejection of naive patches and **63.9% vs 0.0%** post-merge structural drift detection (`100.0%` anchor loss, `91.7%` secret/gate regression, **`0.0%` semantic test weakening**), at a measured context cost of **~15,813 markdown tokens** vs **~728** for a generic spec. Whether a given live model converts those obligations into higher first-try merge rates on your codebase is measured by running `scripts/eval-outcome.mjs --runner cmd|openai|anthropic` with credentials — never assumed from deterministic calibration alone.
