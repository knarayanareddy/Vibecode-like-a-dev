---
id: architecture.fitness-functions
title: Fitness functions for boundaries
module: architecture
summary: Turn architectural claims into checks that fail the build, or accept that they are decoration.
tier_min: 2
cost: medium
priority: 6
tags: [fitness-functions, architecture-testing, boundaries, lint, automation]
triggers: [fitness function, architecture test, boundary check, import rule, archunit]
enforces: [ui.design-tokens]
artifacts: [03-architecture.md, 05-verification.md]
gates:
  - id: G-FIT-DOMAIN-PURE
    statement: Domain modules contain no framework, database or vendor imports, checked in CI.
---

# Fitness functions for boundaries

Every architecture document claims boundaries. Almost none of them are true after six months, because a boundary that only exists in a document is enforced by memory, and memory loses to deadlines.

A fitness function is an automated check of an architectural property. It converts "we don't do that here" into a failing build.

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

## Anti-patterns

- **A hundred lint rules.** Nobody can tell which ones matter; they get disabled wholesale.
- **Architecture tests that assert folder names.** They break on refactors without catching a violation.
- **Checks that only warn.** A warning in CI is a comment nobody reads.
- **Testing the framework.** Asserting that the ORM saves rows tests the ORM.

## Why it works

Structure erodes one convenient import at a time, and each individual import is defensible. A mechanical check is the only reviewer that is present for every commit, has no context to trade away, and cannot be persuaded. This is also how you make an agent's output reviewable: the boundary holds whether or not the agent understood it.

## Cost and when to skip

Medium: half a day for the first two checks, minutes for each subsequent one. Below tier 2 the spec check and a single import rule are usually enough.
