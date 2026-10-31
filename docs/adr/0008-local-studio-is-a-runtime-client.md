# ADR-0008: Local Studio is a Runtime client, not an authority

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** VLD maintainers

## Context

The Runtime ledger owns package state, leases, receipt validation and role policy.
A browser dashboard or VS Code WebView is exposed to untrusted project/agent output
and is a tempting place to accidentally embed a bearer token, run a local command,
or recreate workflow authorization.

Studio must make a local Runtime inspectable without turning the compiler, the
WebView, or an ambient IDE process into a privileged delivery controller.

## Decision

M6 ships a deliberately small local client surface.

1. The existing loopback-only Runtime process serves a static `/studio` page; this
   is not another server or backend. It calls only the same authenticated
   `/v1/runtime` typed API used by other local clients.
2. The operator manually pastes the one-time Runtime token shown by `vld studio
   serve` (or `vld runtime serve`). The page clears the input and keeps it only in
   JavaScript memory. It does not put a token in HTML, a URL, browser storage,
   project configuration, extension configuration or logs.
3. The page has a per-response nonce CSP, no external resources, no permissive
   CORS, no cache, no referrer, and uses DOM `textContent` for every Runtime
   field. It never renders agent output or receipt summaries as HTML.
4. Studio is read-oriented: it displays Runtime packet/policy identities, mission
   package board, dependencies, claims, lease health, bounded agent receipts and
   candidate/verification/review/queue receipts. It can request only the already
   typed `allocate` and `recover` API operations; Runtime independently authorizes
   both. It has no Git, agent, shell, file-serving, merge, forge or direct
   delivery-action implementation.
5. The included VS Code extension is a command entry point, not an IDE-owned
   authority. It accepts only an exact loopback `/studio` URL, opens the browser
   dashboard, or hosts a read-only inspector. The extension retains the pasted
   token only in its command closure; its WebView has a nonce CSP and accepts only
   a closed `refresh` postMessage schema.

## Consequences

- Studio works as a local visual path even while the existing CLI remains the
  complete operation surface.
- Runtime API availability/token failure visibly leaves the dashboard disconnected
  and privileged controls disabled rather than silently falling back to CLI or
  local command execution.
- Approval, store/catalog, project-check and merge controls remain deferred until
  Runtime exposes narrowly typed endpoints with their own policy/identity and
  recovery contracts.
- A future packaged VS Code extension needs extension-host smoke coverage and
  supported-version release evidence before marketplace distribution.
