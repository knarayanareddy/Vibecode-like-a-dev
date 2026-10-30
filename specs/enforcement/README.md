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
| `G1-INCIDENT` | An owner and a first-response runbook exist for the primary journey, and both name the same person or role. | `node enforcement/gates.mjs` + `enforcement/templates/docs/runbook.md` | The runbook file. This proves the fields are present, not that the named person knows the product; the three diagnostic steps are the part to read. |

## Gates that need a person

An attestation gate (`enforcement/<gate>.md`) is not a checkbox. It is a file with
required fields — a date, a name, an outcome — because the alternative is a claim with
no record, which is indistinguishable from not doing it. Fill it in when the thing
happens; the runner rejects a file with the fields missing.
