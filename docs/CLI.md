# CLI reference

> Generated from the `USAGE` constant in `factory/cli.mjs`. Do not edit command prose here; run `node scripts/generate-cli-doc.mjs` after changing the CLI.

```text
vibecode like a dev — from one paragraph to a spec an agent can execute

Usage
  vld init <dir> [--interactive]     write profile.json (or build one via guided wizard)
  vld doctor [--project <dir>] [--packet <dir>] [--json]
                                     diagnose Node runtime, Git, sandbox backends, packet and audit chain
  vld migrate [--project <dir>] [--profile <file>] [--packet <dir>] [--dry-run] [--json]
                                     safely upgrade legacy profiles, runtime policies and packets to current VLD
  vld adopt <repo-or-url> [-o <file>] [--name <slug>] [--idea <text>] [--force] [--json]
                                     infer a profile from a local path or Git repository URL
  vld intake [idea] [--file <path>] [--offline] [--provider <id>] [--model <id>] [-o profile.draft.json]
                                     extract an evidence-grounded draft profile and <=7 questions from prose or stdin
  vld intake accept [profile.draft.json] [-o profile.json] [--answer k=v] [--waive flag:reason:date]
                                     promote a reviewed draft to a strict-ready profile.json with full provenance
  vld plan <profile.json> [--explain] [--json] [--advisory]
                                     strict by default: blocks unwaived risks, rule conflicts & defaulted production fields (--advisory downgrades to warnings)
  vld compile <profile.json> -o <dir> [--force] [--advisory] [--packet-dir <label>] [--lean]
                                     strict by default; --advisory permits unwaived warnings with an advisory banner
                                     --packet-dir overrides the directory name embedded in generated commands
                                     --lean emits AGENTS.md and spec.json only, for a token-budgeted reader
  vld ci init [--project <dir>] [--packet <dir>] [--node <version>] [--force]
                                     write the required pull-request check that runs the packet's enforcement
  vld verify <packet-dir> [--repo <path>] [--run] [--report <file>] [--require-report] [--mutation] [--strict] [--require-assertions] [--json]
                                     verify packet, AST non-tautological assertions, and executed test/mutation proof
  vld change <packet-dir> <change.json> -o <dir> [--apply] [--force] [--json] [--repo <dir>]
                                     render a delta spec for a brownfield change
  vld change verify <change-dir> [--project <dir>]
                                     validate a change proposal, reviewed evidence links and resulting manifest
  vld change archive <change-dir> <packet-dir> [--profile <p>] [--to-profile-rules]
                                     fold an applied change into the profile's overlay stack or profile.rules
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
  vld mission plan <packet-dir> [-o <definition.json>] [--mission-id <id>] [--title <t>] [--offline] [--provider <id> --model <id>] [--cassette <dir> --cassette-mode <m>] [--max-turns <n>] [--max-chars <n>] [--json]
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
  vld runtime delivery review <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor reviewer:<id> [--rules | --report <review.json> --reviewer-model <provider:model>]
  vld runtime delivery queue <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor release-approver:<id>
  vld runtime delivery status <mission.json> [--project <dir>] [--json]
                                     frozen candidate/packet verification, independent review and a local queue; no merge, push or forge access
  vld runtime forge plan-export <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch> [--base-ref <branch>] [--checks <name,...>] [--title <text>] [--out <file>] [--dry-run] [--json]
                                     derive a durable, offline GitHub v1 plan; never reads credentials, invokes gh, pushes, changes a PR, or requests merge
  vld runtime forge execute <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch> [--action publish|inspect|merge] [--pr <n>] [--ready] [--allow-merge] [--checks <a,b>] [--token-env GITHUB_TOKEN] [--api-url <url>]   (publish creates a draft PR unless --ready)
                                     opt-in governed GitHub v1 delivery using an explicit memory-only token; records hash-chained receipt
  vld review prepare|run|verify|record [--packet <dir>] [--project <dir>] [--report <review.json>] [--base-ref <ref>] [--head-ref <ref>] [--json]
                                     context-isolated six-category spec review and high-rigor human escalation
  vld drift check|init-workflow|init-oracles [--packet <dir>] [--project <dir>] [--base-ref <ref>] [--record] [--force] [--json]
                                     continuous specification-to-code drift checks, CI workflow, and semantic oracles
  vld evidence verify|export|append [--project <dir>] [--format json|markdown] [-o <file>] [--json]
                                     verify or export the tamper-evident SHA-256 hash-chained evidence ledger
  vld telemetry status|enable|disable|purge [--project <dir>] [--json]
                                     strictly opt-in local anonymous telemetry (disabled by default; zero automatic network calls)
  vld runtime serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
  vld runtime status|events|allocate|heartbeat|transition|recover [package] --runtime-url <https-url> --runtime-token <token> [--request-id <id>]
                                     explicit typed remote client; https required except loopback development
                                     loopback-only Runtime API plus the local Studio dashboard; never starts an agent
  vld studio serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
                                     launch the same loopback Runtime API and accessible browser Studio; token stays in browser memory only
  vld mission rebase <mission.json> [--target <ref>] [--packet <dir>] [--assign-added <pkg>] [--drop-removed] [--dry-run] [--project <dir>] [--json]
                                     rebase a mission onto an updated target commit and/or recompiled packet without dropping coverage
  vld sandbox probe|conformance [--backend <auto|oci|bwrap|linux-ns|darwin-seatbelt|node-permission>] [--json]
                                     inspect host sandbox backends or execute the 8 live confinement probes (ADR 0011)
  vld build [--profile <file>] [--packet <dir>] [--mission <file>] [--mission-overrides <file>] [--adapter <sandboxed-cli|sandboxed-acp|sandboxed-agent|fake>] [--executable <path>] [--arg <value>] [--backend <id>] [--max-repairs <0-5>] [--gates] [--require-os] [--dry-run] [--project <dir>] [--model <provider:model>] [--cassette <dir>] [--cassette-mode <replay|record|auto|off>] [--test-cmd <json>] [--json]
                                     compile/verify spec, partition mission DAG, run sandboxed packages with bounded repair and emit build-report.json
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
