---
id: reliability.observability-baseline
title: Observability baseline
module: reliability
summary: One correlation ID, structured logs, and two numbers you can alert on; nothing more.
tier_min: 2
cost: medium
priority: 6
tags: [observability, logging, tracing, correlation-id, slo, alerts]
triggers: [observability, logging, monitoring, tracing, correlation id, alert]
enforces: [ops.observability]
artifacts: [03-architecture.md, 05-verification.md]
---

# Observability baseline

When something breaks in a generated app, the usual situation is: a user says it failed, and there is no record of the request — no id, no user, no error, no duration. Debugging becomes archaeology on a chat log.

Observability does not mean a platform. It means three cheap things done consistently.

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
