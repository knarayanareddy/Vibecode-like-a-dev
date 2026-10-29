---
id: data.schema-and-migrations
title: Schema and forward-only migrations
module: data
summary: Schemas outlive code, so every change ships as a reviewed, replayable migration with a way back.
obligation: "In {project}, any change to how {primary} is stored ships as an immutable migration on {db} with a restore step that has been executed once."
tier_min: 1
cost: medium
priority: 3
tags: [database, migrations, schema, rollback, data]
triggers: [schema, migration, database change, alter table, migration rollback]
enforces: [data.persistence]
artifacts: [04-contracts.md]
---

# Schema and forward-only migrations

Code is deployed and reverted weekly. Data is deployed once and lives for years. The most expensive incidents in small products are not logic bugs; they are a migration that ran halfway on a table nobody had snapshotted.

Generated code tends to produce schema by mutation: whatever the ORM inferred from the model classes this afternoon. The result is a production database nobody can reconstruct from the repository.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, any change to how {primary} is stored ships as an immutable migration on {db} with a restore step that has been executed once.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any product with durable state. That includes a mobile app with local storage and a pipeline with intermediate tables.

## The practice

1. **The schema lives in version control** as ordered, immutable migration files. Never edit an applied migration.
2. **Forward-only, and independently runnable.** One migration, one intention. No migration depends on another running in the same second.
3. **Expand, migrate, contract** for anything non-trivial:
   - Expand: add the new nullable column or table; deploy code that writes both.
   - Migrate: backfill in bounded batches, idempotently, with progress recorded.
   - Contract: stop reading the old shape, then remove it in a later release.
4. **Constraints in the database, not only in code.** Foreign keys, unique constraints, non-null, check constraints. The database is the last line of defence, and the only one that also protects the batch job you forgot.
5. **Test against a real engine** at the previous version with representative rows, not against an empty schema.
6. **Back up before destructive changes**, and rehearse the restore once.

The invariant to write down: *running all migrations from empty produces the same schema as running them one at a time on an existing database.*

## Checklist

- [ ] Migrations are numbered, immutable and committed.
- [ ] Every migration is idempotent in re-run, or explicitly guarded.
- [ ] Backfills are batched and rate-limited; they never run in a request path.
- [ ] Destructive changes are two releases apart, not one.
- [ ] There is a documented restore path and a date on which it was tested.
- [ ] Referential integrity is enforced by the engine.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- An already-applied migration file was edited.
- A destructive change shipped in the same release as its replacement.
- A backfill running inside a request path.
- No recorded restore date.
- Foreign keys declared in the ORM but not in the database.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We will squash the migrations at launch. | Then no environment can be rebuilt to a known point. | Keep them immutable; squash only before the first production run. |
| The migration only adds a column, it is safe. | Not on a locked table with a million rows. | Two releases for destructive or locking changes. |
| The framework handles idempotency. | Half of them do not. | Guard it explicitly, or document why not. |
| Rollback means running the down script. | An untested down script is fiction. | Test a restore and record the date. |
| Referential integrity can live in the app. | The app has bugs; the engine does not. | Put the constraint in the schema. |

## Anti-patterns

- **Auto-sync schema from models in production.** Convenient, unbounded, and unrecoverable at scale.
- **A single 900-line initial migration per feature.** Nobody can review it, and it will not replay.
- **Backfill in the deploy.** The deploy times out and half the rows are updated.
- **Nullable everything to avoid a decision.** Nullable columns move the invariant into your application code, where it will be forgotten.

## Why it works

A migration is a reviewable, replayable description of a data change. That makes data change testable, and it makes the recovery path something you can practise rather than improvise. The constraint is that only one of those properties — reviewability — survives if migrations are generated on the fly.

## Cost and when to skip

Medium, and it is mostly discipline rather than effort. Skip the expand/contract ceremony for a prototype with disposable data, but still commit the migrations: the day the data becomes real arrives without warning.
