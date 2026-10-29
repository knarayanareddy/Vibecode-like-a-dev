---
id: security.asvs-baseline
title: OWASP ASVS baseline
module: security
summary: Replace "we did security" with a numbered, checkable baseline that a reviewer can audit.
obligation: "In {project}, the security of {aPrimary} is a numbered, checkable baseline at a stated level, with each item mapped to code or a test rather than to an opinion."
tier_min: 1
cost: low
priority: 4
tags: [owasp, asvs, security, checklist, review]
triggers: [owasp, asvs, security checklist, security review, hardening]
enforces: [auth.identity, auth.authorization]
artifacts: [05-verification.md]
---

# OWASP ASVS baseline

"We follow security best practices" is unfalsifiable. It cannot be reviewed, tested or disagreed with. The OWASP Application Security Verification Standard is numbered, versioned and specific, which makes each claim checkable.

You do not need the full standard. You need the twenty items that apply to a product with a login form and a database, written down with a status.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, the security of {aPrimary} is a numbered, checkable baseline at a stated level, with each item mapped to code or a test rather than to an opinion.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 1 and above. Tier 0 keeps the four items that matter even for a prototype: no secrets in code, parameterised queries, server-side authorization, safe output encoding.

## The practice

Copy the items that apply into the verification plan with a status of `met`, `not applicable` or `open — owner`. A representative subset:

| Area | Requirement | How to check |
| --- | --- | --- |
| Authentication | Passwords are hashed with a memory-hard algorithm (Argon2id, scrypt, bcrypt) | Inspect the auth adapter; one test asserts the hash format |
| Authentication | Session tokens are random, high-entropy, and rotated on privilege change | Inspect issuance; check cookie flags |
| Session | Cookies are `HttpOnly`, `Secure`, `SameSite` | Response header test |
| Access control | Every request is authorized server-side, deny by default | Denial-path test per protected endpoint |
| Access control | Object-level authorization for every identifier in a request | Test with another subject's id |
| Validation | All input validated against a schema at the boundary | Schema at every handler; reject unknown fields |
| Injection | Queries are parameterised; no string concatenation | Lint rule + review |
| Cryptography | Only vetted libraries; no home-made crypto | Dependency review |
| Error handling | Errors do not leak stack traces, SQL or internals | Force a failure and inspect the payload |
| Data protection | Personal data minimised and not logged | Log inspection |
| Communications | TLS everywhere; HSTS on | Header test |
| Files | Upload type, size and content validated; served from a separate origin | Test with a renamed executable |
| API | Rate limits on authentication and public writes | 429 test |
| Dependencies | No known-vulnerable dependency at release | Audit command in CI |
| Logging | Security events logged without secrets or personal data | Inspect log lines |

Then the discipline: **an item is only `met` if a test or a check proves it.** Otherwise it is `open`, which is honest.

## Checklist

- [ ] Baseline chosen (ASVS level 1 for most products) and version recorded.
- [ ] Each applicable item has a status and, where relevant, a test.
- [ ] `open` items have an owner and a date.
- [ ] The audit command runs in CI.
- [ ] The list is reviewed at each release, not once.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- No baseline level recorded.
- Items marked done with no code or test reference.
- `open` items without owners.
- A one-time spreadsheet audit.
- A control described as "handled by the framework".

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We follow best practice. | Unmeasurable, so unverifiable. | Pick a numbered baseline and record the version. |
| Our framework handles security. | It handles its part of it. | Map each item to code or a test. |
| Level 1 is for small projects. | Level 1 is the baseline for every project. | Record the level you are actually meeting. |
| We will run the audit before launch. | That is when items get marked done without a test. | Run it in CI from now. |
| Open items can wait. | An open item needs an owner and a date, or it is an accepted risk. | Record both. |

## Anti-patterns

- **Copying all 300 items.** Nobody reads it; the file becomes a monument.
- **Marking everything met at the end.** The value is in the gaps.
- **A pentest as the only control.** It finds today's bugs, not tomorrow's regressions.
- **Compliance theatre.** A checked box with no test is a claim, and claims are what audits disbelieve.

## Why it works

A numbered standard converts a vague aspiration into a list a reviewer can falsify, and an agent can follow. That is the whole trick: the difference between "be secure" and "sessions must be rotated on privilege change, prove it" is the difference between advice and a requirement.

## Cost and when to skip

Low: an hour to select the subset, minutes per release. There is no product with credentials where skipping this is defensible.
