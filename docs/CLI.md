# CLI reference

> Generated from the `USAGE` constant in `factory/cli.mjs`. Do not edit command prose here; run `node scripts/generate-cli-doc.mjs` after changing the CLI.

```text
vibecode like a dev — from one paragraph to a spec an agent can execute

Usage
  vld init <dir>                     write profile.json to fill in
  vld adopt <repo-or-url> [-o <file>] [--name <slug>] [--idea <text>] [--force] [--json]
                                     infer a profile from a local path or Git repository URL
  vld plan <profile.json> [--json] [--strict]   show selection and reasoning, write nothing; --strict refuses an adopted TODO idea
  vld compile <profile.json> -o <dir> [--force] [--strict] [--packet-dir <label>] [--lean]
                                     --packet-dir overrides the directory name embedded in generated commands
                                     --lean emits AGENTS.md and spec.json only, for a token-budgeted reader
                                     render the specification packet
  vld ci init [--project <dir>] [--packet <dir>] [--node <version>] [--force]
                                     write the required pull-request check that runs the packet's enforcement
  vld verify <packet-dir> [--repo <path>] [--strict] [--require-assertions] [--json]
                                     check a packet, optionally against code; --require-assertions rejects hollow anchored tests
  vld change <packet-dir> <change.json> -o <dir> [--apply] [--force] [--json]
                                     render a delta spec for a brownfield change
  vld change verify <change-dir> [--project <dir>]
                                     validate a change proposal, reviewed evidence links and resulting manifest
  vld change archive <change-dir> <packet-dir> [--profile <p>]
                                     fold an applied change into the profile's overlay stack
  vld change init <dir>              write change.json to fill in
  vld artifact list|init|validate|verify|status <type> [id] [--from-store store/asset] [--project <dir>]
                                     generate, validate and cross-check product, architecture, delivery, review and QA artifacts
  vld discoverability-readiness init|validate [--project <dir>] [--profile <file>] [--packet <dir>] [--file <path>]
                                     locally link a human readiness record to an opted-in packet; advisory only, no crawler or provider claims
  vld export <spec-kit|kiro> <packet-dir> -o <dir> [--force]
                                     generate a bounded interoperability view; the VLD packet remains authoritative
  vld store init <directory> [--id <store-id>] | add <id> <git-url> | diff <id> | update <id> --acknowledge <commit> [--debug]
                                     fetch, review, pin and verify read-only Git-backed shared delivery stores; debug details are bounded and redacted
  vld catalog trust <root.json> | add <id> <git-url> | diff <id> | update <id> --acknowledge <commit> [--debug]
  vld catalog status [id] | copy <id> <package> <payload> --out <file>
                                     verify a threshold-signed, content-only catalog; it cannot execute or enable content
  vld module list|enable|status|verify [ids] [--project <dir>] [--json]
                                     manage version-locked optional delivery modules
  vld bundle list|show|apply <id> [--profile <file>] [--project <dir>] [--dry-run]
                                     apply a conservative profile/module starter bundle
  vld agent list|install|status [id] [--project <dir>] [--force] [--json]
                                     install or inspect generated Codex, Claude Code or Copilot handoffs
  vld workflow list|lint|run|status|complete <id> [step] [--project <dir>]
                                     typed resumable workflows; `run` previews unless --execute is supplied
  vld mission init <definition.json> --packet <dir> [--target HEAD] [--project <dir>] [-o <file>]
  vld mission validate|status <mission.json> [--project <dir>] [--json]
                                     freeze a verified packet and Git target into versioned work packages; no agent is run
  vld workspace create <mission.json> <package> [--project <dir>] [--json]
  vld workspace status|recover <mission.json> [--project <dir>] [--json]
  vld workspace remove <mission.json> <package> [--discard --acknowledge <workspace-id>] [--project <dir>]
                                     allocate, inspect, reconcile or safely remove one Git worktree; no agent is run
  vld runtime init|status|recover <mission.json> [--project <dir>] [--json]
  vld runtime events <mission.json> --actor <role:id> [--after <sequence>] [--limit <1-100>] [--max-bytes <1024-65536>] [--project <dir>] [--json]
  vld runtime allocate <mission.json> <package> --assignee <implementer-id> [--lease-ms <ms>] [--project <dir>] [--json]
  vld runtime heartbeat <mission.json> <package> --run <run-id> --lease-token <token> --actor implementer:<id> [--lease-ms <ms>]
  vld runtime transition <mission.json> <package> --to <state> --actor <role:id> --expected-version <n> [--lease-token <token>]
  vld runtime agent run <mission.json> <package> --policy <agent-policy.json> --lease-token <token> [--project <dir>] [--json]
  vld runtime agent status <mission.json> [--project <dir>] [--json]
                                     opt-in fake or one-declared-argv adapter; local processes are unconfined (no VLD write authority)
  vld runtime delivery submit <mission.json> <package> --policy <delivery-policy.json> --lease-token <token> --sha <commit> [--adapter-run <id>]
  vld runtime delivery verify <mission.json> <package> --policy <delivery-policy.json> [--project <dir>] [--json]
  vld runtime delivery approve <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor reviewer:<id> --reason <text>
  vld runtime delivery queue <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor release-approver:<id>
  vld runtime delivery status <mission.json> [--project <dir>] [--json]
                                     frozen candidate/packet verification, independent review and a local queue; no merge, push or forge access
  vld runtime forge plan-export <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch> [--base-ref <branch>] [--checks <name,...>] [--title <text>] [--out <file>] [--dry-run] [--json]
                                     derive a durable, offline GitHub v1 plan; never reads credentials, invokes gh, pushes, changes a PR, or requests merge
  vld runtime serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
  vld runtime status|events|allocate|heartbeat|transition|recover [package] --runtime-url <https-url> --runtime-token <token> [--request-id <id>]
                                     explicit typed remote client; https required except loopback development
                                     loopback-only Runtime API plus the local Studio dashboard; never starts an agent
  vld studio serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
                                     launch the same loopback Runtime API and accessible browser Studio; token stays in browser memory only
  vld mcp                            run the MCP server over stdio
  vld index [--check]                rebuild primitives/index.json

Exit codes
  0 ok · 1 verification findings · 2 usage or input error

Typical loop
  new project       vld init my-app  →  plan  →  compile  →  hand specs/ to an agent
  existing project  vld adopt .      →  plan  →  compile  →  vld change …
  brownfield        vld change specs changes/add-export.json -o changes/add-export
  no repo access    see prompts/bootstrap.md
  agent integration vld mcp          (declare in your MCP client config)
```
