---
id: testing.mutation-testing
title: Mutation testing
module: testing
summary: Measure assertion strength by breaking the code on purpose; coverage cannot tell you this.
obligation: "In {project}, assertion strength on the {primary} rules is measured by breaking them on purpose, and the score only moves up."
tier_min: 2
cost: high
priority: 6
tags: [mutation-testing, assertions, test-quality, stryker, mutmut]
triggers: [mutation testing, mutation score, test quality, stryker, mutmut, surviving mutant]
enforces: []
gates: [G3-MUTATION]
artifacts: [05-verification.md]
---

# Mutation testing

Coverage answers "was this line executed". It does not answer "would a test notice if this line were wrong". A suite at 95% coverage can be almost entirely decorative: every line runs, no assertion distinguishes correct from incorrect.

Mutation testing answers the second question. It changes the code in small ways — flips a comparison, inverts a boolean, removes a call — and checks whether a test fails. A change that survives is a hole in your assertions.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, assertion strength on the {primary} rules is measured by breaking them on purpose, and the score only moves up.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 2 and above, on the **domain layer only**. Applying it to controllers and adapters produces noise and a large bill.

## The practice

1. **Install a mutation runner** (Stryker for JS/TS, mutmut or cosmic-ray for Python, PIT for Java).
2. **Scope it** to domain modules. Exclude generated code, migrations, wiring and DTOs.
3. **Establish a baseline** — do not chase a target on day one.
4. **Ratchet**: the CI threshold is the current score plus nothing, and it only moves up.
5. **Triage survivors in this order:**
   - Equivalent mutant (the change cannot alter behaviour): suppress with a one-line reason.
   - Missing assertion: fix the test.
   - Genuinely untested branch: write the test.
   - Unreachable code: delete it.
6. **Time-box** a run: incremental mode on changed files is what keeps it usable in CI.

## Checklist

- [ ] Mutation run is scoped to domain code and finishes in CI's budget (or runs nightly on changed files).
- [ ] Threshold ratchets upward and is stored in config.
- [ ] Every suppression has a written reason.
- [ ] Survivors are triaged, not ignored, at least once per release.
- [ ] Assertions are specific enough that a mutated return value fails a test.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A threshold with no recorded baseline.
- Suppressions with no reason.
- The run scoped to files nobody edits.
- Survivors never triaged.
- The same score for three releases.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| Coverage is high, so we are fine. | Coverage measures execution, not detection. | Measure whether the assertions notice. |
| Mutation testing is too slow. | Scope it to the domain, or to changed files. | Budget it instead of skipping it. |
| Equivalent mutants are noise, so we ignore survivors. | Then the threshold means nothing. | Suppress with a written reason. |
| The score can wait for the next release. | The score is how you know the tests weakened. | Ratchet from the first baseline. |
| We lowered the threshold once. | Then it is not a threshold. | Only upward. |

## Anti-patterns

- **Mutating everything.** Test suites, configs and adapters generate hundreds of equivalent mutants and no signal.
- **A percentage target set before a baseline.** You will either game it or spend a week on noise.
- **Suppressing without reasons.** The suppression file becomes the new set of untested rules.
- **Using the score as a performance metric.** It measures assertion quality on the code you pointed it at, nothing more.

## Why it works

It is the closest automated proxy for "would this test catch a bug", because it *is* a bug, injected mechanically. For agent-written tests, which tend to assert shape rather than behaviour, mutation testing is the fastest way to find the difference between a test that runs and a test that checks.

## Cost and when to skip

High: slow runs, a dozen false positives, and genuine work to fix weak assertions. Skip below tier 2, and skip it entirely for UI and glue code. Use it where the rules are: money, permissions, state machines, pricing, scheduling.
