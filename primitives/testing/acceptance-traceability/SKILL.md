---
id: testing.acceptance-traceability
title: Acceptance criteria and traceability anchors
module: testing
summary: Bind every requirement to a named test with an @req anchor, so the spec cannot drift silently.
tier_min: 0
cost: low
priority: 1
tags: [traceability, acceptance, anchors, drift, verification]
triggers: [acceptance criteria, traceability, requirement coverage, spec drift, anchor]
enforces: [spec.drift-guard]
artifacts: [05-verification.md, spec.json]
---

# Acceptance criteria and traceability anchors

A specification that nothing checks is a document that becomes wrong on schedule. Everyone who has tried spec-driven development hits this: the spec and the code diverge within weeks, and the spec is worse than nothing because people trust it.

The mechanism that closes the gap is small. Each requirement carries acceptance criteria in Given/When/Then form, and each criterion is proved by a test that names the requirement.

## When this applies

Always. At tier 0 the criteria live in a single file; the anchors still matter.

## The practice

1. **Write criteria as behaviour, including failure.** Each requirement needs at least one criterion for the happy path and one for the most likely failure. A criterion without a failure case is a demo script.
2. **Give each criterion a stable identifier** (`AC-01`) and write the test name to match it.
3. **Anchor the test** with `@req REQ-xxx` in a comment. One anchor is enough; several are fine.
4. **Count anchors only in test files.** An anchor in production code proves nothing.
5. **Automate the check.** CI fails when a requirement marked done has no anchor, when an anchor names an unknown requirement, or when an anchored test disappears.
6. **Ratchet the status.** Requirements start as `todo` (a notice), and become `done` when the anchor is green (then it is enforced).

The criteria form is not bureaucracy; it is what makes disagreement visible:

```
Given a subject with rows in every table
When the deletion sweep runs
Then a query across all tables returns zero rows
```

Ambiguity has nowhere to hide in that sentence.

## Checklist

- [ ] Every requirement has at least one happy-path and one failure criterion.
- [ ] Criteria use domain vocabulary from the glossary.
- [ ] Each automated requirement has a named anchor path in `spec.json`.
- [ ] The spec check runs in CI on every pull request.
- [ ] Deleted or renamed tests fail the check rather than quietly reducing coverage.
- [ ] Requirements marked done are genuinely anchored, not annotated.

## Anti-patterns

- **Criteria that restate the implementation.** "Then the save method is called" cannot be wrong, so it cannot verify anything.
- **One mega-criterion.** "Then everything works" is not testable.
- **Anchors everywhere in the codebase.** Signals intent, verifies nothing; only test files count.
- **Checking the spec once at the start.** Drift is a process, not an event.
- **Marking everything done at the end.** The ratchet is the point; batch-marking discards it.

## Why it works

This is the enforcement gap in one primitive: the value of a spec is proportional to how cheaply a machine can tell you it is still true. Anchors cost one comment per requirement and give the repository a property most codebases never have — a specification that fails the build when it stops describing reality.

## Cost and when to skip

Very low. Ten comments per project and one small script. There is no tier where this is not worth it, because the alternative is the failure mode this entire toolkit exists to prevent.
