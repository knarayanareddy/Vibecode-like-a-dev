# Optional VLD ACP v1 adapter

This package is the only VLD source boundary that imports
`@agentclientprotocol/sdk`. It uses that package's stable root entry point for
ACP v1; it does not use `unstable` or experimental v2 exports.

It is intentionally **not** a root VLD dependency. Normal `vld` commands and
CI do not install it. Install it only after reviewing the agent peer and its
direct executable policy:

```bash
npm install --prefix factory/integrations/acp-v1
```

A project policy must explicitly select `"adapter": "acp-v1"`. It has the same
host boundary as M4 `local-process`: direct absolute argv only; `read-only`;
`writeWorkspace: false`; `sandbox: false`; network, credentials, push and merge
denied. Its fresh environment contains only VLD IDs/digests and the existing
non-secret locale allowlist.

The bridge advertises no ACP client filesystem, terminal, MCP, authentication,
elicitation or credential capabilities. It records only bounded event metadata
and a stop digest/summary; it does not persist its prompt or transcript. A peer
cannot transition a VLD mission, submit a candidate, approve, queue or merge.

**CWD is not containment.** The ACP peer is a separately reviewed external
process. Do not use this adapter as a write sandbox or as proof that a peer
cannot access its own network/filesystem facilities. Use the fake or existing
local-process/handoff routes when an ACP peer is unavailable or unsuitable.
