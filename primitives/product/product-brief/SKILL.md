---
id: product.product-brief
title: Product brief
module: product
summary: Force the ambiguity out of a one-line idea before an agent fills it with confident guesses.
obligation: "In {project}, who needs {aPrimary} and what they do instead today are written down before any of it is designed."
tier_min: 0
cost: low
priority: 1
tags: [requirements, ambiguity, scope, brief]
triggers: [product brief, brief, one-liner, vague pitch, problem statement, what are we building]
enforces: []
advisory_reason: "A brief is judged by the person who owns the product. The packet can require that it exists; it cannot check that it is right."
advisory: true
artifacts: [01-product-brief.md]
---

# Product brief

An agent does not ask what you meant. It picks the most probable interpretation, builds it well, and explains why it was right. Every ambiguity you leave in a prompt becomes a decision made by a model that has never met your user. The brief is the cheapest place to remove that ambiguity, because it costs ten minutes and saves a rewrite.

This is not a PRD. A PRD is a document that survives approval meetings. A brief is a page that makes the next thousand generated lines correct more often than not.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, who needs {aPrimary} and what they do instead today are written down before any of it is designed.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Always, including prototypes. A prototype brief can be five lines; it cannot be zero lines.

## The practice

Write four things, in this order, in the present tense:

1. **The user.** One person, described by what they do, not by a demographic. "A solo founder who ships weekly and forgets what they changed" beats "SMBs".
2. **The job.** What they do today instead, and what it costs them. If nothing costs them anything, there is no product.
3. **The change.** What the product removes from their day. One sentence, no feature list.
4. **The failure.** What happens if it is wrong, slow, or unavailable. This single answer decides your rigor tier more reliably than any questionnaire.

Then constrain it: what is out of scope, what is assumed, what is unknown. Put the unknowns in an open-questions list. Unanswered questions do not block the skeleton; they block the slice they belong to.

## Checklist

- [ ] One named user, described behaviourally.
- [ ] The current alternative is named, including "a spreadsheet" and "nothing".
- [ ] The change is one sentence and contains no feature names.
- [ ] At least three non-goals are written down.
- [ ] Success is measurable, or explicitly marked as not measured in v1.
- [ ] Assumptions are listed separately from facts.
- [ ] Open questions are numbered so they can be answered or dropped.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A brief with no non-goals.
- A named user that is a demographic rather than a behaviour.
- Success stated as a feeling.
- An assumption presented as a fact.
- Open questions with no numbers.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The idea is clear in my head. | It is not clear in the agent's. | Write the four answers. |
| Users will figure it out. | They will leave. | Describe the user behaviourally, not demographically. |
| The current alternative is nothing. | Nothing is the strongest competitor. | Name what they do today. |
| Success is obvious. | Then it cannot be falsified. | One measurable measure, or an explicit "not measured". |
| Assumptions and facts are the same here. | Then the first surprise looks like a bug. | Separate the two lists. |

## Anti-patterns

- **Feature list disguised as a brief.** "Users can create, edit, delete, share" describes CRUD, not a product.
- **Personas with names and stock photos.** They add words, not decisions.
- **A vision statement.** It cannot be contradicted, so it cannot guide implementation.
- **Metrics with no instrument.** A target nobody can observe becomes a sentence in a slide.

## Why it works

The cost of a wrong decision grows with the distance from the decision to the code. A brief moves decisions to the place where changing them is free. It also gives a reviewer something to reject: "this diff implements a capability that is not in the brief" is a stronger argument than "I don't like it".

Vague prompts produce plausible systems, not correct ones. The tell is that the agent's output looks professional — because the model is excellent at the shape of software and ignorant of your intent.

## Cost and when to skip

Low: an hour at most, and it is reread every session. Skip only for a throwaway spike that will be deleted, and then say so explicitly in the repository, because throwaway code has a way of becoming load-bearing.
