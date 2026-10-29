---
id: agent.spec-drift-guard
title: Spec drift guard
module: agent
summary: Make spec-code divergence fail the build, because an unchecked spec becomes a confident lie.
tier_min: 2
cost: low
priority: 7
tags: [spec-drift, enforcement, ci, traceability, agents]
triggers: [spec drift, drift detection, spec check, keep spec updated, stale spec]
enforces: [spec.drift-guard]
artifacts: [05-verification.md, spec-check.mjs]
---

# Spec drift guard

This is the unsolved problem of spec-driven development, and the reason most specs are abandoned within a quarter: the spec says one thing, the code does another, and nothing notices. The spec then becomes worse than no spec, because people and agents trust it.

The fix is not better discipline. It is a check that runs without anyone remembering.

## When this applies

Tier 2 and above. Below that, the light version — anchors plus a manual pass per requirement — is proportionate.

## The practice

A drift guard is a small program in CI that fails when the specification stops describing reality:

1. **Missing documents.** Every file listed in the manifest exists.
2. **Incomplete requirements.** Every requirement has a statement, acceptance criteria and a verification method.
3. **Unknown anchors.** Every `@req` marker names a requirement that exists.
4. **Unproven completion.** A requirement marked `done` has no anchor in a test file.
5. **Vanished primitives.** Every practice the spec quotes still exists, and is still allowed at this tier.
6. **Gate coverage.** Every gate required by the tier is present in the manifest.

Then the ratchet, which is the part that makes it usable on day one:

- Requirements start as `todo`. Missing anchors are *notices*.
- A requirement is marked `done` only when its anchor is green.
- `--strict` in release CI turns pending into failures, so "we never finished it" cannot ship silently.

Add the change protocol in the same breath: when implementation reveals that a requirement was wrong, the requirement changes first, then the code. That ordering is reviewable; the reverse is indistinguishable from drift.

## Checklist

- [ ] Drift check runs on every pull request.
- [ ] Requirements carry a status: todo, done, blocked.
- [ ] Anchors only count in test files.
- [ ] Release CI runs with `--strict`.
- [ ] Changing a requirement is a reviewable diff, not a chat decision.
- [ ] Superseded requirements are archived rather than deleted, so history survives.

## Anti-patterns

- **A spec generated once and never re-read.** Decorative and misleading.
- **Requirement changes made in code comments.** The manifest is the interface.
- **Marking everything done on release day.** Batch-marking destroys the ratchet's value.
- **A guard that only warns.** Warnings are the absence of a control.
- **Deleting a failing requirement instead of implementing it.** The guard should make that visible in the diff; only a human can decide it is legitimate.

## Why it works

Drift is invisible by nature: each individual change is small and reasonable. A mechanical check makes the accumulated divergence visible at the moment it happens, when the fix costs a minute instead of a rewrite. This is the only mechanism in this entire toolkit that keeps the specification true after week three.

## Cost and when to skip

Low: one script, generated with the packet, plus a CI step. There is no tier where a spec is worth writing and not worth checking, though the checks can be fewer at tier 1.
