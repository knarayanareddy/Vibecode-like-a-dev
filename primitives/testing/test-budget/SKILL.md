---
id: testing.test-budget
title: Test budget and suite shape
module: testing
summary: Spend tests where the rules live; keep the suite fast enough that people actually run it.
tier_min: 0
cost: low
priority: 3
tags: [test-strategy, pyramid, coverage, speed]
triggers: [test suite, coverage, pyramid, slow tests, flaky tests]
enforces: []
artifacts: [05-verification.md]
---

# Test budget and suite shape

Test suites fail in two directions. Too small and nothing is checked. Too large and the suite becomes a liability: forty minutes in CI, flaky retries, and tests updated in bulk to match new code without anyone reading them.

A budget makes the trade-off explicit instead of accidental.

## When this applies

Always, and it is worth restating whenever an agent proposes "comprehensive test coverage".

## The practice

Allocate deliberately:

| Layer | Share | What belongs |
| --- | --- | --- |
| Domain unit | ~70% | Invariants, state transitions, money, permissions, parsing |
| Application | ~15% | Use-case orchestration, authorization, transaction boundaries |
| Contract | ~10% | Interface shapes, error envelopes, external adapters |
| End-to-end | ~5% | One or two journeys, not one per page |

Rules:

- **One journey test per journey**, run in CI on every pull request if it takes under a minute; otherwise on merge.
- **No test of framework behaviour.** The router is tested upstream.
- **Fix flakiness or delete the test.** A flaky test trains everyone to re-run, which trains everyone to ignore failures.
- **Coverage is a diagnostic, never a target.** Read the uncovered lines that contain branching logic, ignore the ones that are wiring.
- **Every bug gets a test**, and the test fails for the reason the bug happened.

## Checklist

- [ ] The suite runs in under a minute locally at tier 1-2 (integration excluded and clearly marked).
- [ ] Domain tests need no database, no network and no browser.
- [ ] Slow tests are marked and have their own job.
- [ ] No test depends on execution order or wall-clock time.
- [ ] Coverage, if measured, is reported and not enforced as a percentage.
- [ ] A new bug is accompanied by a regression test.

## Anti-patterns

- **Coverage targets.** They produce tests that execute lines without asserting anything.
- **One end-to-end test per screen.** Slow, flaky, and they fail for reasons unrelated to the change.
- **Mocking everything.** The suite passes while the app is broken, because nothing real was exercised.
- **Snapshot tests of whole pages.** They encode yesterday's markup as today's requirement.
- **Retrying CI to get green.** That is a broken suite with extra steps.

## Why it works

Tests have a cost per change, not just a cost to write. A suite shaped like the risk of the product — heavy on rules, thin on plumbing — keeps feedback fast enough to be used, which is the only property that makes a suite valuable. Suite size is not a virtue; assertion quality per minute is.

## Cost and when to skip

Low to decide, high to fix later. The budget is one table in the verification plan; the discipline is refusing the 200th shallow UI test.
