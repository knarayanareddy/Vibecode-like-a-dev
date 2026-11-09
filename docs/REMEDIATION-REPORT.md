# Remediation report — blockers and bugs

This is the record of fixing the 16 findings in the external review: four blockers,
twelve bugs. Each entry states what was wrong, what changed, and **how it was proven**.
The proof is the point: a fix without a reproduction that now behaves differently is a
claim, and this repository has enough of those.

Status: **16 of 16 headlines fixed except BLK-3, which needs paid credentials.**
Headline is not the same as every numbered sub-step: see
[Sub-steps that were deliberately not done](#sub-steps-that-were-deliberately-not-done),
which lists the eight recommendations this work declined and why. Read that section
before treating an item as fully closed.

Verification baseline at the end of this work:

| Check | Result |
| --- | --- |
| `npm test` | 377 pass, 0 fail (+ a 4-test packaging suite) |
| `npm run lint` | 128 modules parse, 47 JSON files valid, no committed debris |
| `npm run packet-sync` | both packets byte-identical to a fresh compile |
| `npm run eval` | 34/34 requirements name the product, no `✗` findings |
| `vld verify specs` | PASS · 6 requirements · 0 errors · 0 warnings |
| `vld verify examples/retro-board/spec` | PASS · 16 requirements · 0 errors · 0 warnings |

## Blockers

### BLK-1 — Risk flags raised the tier but added almost no domain content · **fixed**

Added `regulation[]` (`hipaa`, `gdpr`, `pci-dss`, `soc2`) to the profile schema, four
regime overlays, catalog templates for the four traits that had none (realtime,
notifications, search, i18n), a `trait-coverage` verify rule, and a dated-waiver path.

*Proof:* the carepath profile now verifies **24 requirements / 43 criteria / 21 gates**,
and with the HIPAA overlay **30 / 59 / 23**. Keyword counts in the packet: `hipaa` 6,
`phi` 12, `encrypt` 5, `minimum necessary` 1, `break-glass` 7, `six years` 2,
`business associate` 1. A profile declaring an uncovered trait fails with
`trait X has no requirement` unless it records a waiver.

### BLK-2 — The drift guard could be satisfied by a test that proves nothing · **fixed**

Replaced the single `expect(` regex with per-language vacuity rules: skipped/todo/
disabled tests, literal comparisons, empty bodies, and test files that import nothing
are now detected. `done` can be derived from evidence via `--report` (TAP, vitest JSON,
JUnit XML). `vld ci init` generates `--strict --require-assertions` by default.

*Proof:* `expect(true).toBe(true)` with an anchor → **exit 1**; `test.skip` with an
anchor → **exit 1**; empty body with `--require-assertions` → **exit 1**; a file with no
imports → **exit 1**; a done requirement with no passing entry in the report → **exit 1**;
the same done requirement with a passing entry → **exit 0**. Seven tests in
`factory/test/drift-guard.test.mjs` pin this.

### BLK-3 — The central claim, that agents ship better with the packet, is unproven · **open**

**Not fixed, and not fixable in this environment.** The harness exists
(`scripts/eval-outcome.mjs`, `--runner cmd|openai|anthropic`) and the manual,
approval-gated workflow exists (`.github/workflows/live-agent-benchmark.yml`), but a
result requires a paid provider key and a real run.

What was done instead, because it needs no model: a **`--lean` emit arm** that ships
`AGENTS.md` and `spec.json` only. On this repository's own profile it is **~2.9k tokens
against ~6.5k**, with every requirement and acceptance criterion intact. The audit's
1.5k target would require dropping criteria, so it was not reached, and the test
asserts the gap rather than hiding it.

*Evidence still required:* two agent configurations × 24 tasks × 3 arms × ≥1 seed,
committed to `docs/results/` with the exact model id, provider token usage, run id and
packet SHA, reported as **cost per merged task** with confidence intervals. See
[docs/results/README.md](results/README.md).

### BLK-4 — The audience that needs enforcement most cannot use it · **fixed**

Added `vld ci init`, which writes a required pull-request workflow
(`spec-check --strict --require-assertions` + the gate runner + a readable gate table).
Added a composite action at `.github/actions/spec-check/action.yml` that posts the
requirement and gate table on the PR, and a generated `enforcement/summary.mjs` so the
table needs no install.

*Proof:* in an empty repository `vld ci init` writes the workflow; adding a fixture with
`// @req REQ-999` makes the workflow's own first command **exit 1** naming REQ-999,
while an anchor-free repository passes. `vld ci init` refuses a missing packet (exit 2)
and refuses to overwrite an existing workflow without `--force`.

## Bugs

| # | Finding | Status | Proof |
| --- | --- | --- | --- |
| BUG-1 | Wrong product noun ("telehealth" ×307) | fixed | carepath → `appointment`/`patient`; telehealth-only → `clinic`/`user`; noun probe 9/11 |
| BUG-2 | Coverage detector wrong in both directions | fixed | tenant rule → `covered by REQ-008`; read-audit → `partial` by REQ-017; double-book → `unmapped` |
| BUG-3 | Packet contradicts the idea silently | fixed | grace variant selected; `verify` warns, errors under `--strict` |
| BUG-4 | Security requirements name the wrong actor | fixed | REQ-008/REQ-017 use `{tenantNoun}`/`{endUser}`/`{privilegedActor}` |
| BUG-5 | `specs/` hard-coded in generated commands | fixed | `-o docs/spec` emits `node docs/spec/…`; packet-sync green |
| BUG-6 | Untrusted idea text reached the agent as an obligation | fixed | 5 injection findings; `curl … \| (shell)`; `--strict` exits 2 |
| BUG-7 | Tier-3 packets had no room for missing requirements | fixed | budgets split by what is read; 1281-line packet passes with a warning, fat entry point fails |
| BUG-8 | 20 of 21 gates failed on day one with no baseline path | fixed | `--phase` defers; `--baseline` accepts with owner+expiry; regression still exit 1 |
| BUG-9 | Scope outgrew "a compiler": unconfined agent runtime | fixed (boundary) | `vld experimental`; compiler→runtime imports forbidden by test; `docs/EXPERIMENTAL.md` |
| BUG-10 | Idea cut off mid-sentence in the brief | fixed | whole sentences + `(+N sentences in profile.json)` |
| BUG-11 | Node ≥ 22 claimed, unenforced | fixed | exit-2 guard, CI minimum-node job, `npm pack` install test |
| BUG-12 | MCP `compute_rigor` demanded an unused idea | fixed | `{kind, stage}` only; MCP protocol test |

### BUG-7 in detail, because it changed a contract

The ceiling counted every stored document, so each requirement a coverage fix added
competed with the same number. Budgets are now split:

| Budget | Fails verify? | Measures |
| --- | --- | --- |
| `alwaysRead.maxLinesByTier` | yes | `AGENTS.md` (or `spec.md`) — loaded before every task |
| `alwaysRead.maxOnDemandDocLines` | yes | any single area document |
| `maxLinesByTier` | no, warns | the whole stored packet |

A packet that stores 1281 lines now **passes with one warning** that names the largest
area to split; a fat `AGENTS.md` still **fails**. `verify` also reports estimated
reading cost in tokens.

### BUG-9 in detail, because it is a boundary rather than a rewrite

The audit's fix is two published packages. That is a packaging release, not a patch.
What shipped is the property that split would protect: **the compiler does not depend
on the runtime**. A test resolves every import transitively from the compiler entry
points and fails if a runtime module is reachable. The runtime commands are labelled
experimental, print a note on every bare invocation, and are documented with their
unconfined-process limit in `docs/EXPERIMENTAL.md`. The bare spelling still works,
because it is in the published CLI contract and scripts depend on it.

## Things this report is not claiming

- The live comparison (BLK-3) has not been run. The README's calibration numbers are
  about the harness, not about any model.
- The vacuity rules are heuristics. They raise the cost of a false claim; they do not
  make one impossible. Semantic drift where code and test weaken together is still
  caught by mutation testing or a reviewer, not by this guard.
- `--lean` has not been measured against a live model either, so it is offered as an
  arm to test, not as the better default.


## Sub-steps that were deliberately not done

The review's 16 items contain far more than 16 changes. Each headline is fixed; these
numbered recommendations were **not** implemented, and saying so is part of the work.

| Item | Sub-step not done | Why |
| --- | --- | --- |
| BUG-7 | Emit per-area requirement files (`security.md`, `data.md`) linked from an index | Budgeting what is read already removes the squeeze that motivated the item. Splitting the documents is a restructuring of the packet contract, and it interacts badly with the single-file tier-0 packet; it should be its own change with its own review. |
| BUG-9 | Publish `@vld/core` and `@vld/runtime` as two packages | A packaging release, not a patch. The property the split protects — the compiler does not depend on the runtime — is enforced by a test. See the BUG-9 section. |
| BLK-4 | Browser bundle and a static "profile → packet.zip" page | The dependency-free ESM is already there; the bundling and hosting are new surface area. `vld ci init` addresses the stated problem (enforcement must not require the agent to cooperate) without it. |
| BLK-3 | Publish a live result; make the winning arm the default | Cannot be done without a paid provider key. The lean arm exists; nothing claims it is better. |
| BLK-2 | `--local` as the *replacement* for the default lenient mode | The generator still emits strict, so CI is strict by default. The checker cannot flip its own default without failing every team mid-adoption, so it now names the lenient mode and says what CI should run. |
| BLK-2 | Make `G3-MUTATION` mandatory at tier 2 | Attempted and reverted. The gate id encodes its tier and six tests enforce that invariant; promoting it required renaming the gate across the policy, the registry, `mutation.config.json` and the outcome suite. That is a policy release, not a defect fix. Tier 3 still requires it. |
| BUG-8 | Map `--phase` onto the milestones in `06-delivery-plan.md` | `--phase` takes a milestone number, but the mapping is authored in `gates.json` by hand rather than derived from the delivery plan, so the two can drift. Deriving it means parsing the plan's phase headings. |
| BUG-2 | Track coverage precision and recall in `npm run eval` | The three-state classifier and its golden cases are in place; the labelled corpus and the precision/recall reporting are not. |
| BUG-1 | Add `carepath-telehealth` to `examples/ideas` | The vocabulary cases live in `factory/test/vocabulary.test.mjs` (11 ideas, 9 correct). A separate examples corpus would duplicate it. |

### What was found while checking

Re-auditing the sub-steps against the shipped code surfaced three genuine defects that
the headline-level tests had not caught, all now fixed:

1. **A weak noun was still a guess.** `"Something nice for people who like things."`
   produced the adjective `nice`, rendered as "One nice goes from created to finished"
   in every template. A weak pick that is a modifier or a participle now falls back to
   the kind's neutral noun. `"Inventory sync."` still yields `inventory`, because the
   rule is about the word's shape, not the score.
2. **`regulated: true` with no regime only warned.** The review asked for a refusal
   under `--strict`; `compile --strict` now exits 2 instead of printing a note.
3. **Lenient mode was silent.** `spec-check.mjs` now names which mode it ran in and
   says that CI should use the strict flags.
