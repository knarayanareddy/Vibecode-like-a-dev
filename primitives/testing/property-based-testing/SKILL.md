---
id: testing.property-based-testing
title: Property-based testing for invariants
module: testing
summary: Generate thousands of inputs to check invariants your example tests only sampled.
obligation: "In {project}, the invariants that must hold for every {primary} — not just the examples in the brief — are checked with generated inputs, and a failing seed is replayed in the suite."
tier_min: 3
cost: high
priority: 7
tags: [property-based-testing, generative, invariants, hypothesis, fast-check]
triggers: [property based, generative testing, hypothesis, fast-check, generated inputs, edge cases]
enforces: [payments.correctness]
artifacts: [05-verification.md]
---

# Property-based testing

Example tests check the cases you thought of. In money, permission and scheduling logic, the bugs live in the cases you did not think of: the negative amount, the empty list, the duplicate identifier, the date at the DST boundary.

Property-based testing generates those cases from a description of valid input, then shrinks a failure to the smallest input that reproduces it.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the invariants that must hold for every {primary} — not just the examples in the brief — are checked with generated inputs, and a failing seed is replayed in the suite.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 3, and any tier where money, permissions or state machines are involved. Not for UI or transport code.

## The practice

1. **Write the invariant as a property**, not an example:
   - `sum(entries) == 0` for any ledger whose payments are settled.
   - `apply(then revert) == identity` for any state change that claims reversibility.
   - `authorize(actor, resource)` never returns allow when the actor lacks the required grant.
   - serialisation round-trips: `parse(print(value)) == value` for any valid value.
2. **Describe the input domain** with a generator that can only produce valid values. Invalid inputs belong in separate tests, not in the same generator.
3. **Run enough cases** to be meaningful (the default 100 is usually a floor, not a target), and seed failures into the regression suite.
4. **Shrink and commit the minimal counterexample** as an example test, so the failure is fast to reproduce.
5. **Keep properties deterministic**: fix seeds in CI, record the seed on failure.

## Checklist

- [ ] Each core invariant has a property, or a written reason why it cannot be expressed as one.
- [ ] Generators produce only valid domain values; validation is tested separately.
- [ ] Failing seeds are recorded and replayed in the suite.
- [ ] Properties assert a relationship, not a fixed expected output.
- [ ] Runtime is bounded; slow generators are narrowed.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A property asserting a hard-coded output.
- Generators that produce invalid values.
- No seed replay for a found failure.
- A property with no example test beside it.
- A disabled property with no note.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The examples cover the invariant. | They cover the examples you thought of. | Generate inputs instead. |
| Generators should produce anything. | Then you test the validator, not the rule. | Generate valid domain values. |
| Fixing the failing case is enough. | It will regress. | Record the seed and replay it. |
| Properties can assert the same values as the examples. | Then they are examples with extra steps. | Assert a relationship, not a constant. |
| Slow generators are acceptable. | Then the suite gets skipped. | Narrow them. |

## Anti-patterns

- **Properties that are just examples in disguise.** `assert add(2,3) == 5` for any input is not a property.
- **Generators that produce mostly invalid data.** You spend your time testing the validator.
- **Asserting against a reimplementation.** Two copies of the same logic agree with each other and both are wrong.
- **Unbounded runtimes in CI.** Long property suites get moved to nightly and then ignored.

## Why it works

Generative tests explore the input space that example tests sample, which is exactly where subtle domain bugs live. In a payments or permissions system the cost of one missed edge case exceeds the cost of the whole suite, and this is the cheapest way to reach the edges.

## Cost and when to skip

High: an unfamiliar discipline, slower suites, and occasional flakiness from time or ordering. Restrict it to the invariants that would cause real harm, and keep example tests for everything else.
