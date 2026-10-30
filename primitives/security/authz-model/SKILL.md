---
id: security.authz-model
title: Authorization model, deny by default
module: security
summary: Put one policy layer between the request and the data, and test the denial path, not the happy path.
obligation: "In {project}, reading or changing another account's {primary} is refused by one server-side policy layer, and the denial path is tested — including across tenants."
tier_min: 1
cost: medium
priority: 3
tags: [authorization, rbac, abac, tenancy, row-level, security]
triggers: [authorization, permissions, roles, rbac, idor, cross-tenant, tenant isolation, access control, row-level access, object-level access, only view, only see, only command, only approve, assigned site, assigned zone, whole tenant]
enforces: [auth.authorization, auth.tenant-isolation]
artifacts: [02-domain-model.md, 04-contracts.md]
---

# Authorization model, deny by default

Authentication gets built; authorization gets assumed. The result is a product where every logged-in user can read every record, because the only check was "is there a session". Demos never show this, because the demo has one user.

Authorization is a domain concern, not a middleware checkbox: it encodes who may do what, which is a business rule that changes as the product grows.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, reading or changing another account's {primary} is refused by one server-side policy layer, and the denial path is tested — including across tenants.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any project with more than one actor, any multi-tenant product, any admin surface.

## The practice

1. **Pick the smallest model that fits.**
   - RBAC: roles with permissions, assigned to a membership. Fits most products.
   - ReBAC: relationships ("member of", "owner of"). Fits sharing and nested resources.
   - ABAC: attributes and policies. Fits regulated and contextual rules.
2. **One policy layer.** A single module answers "may this actor perform this action on this resource". Handlers call it; they never re-implement it.
3. **Deny by default.** An unmatched action is denied. New endpoints are inaccessible until a policy is written, which is the correct failure direction.
4. **Check object-level access, per identifier.** A valid session plus a guessed id must not read another subject's row. Do the check in the query where possible: `where id = ? and tenant_id = ?`.
5. **Never trust the client for ownership or role.** Tenant, actor and role come from the verified session, not from the request body.
6. **Test denial, not just permission.** For each protected operation: allowed for the right actor, denied for the wrong one, denied for the wrong tenant, and denied with no session.

## Checklist

- [ ] One policy module; no inline role checks scattered through handlers.
- [ ] Deny is the default for unknown actions.
- [ ] Every read by identifier carries an ownership or tenant constraint in the query.
- [ ] Denial tests exist for each protected operation, including cross-tenant.
- [ ] 403 responses do not reveal whether the resource exists (use 404 when that leaks less).
- [ ] Role changes take effect without a new login, or the delay is documented.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- Inline role checks scattered through handlers.
- A read by id with no ownership predicate.
- No denial test for a protected operation.
- A policy module only the transport layer calls.
- An admin bypass path with no test.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The interface hides the button. | The interface is editable. | Check the policy on the server. |
| Checking the role is enough. | A role does not know who owns the row. | Ownership or tenant constraint in the query. |
| Deny-by-default breaks the happy path. | That is what it is for. | Explicit allow per action. |
| 403 is more informative. | It confirms the record exists. | 404 where that leaks less. |
| Role changes can wait for the next login. | Then revocation is delayed. | Invalidate the session, or document the delay. |

## Anti-patterns

- **`if (user.role === 'admin')`** repeated in twenty handlers. They will diverge, and one will be wrong.
- **UI-only enforcement.** The API is the product; the UI is one client.
- **Tenant id from the request.** The classic cross-tenant data breach, in three lines.
- **Roles named after people** (`manager`, `editor`). Name capabilities; roles are bundles of them.
- **Authorization tested only positively.** The denial path is the security property.

## Why it works

Authorization failures are silent in happy-path testing and catastrophic in production, and they are pure domain logic: testable, deterministic, fast. Centralising the decision means one place to review, one place to fix, and a denial test that keeps the property true after the next refactor.

## Cost and when to skip

Medium: a policy module and a denial test per operation. Skip the full model for a single-user local tool; never skip object-level checks once records belong to different people.
