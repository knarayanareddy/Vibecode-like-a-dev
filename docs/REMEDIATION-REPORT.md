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

### What CI found that local runs could not

The first push was green on Linux and on this machine, and failed four CI checks. Each
failure was in the verification written for this work, not in the product — which is
exactly the class of defect a local run of the same suite cannot find, because the local
suite is the same one that just passed.

| Check | Failure | Cause |
| --- | --- | --- |
| `spec-check --strict` (self) | `cites unknown requirement REQ-999` in `ci-init.test.mjs` | A fixture quotes a bad anchor literally, so the repository's own drift guard read it as a real citation |
| `gates --strict` (self) | `G1-SECRETS` flagged `gates.test.mjs:614` | A fixture plants an `AKIA…` value to test the secret scan; the literal value is itself credential-shaped |
| Portable smoke, Windows | `documented commands point at the real output directory` — no commands collected | The collector's character class excluded `~`, and a Windows temp path is `C:/Users/RUNNER~1/…` |
| Portable smoke, Windows | `the CLI refuses a runtime below the documented minimum` — exit 1, not 2 | The probe imported the CLI from a bare absolute path; on Windows the loader reads a drive letter as a package name and throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` |

Two more Windows hazards were removed while looking: `new URL(import.meta.url).pathname`
yields `/D:/a/…`, which `path.resolve` then mangles, and it is now `fileURLToPath`.

The fix for each was to make the *check* platform-correct rather than to relax it. The
fixtures build their traps at runtime, which is the convention the existing anchor tests
already use, so the scans still see real input and the repository still passes its own
enforcement. The Windows collector now matches any non-space run ending in the script
name, and is verified against a relative path, a `/tmp` path and the exact `RUNNER~1`
shape that failed.

All fifteen checks pass at `1a4c956`, including both portable runners.

## Second audit: what was real and what was not

A second, independent audit arrived using different ids (`BLKR-01…05`, `BUG-06…08`).
It overlaps this work by renaming three items and misdiagnoses two others. Each claim
was checked against the shipped code rather than against its own "before" block.

| Second-audit id | Verdict | Evidence |
| --- | --- | --- |
| BLKR-01 mutation catch rate | Same item as BLK-2 | `G3-MUTATION` exists as a tier-3 gate; promotion to tier 2 is the sub-step declined above |
| BLKR-02 unconfined agent | Does not reproduce | The audit shows `env: process.env`; the code builds a closed allowlist (`environmentFor`). The unconfined-process limitation is disclosed in `README.md` and ADR-0006 |
| BLKR-03 vocabulary ceiling | Real, same as BUG-2 | `docs/STRESS-TEST.md` concedes 50% coverage. The audit's cited `findUnmappedObligations` does not exist |
| BLKR-04 file-wide assertion | **Real — fixed here** | One asserted test vouched for every other anchor in the file |
| BLKR-05 line budget cliff | Diagnosis wrong | `factory/lib/emitter.mjs` does not exist. habit-sync stores 906 lines against the 900 stored-packet reference: an existing warning, not a 28-line cliff |
| BUG-06 fixture risk inference | **Real — fixed here** | One `tests/fixtures/*.sql` inferred `pii`, `destructiveWrites` and `multiTenant` |
| BUG-07 context tokens | Same item as BUG-7 | Declined above with its reason |
| BUG-08 transitive blast radius | **Real — fixed here** | The radius named requirements and areas, never an imported module |

### What each fix does, and what it deliberately does not

**BUG-06 — fixture schemas.** `isProductionEvidence()` excludes paths whose *segment*
is a test, fixture, example, benchmark, mock or snapshot tree. Per segment, not by
substring: `src/testing.ts` and `src/latest.sql` remain production evidence, and a
mirror test asserts that identical DDL under `src/db/` still infers all three risks.
The exclusion is not configurable. A flag to keep fixture evidence would exist only to
recreate the false positive.

**BUG-08 — blast radius.** `planChange` takes an optional `projectDir` (`--repo` on the
CLI, matching `vld change verify --project`). It reports the one-hop import graph of
the anchored tests, rendered into `proposal.md`. Relative specifiers only, no package
resolution, no transitive closure: each of those turns a deterministic file read into
a resolver with its own bugs, and the point is to stop missing the obvious module.
Without a project the section is **absent**, not empty — an empty list would read as
"nothing else is affected".

**BLKR-04 — scoped assertions.** The assertion window is the test carrying the anchor:
brace-depth for JS/TS, indent for Python, a fixed window otherwise. When an anchor
cannot be scoped individually the check falls back to the file-level signal, so this
narrows a false pass rather than inventing one. Both checkers changed together,
because the repository ships two — `factory/lib/verify.mjs` for `vld verify` and the
generated `spec-check.mjs` in every packet — and a rule in only one is a rule an agent
can route around by running the other. The regression tests assert both.

All three were verified against the repository's own 49 anchored test files under
`--require-assertions`: zero false positives.

## Third audit: five of ten reproduced

A third audit (`BLK-1…3`, `BUG-4…10`) was checked the same way, against the merged
code rather than against its own "before" blocks.

| Third-audit id | Verdict | Evidence |
| --- | --- | --- |
| BLK-1 tautologies | **Real — fixed** | `assert(1,1)` was caught; `assert.equal(1,1)` passed, because the rule matched `assert(...)` and never `assert.<method>(`. `IMPORT_SIGNAL` also accepted `import 'node:test'` |
| BLK-2 wrong noun | Partly real | Primary noun was already `consultation`, not `agent`. The residual is real: `diagnosis` is listed as a term to define when the idea says the product must never produce one |
| BLK-3 Node gate | Not a defect | The guard fires as designed. The suggestion to name `npx -p node@22` is a message improvement, not a bug |
| BUG-4 line ceiling | Does not reproduce | Tier 3 + HIPAA + GDPR + PCI-DSS compiled to 1037 of 1100 lines and verified with zero warnings |
| BUG-5 wrong requirement | Not reproduced | The scoring critique is plausible, but on a fixture where all rules are unmapped the reasons were correct. Needs their exact fixture before touching a passing check |
| BUG-6 rule truncation | **Real — fixed** | An idea stating 5 rules rendered 2. Two causes: present-tense detection, and a silent cap of six |
| BUG-7 multi-surface | Real, but a feature | `kind` is singular by design; the actionable half is the missing warning when the idea names another surface |
| BUG-8 change area | **Real — fixed** | A `feature.ai-no-diagnosis` requirement reported `areas: ['core']`, and the `ai` practice never appeared |
| BUG-9 PASS on nothing | **Real — fixed** | `PASS · 0 error(s) · 4 pending`, exit 0, on a repository with no proven requirement |
| BUG-10 no did-you-mean | **Real — fixed** | `unknown trait "uploads"` listed thirteen values and never `upload` |

### BLK-2's negated concepts — fixed

A rule the product must *never* satisfy was becoming a term to define. It is now
detected and routed:

- Detection is narrow on purpose: a negation adjacent to a **production** verb (give,
  produce, return, emit, generate, present, show, display, offer, suggest, recommend)
  with a direct object in the same clause. The opposite mistake is worse than the bug —
  a detector broad enough to catch "never lose a settlement" would delete a real domain
  noun from every packet, and deleting is silent where listing is not.
- It takes the **head** noun of the object, not its modifier: "never return patient
  data" must not forbid `patient`.
- The noun is removed from the candidate pool, not from the rendered table, so it
  cannot become the primary noun either.
- Nothing disappears: the exclusion renders in the brief's own non-goals list as
  "Never produced by this product: a diagnosis", so a wrong classification is visible.
- Both directions are overridable — `vocabulary.forbidden` and `vocabulary.affirmed` —
  following the existing `domain.entity` precedent.

Regression tests pin the carepulse case (`diagnosis` moves), the `settlement`
counter-example (a real noun survives "never lose"), the modifier/head-noun distinction,
the primary-noun guarantee, and both overrides.

### BUG-7's surfaces — deliberately still open

`kind` describes one deployable and decides document layout; adding `surfaces[]` means
the planner unions catalog templates across surfaces, which changes tier calculation,
gate selection and doc arrangement. That is a feature, not a repair.

The cheap half — warn when the idea names a surface the profile does not declare — is
worth doing, but it is new behaviour rather than a defect fix, and it would fire on the
adversarial corpus. Shipping it alongside a correctness fix would make the correctness
fix harder to review, so it stays open with this reasoning rather than as an oversight.

### Correction to an earlier claim

The first version of this section said BLK-2 "touches every packet". It does not: only
two packets are committed (`specs/` and `examples/retro-board/spec`), so the cost is a
regeneration, which this repository does routinely. The cost was overstated.

### A divergence worth recording

`vld verify` does not implement the vacuity rules at all; only the shipped
`spec-check.mjs` does. The third audit's BLK-1 named `spec-check`, so that is what was
fixed. The two checkers disagreeing about a hollow test is the same class of problem as
the one fixed in the second round, and it remains.

### What CI caught in the third round

The BUG-6 fix removed a silent cap of six on "rules your idea already states". That
cap was hiding a real disagreement between two promises: no rule is dropped in
silence, and a single on-demand document stays under 200 lines. The adversarial corpus
contains an idea stating 110 near-identical rules, so removing the cap made
`02-domain-model.md` 204 lines and the adversarial stress job failed.

Two attempts made it worse before it got better. A one-line-per-rule table still
overflowed; and spreading the return value of `ordered` — which returns a string, not
an array — emitted one character per line, turning a 200-line document into 2834.

The resolution is to group rules that are identical once digits are normalised. An
idea that states the same invariant 110 times has one invariant; the document says
"110 variants that differ only in their numbers" and quotes one complete sentence.
Nothing is dropped, nothing is truncated mid-sentence, and the ceiling holds.

The same section also carried a mixed-noun defect the third review noticed: the
sentence read "beside the rule it protects" because the primary noun was `rule`.
