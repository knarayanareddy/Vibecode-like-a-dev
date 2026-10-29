---
id: domain.bounded-contexts
title: Bounded contexts and module seams
module: domain
summary: Draw boundaries where meaning changes, then make the dependency direction mechanical.
tier_min: 1
cost: medium
priority: 3
tags: [ddd, boundaries, modules, coupling, contexts]
triggers: [bounded context, module, boundary, coupling, separation]
enforces: [auth.tenant-isolation]
artifacts: [02-domain-model.md, 03-architecture.md]
---

# Bounded contexts and module seams

The same word means different things in different parts of a system. `Product` in a catalogue has images and copy; `Product` in fulfilment has weight and dimensions. Teams that share one `Product` model end up with 60 nullable columns and a class nobody dares change.

A bounded context is a boundary inside which one model is consistent. Inside it, words have exactly one meaning. Across boundaries, you translate explicitly.

## When this applies

Tier 1 and above, or any time two subsystems use the same word for differently shaped data. For a single-screen prototype, one context is correct and pretending otherwise is ceremony.

## The practice

1. **List the words that change meaning** as you cross the product. Each cluster of consistent meaning is a candidate context.
2. **Give each context one reason to change** and one owner (a person, or the same person wearing a different hat).
3. **Decide the interaction**:
   - Synchronous call to a declared interface (simple, coupled in time).
   - Domain event (decoupled, eventually consistent, needs idempotency).
   - Shared kernel (a small set of types both sides treat as immutable; keep it tiny).
4. **Forbid shared tables.** A context owns its storage. Reading another context's table is the coupling you were trying to avoid, hidden in SQL.
5. **Enforce the direction** with an import rule, not a review habit.

A workable default for a new product:

```
transport → application → domain ← adapters
                ↓
        other contexts via declared interfaces only
```

## Checklist

- [ ] Each context has a one-line responsibility and a list of what it owns.
- [ ] No context imports another context's internals; only its published interface or events.
- [ ] Every cross-context read is a call or an event, never a joined table.
- [ ] The allowed import graph is written down and checked by tooling.
- [ ] Shared kernel is small enough to read in one sitting.

## Anti-patterns

- **One context per microservice on day one.** You have split the model before you understand it, and you now need distributed transactions for a CRUD screen.
- **A "shared" package that becomes a second monolith.** It will contain everything within a year.
- **Boundaries by technical layer.** `controllers/`, `services/`, `repositories/` is not a model; it is a stack trace.
- **Boundaries by team org chart** when the product has one team.

## Why it works

Boundaries are where change is absorbed. A context with a declared interface can be replaced, rewritten or extracted. Without boundaries, every change is global, and global changes are what make generated codebases unreviewable: the diff touches fourteen directories because there was nowhere for the change to live.

## Cost and when to skip

Medium. Boundaries cost indirection and a translation layer. Skip for prototypes and single-purpose scripts; adopt at tier 1 and above, especially with authentication, billing or tenancy, where isolation is a correctness property rather than a preference.
