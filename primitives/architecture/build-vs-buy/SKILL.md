---
id: architecture.build-vs-buy
title: Build versus buy for commodity concerns
module: architecture
summary: Never hand-generate auth, payments, email or queues; own the domain, rent the commodity.
obligation: "In {project}, everything around {aPrimary} that is commodity — auth, mail, payments, queues — is bought and wrapped in a port, and only the {primary} rules are written by hand."
tier_min: 1
cost: low
priority: 5
tags: [build-vs-buy, auth, payments, vendors, risk]
triggers: [auth, payment provider, email, build or buy, vendor, dependency choice]
enforces: []
gates: [G2-ADR]
artifacts: [03-architecture.md]
---

# Build versus buy

The most expensive code in a generated codebase is usually the code nobody asked for: a hand-rolled password reset, a home-made session store, a retry queue built on a table and a cron job. It passes the demo and fails the first security review, the first incident and the first audit.

The rule is not "buy everything". It is: **own what makes you different; rent what would make you liable.**

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, everything around {aPrimary} that is commodity — auth, mail, payments, queues — is bought and wrapped in a port, and only the {primary} rules are written by hand.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Tier 1 and above, at the moment a capability appears that every company in the world also needs.

## The practice

Classify the concern before writing code:

| Concern | Default | Why |
| --- | --- | --- |
| Authentication, sessions, MFA | Buy (managed IdP) or a vetted library | Credential handling is a liability, not a feature |
| Payments, tax, invoicing | Buy (provider SDK) | Compliance and money movement are not a weekend build |
| Email and SMS delivery | Buy | Deliverability is an entire discipline |
| Queues and scheduled jobs | Buy or use the platform | Correct retry semantics are subtle |
| Search at scale | Buy | Relevance tuning is a product of its own |
| File storage and scanning | Buy | Durability and malware scanning are not free |
| Your domain rules | Build | This is the product |
| Your data model | Build | This is your leverage |
| Your UI and interaction | Build | This is the experience |

Then, for anything bought:

1. **Wrap it in one adapter** and expose only the port your domain needs.
2. **Pin the version and record why** in an ADR.
3. **Write a contract test against a recorded real response**, not against your reading of the docs.
4. **Know the exit**: what data you need to export, and what would trigger leaving.

## Checklist

- [ ] Each commodity concern is either bought or has an ADR explaining the build.
- [ ] Vendors are behind a port; the domain does not import their SDK.
- [ ] Pricing and quota limits are documented, including what happens at the limit.
- [ ] Data residency and retention of the vendor are known if personal data is involved.
- [ ] There is an exit note: export path and switching cost.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- Auth, payment, email or queue code with no ADR.
- A vendor import inside the domain or application layer.
- The pricing page never reconciled with what the code sends.
- No export script for the data you send out.
- A second provider added as fallback with no abstraction.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| Rolling our own auth is not that hard. | The hard part is ten years of attacks, not the login form. | Buy it, then wrap it in a port. |
| A vendor SDK in the domain saves time. | It couples your rules to their versioning. | Keep the vendor behind a port. |
| We will handle the quota limit later. | The limit is the outage. | Document what happens at the cap before launch. |
| No personal data reaches the vendor. | Email and payment providers see both. | Record residency and retention. |
| We can always migrate. | Not without an export path nobody wrote. | Write the exit note when you sign up. |

## Anti-patterns

- **Hand-rolled auth because it was faster.** It is faster until the first audit.
- **Three vendors for the same job.** Two of them will be half-integrated forever.
- **Buying the domain.** If your differentiation is inside a vendor's configuration UI, you do not own it.
- **A free tier treated as a design constraint.** Free limits become an outage with a billing event.

## Why it works

Commodity code has commodity risk and no competitive return: you pay full maintenance cost for zero differentiation. Meanwhile it is exactly the code an agent writes most confidently and most wrongly, because the happy path is well represented in training data and the failure paths are not.

## Cost and when to skip

Low to decide, and it usually saves weeks. Skip the discipline only for a prototype explicitly marked throwaway, and then never promote that prototype to production without revisiting it.
