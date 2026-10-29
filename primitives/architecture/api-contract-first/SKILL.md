---
id: architecture.api-contract-first
title: Contract before implementation
module: architecture
summary: Fix interfaces, error shapes and status codes while changing them is still free.
obligation: "In {project}, the shapes that carry {aPrimary} — its identifiers, error envelope and version — are fixed before the first handler is written."
tier_min: 1
cost: medium
priority: 3
tags: [api, contract, openapi, versioning, errors, interfaces]
triggers: [api, endpoint, contract, openapi, request, response, error shape]
enforces: [api.contract, api.error-envelope]
artifacts: [04-contracts.md]
---

# Contract before implementation

An interface decided during implementation is decided by accident: whatever shape the ORM returned, whatever the framework's default error looked like, whatever field name came to mind first. The client is written against that accident and now it is a promise.

Writing the contract first is cheaper for one reason: at that moment, changing it costs nothing.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the shapes that carry {aPrimary} — its identifiers, error envelope and version — are fixed before the first handler is written.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any exposed or consumed interface: HTTP endpoints, a library's public surface, a CLI's commands and exit codes, event schemas, a module boundary another team owns.

## The practice

1. **Enumerate the surfaces** and give each one a version and an owner.
2. **Fix conventions once, globally**: identifiers, timestamps, money, naming, pagination, idempotency, auth headers, deprecation window.
3. **Define one error envelope** and use it for every failure, including unknown routes and validation.
4. **Write the two or three failure examples per endpoint** as concrete payloads. This is where contracts actually differ, and where generated implementations quietly improvise.
5. **Generate or check the machine-readable contract in CI** so drift is detected rather than discovered by a client.
6. **Name the breaking changes** and state the rule: removing a field, narrowing a type, adding a required request field, changing a status code.

```json
{ "error": { "code": "PAYMENT_DECLINED", "message": "Card declined by the issuer.",
  "correlationId": "01J8Z...", "details": [{ "field": "paymentMethod", "reason": "insufficient_funds" }] } }
```

## Checklist

- [ ] Every surface has a version and an owner.
- [ ] One error envelope, one identifier scheme, one timestamp format.
- [ ] Each endpoint has at least one documented failure payload.
- [ ] Pagination and filtering are cursor-based and documented.
- [ ] Idempotency keys on every mutating endpoint that a client may retry.
- [ ] Contract check runs in CI, and a breaking change fails it.
- [ ] Status codes are chosen deliberately (403 vs 404 is a disclosure decision).

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- The same meaning gets different status codes on different endpoints.
- An error payload with no stable code.
- A removed field that did not fail CI.
- Offset pagination on a list users can delete from.
- The contract file is written after the handlers exist.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The contract is the OpenAPI file we generate later. | Generated afterwards, the contract describes the bug. | Write the shape first, then implement it. |
| We can add versioning after launch. | Every client you cannot see is already coupled. | Version from v1 and move additively. |
| Every error returns a message. | A prose message cannot be handled by a caller. | One envelope with a stable code and an id. |
| Idempotency is a payments concern. | Any retried POST duplicates without it. | A key on every mutating endpoint a client may retry. |
| 404 versus 403 is a detail. | It is a disclosure decision. | Choose once and apply it everywhere. |

## Anti-patterns

- **Endpoint-per-screen.** The interface becomes a rendering detail, and every UI redesign is a breaking change.
- **Errors as prose.** `{"message": "Something went wrong"}` cannot be handled by a client.
- **Sequential integer IDs in public shapes.** They leak volume and invite enumeration.
- **Versioning by header nobody reads.** Path versioning plus additive change is simpler.
- **A contract nobody validates.** It is documentation, and it will drift.

## Why it works

A contract is the one part of the system that both sides compile against, so it is the only place where a mismatch fails fast. It also constrains an agent: given a fixed envelope and status table, "invent a plausible error shape" becomes visibly out of scope in review.

## Cost and when to skip

Medium: an hour per surface, and it removes a class of rework. Skip the formal machine-readable contract for internal throwaway interfaces; never skip fixing the error envelope.
