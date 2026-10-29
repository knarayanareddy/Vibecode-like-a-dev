# Stress test: ten ideas, end to end

Ten product ideas were run through the pipeline — `plan` → `compile` → `verify` → the shipped drift guard — and the resulting packets were judged on more than their exit codes. The profiles are committed in [`examples/ideas/`](../examples/ideas) and the runner is [`scripts/stress-test.mjs`](../scripts/stress-test.mjs); `npm run stress` reproduces every number below, and CI fails if any of them regresses.

The ideas were chosen to span the axes the tool claims to handle: a one-line prototype and a five-sentence regulated ledger, four languages of cost, eight kinds, and tiers 0 through 3.

| # | Idea | Kind | Stack | Tier | Req | Crit | Gates | Lines | Idea vocabulary | Unmapped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Rename photos by EXIF date (one line) | cli | TS | 0 | 4 | 6 | 3 | 134 | 0% | 0 |
| 02 | Vintage bicycle marketplace (one line) | web-app | TS | 2 | 18 | 32 | 15 | 945 | 22% | 0 |
| 03 | Slack standup bot (one line) | api | Python | 1 | 9 | 15 | 8 | 849 | 10% | 0 |
| 04 | Physiotherapy clinic bookings (paragraph) | api | Python | 3 | 14 | 25 | 21 | 935 | 17% | 1 |
| 05 | Double-entry payout ledger (paragraph) | api | Python | 3 | 16 | 30 | 21 | 965 | 38% | 0 |
| 06 | Offline-first habit tracker (paragraph) | mobile | TS | 1 | 12 | 22 | 8 | 885 | 41% | 0 |
| 07 | Analytics event pipeline (paragraph) | data-pipeline | Python | 2 | 11 | 19 | 15 | 893 | 33% | 1 |
| 08 | Feature-flag SDK (structured) | library | TS | 2 | 8 | 12 | 15 | 858 | 22% | 2 |
| 09 | Docs assistant with citations (structured) | agent | Python | 1 | 9 | 19 | 8 | 881 | 19% | 2 |
| 10 | Go log shipper (structured) | cli | Go | 1 | 6 | 8 | 8 | 822 | 3% | 1 |

Two definitions, because the whole report depends on them:

- **Idea vocabulary** — the share of distinctive words in the idea that appear anywhere in the requirements or the domain model, *excluding the verbatim quote of the idea itself*. It is a lower bound on domain specificity, not a quality score.
- **Unmapped** — sentences in the idea that state a rule ("must", "never", "only", "at least") for which no requirement exists. These are printed in the packet as a checklist, not silently dropped.

## What passed

**Structural validity: 10/10.** Every packet verifies, ships a working `spec-check.mjs`, stays under its tier ceiling, has acceptance criteria on every requirement, an anchor hint on every automated one, and references no document it does not ship. The drift guard ran against each packet's own directory and exited 0.

**Stack fidelity: 10/10 after two fixes.** TypeScript packets get Vitest and npm, Python gets pytest and ruff, Go gets `go test` and `golangci-lint`. An unknown stack (Rust, Ruby, .NET) is now named as unrecognised and flagged for an ADR instead of being quietly handed a TypeScript table.

**Rigor spread is real, not cosmetic.** Tier 0 produced a single 134-line file with three gates. Tier 3 produced 21 gates, a tenant-isolation requirement, an audit trail, and a data-lifecycle requirement. The median packet is 880 lines against ceilings of 900–1100.

**Class-specific obligations do appear.** The payments idea gets `payments.correctness` and a domain model whose invariants include *"Entries are immutable; corrections are compensating entries"* and *"Sum of debits minus credits equals zero per settled transaction"*. The pipeline idea gets watermark/idempotency. The SDK gets public-surface stability. The assistant gets model guardrails. These are the reason the tool is more than a prompt template.

## What failed, and what changed

Six real defects. Each now has a test that would fail if it came back.

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **Catalog insertion renumbered every later requirement.** Ids were a position in the catalog, and anchors cite `REQ-###` — so adding a rule silently repointed existing anchors at different rules while the guard kept passing. | Inserting one requirement mid-catalog shifted every subsequent id. | Ids are now assigned once and preserved per requirement key; ids of dropped requirements are retired, never recycled. `buildPlan` takes `previousIds`, `compile` reads them from the packet being regenerated. |
| 2 | **A payments packet talked about a retro board.** The domain model illustrated "name your own nouns" with the example project's nouns. | `05-payout-ledger/02-domain-model.md` contained *"For a retro board that is board, card, vote, action."* | The sentence is now product-neutral, and a test fails if packet text contains vocabulary from another example product. |
| 3 | **A Go project was handed TypeScript tooling.** Any stack that was not Python silently fell through to the TypeScript default — no `go test`, but ESLint and Vitest. | `10-log-shipper` named Vitest and ESLint, never `go test`. | Added a Go stack profile (language, router, migrations, `go test`, `golangci-lint`, `slog`) and language-appropriate anchor paths. Unrecognised stacks are labelled and require an ADR. |
| 4 | **Tier-0 packets pointed at documents they do not ship.** The single-file packet told the agent to read `05-verification.md` and `07-agent-handoff.md`; a tier-0 packet contains neither. | `01-photo-sorter/AGENTS.md` read order listed three missing files. | Read order, commands and out-of-scope references are now generated from the packet shape, and a test asserts no packet references a document it does not contain. |
| 5 | **The rate-limit obligation fired for libraries.** `ops.rate-limits` was gated on `publicFacing`, so a feature-flag SDK was told to rate-limit its authentication endpoints. | `08-flags-sdk` carried a requirement it could not satisfy. | Gated on kinds that actually have a network surface (`web-app`, `api`, `mobile`, `agent`) in addition to `publicFacing`. |
| 6 | **A tier-1 daemon had no observability requirement.** `ops.observability` was a tier-2 gate, so a log shipper that must not lose records on restart was not obliged to be visible when it fails. | `10-log-shipper` requirements list had no `ops.observability`. | Now applies to data pipelines, automation, and anything with the `background-jobs` trait at any tier ≥ 1. |

Two coverage gaps were found by the same pass and closed in the catalog:

- **`data.uploads`** — nothing obliged validation, containment and metadata stripping for an upload surface, although the marketplace idea uploads public photos. Applies when the `upload` trait is set and the project is tier ≥ 1 or public-facing.
- **`mobile.offline`** — the offline trait selected *practices* but no *requirement*, although the habit tracker's entire premise is that a tick survives being killed. Applies when the `offline` trait is set at tier ≥ 1.

Both are ordinary catalog entries with predicates, statements, failure paths and acceptance criteria; that is the intended extension mechanism, and it cost about forty lines of JSON each.

## The honest limit this test exposes

**The packet knows engineering classes, not your business.** Mean idea-vocabulary coverage is 21%, and the worst case is the clearest: the Go log shipper's idea names redaction, batched acknowledgements, dead-letter files and durable positions; its packet names none of them, because the catalog has no obligation called "a log shipper". What it does say is that the product must be runnable, observable, well-behaved at the command line, and must pin its own domain invariants — true, useful, and not enough.

The mitigation is deliberate and bounded:

1. The domain model states outright that the nouns are yours to supply, and now does so without borrowing another product's nouns.
2. Every normative sentence in the idea that no requirement covers is quoted back in `01-product-brief.md` as *"Obligations in the idea with no requirement yet"* — turn it into a requirement with `vld change`, or write it down as a non-goal. The pipeline, clinic, SDK, assistant and shipper packets each carry one or two of these.
3. `vld change` exists precisely for this: the delta is how a product-specific rule becomes an anchored requirement without editing generated files.

What is **not** claimed: that the packet alone is a sufficient specification. For ideas 04, 05, 07 and 08 the class-level obligations carry most of the weight, because payments, health data, pipelines and public libraries are heavily regulated by convention. For 03, 09 and 10 the packet is a scaffold plus a to-do list of the author's own rules, and the author has to do that work.

## Other limits worth stating

- **The unmapped-obligation heuristic only sees normative sentences.** "It redacts configured patterns" is a real requirement in the shipper idea and is invisible to a `must`/`never` matcher. The list is a floor, not a ceiling.
- **Tier 1 is the tightest budget.** The habit tracker is 885 lines against a 900-line ceiling. One more tier-1 obligation fails `verify`. The ceiling is a feature — the category's main criticism is length — but the next catalog addition for tier 1 requires trimming prose first, by design.
- **Ten ideas is not a benchmark.** These are hand-written profiles, not real users' first drafts, and the tool has not been compared against a person writing the same spec. That remains roadmap item #1.
