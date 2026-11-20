# Gate enforcement

Every gate in `spec.json` has exactly one command that checks it. This directory is
generated; re-run `vld compile … --force` after changing the profile rather than
editing it by hand.

```bash
node enforcement/gates.mjs            # check this repository
node enforcement/gates.mjs --strict   # pending gates fail too: use this in release CI
node enforcement/gates.mjs --json     # feed it to something else
```

`enforcement/gates.mjs` has no dependencies, so it runs anywhere Node runs and can be
committed alongside the spec. It checks structure — files, commands, anchors, record
fields — because that is what a repository can prove about itself. It is not proof
that the gate is *met*: each row says what the mechanism cannot see, and those gaps
are where review still matters.

| Gate | What it asks for | How it is checked | What this mechanism does not prove |
| --- | --- | --- | --- |
| `G0-RUN` | The project starts from a clean clone with one documented command. | `node enforcement/gates.mjs` | The README itself. This check only proves a command is written down; G0-SMOKE proves it works. |
| `G0-CHECK` | Lint or typecheck runs in CI on every pull request. | `node enforcement/gates.mjs` | The workflow file. Add the same command to the README so a local run matches CI. |
| `G0-SMOKE` | One happy-path smoke test exercises the primary user journey. | `node enforcement/gates.mjs` | One end-to-end test, exercising the documented interface rather than the internals. |
| `G1-CI` | The full test suite runs in CI on every pull request and is required to merge. | `node enforcement/gates.mjs` | The workflow file, plus a branch protection rule that makes the job required. The rule is in the forge, not in the repository. |
| `G1-DOMAIN-TESTS` | Every rule in the domain model has at least one automated test. | `node enforcement/gates.mjs` | `spec-check.mjs` counts the anchors; this gate fails while a core requirement has none. |
| `G1-AC-TRACE` | Every requirement marked automated maps to a named test through an @req anchor. | `node enforcement/gates.mjs` | `spec-check.mjs --strict`, run in CI. |
| `G1-RUNBOOK` | README documents how to run, test and deploy, plus known limitations. | `node enforcement/gates.mjs` | Three headings. A runbook with none of them is a README for the author. |
| `G1-SECRETS` | No secret is committed; configuration comes from the environment and is validated at startup. | `node enforcement/gates.mjs` + `enforcement/gitleaks.toml` | The runner scans the working tree; gitleaks scans history. Both are needed: this file cannot see what was already committed and deleted. |
| `G2-AUTHZ` | Authorization is enforced server-side and covered by denial-path tests. | `node enforcement/gates.mjs` + `enforcement/policy/authz.rego` | The rego policy is evaluated with `conftest test --policy enforcement/policy`; the runner only proves a denial test exists. |
| `G2-THREAT` | A threat model exists and each accepted mitigation maps to a control or a test. | `node enforcement/gates.mjs` | The document. A threat model without an owner column is a list of worries. |
| `G2-CONTRACTS` | Every consumed or exposed interface has a versioned contract and a breaking-change check. | `node enforcement/gates.mjs` + `enforcement/contracts/contract.test.ts` | The skeleton consumes a recorded fixture; replace the fixture with a real capture, not a mock written from the docs. |
| `G2-OBSERVABILITY` | Requests, errors and latency are observable with correlation IDs. | `node enforcement/gates.mjs` | A grep is the weakest form of this check. It proves the identifier exists, not that every path carries it. |
| `G2-MIGRATIONS` | Schema changes ship as forward-only migrations with a tested rollback or restore path. | `node enforcement/gates.mjs` | The migration directory. Forward-only is a convention the runner cannot see; the restore drill in G3-RESTORE is what proves it. |
| `G2-ADR` | Significant decisions are recorded as ADRs with context, decision and consequence. | `node enforcement/gates.mjs` | The ADR directory. An ADR with no consequence section is a changelog entry. |
| `G2-DRIFT` | CI fails when a requirement loses its test anchor or the spec references a missing primitive. | `node enforcement/gates.mjs` | `spec-check.mjs`, shipped with the packet. This gate is the one check that needs no project code to be honest. |
| `G2-MUTATION` | Domain-layer mutation score meets or exceeds the 60% tier-2 kill floor. | `node enforcement/gates.mjs` + `enforcement/mutation.config.json` | `vld verify --run --mutation` or Stryker / mutmut / gremlins / cargo-mutants report enforcing a 60% kill floor. |
| `G3-MUTATION` | Domain-layer mutation score is at or above the target recorded in the spec. | `node enforcement/gates.mjs` + `enforcement/mutation.config.json` | The runner rejects an absent/malformed manifest, a missing requirement oracle, or an oracle with no @req anchor/assertion. CI must run the selected mutation tool; the structural runner cannot measure its score or prove the oracle is complete. |
| `G3-PROPERTY` | Core invariants are covered by property-based or generative tests. | `node enforcement/gates.mjs` | The generated-seed corpus is not checked; a property test without a recorded seed is an example test in disguise. |
| `G3-SLO` | Service level objectives and an error budget are documented and alerted on. | `node enforcement/gates.mjs` | The document plus the alert rule. The number is a policy decision; this check only proves someone wrote it down. |
| `G3-RESTORE` | A restore drill has been performed and its date recorded. | `node enforcement/gates.mjs` + `enforcement/templates/enforcement/restore-drill.md` | An attestation, because the drill happens against production data the repository cannot see. |
| `G3-SECURITY` | Threat model is reviewed each release; a security regression suite exists. | `node enforcement/gates.mjs` | The document plus the security regression suite. A review nobody signed for is a meeting. |
| `G3-ROLLBACK` | Every deploy has a tested rollback or a feature-flag kill switch. | `node enforcement/gates.mjs` + `enforcement/templates/enforcement/rollback.md` | An attestation, because executing the rollback is the evidence. An unexecuted rollback procedure is a paragraph. |
| `G2-AUTONOMY` | Autonomous tool calls enforce a closed allowlist, human confirmation on destructive actions, step/cost ceilings and a tested kill switch. | `node enforcement/gates.mjs` | Test signals on the tool dispatcher and runner loop. It does not prove every external side effect is classified destructive; review the tool registry alongside it. |
| `G3-PHI-ENCRYPT` | A PHI field is unreadable in raw storage and in logs, proven by a test. | `node enforcement/gates.mjs` + `enforcement/templates/docs/phi-encryption.md` | The attestation. It records an owner's claim per store; it cannot show that a field is unreadable in raw storage, which is what the requirement's test must prove. |
| `G3-AUDIT-RETENTION` | Audit records for PHI are append-only and the retention period is configured, proven by a test. | `node enforcement/gates.mjs` + `enforcement/templates/docs/audit-retention.md` | The document. A retention period that exists only in a table row is a policy, not a proven control. |
| `G3-SUBJECT-RIGHTS` | Access and erasure are both exercised by a test against every store the product owns. | `node enforcement/gates.mjs` | The test names. It cannot show the export covers every store the product owns — that is the requirement's checklist. |
| `G3-AI-OVERSIGHT` | AI transparency labelling, human-override gating, stop-switch behaviour and traceable decision logging are proven by automated tests. | `node enforcement/gates.mjs` | Automated checks for labels, override gates and trace logs; conformity classification remains a documented legal review. |

## Gates that need a person

An attestation gate (`enforcement/<gate>.md`) is not a checkbox. It is a file with
required fields — a date, a name, an outcome — because the alternative is a claim with
no record, which is indistinguishable from not doing it. Fill it in when the thing
happens; the runner rejects a file with the fields missing.
