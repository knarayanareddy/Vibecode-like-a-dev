---
id: architecture.style-selection
title: Architecture style selection
module: architecture
summary: Default to a modular monolith, and make distributed complexity justify itself against a measured constraint.
tier_min: 0
cost: low
priority: 2
tags: [architecture, monolith, microservices, style, modules]
triggers: [architecture, monolith, microservices, structure, folder layout]
enforces: []
artifacts: [03-architecture.md]
---

# Architecture style selection

Agents produce the architecture of their training data. Ask for a todo app and there is a reasonable chance you get a service layer, a repository layer, a domain layer, an event bus and a Docker Compose file with four containers. It runs. It is also four times the operational surface of the product, and every future change has to cross it.

The right question is not "which architecture is best". It is "what is the smallest structure that keeps the rules findable and the boundaries changeable at this stage".

## When this applies

Always, but the answer changes with stage. A prototype earns one folder; a tier 2 product earns modules with enforced import rules.

## The practice

Default to a **modular monolith**: one deployable, several modules, boundaries checked by tooling. Then vary by kind:

| Kind | Default style | Reason |
| --- | --- | --- |
| web-app / api | Modular monolith, hexagonal inside | One transaction boundary, one deploy, clear seams |
| cli | Hexagonal single artifact | Core is testable without spawning a process |
| library | Stable core, narrow surface | The surface is the product |
| data-pipeline | Staged pipeline with explicit contracts | Replayability and data dependencies, not services |
| agent / automation | Hexagonal task runner | Model and tool calls are adapters |

Promote to services only when one of these is *measured*:

- Two modules need different scaling curves and the difference costs real money.
- Two teams need independent release cadence (a team boundary, not a preference).
- A module must run in a different trust or compliance zone.
- Deploy blast radius is unacceptable and cannot be reduced by flags or canaries.

None of those is "it feels more scalable". If you cannot name the measurement, you are buying distributed complexity with an unmeasured currency.

## Checklist

- [ ] The chosen style is written down with the alternatives and why they were rejected.
- [ ] Module boundaries are enforced by an import rule, not by convention.
- [ ] There is exactly one deployable in v1, or a written reason why not.
- [ ] The folder structure names domains, not framework layers.
- [ ] The document states what would trigger a change of style.

## Anti-patterns

- **Framework-shaped folders.** `controllers/`, `services/`, `repositories/` hides the model and invites anaemic services.
- **Microservices for a single team.** You get network failure modes and distributed transactions in exchange for nothing measurable.
- **"Clean architecture" as four folders of pass-through.** If every call site is a one-line delegation, the layers are tax.
- **Copying the architecture of a company with 500 engineers.** Their constraints are not yours.

## Why it works

Structure is a cost paid on every change. The smallest structure that keeps rules findable minimises that cost while the product is still changing shape. Boundaries you enforce mechanically can be extracted later; boundaries you only drew on a diagram cannot, because the code has already leaked across them.

## Cost and when to skip

Low: an hour of decisions and one import-boundary rule. Skipping it does not save the hour, it defers it to the first refactor, at a much higher price.
