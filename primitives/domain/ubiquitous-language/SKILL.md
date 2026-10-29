---
id: domain.ubiquitous-language
title: Ubiquitous language and DDD basics
module: domain
summary: One word per concept, in code, tests, UI and commits, so the model cannot quietly fork.
tier_min: 0
cost: low
priority: 1
tags: [ddd, language, naming, glossary, model]
triggers: [domain model, glossary, naming, ubiquitous language, ddd, entity, term definition]
enforces: []
artifacts: [02-domain-model.md]
---

# Ubiquitous language and DDD basics

Ask two implementers to build "subscription management" and you will get a `User` with an `isActive` flag, a `Plan` with a `price`, an `Account` with a `planId`, and an unresolved argument about whether a trial is a plan. All of them work. None of them can talk to each other.

The failure is not technical. It is a model that forked because no one wrote the words down. Eric Evans called the fix the ubiquitous language: one vocabulary used everywhere, so a change in understanding is a change you can see.

## When this applies

Any project with more than one noun in the brief. That is nearly all of them.

## The practice

Maintain a table of terms with a working definition and a status. Definitions are one sentence and behavioural:

| Term | Definition | Status |
| --- | --- | --- |
| Account | The durable identity; owns credentials and profile | confirmed |
| Session | A revocable grant of access with an expiry | confirmed |
| Member | The link between an Account and a Workspace, carrying roles | proposed |

Rules that make the table load-bearing:

1. A term is used verbatim in code, tests, commit messages, API fields and UI copy. No synonyms, no abbreviations at the boundary.
2. When the table changes, the code changes in the same commit. A renamed concept is a migration, not a comment.
3. Words that mean different things in different contexts get different names, prefixed by their context if needed (`BillingCustomer` versus `SupportUser`). Two contexts sharing one word is how hidden coupling starts.
4. Prefer domain words over technical ones. `Reservation`, not `BookingRecord`. `Settled`, not `status = 3`.

Then define the model's bones:

- **Entity**: identity matters, attributes change.
- **Value object**: immutable, compared by value (`Money`, `DateRange`, `Email`).
- **Aggregate**: a consistency boundary; the only way in is through its root.
- **Invariant**: what must be true after every operation; each one becomes a test.
- **Domain event**: a fact other contexts react to, named in the past tense.

## Checklist

- [ ] Every noun in the brief appears in the glossary or is deleted.
- [ ] No term is defined as "a thing that" — definitions say what changes and what must hold.
- [ ] Code identifiers match the glossary, including plurals and casing conventions at the boundary.
- [ ] Ambiguous words (`user`, `item`, `record`, `status`) are replaced or qualified.
- [ ] Invariants are listed as sentences that a test could make false.

## Anti-patterns

- **An anaemic model.** Tables plus a service layer full of `if` statements. All the rules live in one 800-line service and no one can find them.
- **A glossary nobody reads.** If it is not referenced in review, it is decoration. Make it the first thing a new contributor reads and the first thing a reviewer checks.
- **`User` for everything.** In a billing system, `Customer` and `Administrator` are different actors with different permissions and different lifecycles.
- **Technical names for domain things.** `DataRow`, `RecordTable`, `TxnStatus` — the model disappears and the schema becomes the design.

## Why it works

Names are the interface between human intent and machine implementation. A shared vocabulary is the cheapest available compression: `delinquent` carries a rule, a date comparison and a notification policy; `status = 2` carries nothing. It also makes generated code reviewable, because a reviewer can check vocabulary without reconstructing the design.

## Cost and when to skip

Low, and it amortises. Skip only for a script with no domain — and if you cannot name the domain, that is the first finding.
