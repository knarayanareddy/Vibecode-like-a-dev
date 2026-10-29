---
id: testing.tdd-loop
title: Test-driven loop
module: testing
summary: Write the failing test first; it is the only instruction an agent cannot reinterpret.
obligation: "In {project}, the first behaviour of every {primary} requirement is a failing test that was watched failing, before the handler that satisfies it exists."
tier_min: 0
cost: low
priority: 1
tags: [tdd, tests, red-green-refactor, feedback]
triggers: [tdd, test first, red green refactor, write tests]
enforces: []
gates: [G1-DOMAIN-TESTS, G1-AC-TRACE]
artifacts: [05-verification.md]
---

# Test-driven loop

Ask for a feature and you will get code, a summary, and a test that was written afterwards to match whatever the code does. That test cannot fail, so it verifies nothing. The suite grows, confidence does not.

The loop is old and unfashionable and it survives because it works on the actual difficulty: knowing what "correct" means before you write the code.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the first behaviour of every {primary} requirement is a failing test that was watched failing, before the handler that satisfies it exists.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

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

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- Test and implementation in one commit with no red evidence.
- Assertions on call counts or internals.
- A test asserting that nothing was thrown.
- Several behaviours in one test.
- "Tests pass" reported with no output.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| I will write the test after; it is the same thing. | It becomes a test of the implementation, not the requirement. | Red first, and observed. |
| The test failed, that is enough. | It may have failed for the wrong reason. | Read the failure output. |
| I will generalise now to save time. | It builds cases no test asked for. | The least code that goes green. |
| All tests pass. | A claim about a command is not a command. | Paste the output. |
| Refactor and behaviour change together. | Then a failure has two possible causes. | Refactor green, on its own. |

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
