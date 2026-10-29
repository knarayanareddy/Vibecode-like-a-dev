---
id: domain.aggregates-and-invariants
title: Aggregates and invariants
module: domain
summary: Name the consistency boundary, list what must always be true, and turn each invariant into a test.
obligation: "In {project}, each rule that makes {aPrimary} valid names its consistency boundary and has one test that fails when the rule is broken."
tier_min: 0
cost: medium
priority: 2
tags: [ddd, aggregate, invariants, consistency, transactions]
triggers: [aggregate, invariant, transaction boundary, consistency, state machine]
enforces: [payments.correctness, core.domain-invariants]
artifacts: [02-domain-model.md]
---

# Aggregates and invariants

Most "data corruption" bugs are not corruption. They are two writes that should have been one decision, and an invariant nobody wrote down. Code that looks fine produces impossible states: a refund larger than its charge, a session that is both revoked and active, a tenant whose rows belong to another tenant.

An aggregate is a cluster of objects that must be consistent together. An invariant is a statement that must hold after every operation on it. Together they tell you where transactions belong and what to test.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, each rule that makes {aPrimary} valid names its consistency boundary and has one test that fails when the rule is broken.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Always. Even a small product has at least one invariant, and it is usually the thing the product is for.

## The practice

1. **Find the transactional boundary.** If two pieces of state must change together or not at all, they belong to the same aggregate.
2. **Pick one root per aggregate.** Outside code holds an identifier and calls methods on the root. No reaching into children.
3. **Write invariants as sentences a test could falsify.**
   - Good: "Sum of debits minus credits equals zero per settled transaction."
   - Useless: "Data must be valid."
4. **Make illegal states unrepresentable** where the language allows it: enums instead of magic strings, value objects instead of primitives, constructors that refuse invalid combinations.
5. **Return typed errors, not exceptions for control flow.** `InsufficientFunds` is a domain outcome; `throw new Error('oops')` is a lost fact.
6. **Emit events after the state change commits**, never before.

## Checklist

- [ ] Each aggregate has a named root and a short reason to exist.
- [ ] Every invariant has at least one test that fails if it is violated.
- [ ] State machines list legal and illegal transitions explicitly.
- [ ] Money is integer minor units plus currency. Time is an injected clock.
- [ ] Concurrency: either version-checked writes (optimistic) or a documented serialisation point.
- [ ] No aggregate spans two services or two database transactions.
- [ ] Each invariant that spans two objects is either inside one aggregate or explicitly made eventual.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- An invariant with no failing test.
- An aggregate reaching into another context's table.
- A state machine that lists no illegal transitions.
- Time read from the environment inside the domain.
- One transaction spanning two aggregates that must agree immediately.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The database enforces it. | It enforces constraints, not the two-step rule. | Test the invariant in the domain. |
| An invariant test is a unit test of the setter. | That tests the mechanism, not the rule. | Assert the rule as a sentence. |
| Concurrency is an edge case. | It is the default as soon as two people act on the same record. | Version-checked writes or a documented serialisation point. |
| The aggregate can span the parent and the child. | Then you have two boundaries pretending to be one. | Split and make the change eventual. |
| Money as a float is fine for now. | It is not fine at any time. | Integer minor units plus currency. |

## Anti-patterns

- **One aggregate for the whole system.** Everything is a transaction with everything else; throughput dies and the model says nothing.
- **Aggregate per table.** No invariants survive, so the rules end up in services.
- **Public setters everywhere.** `setStatus()` allows any transition, so the state machine exists only in the reviewer's head.
- **Invariants checked only in the UI.** The first direct API call proves they were never real.

## Why it works

Invariants are the only specification of behaviour that a machine can check. They also survive refactoring: a UI rewrite does not change "a captured payment cannot be captured twice". Property-based and mutation tests both need these sentences to exist; without them, tests can only assert that code ran.

## Cost and when to skip

Medium: it requires thinking before typing, which is precisely what agents skip. Skip the formal aggregate shape for a prototype, but never skip writing the invariants down — they are two lines of prose with a very high return.
