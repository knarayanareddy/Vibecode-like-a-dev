---
id: delivery.ci-gates
title: CI gates from the first commit
module: delivery
summary: Make the definition of done run without a human, on the first day, before there is anything to break.
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

## Anti-patterns

- **Required checks nobody can run locally.** Then CI is the only place to discover a broken build, which is the slowest possible loop.
- **`continue-on-error: true`** on a check people care about. That is a log line, not a gate.
- **Testing on every OS and version on day one.** A matrix for a product with one deployment target is cost without information.
- **A red default branch.** It teaches everyone that red is normal.

## Why it works

CI is the only reviewer present for every change, with no memory and no favours. It also makes generated code safe to accept: a diff that fails a mechanical gate never reaches a human, which means human review time goes to design instead of typos.

## Cost and when to skip

Low: twenty minutes on day one, and it saves that on the first broken commit. There is no tier where skipping is sensible.
