# Bootstrap prompt (agent-driven path)

Use this when you cannot run the CLI — for example inside a chat-only builder, or when you want an agent to author the packet directly in your product repository.

**Trade-off, stated plainly:** the CLI path is deterministic, reproducible and verified against policy. This path is faster to start and up to the model's judgement. Prefer the CLI when you can; use this when you cannot, and expect to review the selection.

---

## The prompt

> You are setting up a software factory specification for a new project. Do not write application code. Your only output is a specification packet.
>
> **Inputs**
> - Idea: `<paste one paragraph: who it is for, what it does, what they do today instead>`
> - Factory repository: `https://github.com/knarayanareddy/Vibecode-like-a-dev`
> - Declared kind (web-app, api, cli, library, data-pipeline, mobile, agent, automation): `<kind>`
> - Stage (prototype, mvp, internal-tool, production): `<stage>`
>
> **Step 1 — Read the rules, not the whole library.**
> Read, in this order:
> 1. `factory/policy.json` — tier thresholds, risk weights, stage caps, gates, size ceilings.
> 2. `factory/routing.json` — every practice with the predicate that selects it and the reason it exists.
> 3. `primitives/index.json` — the catalog. Open an individual `SKILL.md` only when you are about to apply it.
> 4. `factory/catalog/requirements.json` — requirement templates with acceptance criteria.
>
> **Step 2 — Derive the rigor tier.** Score the project with the signals in `policy.json` (money +3, regulated +3, tenant isolation +2, large scale +2, personal data / destructive writes / public surface / integrations / production +1 each). Apply the stage cap unless a hard risk (payments, regulated) is present. State the score, the signals and the resulting tier. Do not skip this step: it decides how much of the rest you may use.
>
> **Step 3 — Select practices.** For each rule in `routing.json`, evaluate the predicate against the project and the tier. Select the practice only if the predicate is true and `tier_min <= tier`. Respect the tier's practice ceiling. For each selected practice, record one line: the id, and why it applies here. For each skipped or deferred one, record the reason. Never drop a practice silently.
>
> **Step 4 — Select requirements.** For each requirement in `catalog/requirements.json` whose predicate is true, emit it with its acceptance criteria, its failure path and a verification method. Assign ids `REQ-001`… in catalog order. Do not invent new requirements unless a required behaviour is genuinely missing from the catalog; if you do, mark it `custom: true` and give it a failure path.
>
> **Step 5 — Write the packet** in the structure below, under `specs/`. Keep the whole packet under the tier's line ceiling from `policy.json`. Facts you do not know must be written as `_confirm_` or as an open question — never invented.
>
> ```
> specs/
>   AGENTS.md               entry point: read order, commands, hard rules, stop conditions
>   00-constitution.md      ten laws, definition of done, change protocol, selected practices with reasons, deliberate omissions
>   01-product-brief.md     user, job, scope, non-goals, measures, assumptions, open questions
>   02-domain-model.md      ubiquitous language, bounded contexts, aggregates, invariants, state machines, events
>   03-architecture.md      style decision with rejected alternatives, import rules, stack, ADRs, fitness functions
>   04-contracts.md         interface inventory, conventions, error envelope, status codes, contract tests
>   05-verification.md      test layers, traceability table, gates, drift guard, review checklist
>   06-delivery-plan.md     phases with exit criteria, commit protocol, stop rules, risks
>   07-agent-handoff.md     paste-ready brief, the loop, hard rules, escalation, reviewer prompt
>   spec.json               machine-readable: rigor, primitives[], requirements[], gates[], docs[]
>   spec-check.mjs          copy verbatim from factory/templates/spec-check.mjs
> ```
>
> **Step 6 — Make it enforceable.** Every automated requirement gets an `@req REQ-xxx` anchor in the test that will prove it, recorded in `spec.json` as `anchor`. Requirements start with `"status": "todo"`. Wire `node specs/spec-check.mjs --repo .` into CI, with `--strict` in release CI.
>
> **Rules for this task**
> - Do not write application code, install dependencies, or scaffold a repo.
> - Do not use a practice that is above your tier, even if it seems useful.
> - Do not pad. If a section has nothing to say beyond the template, write one honest sentence about what must be decided.
> - Report at the end: tier and score, practices selected/deferred, requirements emitted, packet line count, and the three questions a human must answer before implementation starts.

---

## After the agent responds

1. Check the tier arithmetic yourself. It is the cheapest place to catch a wrong plan.
2. Check that the deferred list is plausible for your product; if not, the profile is wrong, not the model.
3. Answer the open questions in the brief before Phase 2.
4. Run `node specs/spec-check.mjs --repo .` — if the agent did not ship the script, copy it from `factory/templates/`.
5. If you can run the CLI, regenerate the same profile with it and diff the two packets. Differences are where the model's judgement replaced policy.
