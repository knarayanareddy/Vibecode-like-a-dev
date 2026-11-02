# Input, Protocol, Artifact, and Distribution Remediation Plan

**Status:** Complete — local and hosted validation passed
**Scope:** Remediate the confirmed profile-validation, MCP framing, artifact-validation, version-provenance, package/distribution, extension-test, and contributor-governance findings. Preserve VLD's deterministic compiler and its explicit distinction between durable reviewed project state and ephemeral local state.

## Review decisions and boundaries

- [x] Treat a misspelled policy-bearing profile field as a compile-blocking validation error, never as an inert extra field.
- [x] Treat a final complete MCP JSON-RPC message at EOF exactly like a newline-terminated message; report malformed residual input as a JSON-RPC parse error.
- [x] Treat a corrupt packet manifest as invalid authority for every artifact validator. Do not silently turn it into an empty requirement set.
- [x] Do **not** blanket-ignore `.vld/`: locked modules, catalog trust/pins, and reviewed store metadata are intentionally reviewable project state. Ignore only caches, local execution state, generated agent state, and path-specific workspace state; document the policy.
- [x] Make emitted compiler provenance derive from the package version rather than a second stale version literal.
- [x] Keep public CLI failure semantics machine-detectable: a refused requested write must use a non-zero exit code.
- [x] Make package documentation links work from the installed tarball and make the VS Code package test script discover at least one meaningful test.
- [x] Keep service startup output/token handling deliberate; a generic `--json` flag is not automatically appropriate for a long-running command.

## 1. Close the profile input contract

### Implementation checklist

- [x] Define the complete allowed top-level profile key set.
- [x] Reject unknown top-level keys during validation, including a `risk` typo for `risks`.
- [x] Preserve valid optional `overlays` and existing profile defaults.
- [x] Validate nested object shapes sufficiently to prevent unknown policy-bearing keys from becoming inert configuration.
- [x] Ensure CLI `plan`/`compile` returns a non-zero status and names the offending field.

### Acceptance checklist

- [x] A high-risk profile with `risks` retains its risk score and tier.
- [x] Renaming `risks` to `risk` produces an explicit validation error and no packet.
- [x] Arbitrary top-level and nested risk keys fail closed.
- [x] Existing supported profiles and bundle-generated profiles remain valid.

## 2. Flush MCP input safely at EOF

### Implementation checklist

- [x] Extract line processing so newline-delimited and EOF-residual messages use the same parse/dispatch/error path.
- [x] On EOF, ignore whitespace-only residual input and process one non-empty final JSON-RPC message.
- [x] Do not call `process.exit()` before the residual message is dispatched.
- [x] Keep one JSON-RPC response per request and existing notification behavior.

### Acceptance checklist

- [x] A single `tools/list` request without a trailing newline yields one response.
- [x] Multiple messages with only the last missing its newline yield all responses.
- [x] A malformed final residual message yields one `-32700` parse error.
- [x] Existing newline-delimited MCP behavior remains unchanged.

## 3. Fail closed on corrupt artifact packet authority

### Implementation checklist

- [x] Replace the ambiguous empty-array packet loader with a result that distinguishes missing, malformed, and valid manifests.
- [x] Require a valid `spec.json` manifest before validating requirement links for every artifact type.
- [x] Continue to allow artifact **authoring** before a packet exists where supported; validation must report that no packet authority is available.
- [x] Ensure `verifyArtifacts` reports the packet failure once, clearly, without masking artifact errors.

### Acceptance checklist

- [x] A review brief referencing `REQ-999` fails against a corrupt manifest.
- [x] A malformed/missing manifest cannot cause a strict artifact validation pass.
- [x] A valid packet still accepts known links and rejects unknown links.
- [x] QA-plan packet-required behavior remains intact.

## 4. State persistence, version, and CLI outcome contracts

### Implementation checklist

- [x] Add targeted `.gitignore` rules for ephemeral `.vld` caches/execution state while retaining durable reviewed locks.
- [x] Document which `.vld` entries teams should commit and which must remain local.
- [x] Derive `FACTORY_VERSION` from root package metadata and add a synchronization invariant.
- [x] Make `adopt` return non-zero when its requested output was refused, while preserving the diagnostic report.
- [x] Add an oldest-supported Node 22 CI coverage lane without removing current latest-Node coverage.

### Acceptance checklist

- [x] Local runtime/workflow/cache/agent/workspace state is ignored by Git rules.
- [x] Module locks and catalog/store trust metadata remain eligible for review and version control.
- [x] Every emitted footer and `spec.json.generatedWith.version` equals `package.json.version`.
- [x] `adopt` exit status is non-zero when it cannot write the selected output.
- [x] CI executes the portable core suite at the minimum supported Node 22 version and latest Node 22.

## 5. Package, extension, and contributor-facing authoring

### Implementation checklist

- [x] Include linked documentation, prompts, and example assets in the npm package, or replace links with versioned reachable destinations.
- [x] Add package `repository`, `bugs`, and `homepage` metadata.
- [x] Add an actual dependency-free VS Code extension-package test and keep its `npm test` command non-vacuous.
- [x] Add `CONTRIBUTING.md`, `SECURITY.md`, and an honest `CHANGELOG.md` beginning with an Unreleased section.
- [x] Document why `runtime serve --json` is intentionally not a one-shot JSON response, or add a separately safe machine-readable readiness contract after review.

### Acceptance checklist

- [x] `npm pack --dry-run` includes every local README link target promised to installed users.
- [x] The VS Code package test reports at least one executed test.
- [x] Package metadata renders repository and issue links correctly.
- [x] Contributor/security/release guidance is present without inventing historical release entries.

## Validation matrix

- [x] Focused profile, MCP, artifact, CLI, package, Studio, and CI-policy regressions.
- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run check`
- [x] `npm pack --dry-run`, plus an isolated packed install/link audit.
- [x] VS Code package `npm test`.
- [x] ACP optional-package install/test.
- [x] `git diff --check`
- [x] Hosted CI green on Linux, macOS, Windows, minimum Node 22, and latest Node 22.

## Completion checklist

- [x] Every confirmed finding has regression coverage or an explicitly documented design decision.
- [x] Generated packets are synchronized where generator output changes.
- [x] No broad `.vld` ignore rule obscures durable reviewed authority.
- [x] Local validation matrix passes.
- [x] Hosted CI passes.
