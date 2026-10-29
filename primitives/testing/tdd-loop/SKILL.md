---
id: testing.tdd-loop
title: Test-driven loop
module: testing
summary: Write the failing test first; it is the only instruction an agent cannot reinterpret.
tier_min: 0
cost: low
priority: 1
tags: [tdd, tests, red-green-refactor, feedback]
triggers: [tdd, test first, red green refactor, write tests]
enforces: []
artifacts: [05-verification.md]
---

# Test-driven loop

Ask for a feature and you will get code, a summary, and a test that was written afterwards to match whatever the code does. That test cannot fail, so it verifies nothing. The suite grows, confidence does not.

The loop is old and unfashionable and it survives because it works on the actual difficulty: knowing what "correct" means before you write the code.

## When this applies

All behaviour worth naming, at every tier. For a prototype, apply it to the two or three rules that would hurt if wrong.

## The practice

1. **Red.** Write the smallest test that expresses the next piece of behaviour. Run it. Watch it fail, and check it fails for the *right reason* — not a typo, not an import error.
2. **Green.** Write the least code that makes it pass. Resist generalising; the next test will tell you what the general case needs.
3. **Refactor.** Improve names and structure with the test green. No behaviour change in this step.
4. **Anchor.** Add `// @req REQ-xxx` so the test is bound to a requirement.
5. Repeat in slices of minutes, not hours.

Two habits make the loop survive contact with agents:

- **Ask for the failing test and the failure output before the implementation.** It is the only evidence that the test was written first and actually ran.
- **Never accept "all tests pass" without output.** A claim about a command is not a command.

## Checklist

- [ ] Each new behaviour starts with a failing test that was observed failing.
- [ ] Each test asserts an outcome, not an implementation detail.
- [ ] Test names read as sentences about behaviour.
- [ ] One reason to fail per test.
- [ ] Red step verified by pasted output when a second party wrote the code.
- [ ] Every automated requirement has an anchor.

## Anti-patterns

- **Tests written from the implementation.** They lock in accidents and miss requirements.
- **Asserting on internals.** Mock call counts and private method spies break on refactors and pass on bugs.
- **One giant test per feature.** The failure message is "it broke", which is not information.
- **Skipping red.** Without observing failure you cannot distinguish a working test from a vacuous one.
- **Testing the framework.** Proving the router routes is not your job.

## Why it works

A test is the only artefact that states expected behaviour precisely enough for a machine to check. For an agent, it converts an ambiguous instruction into a local objective with a stop condition, and it makes over-building visible: code with no failing test behind it is unrequested.

It also changes the shape of the work. Debugging means "which assumption in this test is wrong", which is a far smaller search space than "why does this not work".

## Cost and when to skip

Low per cycle, and it front-loads thinking rather than adding work. The honest failure mode is testing trivia: if a test only restates the code, delete it and keep the behavioural ones.
