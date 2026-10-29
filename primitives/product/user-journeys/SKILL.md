---
id: product.user-journeys
title: User journeys as testable slices
module: product
summary: Turn intent into a small number of end-to-end paths, then build one of them completely before widening.
obligation: "In {project}, the {primary} journey is one path from first step to finished with its failure step written down, and it works end to end before a second journey starts."
tier_min: 0
cost: low
priority: 3
tags: [journeys, slices, vertical-slice, ux]
triggers: [user journey, user story, flow, slice, walkthrough]
enforces: [core.primary-journey]
artifacts: [01-product-brief.md, 06-delivery-plan.md]
---

# User journeys as testable slices

The most common failure of agent-built products is not broken code. It is a set of features that each work in isolation and never add up to a path a person can complete. Five half-built screens look like progress and behave like a demo.

A journey is the unit of work that prevents this: one actor, one goal, a first step and a last step, exercised end to end before the second journey starts.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the {primary} journey is one path from first step to finished with its failure step written down, and it works end to end before a second journey starts.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any product with a user interface, a command-line entry point, or an API consumer. For a library, the equivalent is "a consumer installs it and completes one real task".

## The practice

Write journeys in this shape:

```
Actor:     who
Goal:      what they get
Trigger:   what starts it
Steps:     5 or fewer, each an action and an observable result
Success:   the state that proves it worked
Failure:   the two most likely ways to fail, and what they see
Out of scope: what this journey deliberately does not cover
```

Then order them:

1. **The spine.** The shortest path that delivers the core value. This is built first, end to end, including storage, error handling and one test per step.
2. **The return visit.** The second use of the product, which exposes state and persistence bugs the first visit hides.
3. **The recovery path.** What the user does when the spine fails. This is where products feel unreliable.

One journey, complete, beats ten journeys at 80%. The 80% is where all the ambiguity lives.

## Checklist

- [ ] The spine journey is written before any code.
- [ ] Each journey has an explicit failure step.
- [ ] Journeys are ordered, not prioritised; you finish one before starting the next.
- [ ] Each journey names the state it leaves behind.
- [ ] The primary journey has one automated end-to-end test, and only one.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- Journeys that share no step with the primary path.
- A journey with no failure step.
- Three journeys in progress.
- No test that traverses the whole path.
- A journey that names screens instead of outcomes.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We can build all the screens in parallel. | Then none of them is finished. | Build one spine journey end to end. |
| The happy path is the journey. | The product is judged on the failure step. | Write the failure explicitly. |
| Priority order is better than sequence. | Priority invites doing three at once. | Order them. |
| The journey ends at the last click. | It ends in a state you can observe. | Name the state left behind. |
| One test per step is thorough. | Then nothing tests the path. | One end-to-end test for the spine. |

## Anti-patterns

- **Journeys as feature lists.** "User can manage projects" is not a journey.
- **Journey maps with 40 nodes.** If the diagram needs a legend, you have modelled the system, not the user.
- **Building all journeys in parallel.** You get integration bugs in every one and a working product in none.
- **Skipping the recovery path.** Error states are the difference between a demo and a product.

## Why it works

A journey is the smallest unit that can be *verified from outside the system*, which is the only kind of verification that catches the difference between "the code exists" and "the product works". It also gives the agent a natural stopping point: one journey per session, with a report at the end.

## Cost and when to skip

Low. For a CLI or library, write the equivalent of three journeys: first successful use, repeat use, and failure recovery.
