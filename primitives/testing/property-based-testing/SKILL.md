---
id: testing.property-based-testing
title: Property-based testing for invariants
module: testing
summary: Generate thousands of inputs to check invariants your example tests only sampled.
tier_min: 3
cost: high
priority: 7
tags: [property-based-testing, generative, invariants, hypothesis, fast-check]
triggers: [property based, generative testing, hypothesis, fast-check, invariant, edge cases]
enforces: [payments.correctness]
artifacts: [05-verification.md]
---

# Property-based testing

Example tests check the cases you thought of. In money, permission and scheduling logic, the bugs live in the cases you did not think of: the negative amount, the empty list, the duplicate identifier, the date at the DST boundary.

Property-based testing generates those cases from a description of valid input, then shrinks a failure to the smallest input that reproduces it.

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

## Anti-patterns

- **Properties that are just examples in disguise.** `assert add(2,3) == 5` for any input is not a property.
- **Generators that produce mostly invalid data.** You spend your time testing the validator.
- **Asserting against a reimplementation.** Two copies of the same logic agree with each other and both are wrong.
- **Unbounded runtimes in CI.** Long property suites get moved to nightly and then ignored.

## Why it works

Generative tests explore the input space that example tests sample, which is exactly where subtle domain bugs live. In a payments or permissions system the cost of one missed edge case exceeds the cost of the whole suite, and this is the cheapest way to reach the edges.

## Cost and when to skip

High: an unfamiliar discipline, slower suites, and occasional flakiness from time or ordering. Restrict it to the invariants that would cause real harm, and keep example tests for everything else.
