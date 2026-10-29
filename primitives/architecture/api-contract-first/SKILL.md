---
id: architecture.api-contract-first
title: Contract before implementation
module: architecture
summary: Fix interfaces, error shapes and status codes while changing them is still free.
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
