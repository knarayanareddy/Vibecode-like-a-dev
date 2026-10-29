---
id: delivery.ci-gates
title: CI gates from the first commit
module: delivery
summary: Make the definition of done run without a human, on the first day, before there is anything to break.
obligation: "In {project}, the checks that guard {aPrimary} run on every pull request before the first {primary} handler exists, and none of them is optional."
tier_min: 1
cost: low
priority: 2
tags: [ci, github-actions, gates, automation, pull-requests]
triggers: [ci, pipeline, github actions, gate, pull request checks]
enforces: [core.runnable]
artifacts: [06-delivery-plan.md, 05-verification.md]
---

# CI gates from the first commit

A gate that lives in a document is a suggestion. A gate that lives in CI is a fact.

The failure pattern is predictable: CI is added "once the code settles", the first two weeks of commits are unverified, and by the time CI exists the suite is red and everyone has learned to ignore it. Adding the pipeline to an empty repository takes twenty minutes and prevents all of that.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the checks that guard {aPrimary} run on every pull request before the first {primary} handler exists, and none of them is optional.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 1 and above. At tier 0, a single job with lint and tests is still worth it.

## The practice

Build the pipeline before the product, in this order:

1. **Install from the lockfile** (`npm ci`, `uv sync --frozen`). If the lockfile is missing, fail.
2. **Lint and format check.** Fast, and it stops style debate in review.
3. **Typecheck** (if the language supports it). Cheap correctness.
4. **Tests**, with a time budget. Slow suites get a separate job, not a shorter one.
5. **Spec check** (`node specs/spec-check.mjs`) once the packet exists.
6. **Build or package.** Prove the artefact exists.
7. **Security**: secret scan, dependency audit, and (at tier 2+) a check that migrations apply cleanly.
8. **Branch protection**: all required checks green, no direct pushes to the default branch.

Rules that keep it useful: keep the whole thing under ten minutes for a fast feedback loop; make failures name the fix; never add a job that cannot fail; treat a flaky job as a bug with an owner.

## Checklist

- [ ] Pipeline exists before the first feature commit.
- [ ] Install is from a committed lockfile.
- [ ] Lint, typecheck, tests are required checks on the default branch.
- [ ] Spec check is wired in as soon as the packet exists.
- [ ] Time to green under ten minutes, or the slow parts are split out.
- [ ] Caching configured for dependencies, keyed on the lockfile.
- [ ] Secrets come from CI configuration, never from the repository.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A required check that has never failed.
- The test command in CI differs from the one in the README.
- Secrets referenced from the repository instead of CI configuration.
- Pipeline over ten minutes at tier 0 or 1.
- A green build on a branch with no tests.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We will add CI once there is something to test. | The first feature is where the suite shape is set. | Pipeline before the first feature commit. |
| Local tests are enough. | Local means on this machine, when someone remembers. | Required checks on the default branch. |
| The suite is flaky, so it cannot be required. | Then nothing is required. | Fix it, or quarantine it with a deadline. |
| Caching can wait. | A ten-minute pipeline gets bypassed. | Cache on the lockfile from day one. |
| The spec check runs nightly. | By then the drift is merged. | Run it per pull request. |

## Anti-patterns

- **Required checks nobody can run locally.** Then CI is the only place to discover a broken build, which is the slowest possible loop.
- **`continue-on-error: true`** on a check people care about. That is a log line, not a gate.
- **Testing on every OS and version on day one.** A matrix for a product with one deployment target is cost without information.
- **A red default branch.** It teaches everyone that red is normal.

## Why it works

CI is the only reviewer present for every change, with no memory and no favours. It also makes generated code safe to accept: a diff that fails a mechanical gate never reaches a human, which means human review time goes to design instead of typos.

## Cost and when to skip

Low: twenty minutes on day one, and it saves that on the first broken commit. There is no tier where skipping is sensible.
