# ADR-0001: The plan is a deterministic compiler, not a model call

**Status:** accepted

## Context

The obvious way to build this tool is to ask a model to read the idea and the primitive library and produce a specification. That is also how every other tool in the category behaves, and it produces three problems we measured immediately while prototyping:

1. **Non-reproducibility.** The same idea yields different practice selections on different runs, so a plan cannot be reviewed as a diff or cached in CI.
2. **Unauditability.** When a practice is selected, nothing records the predicate that selected it. A reviewer cannot tell whether the omission of a security practice was a judgement or a sampling artefact.
3. **Cost and latency before any code exists.** Planning consumed tokens for a decision that is, in the end, a table lookup over declarative rules.

The alternative — encode selection as data, and reserve the model for authoring project-specific prose — is less impressive in a demo and strictly better to review.

## Decision

Planning and selection are pure functions over five inputs: the profile, `factory/policy.json`, `factory/routing.json`, `factory/catalog/requirements.json`, and `primitives/index.json`. No network, no model, no clock, no randomness. Given the same inputs, `vld compile` produces a **byte-identical** packet.

Project-specific content (the idea, the user, the non-goals, the open questions) is authored by the human in the profile and by the agent in the product repository. The compiler never invents facts about the product; it emits candidates marked `_confirm_` and puts invented specifics behind explicit prompts.

An agent may still author a packet without the CLI (see `prompts/bootstrap.md`), but that path is documented as second-class: it is not reproducible and cannot be verified against the policy.

## Consequences

**Gained**

- Plans are reviewable in a pull request and diffable across versions of a project.
- Regenerating a packet after a policy change produces a diff that only contains the real consequences of the change.
- Selection can be tested (45 tests), including negative cases: an unreachable primitive, a duplicate route, a practice quoted above its tier.
- Zero cost to iterate on tiering before spending anything on generation.

**Given up**

- The compiler cannot infer nuance from a vague profile. If the profile says `mvp` and the product is in fact regulated, the output is wrongly light — the `risks` fields exist precisely because intent cannot be guessed.
- Project-specific content is thinner than a model would write. That is deliberate: an invented definition of your domain term is worse than a blank marked `_confirm_`.
- The `--quick` path (one sentence in, packet out, model-written) does not exist yet, and adding it later will need to preserve the auditability property or be a separate, clearly-labelled mode.

## Alternatives rejected

- **Model-generated plan with a JSON schema.** Reproducible only with temperature 0 and a pinned model, still unauditable, still costs tokens per iteration.
- **Hybrid: model proposes, rules filter.** The filter becomes the decision anyway; the model is decoration.
- **Hand-maintained per-project checklists.** That is where the category started, and it does not scale past a handful of projects.
