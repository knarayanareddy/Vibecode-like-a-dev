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

Run `node scripts/eval-library.mjs` and the stress suites to reproduce.

| Metric | Value | Verdict |
| --- | --- | --- |
| Practices | 34, 2,187 lines, median 64 | Thin against 25 skills × richer anatomy |
| Checklist items | 198 (5.8 per practice) | Adequate, but no anti-rationalization or red flags |
| Practices declaring `enforces` | 21 of 34 | 13 practices advise behaviour no requirement or gate covers |
| Catalog requirements | 27; **21** enforced by a practice | 6 requirements (`core.primary-journey`, `core.domain-invariants`, `ai.guardrails`, `delivery.audit-trail`, `data.uploads`, `mobile.offline`) have no teaching practice |
| Routing rules | 34, of which 12 are `always: true` | The packet skeleton is unconditional; the rest discriminate |
| Library discoverability | **self-recall@1 100%** (34/34 practices rank first for their own title via the real MCP search) | Works |
| Trigger collisions | **8 → 0** after this pass | Two practices claiming "rollback" or "coverage" is a routing bug, now fixed |
| Dead weight | 0 practices never selected across 36 profiles | Works |
| **Packet specificity** | **90% of a tier-3 API packet is byte-identical to a different product's packet** (847/941 lines; `AGENTS.md` 98% identical, `00-constitution.md` 97%) | **This is the "boilerplate" you are feeling, quantified** |

That last row is the whole argument in one number. A physiotherapy booking service and an insurance claims API receive the same 847 lines. The 94 lines that differ carry the requirement set, the gates, the stack and a few domain terms.

Two consequences follow directly:

1. **The packet is doing two jobs with one artefact.** A *constitution* is legitimately stable; a *specification* must not be. Merging them makes 90% of the bundle noise for any given product, and the evidence says noise costs tokens and attention.
2. **What differentiates us is not on disk.** The selection, the rigor score, the skipped-with-reason list, the anchors, the guard — those are the product. The documents are the *rendering* of it, and we have been shipping the rendering.

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

1. **Split constitution from specification.** The stable layer (laws, DoD, gates) is written once per organisation and *referenced*, not regenerated per project; the per-project layer carries only what differs.  
   *Acceptance:* two unrelated tier-3 packets share <35% of lines, and `verify` still passes for both.
2. **Per-practice specificity obligations.** Every practice states what it would change *in this product* — derived from the profile's idea, not a generic paragraph.  
   *Acceptance:* a packet contains at least one product-specific sentence per selected practice, checked mechanically.
3. **Anti-rationalization and red flags in all 34 practices.** The two sections that make skills stick.  
   *Acceptance:* every `SKILL.md` has both; the eval checks for them.
4. **Close the enforcement gap.** A practice that enforces nothing either gains a requirement/gate or is marked advisory.  
   *Acceptance:* `eval-library` reports 0 practices with no consequence, or an explicit `advisory: true` with a reason.

### Tier 2 — makes the library a system rather than a list

5. **Presets/overlays** (Spec Kit's best idea): organisation → domain → team layering over our catalog and routing, without forking JSON.  
   *Acceptance:* an overlay adds one requirement and one gate to a compiled packet, with provenance recorded in `spec.json`.
6. **Archive step for `vld change`** (OpenSpec's best idea): a delta that is applied is *folded back* into the packet's source of truth, with history preserved.  
   *Acceptance:* apply → archive → recompile is idempotent; history shows the merge.
7. **Executable gates.** For each tier, ship the *mechanism* where one exists: dependency-cruiser/ArchUnit rule fragments, OPA/Conftest policies, contract-test skeleton, mutation-test config.  
   *Acceptance:* a generated packet contains at least one runnable enforcement file per applicable gate, and `spec-check` runs them.
8. **EARS-shaped requirement statements** for the automated catalogue, so each maps to a scenario mechanically.  
   *Acceptance:* every catalogue requirement parses against the five EARS patterns; `verify` rejects one that does not.

### Tier 3 — the thing that makes all claims checkable

9. **The evaluation harness.** Two axes, both needed: *library* (routing precision/recall, discrimination — the deterministic rung now exists in `eval-library.mjs`) and *outcome* (the same ticket built with no spec, a generic spec and this packet; scored on merge rate, review defects, drift and cost).  
   *Acceptance:* the outcome harness runs on ≥20 tasks, reports with/without deltas, and `README` quotes its numbers or stops making claims.
10. **Model-in-the-loop routing eval** for the MCP layer: labelled prompts → expected practices, precision and recall with CI thresholds (recall ≥0.7, precision ≥0.9), because metadata changes move recall by ~20 points.  
    *Acceptance:* a change to a practice description that breaks routing fails CI.

### What I would *not* build

- A prettier document renderer, until tier 1 is done.
- Guidance-mode hooks or an IDE.
- More than ~40 practices. The ceiling is the point; depth beats breadth.
- Spec-as-source codegen.

---

## 9. Verdict

**"Thin and boilerplate": correct about the artefacts, wrong about the mechanism.**

- Thin: yes — 34 practices at ~64 lines against 25-skill libraries that ship evals, anti-rationalization tables and review personas; no presets, no archive, no executable gates, no EARS, no outcome harness.
- Boilerplate: measurably yes — 90% of a packet is identical across unrelated products, and the evidence says that specific property (bulk generic context) is neutral-to-harmful for agent success.
- Wrong: the selection-with-reasons, risk-derived rigor, skip/defer accounting, stable ids, anchor enforcement and the shipped guard are not boilerplate, are not in any surveyed tool together, and are backed by the one study that measured the thing we claim (specification completeness → 88.6% vs 55.8%).

The fastest way to feel the difference is to make the packet *smaller and more specific* while making the enforcement *larger and more executable*. That is tier 1 and tier 2 above, and it is roughly the work of a few focused weeks, not a rewrite.
