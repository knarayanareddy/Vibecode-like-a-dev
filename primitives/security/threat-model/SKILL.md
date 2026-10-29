---
id: security.threat-model
title: Lightweight threat model
module: security
summary: Draw the trust boundaries once, name the assets, and turn each accepted mitigation into a control or a test.
tier_min: 2
cost: medium
priority: 5
tags: [security, threat-model, stride, trust-boundary, owasp]
triggers: [security, threat model, attack, trust boundary, owasp, vulnerability]
enforces: [auth.authorization, ops.rate-limits]
artifacts: [04-contracts.md, 05-verification.md]
---

# Lightweight threat model

Security review arrives late and finds structural problems: an endpoint that trusts a client-supplied tenant id, an upload that serves whatever it is given, a webhook handler that does not verify its signature. Each is cheap to design and expensive to retrofit.

A one-hour threat model finds most of them before the code exists. It does not need a methodology or a meeting; it needs a diagram and four questions.

## When this applies

Tier 2 and above, or any project handling payments, personal data, authentication or file uploads.

## The practice

1. **Draw the boundary.** Browser → API → database, plus every external service. Mark where trust changes.
2. **List the assets** in order of cost if lost: money, credentials, personal data, availability, reputation.
3. **Walk STRIDE over each boundary crossing**, quickly:
   - Spoofing: can a caller claim to be someone else?
   - Tampering: can a client influence server-trusted values (price, tenant, role)?
   - Repudiation: would you know who did it?
   - Information disclosure: does an error or an id leak another subject's data?
   - Denial of service: is there any limit on cost per request?
   - Elevation of privilege: is authorization checked server-side, on every path?
4. **For each threat, decide**: mitigate (control + test), accept (written), transfer (vendor responsibility), or eliminate (remove the feature).
5. **Encode accepted mitigations as tests.** Anything not in a test will be reverted by a refactor.

The four failures that appear in nearly every generated app:

- Client-supplied ownership: `tenantId` or `userId` taken from the request body.
- Missing object-level authorization: a valid session can read any record by guessing an identifier.
- Unverified webhooks: signature not checked, so anyone can post an event.
- Unrestricted upload: no type, size or content validation, served from the app's own origin.

## Checklist

- [ ] Trust boundaries drawn; every crossing has an identified control.
- [ ] Object-level authorization tested with a denial case.
- [ ] Webhook signatures verified and replay rejected.
- [ ] Upload type, size and scanning decisions recorded.
- [ ] Rate limits on authentication and public writes.
- [ ] Threats list has an owner and a status; accepted risks are written down.

## Anti-patterns

- **Threat modelling as a document.** If nothing references a test or a control, it is a security-themed essay.
- **Trusting the client for anything.** Roles, prices, ownership and ids are server facts.
- **Authorization only in the UI.** Hiding a button is not access control.
- **"We'll do a security pass before launch".** Structural controls are not retrofittable in a week.

## Why it works

The expensive security bugs are design-shaped, and design is cheapest to change before implementation. A boundary diagram with four questions per crossing costs an hour and catches the class of bug that no amount of test coverage finds, because the code is behaving exactly as written.

## Cost and when to skip

Medium at first, then minutes per change. Skip the full walk for an internal tool with no personal data; never skip the object-level authorization and webhook questions if those features exist.
