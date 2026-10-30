---
id: agent.review-protocol
title: Automated review protocol
module: agent
summary: Review against the spec with a reviewer that did not write the code, and refuse the diff that only looks right.
obligation: "In {project}, every change to {aPrimary} rule is reviewed by a session that did not write it, against `spec.json` rather than against the diff."
tier_min: 1
cost: low
priority: 4
tags: [review, code-review, agents, automation, quality]
triggers: [code review, pull request, review agent, automated review, self-review]
enforces: []
advisory_reason: "An independent review is a session habit; CI sees the diff, not who read it or with what memory."
advisory: true
artifacts: [07-agent-handoff.md]
---

# Automated review protocol

The agent that wrote the code will approve the code. It shares its own blind spots, has the same misunderstanding of the requirement, and is optimistically biased by having just produced it. "I reviewed my change and it looks correct" is not a review; it is a restatement.

A review needs a reader with a different objective: the spec, not the diff.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, every change to {aPrimary} rule is reviewed by a session that did not write it, against `spec.json` rather than against the diff.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 1 and above, and always when a second agent or a human can look. At tier 0, one adversarial pass by the same agent with an explicit checklist still catches the obvious.

## The practice

1. **Separate the sessions.** The reviewer gets the requirement and the diff, not the author's reasoning or chat history.
2. **Review against criteria, in this order:**
   - Scope: does the diff implement exactly the listed requirements?
   - Coverage: does every acceptance criterion have an assertion?
   - Failure paths: are the described failures handled, not just the happy path?
   - Assertion strength: would these tests fail if the behaviour were wrong?
   - Boundaries: domain purity, cross-context reads, authorization on every object read.
   - Reversibility: can this be rolled back, or is data changed irreversibly?
3. **Require evidence per finding**: file, line, the spec line violated, smallest fix. A finding without a spec reference is an opinion, and opinions are the noise that gets reviews ignored.
4. **Say "none" per category.** It prevents the model from manufacturing findings to look thorough.
5. **Never let the reviewer fix the code in the same session.** The review is a separate artefact with its own diff.
6. **Human review goes to design**, not to formatting: the mechanical things are in CI.

## Checklist

- [ ] Reviewer session has no memory of writing the code.
- [ ] Findings cite the requirement or criterion violated.
- [ ] Categories with no findings are stated as none.
- [ ] Test weakening is called out explicitly.
- [ ] New dependencies and new environment variables appear in the findings list.
- [ ] The review is committed as a comment or artefact, not in a chat that disappears.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- The reviewer session saw the implementation discussion.
- Findings cite style but no requirement or criterion.
- A category is omitted rather than marked "none".
- The diff weakens or deletes a test and the review does not say so.
- The review exists only as chat messages.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| I wrote it, so I can review it. | The author shares the blind spot that produced the defect. | Review in a separate session with no memory of writing it. |
| The tests pass, so the diff is right. | Tests encode what you thought of; review is for what you did not. | Review against the criteria, not the test output. |
| I only found issues in two categories. | A silent category looks like a clean category. | Write "none" explicitly for every category. |
| The comments are on the pull request, we will act later. | Chat disappears; a review is an artefact. | Commit the review beside the change. |
| It is a small change, skip the review. | Twenty lines is exactly where a boundary gets crossed quietly. | Review every change that touches a rule. |

## Anti-patterns

- **"LGTM" from the author.** It is a mood, not a review.
- **Review by checklist without the diff.** It finds categories, not defects.
- **Review that rewrites style.** The linter already did that; the reviewer's time is for correctness.
- **Reviewing only the final commit.** Intermediate commits hide the requirement that was dropped.
- **A reviewer prompt with no spec.** It will judge whether the code looks like code.

## Why it works

Review quality is a function of independence and specificity. Giving the reviewer the criteria, not the author's intent, removes the confirmation loop. This is also the cheapest place to catch agent-specific failure modes, because the model's *own* tendency to over-build and under-assert is exactly what a spec-anchored review checks.

## Cost and when to skip

Low: one extra session per change. It is the highest-return practice in this module, and the one most often skipped when a build "feels done".
