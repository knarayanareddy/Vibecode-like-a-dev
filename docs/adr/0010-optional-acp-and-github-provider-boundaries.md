# ADR-0010: Optional ACP v1 and GitHub provider boundaries

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** VLD maintainers

## Context

VLD needs a portable coding-agent protocol and a forge integration without
turning its deterministic Core, Runtime ledger or Studio browser client into an
ambient process, credential, network or merge authority. ACP v2 remains
experimental, and a GitHub API request cannot replace GitHub authorization or
branch protection.

M4's local adapters are intentionally constrained, and M5 has frozen candidate,
verification, independent approval and queue receipts but no push/PR/merge
capability. A provider must consume those identities, not create or reinterpret
them.

## Decision

M8 introduces two **optional, nested integration packages**:

- `factory/integrations/acp-v1` pins `@agentclientprotocol/sdk` 2.2.0 and imports
  only its stable root entry point. Core dynamically loads it only when an
  explicit `acp-v1` policy is selected; normal VLD use has no ACP dependency.
  The bridge uses stable ACP v1 stdio JSON-RPC, advertises no client filesystem,
  terminal, MCP, authentication, elicitation or credential capability, and
  maps bounded session-update metadata into ordinary host events. Peer messages
  cannot transition Runtime state. The peer gets a fresh non-secret VLD context
  environment and a digest-only host prompt. ACP v1 is read-only in the same
  limited sense as M4 local-process: CWD is **not** containment, so a
  write-capable/sandboxed peer remains out of scope.
- `factory/integrations/github-v1` is a caller-injected GitHub REST client. It
  never reads `gh` login, environment tokens, files, browser storage or Runtime
  state. A surrounding operator supplies an in-memory token and an immutable
  plan built from an exact VLD candidate + independent approval + queue tuple.
  It can create/update a PR, inspect its exact head/base/check/review facts and
  request an exact-SHA merge only when the reviewed plan allows it. GitHub still
  enforces credentials, authorization and branch protection; VLD cannot push a
  branch or claim a merge succeeded without GitHub's exact response.

Neither adapter is catalog content. Neither is automatically installed,
discovered, enabled, invoked by Studio, or used in normal CI. The Core keeps no
provider credential, raw ACP prompt/transcript, webhook receiver, token, or
forge authority. Fixture-only tests inject peers/HTTP responses; any live peer
or GitHub run is manual and uses a disposable repository/account.

## Consequences

- VLD can exercise portable ACP/GitHub protocol and identity contracts without
  a proprietary agent account or network in default tests.
- An ACP peer must be explicitly installed and selected. It remains subject to
  M4 duration/output/cancellation/receipt handling and cannot directly submit,
  approve, queue, merge or alter policy.
- A GitHub plan is reviewable and tamper-evident, but M8 does not add a Runtime
  CLI command, credential configuration, automatic push, webhook, autonomous
  polling or hidden PR/merge action.
- A later typed Runtime forge endpoint needs a new ADR for credential brokerage,
  target revalidation, durable forge receipts, idempotency, ambiguity recovery,
  human confirmation and project/organization authorization.
