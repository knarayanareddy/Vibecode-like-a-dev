---
id: architecture.adr-log
title: Architecture decision records
module: architecture
summary: Record the why behind every decision that would otherwise be reverse-engineered from code.
tier_min: 0
cost: low
priority: 5
tags: [adr, decisions, documentation, rationale]
triggers: [adr, decision record, why, rationale, trade-off]
enforces: []
artifacts: [03-architecture.md]
---

# Architecture decision records

Six weeks from now, someone will ask why the queue exists, why sessions expire in fifteen minutes, or why the payment flow has two idempotency keys. The code will not answer. The chat that decided it is gone. So they will guess, or add a second mechanism, and the first one becomes unremovable.

An ADR is one page: context, decision, consequence. It is the cheapest durable memory a repository has.

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

## Anti-patterns

- **ADRs written after the fact to justify a decision.** Fine for the record, useless for the decision.
- **ADRs that are design documents.** If it takes twenty minutes to read, it will not be read.
- **Editing accepted ADRs.** History is the value; supersede instead.
- **Decisions recorded in chat.** One new contributor cannot read your chat.

## Why it works

Rationale is the part of engineering that does not live in code. Without it every new session — human or agent — re-litigates settled questions, and the answer changes based on who asked. An ADR turns a settled question into a constraint anyone can read in thirty seconds.

## Cost and when to skip

Low: ten minutes per decision, and most projects need fewer than ten ADRs. Never skip the dependency intake rule; it is one line in the review checklist.
