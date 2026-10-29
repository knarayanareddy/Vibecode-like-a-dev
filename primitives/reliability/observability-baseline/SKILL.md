---
id: reliability.observability-baseline
title: Observability baseline
module: reliability
summary: One correlation ID, structured logs, and two numbers you can alert on; nothing more.
obligation: "In {project}, a failed {primary} operation is one structured log line with a correlation id and the record it belonged to, plus an alert someone has received."
tier_min: 2
cost: medium
priority: 6
tags: [observability, logging, tracing, correlation-id, slo, alerts]
triggers: [observability, logging, monitoring, tracing, correlation id, alert]
enforces: [ops.observability, delivery.audit-trail]
artifacts: [03-architecture.md, 05-verification.md]
---

# Observability baseline

When something breaks in a generated app, the usual situation is: a user says it failed, and there is no record of the request — no id, no user, no error, no duration. Debugging becomes archaeology on a chat log.

Observability does not mean a platform. It means three cheap things done consistently.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, a failed {primary} operation is one structured log line with a correlation id and the record it belonged to, plus an alert someone has received.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 2 and above. Below that, structured logs alone are enough.

## The practice

1. **Correlation ID.** Generate one per inbound request (honour an incoming one if trusted), attach it to every log line, error and outbound call, and return it to the client so a support conversation starts with an identifier.
2. **Structured logs.** One JSON line per event with a fixed field set: `time`, `level`, `msg`, `correlationId`, `actorId`, `route`, `outcome`, `durationMs`. No personal data, no secrets, no interpolated strings.
3. **Two metrics with alerts.** Error rate and p95 latency on the primary journey. A third is queue depth if work is async. Every alert needs a runbook line saying what to check.
4. **Errors carry context.** Log once at the boundary, with the error class, the operation and the correlation ID. Do not log the same error at four layers.
5. **Set an SLO, at least informally.** "99.5% of requests under 500ms, measured weekly" is enough to make trade-offs discussable.

## Checklist

- [ ] Correlation ID generated or propagated on every inbound request.
- [ ] Logs are structured JSON with a stable field set.
- [ ] No personal data, tokens or credentials in logs.
- [ ] Error rate and latency are recorded and one alert exists.
- [ ] Each alert has a one-line runbook: what to look at first.
- [ ] Errors are logged once, at the boundary, with their cause.
- [ ] Every state change to a regulated or personal record logs who did it, when, and the before and after values, in a store the application cannot rewrite.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- The same error logged at three layers.
- No correlation id on background jobs.
- An alert nobody has ever received.
- Tokens or email addresses in logs.
- A dashboard described as monitoring with no alert behind it.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We have logs. | Unstructured logs are a haystack. | JSON with a stable field set. |
| We will add correlation when we need it. | You need it during the first incident. | Generate or propagate it from day one. |
| Logging the payload helps debugging. | It logs personal data. | Log ids and outcomes, not bodies. |
| Metrics come after launch. | Then launch is unobservable. | Two numbers and one alert. |
| An alert without a runbook is fine. | It pages someone who cannot act. | One line: what to look at first. |

## Anti-patterns

- **A tracing platform for a product with one service.** Instrument the basics first; vendor sampling later.
- **`console.log('here')`.** Unsearchable, unaggregatable, and it will reach production.
- **Logging the same error at four layers.** You get four alerts and one cause.
- **Alerts without runbooks.** They train people to silence alerts.
- **Personal data in logs.** It turns your logging pipeline into a compliance liability.

## Why it works

The difference between a five-minute fix and a two-hour hunt is whether the failing request can be identified from outside. Correlation IDs are the cheapest available identity for a request, and two metrics are enough to distinguish "it is broken" from "it is slow" from "it is one user".

## Cost and when to skip

Medium at setup (half a day), near zero per feature if enforced at the boundary. Skip the dashboards, never skip the correlation ID once real users exist.
