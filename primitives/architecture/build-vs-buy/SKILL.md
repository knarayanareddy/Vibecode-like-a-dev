---
id: architecture.build-vs-buy
title: Build versus buy for commodity concerns
module: architecture
summary: Never hand-generate auth, payments, email or queues; own the domain, rent the commodity.
tier_min: 1
cost: low
priority: 5
tags: [build-vs-buy, auth, payments, vendors, risk]
triggers: [auth, payment provider, email, queue, build or buy, vendor]
enforces: []
artifacts: [03-architecture.md]
---

# Build versus buy

The most expensive code in a generated codebase is usually the code nobody asked for: a hand-rolled password reset, a home-made session store, a retry queue built on a table and a cron job. It passes the demo and fails the first security review, the first incident and the first audit.

The rule is not "buy everything". It is: **own what makes you different; rent what would make you liable.**

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

## Anti-patterns

- **Hand-rolled auth because it was faster.** It is faster until the first audit.
- **Three vendors for the same job.** Two of them will be half-integrated forever.
- **Buying the domain.** If your differentiation is inside a vendor's configuration UI, you do not own it.
- **A free tier treated as a design constraint.** Free limits become an outage with a billing event.

## Why it works

Commodity code has commodity risk and no competitive return: you pay full maintenance cost for zero differentiation. Meanwhile it is exactly the code an agent writes most confidently and most wrongly, because the happy path is well represented in training data and the failure paths are not.

## Cost and when to skip

Low to decide, and it usually saves weeks. Skip the discipline only for a prototype explicitly marked throwaway, and then never promote that prototype to production without revisiting it.
