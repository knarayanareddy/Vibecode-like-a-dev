---
id: architecture.adr-log
title: Architecture decision records
module: architecture
summary: Record the why behind every decision that would otherwise be reverse-engineered from code.
obligation: "In {project}, the decisions that are expensive to reverse — persistence in {db}, the auth model, and every dependency worth a day — carry an ADR with a consequence."
tier_min: 0
cost: low
priority: 5
tags: [adr, decisions, documentation, rationale]
triggers: [adr, decision record, why, rationale, trade-off]
enforces: []
gates: [G2-ADR]
artifacts: [03-architecture.md]
---

# Architecture decision records

Six weeks from now, someone will ask why the queue exists, why sessions expire in fifteen minutes, or why the payment flow has two idempotency keys. The code will not answer. The chat that decided it is gone. So they will guess, or add a second mechanism, and the first one becomes unremovable.

An ADR is one page: context, decision, consequence. It is the cheapest durable memory a repository has.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the decisions that are expensive to reverse — persistence in {db}, the auth model, and every dependency worth a day — carry an ADR with a consequence.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Every project, including prototypes. The record is short. The only projects that do not need it are ones nobody will touch again.

## The practice

One file per decision in `docs/adr/`, numbered, immutable once accepted. Supersede rather than edit.

```
# ADR-007: Cursor pagination instead of offset

Status: accepted (2026-01-14) · Supersedes: none

## Context
Lists can exceed 10k rows; offset pagination shifts rows when items are inserted,
which produced duplicate items in the UI during the beta.

## Decision
Cursor pagination on all collection endpoints. Cursor is an opaque, signed value.

## Consequences
+ Stable paging under insert and delete.
+ No count query on the hot path.
- Clients cannot jump to page N; the admin export keeps offset pagination behind a flag.
- Every new collection endpoint must implement the cursor contract and its test.
```

Write an ADR when the decision is **expensive to reverse** (data model, protocol, vendor, auth model), **surprising to a newcomer**, or **revisited more than once**. Do not write one for a library choice you would change in an afternoon.

The intake rule that makes this survive agents: *a new dependency requires an ADR naming what it replaces and what breaks without it.* It converts "the agent added a state management library" from an invisible diff into a reviewable decision.

## Checklist

- [ ] ADR exists for: language/runtime, persistence, auth model, and every dependency over a day's effort to remove.
- [ ] Each ADR states the consequence, including what becomes harder.
- [ ] Statuses are used honestly: proposed, accepted, superseded, rejected (with the reason it was rejected).
- [ ] Rejected options are named; "we considered nothing else" is a finding.
- [ ] The index is one screen long.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- The ADR list grows but no ADR was ever rejected or superseded.
- The consequences section contains only benefits.
- A new dependency in the lockfile with no ADR.
- ADRs are numbered but not indexed anywhere.
- The persistence ADR predates the database actually in use.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The code documents itself. | It documents what you did, never what you rejected. | One paragraph per decision, with the alternative named. |
| ADRs are bureaucracy on a small project. | The small project is where a reversal costs a week. | Write them for the four decisions that are expensive to reverse. |
| I will write it after shipping. | By then you remember the choice, not the constraint. | Write it when the decision is made, status proposed. |
| Superseding is the same as editing. | An edited ADR hides that the ground moved. | Supersede it; never rewrite history. |
| We considered nothing else. | That is a finding, not a decision. | Name the rejected option and why it lost. |

## Anti-patterns

- **ADRs written after the fact to justify a decision.** Fine for the record, useless for the decision.
- **ADRs that are design documents.** If it takes twenty minutes to read, it will not be read.
- **Editing accepted ADRs.** History is the value; supersede instead.
- **Decisions recorded in chat.** One new contributor cannot read your chat.

## Why it works

Rationale is the part of engineering that does not live in code. Without it every new session — human or agent — re-litigates settled questions, and the answer changes based on who asked. An ADR turns a settled question into a constraint anyone can read in thirty seconds.

## Cost and when to skip

Low: ten minutes per decision, and most projects need fewer than ten ADRs. Never skip the dependency intake rule; it is one line in the review checklist.
