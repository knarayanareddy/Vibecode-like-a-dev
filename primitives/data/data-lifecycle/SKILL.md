---
id: data.data-lifecycle
title: Data lifecycle, export and deletion
module: data
summary: Decide retention, export and deletion before you store the first personal field; retrofitting them is a project.
obligation: "In {project}, every personal field of {aPrimary} has a stated purpose and retention period, and deleting {aSecondary} removes it from every copy, not just the table."
tier_min: 2
cost: medium
priority: 5
tags: [privacy, gdpr, retention, deletion, pii, compliance]
triggers: [pii, gdpr, delete account, retention, data export, privacy]
enforces: [data.lifecycle]
artifacts: [04-contracts.md, 02-domain-model.md]
---

# Data lifecycle, export and deletion

Personal data arrives as a convenience field and stays as a liability. The deletion path gets built last, if at all, and then it turns out that one table has no owner, one cache is not invalidated, and the analytics export keeps a copy forever.

Deletion is a design constraint, not a feature request. Systems designed with it are cheap to comply with; systems retrofitted with it are a quarter of work.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, every personal field of {aPrimary} has a stated purpose and retention period, and deleting {aSecondary} removes it from every copy, not just the table.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any storage of personal data, regulated data, or data a customer would be upset to find in a log.

## The practice

1. **Inventory the fields.** For each stored field: purpose, personal or not, retention period, deletion mechanism.
2. **Minimise at the boundary.** Do not store what you do not need. A birth date is rarely needed; an age band usually is.
3. **Tag personal data in the schema** so the deletion sweep can find it mechanically rather than by memory.
4. **One deletion operation per subject**, implemented once, covering: primary rows, derived rows, caches, search indexes, object storage and queued events.
5. **Retention as a scheduled job**, not a policy document. Expired data is deleted by a job whose run is recorded.
6. **Export as a first-class operation** if the domain promises portability; it also proves your data model is self-describing.
7. **Never log personal data.** Log identifiers, and resolve them in the system that is allowed to.

## Checklist

- [ ] Each personal field has a purpose and a retention period.
- [ ] Deletion covers derived data, caches and indexes; a test proves zero rows remain.
- [ ] The deletion audit record holds no personal data.
- [ ] A retention job exists and its last run is observable.
- [ ] Backups have a documented expiry, and the restore process accounts for deleted subjects.
- [ ] Analytics and log pipelines are in the inventory.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A personal field with no stated purpose.
- Deletion implemented only at the API layer.
- The retention job has no alert and no last-run time.
- An analytics pipeline in the diagram but not in the inventory.
- A deletion test that asserts no error rather than zero rows.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| We are not storing personal data. | Email, IP and user agent are personal data. | Inventory the fields and say why each exists. |
| Deleting removes the row. | Caches, indexes, backups and logs keep the copy. | Follow the data and delete every copy. |
| The deletion job logs who was deleted. | That log is now the personal data. | Record completion without content. |
| Retention is a legal question, not code. | The code is what actually deletes. | Encode the period and observe the job. |
| Backups are out of scope. | A restore reinstates the deleted subject. | Document backup expiry and the restore caveat. |

## Anti-patterns

- **Soft delete as the whole policy.** Rows marked deleted still breach retention, and they still appear in joins.
- **Deleting the account row only.** Everything with a foreign key survives, orphaning data you must still protect.
- **Anonymising by dropping a name column.** The email, the address and the free-text note identify the person.
- **One-off deletion scripts.** They will be run twice, by two people, in different ways.

## Why it works

Retention and deletion are cheap while the data model is small and expensive once six services hold copies. Deciding early also improves the model: a field with no purpose and no retention period is usually a field nobody needed.

## Cost and when to skip

Medium: a day at tier 2, mostly inventory and one sweep implementation. Skip the export; never skip the deletion path once real personal data exists.
