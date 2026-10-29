---
id: architecture.fitness-functions
title: Fitness functions for boundaries
module: architecture
summary: Turn architectural claims into checks that fail the build, or accept that they are decoration.
obligation: "In {project}, the claim that {primary} rules stay free of {db} and framework code is a check that fails the build, not a sentence in a document."
tier_min: 2
cost: medium
priority: 6
tags: [fitness-functions, architecture-testing, boundaries, lint, automation]
triggers: [fitness function, architecture test, boundary check, import rule, archunit]
enforces: [ui.design-tokens]
artifacts: [03-architecture.md, 05-verification.md]
---

# Fitness functions for boundaries

Every architecture document claims boundaries. Almost none of them are true after six months, because a boundary that only exists in a document is enforced by memory, and memory loses to deadlines.

A fitness function is an automated check of an architectural property. It converts "we don't do that here" into a failing build.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the claim that {primary} rules stay free of {db} and framework code is a check that fails the build, not a sentence in a document.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 2 and above. At lower tiers, keep the two cheapest checks (domain purity and the spec check) and skip the rest.

## The practice

Pick a small set, each with a real failure mode:

| Property | Check | Fails when |
| --- | --- | --- |
| Domain purity | import rule on domain modules | a handler or driver is imported into the domain |
| Context isolation | import rule between contexts | one context imports another's internals |
| Design tokens | regex or lint rule | a raw hex colour or pixel spacing appears |
| Contract agreement | contract test | response shape diverges from the contract |
| Requirement anchors | spec check | a requirement loses its test |
| File size | lint rule | a module passes ~300 lines |
| Dependency direction | dependency-cruiser / import-linter | an import points outward |

Rules for writing them:

- The failure message must name the property and the fix, not just the file.
- One check per property. Two overlapping checks produce two places to argue with.
- Ratchet, do not big-bang: allow an explicit exceptions file with a reason and an owner, and make the file shorter over time.
- Put them in the same CI job as tests so they cannot be skipped.

## Checklist

- [ ] At least domain purity and requirement anchors are automated.
- [ ] Each check prints the violated property and the remedy.
- [ ] Exceptions are explicit, dated and few.
- [ ] The check runs on every pull request, not nightly.
- [ ] A new boundary is added to the check in the same change that introduces it.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A boundary in the documentation with no corresponding check.
- An exemption list that only grows.
- A check that names the violating file but not the remedy.
- The document mentions modules the import rule does not know about.
- The rule was not updated when the newest module was added.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The architecture is in the document. | A document cannot fail, so the boundary erodes. | Turn the claim into a check. |
| Grep is too crude for this. | Crude and running beats precise and imagined. | Start with grep, upgrade when it gets noisy. |
| The check was noisy, so we exempted it. | Undated exemptions are permanent. | Date every exemption and review it. |
| Nightly is enough. | By the time it runs, the boundary error is merged. | Run it on every pull request. |
| We will add the rule once the module is stable. | New modules are exactly where erosion starts. | Add the rule in the change that introduces the boundary. |

## Anti-patterns

- **A hundred lint rules.** Nobody can tell which ones matter; they get disabled wholesale.
- **Architecture tests that assert folder names.** They break on refactors without catching a violation.
- **Checks that only warn.** A warning in CI is a comment nobody reads.
- **Testing the framework.** Asserting that the ORM saves rows tests the ORM.

## Why it works

Structure erodes one convenient import at a time, and each individual import is defensible. A mechanical check is the only reviewer that is present for every commit, has no context to trade away, and cannot be persuaded. This is also how you make an agent's output reviewable: the boundary holds whether or not the agent understood it.

## Cost and when to skip

Medium: half a day for the first two checks, minutes for each subsequent one. Below tier 2 the spec check and a single import rule are usually enough.
