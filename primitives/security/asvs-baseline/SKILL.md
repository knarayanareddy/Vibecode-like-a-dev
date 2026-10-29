---
id: security.asvs-baseline
title: OWASP ASVS baseline
module: security
summary: Replace "we did security" with a numbered, checkable baseline that a reviewer can audit.
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

## Anti-patterns

- **Copying all 300 items.** Nobody reads it; the file becomes a monument.
- **Marking everything met at the end.** The value is in the gaps.
- **A pentest as the only control.** It finds today's bugs, not tomorrow's regressions.
- **Compliance theatre.** A checked box with no test is a claim, and claims are what audits disbelieve.

## Why it works

A numbered standard converts a vague aspiration into a list a reviewer can falsify, and an agent can follow. That is the whole trick: the difference between "be secure" and "sessions must be rotated on privilege change, prove it" is the difference between advice and a requirement.

## Cost and when to skip

Low: an hour to select the subset, minutes per release. There is no product with credentials where skipping this is defensible.
