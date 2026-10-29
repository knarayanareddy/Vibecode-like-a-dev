---
id: reliability.idempotency-and-retries
title: Idempotency and retry policy
module: reliability
summary: Assume every message arrives twice; make replay safe and retry only what can succeed.
tier_min: 2
cost: medium
priority: 5
tags: [idempotency, retries, webhooks, queues, distributed]
triggers: [webhook, retry, duplicate, idempotency, queue, at-least-once, double charge]
enforces: [integration.retries, pipeline.idempotency]
artifacts: [04-contracts.md, 02-domain-model.md]
---

# Idempotency and retry policy

Every network boundary has three outcomes, not two: success, failure, and *unknown*. The unknown one is where duplicate charges, double emails and phantom jobs come from.

If a message can arrive twice — and with webhooks, queues and client retries it will — then every handler is a potential duplicate. Idempotency is the property that makes reprocessing safe; retry policy is the decision about which failures are worth repeating.

## When this applies

Any webhook consumer, any queue consumer, any client that retries, any pipeline stage that can be replayed.

## The practice

**Idempotency**

1. **Accept an idempotency key** on mutating operations from clients, and derive one for internal events (event id, or a natural key).
2. **Store the key with the outcome**, in the same transaction as the effect. A key consumed twice returns the first result.
3. **Scope the key**: per operation, per actor, per resource. Unscoped keys collide between users.
4. **Guard with a unique constraint**, not with an if-statement. Concurrency defeats checks; the database does not.
5. **Make the write atomic with the side effect** where possible; where not, use an outbox and accept eventual delivery.

**Retry policy**

| Condition | Action |
| --- | --- |
| 400, 401, 403, 404, 422 | Fail fast. It will not succeed on retry. |
| 409 | Re-read and decide; do not blind retry. |
| 408, 425, 429, 5xx | Retry with exponential backoff and jitter, bounded attempts. |
| Timeout after send | Retry **only** with an idempotency key. This is the dangerous case. |

Also: cap total attempts, record attempt counts, and move poisoned messages to a dead-letter destination with the payload and the reason.

## Checklist

- [ ] Every mutating endpoint accepts an idempotency key or is naturally idempotent.
- [ ] Uniqueness is enforced by the database, not by application checks alone.
- [ ] Client errors are never retried.
- [ ] Retries have backoff, jitter, a cap and a dead-letter path.
- [ ] Webhook signatures are verified before processing, and replays are rejected.
- [ ] A test sends the same event twice and asserts one effect.

## Anti-patterns

- **Retry on every error.** A 400 becomes a traffic spike and an alert storm.
- **Idempotency implemented in memory.** It disappears on restart, exactly when duplicates happen.
- **Assuming exactly-once delivery.** The queue promised at-least-once; design for it.
- **A lock instead of a key.** Locks prevent concurrency, not duplicates arriving a minute apart.
- **Side effects outside the transaction** with no outbox. The write commits, the email does not, and no one notices until a customer asks.

## Why it works

Duplicates are not an edge case; they are the normal result of retries, redeliveries and impatient users. The mechanism is small and local: one key, one unique index, one stored outcome. It converts a class of intermittent, unreproducible bugs into a database constraint.

## Cost and when to skip

Medium per integration, low once the pattern exists. Skip for purely idempotent operations (idempotent by nature: setting a value to a constant); never skip for money, entitlements or notifications.
