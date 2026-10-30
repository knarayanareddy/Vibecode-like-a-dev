---
id: security.threat-model
title: Lightweight threat model
module: security
summary: Draw the trust boundaries once, name the assets, and turn each accepted mitigation into a control or a test.
obligation: "In {project}, every way into {aPrimary} — its endpoints, uploads, webhooks and admin paths — has a named control, and each accepted risk has an owner."
tier_min: 2
cost: medium
priority: 5
tags: [security, threat-model, stride, trust-boundary, owasp, llm-guardrails]
triggers: [threat model, prompt injection, abuse case, untrusted upload, attack surface, trust boundary, stride, vulnerability, llm guardrails, token spend, external model, structured json output]
enforces: [auth.authorization, ops.rate-limits, data.uploads, ai.guardrails]
artifacts: [04-contracts.md, 05-verification.md]
---

# Lightweight threat model

Security review arrives late and finds structural problems: an endpoint that trusts a client-supplied tenant id, an upload that serves whatever it is given, a webhook handler that does not verify its signature. Each is cheap to design and expensive to retrofit.

A one-hour threat model finds most of them before the code exists. It does not need a methodology or a meeting; it needs a diagram and four questions.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, every way into {aPrimary} — its endpoints, uploads, webhooks and admin paths — has a named control, and each accepted risk has an owner.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

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
- [ ] Uploads are type-sniffed, size-capped, stored outside the executable path, and their filename is never used as a path.
- [ ] Model output is untrusted input: validated against a schema, never concatenated into a query, a shell command or a template that runs.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A trust boundary drawn with no control on it.
- Public writes with no rate limit.
- Webhooks processed before the signature is verified.
- An accepted risk with no owner.
- A threat list unchanged since its first draft.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We are too small to be a target. | Scanners do not care about size. | Draw the boundaries anyway. |
| The security review happens at the end. | At the end, changes cost a release. | Model before the first external surface. |
| Object-level authorization is covered by the role check. | It is a different question. | A denial test per object. |
| Uploads are just files. | They are the most common way in. | Type, size, containment and a scanning decision. |
| Accepted risks can stay in our heads. | Then they are rediscovered as bugs. | Write them down with an owner. |

## Anti-patterns

- **Threat modelling as a document.** If nothing references a test or a control, it is a security-themed essay.
- **Trusting the client for anything.** Roles, prices, ownership and ids are server facts.
- **Authorization only in the UI.** Hiding a button is not access control.
- **"We'll do a security pass before launch".** Structural controls are not retrofittable in a week.

## Why it works

The expensive security bugs are design-shaped, and design is cheapest to change before implementation. A boundary diagram with four questions per crossing costs an hour and catches the class of bug that no amount of test coverage finds, because the code is behaving exactly as written.

## Cost and when to skip

Medium at first, then minutes per change. Skip the full walk for an internal tool with no personal data; never skip the object-level authorization and webhook questions if those features exist.
