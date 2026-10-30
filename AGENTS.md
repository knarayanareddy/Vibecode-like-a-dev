# AGENTS.md

You are working on **vibecode-like-a-dev**: a deterministic compiler that turns a project profile into a specification packet, plus a library of engineering primitives that the packet quotes.

This file is for agents working on *this* repository. Packets generated *by* this tool ship their own `AGENTS.md`; they are different documents.

## Commands

```bash
node factory/cli.mjs index              # rebuild primitives/index.json (required after editing a primitive)
node factory/cli.mjs index --check      # fail if the index is stale
node factory/cli.mjs plan examples/retro-board/profile.json
node factory/cli.mjs compile examples/retro-board/profile.json -o examples/retro-board/spec --force
node factory/cli.mjs verify examples/retro-board/spec
node factory/cli.mjs adopt <repo> -o <profile.json>   # infer a profile from code, with evidence
node factory/cli.mjs change <packet> <change.json> -o <dir>
node factory/cli.mjs change verify <dir>
node factory/cli.mjs mcp                # MCP server over stdio (8 tools)
npm test                                # 160 tests: integrity, planning, adoption, deltas, MCP, enforcement
npm run check                           # index freshness + tests + verify the example packet
```

No dependencies, no build step, Node 22+. If a change requires a dependency, stop and explain why in an ADR under `docs/` before adding it.

## Layout

| Path | Meaning |
| --- | --- |
| `primitives/<module>/<name>/SKILL.md` | One practice. Frontmatter is a contract; the body is the argument. |
| `primitives/index.json` | Generated. Never hand-edit. |
| `factory/policy.json` | Tiers, risk weights, caps, gates, line ceilings. |
| `factory/routing.json` | Which practice applies when, and why. |
| `factory/catalog/requirements.json` | Requirement templates with acceptance criteria. |
| `factory/lib/` | `frontmatter`, `predicate`, `indexer`, `planner`, `verify`, `emit/`, `scan`, `adopt`, `change`, `mcp`. |
| `factory/templates/spec-check.mjs` | Copied verbatim into every packet. Must stay dependency-free and standalone. |
| `factory/test/` | Node's test runner. Tests are the specification. |
| `examples/` | A profile and its compiled packet. Regenerate, do not hand-edit. |

## Rules

1. **The packet is a pure function of the profile.** No model calls, no clock-derived decisions except `generatedAt`, no randomness. Two compiles of the same profile must differ only in the timestamp.
2. **Every decision must be explainable in one line.** A practice is selected by a predicate and carries a `why`. If you cannot state why in one sentence, it is not a rule yet.
3. **Nothing is dropped silently.** Practices that do not apply are recorded as skipped with a reason; practices that do not fit the budget are recorded as deferred. Both appear in the packet.
4. **Keep the packet small.** Each tier has a hard line ceiling in `policy.json`, and `verify` fails when a packet exceeds it. Trim prose; never trim acceptance criteria or gates.
5. **The shipped checker is standalone.** `factory/templates/spec-check.mjs` runs inside a product repository with no access to this one: no imports beyond `node:` built-ins, no shared modules.
6. **Test first when behaviour changes.** Predicate semantics, planning, emission and verification all have tests. A change to `docs.mjs` prose needs a regenerated example and a passing `npm run check`.
7. **Do not weaken a test to make a check pass.** If the test is wrong, say why in the commit and fix the behaviour it describes.
8. **Gates accumulate, never repeat.** A tier-2 gate list must not restate a tier-1 obligation.
9. **Adoption infers, and says so.** Every value `adopt` produces carries the observation and a confidence. Never add an inference without evidence, and never infer regulation, team size or user scale from code.
10. **Runtime dependencies decide the kind; dev dependencies only inform tooling.** A dev-only `express` must not turn a library into an API server. This is covered by a test; keep it that way.
11. **A delta declares four things:** what changes, its blast radius, a probe, and a rollback. High risk without a probe and a rollback is invalid, not merely discouraged.
12. **Suppression is reported, never silent.** `@req-ignore` and `anchors.exclude` exist because a document or a fixture may legitimately quote a marker. Every run prints how many anchors were ignored; a suppression path that hides work quietly defeats the purpose of the guard.
13. **Progress is never regenerated.** A recompile carries `status` and `anchor` forward per requirement key and reports what it dropped. A no-op recompile must be byte-identical to a fresh compile, so `specs/` stays reviewable in a diff.
14. **Library metadata is measured, not judged.** `npm run eval` reports self-recall@1 for practice search, trigger collisions across practices, practices no profile ever selects, and catalogue requirements no practice enforces. A description or trigger change that breaks routing fails CI. `scripts/eval-specificity.mjs` does the same for the emitter: it compiles every committed profile and fails when two same-tier packets share too much content. The ratchet only moves down.
15. **A generative input must never become document structure.** Idea text is user data: flatten it before embedding, bound its length, and never let it reach a line start that Markdown reads as a heading. The adversarial suite tests this.
16. **Requirement ids are permanent.** `REQ-###` is an anchor target in product repositories. Ids are preserved per requirement key and retired when a requirement drops out — never renumbered, never recycled. This has a test; keep it.
17. **The MCP server must not drift from the CLI.** Both call `buildPlan`. If you add a tool, it returns policy-derived data, never a second implementation of the selection rules.

## Definition of done

- [ ] `npm run check` passes: `index --check`, tests, the example packet, this repository's own drift guard, the library eval, and both stress runs (ten representative ideas, twenty hostile ones, six refusals).
- [ ] If a primitive changed, its body is still under 500 lines and its checklist items are falsifiable.
- [ ] If policy or routing changed, `examples/retro-board/spec` **and** the self-spec packet (`npm run dogfood`) were regenerated and the diff was read, not just accepted.
- [ ] If a new practice was added, it is routed, its `enforces` keys exist, and its behaviour is covered by a test.
- [ ] Any change that would be expensive to reverse has an ADR (see `docs/` for existing ones).

## Do not

- Add a runtime dependency to the CLI or to the shipped checker.
- Hand-edit `primitives/index.json` or anything under `examples/*/spec/`.
- Introduce a model call into planning, selection or verification.
- Add a practice that applies to everything; the tool's value is in what it skips.
- Rewrite a generated packet's prose by hand — fix the generator instead.
