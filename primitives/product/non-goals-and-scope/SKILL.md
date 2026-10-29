---
id: product.non-goals-and-scope
title: Non-goals and scope discipline
module: product
summary: Write down what the product will not do, so scope creep becomes a review comment instead of a surprise.
obligation: "In {project}, the three things this version will not do with {aPrimary} are written down before the first sprint, so scope becomes a review comment instead of a surprise."
tier_min: 0
cost: low
priority: 1
tags: [scope, non-goals, yagni, review]
triggers: [scope, creep, out of scope, feature request, non-goals]
enforces: [core.non-goals]
artifacts: [01-product-brief.md]
---

# Non-goals and scope discipline

Generated code expands. Ask for a login screen and you often get password reset, profile avatars, an admin panel and a settings page. None of it is wrong; all of it is unrequested, unreviewed and now yours to maintain.

Scope discipline is not about saying no to users. It is about making the boundary explicit so that a review can point at a line instead of arguing about taste.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the three things this version will not do with {aPrimary} are written down before the first sprint, so scope becomes a review comment instead of a surprise.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Always. The smaller the project, the more damage unrequested capability does, because it is a larger share of the whole.

## The practice

Write the non-goals as *capabilities you are deliberately not building*, not as vague exclusions.

Weak: "No enterprise features yet."
Strong: "No SSO, no SCIM, no audit export. Enterprise buyers are out of scope until three mid-market customers ask."

Include the traps specific to generated software:

- No public API, SDK or plugin system in v1.
- No mobile client unless the kind is mobile.
- No notification channels that are not in scope.
- No realtime collaboration unless realtime is a declared trait.
- No data import from other systems; v1 starts empty.
- No multi-region, no horizontal scale beyond the stated user count.

Then add the rule that makes it enforceable: **a diff that implements an unlisted capability is rejected, and the capability moves to the brief or disappears.** Both outcomes are fine. Silent addition is not.

## Checklist

- [ ] At least three non-goals, each naming a capability.
- [ ] Each non-goal says why, in one clause.
- [ ] Review checklist contains "nothing beyond the listed requirements".
- [ ] There is a named place to record deferred ideas (a `docs/ideas.md` is enough).
- [ ] The first version has a stated cut line: what gets dropped if time runs out.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- Scope resolved verbally and nowhere else.
- A feature in the pull request that no requirement names.
- No cut line for the first version.
- A non-goal phrased as "not now" with no capability named.
- The brief grew while the calendar did not.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| Non-goals are negative thinking. | They are the only defence against the tenth feature. | Name three capabilities you will not build. |
| We will settle scope when we see the estimate. | The estimate arrives after the scope. | State the cut line now. |
| Everything in the brief is in scope. | The brief is intent; scope is a list. | Requirements, not prose. |
| Deferred ideas can live in the chat. | Then they get built by accident. | One file for deferred ideas. |
| A non-goal needs no reason. | Without one it gets reopened every month. | One clause of why. |

## Anti-patterns

- **"Out of scope for now"** with no condition. It becomes in-scope under pressure.
- **Deleting the non-goals when the project is "almost done".** That is exactly when they matter.
- **Treating a stakeholder request as authorisation.** A request is input to the brief, not a change to it.

## Why it works

Agents optimise for completeness of the pattern they have seen, not for your budget. Naming the boundary converts an implicit judgement call into an explicit review criterion, and review criteria are the only thing that survives a new session with no memory.

## Cost and when to skip

Ten minutes. There is no project where this is not worth it, including the prototype, because the prototype is where the unrequested capability first appears.
