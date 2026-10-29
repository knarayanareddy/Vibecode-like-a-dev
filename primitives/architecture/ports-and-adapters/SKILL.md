---
id: architecture.ports-and-adapters
title: Ports and adapters (hexagonal)
module: architecture
summary: Keep the domain free of frameworks and vendors so the expensive parts stay replaceable.
obligation: "In {project}, {primary} rules run in tests with no {db} and no network, because every external call sits behind a port the use case owns."
tier_min: 0
cost: medium
priority: 5
tags: [hexagonal, ports, adapters, dependency-inversion, testability]
triggers: [hexagonal, ports and adapters, dependency inversion, swap database, vendor lock-in]
enforces: [library.api-stability, cli.ergonomics]
artifacts: [03-architecture.md]
---

# Ports and adapters

The first thing generated code does with a rule is wrap it in a framework call. Business logic appears inside a request handler, a React component, a queue consumer and a cron job, and then it exists in four places with four subtly different behaviours.

Ports and adapters put the rule in one place: the domain defines the interfaces it needs, and everything external implements them.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, {primary} rules run in tests with no {db} and no network, because every external call sits behind a port the use case owns.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 0 and above, in proportion. A prototype can have a single adapter; it still should not put pricing rules in a controller.

## The practice

**Define ports in the domain's language.**

```
interface LedgerRepository {
  append(entry: LedgerEntry): Promise<void>
  balanceFor(paymentId: PaymentId): Promise<Money>
}
```

Note what is absent: no `findAll`, no ORM types, no pagination, no `query`. A port serves the use case, not the table.

**Implement adapters outside it.** One adapter per real dependency: database, HTTP client, queue, mail, payments, clock, ID generator.

**Inject at the edge.** The application layer receives instances; it never constructs them from a global.

**Keep the direction one-way.** Domain knows nothing. Adapters know the domain. Transport knows the application.

Two small ports that pay for themselves immediately: `Clock` (so time-dependent rules are testable) and `IdGenerator` (so identity is deterministic in tests).

## Checklist

- [ ] Domain files import nothing from the framework, driver or vendor SDK.
- [ ] Every external call in a use case goes through a port.
- [ ] Tests for the domain run with no database, no network and no fake timers where a fake clock will do.
- [ ] At most one adapter per dependency; a second adapter is a real requirement, not a preference.
- [ ] Interfaces are named after the domain, not the technology (`Ledger`, not `PostgresLedgerRepository`).

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A domain file importing the framework, the driver or an SDK.
- Domain tests that need a database or a container.
- Port methods named after SQL operations.
- A hand-written fake per test instead of one shared fake.
- An adapter that contains business rules.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| A repository interface for one database is over-engineering. | The interface is what makes the rule testable without the database. | Port at the use-case boundary, not per table. |
| The ORM entities are the domain model. | Then the framework owns your invariants. | Keep persistence models at the edge. |
| The domain needs framework annotations. | Then the domain cannot be tested in milliseconds. | Configure at the edge instead. |
| Naming it `PostgresLedgerRepository` is clearer. | It names the part you wanted replaceable. | Name ports after the domain. |
| Two adapters is a real requirement. | It is usually a preference. | One adapter until a second consumer exists. |

## Anti-patterns

- **Port per table.** You have written an ORM with extra steps and no domain.
- **Leaky types.** A port returning an ORM entity or a vendor SDK type exports the dependency you were hiding.
- **Abstraction for something used once.** A port with one implementation and no test double is a wrapper, not a seam. Keep it if it isolates time, network or money; drop it otherwise.
- **Interface explosion.** Twenty single-method interfaces nobody can navigate. Group by use case.

## Why it works

The domain becomes testable in milliseconds with no infrastructure, which is what makes TDD survive contact with reality. It also bounds the cost of replacement: swapping a payment provider or a database is an adapter change plus a contract test, not a rewrite. That is the difference between a codebase that can evolve and one that can only accumulate.

## Cost and when to skip

Medium: indirection, mapping code at boundaries, and a small amount of ceremony per dependency. Skip it for a script whose whole job is to call one API. Adopt it whenever the product has rules worth naming.
