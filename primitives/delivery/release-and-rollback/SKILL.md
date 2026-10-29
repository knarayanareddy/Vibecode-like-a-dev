---
id: delivery.release-and-rollback
title: Release, feature flags and rollback
module: delivery
summary: Ship small, behind a switch, with a rehearsed way back; forecasts are wrong more often than rollbacks are used.
tier_min: 2
cost: medium
priority: 6
tags: [release, rollback, feature-flags, deployment, canary, runbook]
triggers: [deploy, release, rollback, feature flag, canary, incident]
enforces: []
artifacts: [06-delivery-plan.md]
---

# Release, feature flags and rollback

A release is not a deploy. A deploy moves code; a release exposes behaviour to users. Conflating them means the only way to stop a bad change is to deploy again, quickly, during an incident, under pressure.

Small releases with a way back are how small products survive their own success.

## When this applies

Tier 2 and above, or any product with real users. Prototypes can deploy straight from main and should say so.

## The practice

1. **Separate deploy from release.** Merge and deploy continuously if you like; put new behaviour behind a flag that defaults off.
2. **One flag mechanism**, defined in config, with an owner and an expiry date. Flags are debt: a flag older than a release cycle gets deleted or promoted.
3. **Ship the smallest observable change.** One requirement per release where possible; it makes the cause of a regression obvious.
4. **Rehearse the rollback** at least once. An untested rollback is a plan, and plans fail during incidents.
5. **Write the release checklist**: migrations applied? flags default off? dashboards watched? who is watching and for how long?
6. **Watch the right window.** For a small product, fifteen minutes of error rate and one real journey tells you more than a week of dashboards.
7. **Record decisions in the moment.** An incident note with timestamps, actions and observations is worth more than a polished postmortem written a week later.

## Checklist

- [ ] Deploy and release are separate steps for risky changes.
- [ ] Every flag has an owner and an expiry.
- [ ] Rollback procedure is written and has been executed at least once.
- [ ] Migrations are compatible with the previous release (expand/contract).
- [ ] Release checklist exists and is followed, not remembered.
- [ ] Someone is watching a defined window after the release.
- [ ] A bad release's cause can be identified from logs within minutes.

## Anti-patterns

- **Friday afternoon deploys with no watcher.** The change is not the problem; the timing is.
- **Rollback by "redeploy the old commit"** when the migration was destructive. It does not work, and it fails at the worst moment.
- **Zero flags, maximum confidence.** Confidence is not a control.
- **A permanent flag forest.** Nobody knows which combination is live, so nobody can reproduce a bug.
- **Postmortems that assign blame.** You get fewer reports, not fewer incidents.

## Why it works

The cost of a bad release is proportional to how long it stays live and how hard it is to reverse. Both are design decisions made in advance. A flag turns a two-hour incident into a two-minute toggle, and a rehearsed rollback turns a panic into a procedure.

## Cost and when to skip

Medium: one mechanism, one checklist, one rehearsal. Skip flags for a prototype that nobody depends on; never skip the rollback note once data can be lost.
