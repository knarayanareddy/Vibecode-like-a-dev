# Authoring a primitive

A primitive is a practice, packaged so an agent can find it, judge whether it applies, and follow it. It is data, not code: one markdown file plus one routing rule.

The test suite refuses to let a primitive be invalid, unreachable, routed twice, tier-inconsistent, or orphaned from the requirement catalog. So the workflow below is enforced, not suggested.

## 1. Create `primitives/<module>/<name>/SKILL.md`

```markdown
---
id: testing.mutation-testing          # <module>.<kebab-name>, unique, namespaced by folder
title: Mutation testing               # shown in plans and tables
module: testing                       # must match the folder
summary: One sentence. Say what it prevents and when to use it.
tier_min: 2                           # lowest tier where this practice is allowed (0-3)
cost: high                            # low | medium | high, in ongoing attention
priority: 6                           # 1 = never skip, 9 = nice to have. Drives budget cuts.
tags: [mutation-testing, assertions]  # for search
triggers: [mutation testing, stryker] # phrases a user or agent would say
enforces: [spec.drift-guard]          # requirement keys from the catalog this practice supports
artifacts: [05-verification.md]       # packet documents this practice feeds
gates:                                # optional: extra gates this practice contributes
  - id: G-FIT-DOMAIN-PURE
    statement: Domain modules contain no framework or vendor imports, checked in CI.
---

# Mutation testing

One paragraph on the failure mode this prevents, written as a consequence,
not as an aspiration. "Coverage answers X; it does not answer Y" beats
"testing is important".
```

### Body contract

| Section | Purpose |
| --- | --- |
| Opening paragraph | The failure mode, concretely. Assume the reader has seen the bad outcome. |
| `## When this applies` | Stage, tier, and the signals that make it relevant. Say when it does *not* apply. |
| `## The practice` | The smallest complete version. Steps, tables, a code sample if it clarifies. |
| `## Checklist` | Falsifiable items a reviewer can tick. Not a restatement of the prose. |
| `## Anti-patterns` | The specific wrong versions, each with why it fails. |
| `## Why it works` | The mechanism. One paragraph. |
| `## Cost and when to skip` | Honest cost, and the tier below which to skip. |

Rules:

- **Under 500 lines, and shorter than you think.** This is the whole point of the project. Most primitives here are 60-90 lines.
- **No time-sensitive claims.** No version numbers that rotate, no "currently the most popular". Link the idea, not the release.
- **No invented certainty.** If a number is a rule of thumb, say so.
- **Say "skip this when…".** A practice that claims to apply always is a practice nobody trusts.

## 2. Add a routing rule to `factory/routing.json`

```json
{
  "primitive": "testing.mutation-testing",
  "when": { "field": "tier", "gte": 2 },
  "why": "Coverage measures execution; mutation testing measures assertion strength."
}
```

Predicates available: `all`, `any`, `not`, `always`, and `field` with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `includes`, `exists`, `truthy`.

Every rule needs a `why` of at least twenty characters, because the packet prints it and a reviewer will read it. Unknown operators throw rather than defaulting to false — a router that silently ignores a decision is worse than one that refuses.

## 3. Optional: contribute requirement templates

If the practice implies behaviour a project must have, add a requirement to `factory/catalog/requirements.json`:

```json
{
  "key": "domain.money-precision",
  "when": { "field": "risks.payments", "eq": true },
  "render": "reliability",
  "title": "Money is exact under aggregation",
  "statement": "Amounts are stored as integer minor units with an explicit currency and never as floating point.",
  "failurePath": "A 0.1 + 0.2 sum of floats produces 0.30000000000000004; the ledger rejects non-integer amounts.",
  "acceptance": ["Given two amounts of 0.10 and 0.20 in EUR, when summed by the domain, then the result is exactly 30 minor units."],
  "verify": "automated"
}
```

Requirements need: a statement two independent implementers would implement the same way, at least one acceptance criterion, and a failure path. The test suite rejects vacuous ones (`you should`, `best practice`) and requirements with no criteria.

`render` picks the packet document the requirement appears in: `core`, `data`, `security`, `frontend`, `api`, `reliability`, `ai`.

## 4. Regenerate and check

```bash
node factory/cli.mjs index        # rewrite primitives/index.json
npm test                          # integrity, routing, planning, enforcement
npm run check                     # index freshness + tests + verify the example packet
```

If a payload changes, tell the reader what changed rather than quietly regenerating the committed example.

## 5. If you change policy

`factory/policy.json` holds the tier thresholds, risk weights, stage caps, gates and per-tier line ceilings. Changes there affect every packet:

- **New gate** — add it to the tier that introduces the obligation, and never restate a lower tier's gate.
- **New risk signal** — give it a weight and a label; the plan prints it.
- **Raise a line ceiling** — say why in the `policy` field. The ceiling is the project's main defence against becoming the thing it criticises.

## 6. If you change the guard or the emit path

The drift guard exists twice on purpose — `factory/lib/verify.mjs` for `vld verify` and `factory/templates/spec-check.mjs` for the copy shipped inside a packet, which may not import anything from this repository. Any change to anchor scanning, suppression or the exit-code contract must land in both, with a test that would fail if they diverge.

Two invariants hold the packet together, and both have tests:

- **A no-op recompile is byte-identical to a fresh compile.** If you add a field that depends on the previous packet, gate it on an actual change, or the "committed packet is in sync with the generator" CI check will fail for the wrong reason.
- **Same profile, same bytes.** No clock, no randomness, no environment lookups. `generatedAt` is the single exception and is stripped by the sync check.

## Review checklist for a new primitive

- [ ] The failure mode is stated concretely, with the cost of not doing it.
- [ ] The practice fits in a paragraph plus a checklist.
- [ ] The checklist item would fail for a real, identifiable implementation.
- [ ] Anti-patterns are things people genuinely do, not strawmen.
- [ ] `tier_min` and `cost` are honest; the packet will tell people to skip it below that tier.
- [ ] `enforces` keys exist in the catalog, and the requirement they point at is testable.
- [ ] The routing predicate is as narrow as the practice's real applicability.
- [ ] `index --check` and `npm test` pass.
