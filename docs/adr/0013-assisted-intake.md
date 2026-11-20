# ADR 0013: Evidence-Grounded Assisted Intake Upstream of the Deterministic Compiler

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** VLD Core & Runtime Maintainers
- **Related:** ADR 0009 (Optional SDK Extension Boundary), ADR 0011 (Workspace Confinement), Roadmap P1.4 & P1.5

## Context

`vld plan` and `vld compile` are deterministic by design: identical `profile.json` inputs always emit byte-identical specification packets without network access or probabilistic inference. In practice, however, users begin with unstructured prose — a paragraph, a product brief, or meeting notes — not a completed `profile.json`. Forcing manual translation caused two failure modes observed during adversarial audit:

1. Users left `profile.risks` empty or omitted `profile.regulation` while describing children's chat, Stripe flows, or EU clinical scheduling in `profile.idea`, silently receiving a lower rigor tier.
2. Users stated domain invariants and latency expectations in prose that either went unextracted or contradicted each other.

Putting an LLM inside `vld plan` or `vld compile` would destroy determinism, break offline reproducibility, and allow model hallucinations to silently lower rigor.

## Decision

Introduce an explicit, pre-compiler assisted intake stage (`vld intake` and `vld intake accept`, implemented in `factory/lib/intake.mjs`) that sits strictly upstream of `profile.json`:

1. **Untouched compiler purity.** `factory/lib/intake.mjs` and `factory/lib/model-client.mjs` live in the runtime boundary (`core-boundary.test.mjs`). `vld plan`, `vld compile`, and `vld verify` never invoke a model.
2. **Verbatim evidence contract.** Every field proposed in `profile.draft.json` has the shape `{ value, evidence, confidence, source, status, question }`. Any non-empty `evidence` string supplied by a model is verified as an exact case-insensitive substring of the input text; fabricated or paraphrased quotes are rejected, stripped, and downgraded to `status: "needs-human"` with confidence capped at `0.35`.
3. **Independent deterministic reconciliation.** Intake always runs the lexical risk/regime scanner (`factory/lib/risk-hints.mjs`), domain noun/actor extractor (`factory/lib/domain-hints.mjs`), and EARS cross-rule contradiction linter (`factory/lib/rule-lint.mjs`) over the exact same text. Whenever the model omits or denies a risk flag or regulatory regime that the deterministic scanner matched, the draft records a disagreement, marks the field `needs-human`, and never silently suppresses the risk.
4. **First-class offline mode.** When `--offline` is passed or no model provider key is configured, `vld intake` produces a complete `profile.draft.json`, `intake-report.json`, and bounded question list (`<= 7` questions ordered by tier impact, with dependent follow-ups) using deterministic analysis alone.
5. **Auditable promotion gate (`vld intake accept`).** Drafts cannot be compiled directly until promoted to `profile.json`. Promotion refuses unresolved `needs-human` items unless answered or explicitly waived with reason and expiry date, stamps `profile.provenance[field]` (`user | inferred | default | waived`) and timestamped answers, verifies strict `vld plan` readiness, and records request/response digests and usage in `intake-report.json` and `.vld/evidence.jsonl`.

## Consequences

- **Positive:** Users go from messy prose (`vld intake "SaaS for EU clinics..."`) to a tier-accurate, overlay-complete, strict-passing `profile.json` in `<= 7` targeted questions, with or without an API key.
- **Positive:** Hallucinated model quotes cannot invent authority, and model omissions cannot bypass deterministic risk gates.
- **Trade-off:** Assisted intake adds one explicit review step (`profile.draft.json` -> `vld intake accept` -> `profile.json`) rather than silently mutating `profile.json`. That friction is intentional: the human remains the authority over risk waivers and regulatory scope.
