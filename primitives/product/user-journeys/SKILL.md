---
id: product.user-journeys
title: User journeys as testable slices
module: product
summary: Turn intent into a small number of end-to-end paths, then build one of them completely before widening.
tier_min: 0
cost: low
priority: 3
tags: [journeys, slices, vertical-slice, ux]
triggers: [user journey, user story, flow, slice, walkthrough]
enforces: []
artifacts: [01-product-brief.md, 06-delivery-plan.md]
---

# User journeys as testable slices

The most common failure of agent-built products is not broken code. It is a set of features that each work in isolation and never add up to a path a person can complete. Five half-built screens look like progress and behave like a demo.

A journey is the unit of work that prevents this: one actor, one goal, a first step and a last step, exercised end to end before the second journey starts.

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

## Anti-patterns

- **Journeys as feature lists.** "User can manage projects" is not a journey.
- **Journey maps with 40 nodes.** If the diagram needs a legend, you have modelled the system, not the user.
- **Building all journeys in parallel.** You get integration bugs in every one and a working product in none.
- **Skipping the recovery path.** Error states are the difference between a demo and a product.

## Why it works

A journey is the smallest unit that can be *verified from outside the system*, which is the only kind of verification that catches the difference between "the code exists" and "the product works". It also gives the agent a natural stopping point: one journey per session, with a report at the end.

## Cost and when to skip

Low. For a CLI or library, write the equivalent of three journeys: first successful use, repeat use, and failure recovery.
