# Optional VLD ACP v1 adapter

This package is the only VLD source boundary that imports
`@agentclientprotocol/sdk`. It uses that package's stable root entry point for
ACP v1; it does not use `unstable` or experimental v2 exports.

It is intentionally **not** a root VLD dependency. Normal `vld` commands and Core CI do not install it. A separate adapter CI job installs and tests this package in isolation. Install it only after reviewing the agent peer and its
direct executable policy:

```bash
npm install --prefix factory/integrations/acp-v1
```

A project policy must explicitly select `"adapter": "acp-v1"`. It has the same
host boundary as M4 `local-process`: direct absolute argv only and no VLD
workspace-write authority (`read-only`; `writeWorkspace: false`; `sandbox: false`).
Network, credentials, push and merge are denied as VLD capabilities and its fresh
environment contains only VLD IDs/digests plus the non-secret locale allowlist.
These declarations are not filesystem, network or credential containment for the
same-user ACP peer; it remains an unconfined host process until a sandbox adapter
proves OS-enforced isolation.

The bridge advertises no ACP client filesystem, terminal, MCP, authentication,
elicitation or credential capabilities. It records only bounded event metadata
and a stop digest/summary; it does not persist its prompt or transcript. A peer
cannot transition a VLD mission, submit a candidate, approve, queue or merge.

**CWD is not containment.** The ACP peer is a separately reviewed external
process. Do not use this adapter as a write sandbox or as proof that a peer
cannot access its own network/filesystem facilities. Use the fake or existing
local-process/handoff routes when an ACP peer is unavailable or unsuitable.
