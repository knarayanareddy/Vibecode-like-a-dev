# Contributing

Thanks for improving VLD. Changes should preserve the boundary between reviewed input, deterministic compiler output, and optional local runtime state.

## Reproducible development environment

Open the repository in the shipped devcontainer (`.devcontainer/devcontainer.json`, which installs Node 22 under `/usr/local` alongside `git`, `unshare`, `bubblewrap`, `podman`, and `python3`), or verify a local checkout first:

```bash
bash scripts/bootstrap.sh --doctor
npm run check
```

`scripts/bootstrap.sh` checks that `node -v` is `>= 22.0.0`, prints the resolved Node install prefix, and warns if Node sits under a path that OS namespace sandboxes mask with `tmpfs` (`$HOME`, `/tmp`, `/var/tmp`, `/root`, `/run`). VLD's `linux-ns` and `bwrap` backends bind the resolved Node prefix read-only before masking so `nvm`, `fnm`, `volta`, and `asdf` layouts pass 8/8 conformance, while `/usr/local` remains the recommended container prefix.

### Supported runtime & sandbox matrix

| Runtime | Sandbox backend | Confinement class | Host requirements | Verified by |
| --- | --- | --- | --- | --- |
| Node `>=22` (22.0.0 floor + 22.x LTS) | `bwrap` | `os-namespace` | Linux + `bubblewrap` + unprivileged userns | 3-probe preflight + 8-probe conformance |
| Node `>=22` (22.0.0 floor + 22.x LTS) | `linux-ns` | `os-namespace` | Linux + `util-linux` (`unshare -Urnm`) | 3-probe preflight + 8-probe conformance + `nvm`/`fnm`/`volta`/`asdf` fixtures |
| Node `>=22` (22.x LTS) | `oci` | `os-container` | Linux/macOS + rootless `podman` or `docker` + `seccomp-default.json` | 3-probe preflight + 8-probe conformance |
| Node `>=22` (22.x LTS) | `darwin-seatbelt` | `os-seatbelt` | macOS + `sandbox-exec` | 3-probe preflight + 8-probe conformance |
| Node `>=22` (22.0.0 floor + 22.x LTS) | `node-permission` | `runtime-permission` | Linux, macOS, Windows (portable fallback) | 3-probe preflight + 8-probe conformance |

Backends are ranked by live preflight conformance score first and confinement strength second; `vld doctor` fails non-zero whenever the best available backend scores below `8/8`.

## Before opening a pull request

1. Start with a focused test or regression when behavior changes.
2. Run `bash scripts/bootstrap.sh`, `npm run lint`, `npm test`, and `npm run check` for compiler/policy changes.
3. Regenerate and inspect committed packets when generator output changes: `npm run dogfood` and `node factory/cli.mjs compile examples/retro-board/profile.json -o examples/retro-board/spec --force`.
4. Do not hand-edit generated packet output; change the profile, policy, routing, template, or approved change source instead.
5. Keep dependencies out unless an ADR explains the durable trade-off. The core CLI (`@vld/core`) deliberately has no runtime dependencies.

## CI maintenance

Workflow jobs have explicit time limits so a stalled tool cannot consume an unbounded runner. Keep third-party GitHub Actions pinned to full commit SHAs; Dependabot may propose an update, but a maintainer must review the action release notes, provenance, permissions, and the pinned replacement SHA before merging. Do not add live-provider or arbitrary-command evaluation to pull-request workflows: those paths require an explicit human-approved environment.

## Reviews and security

Keep changes small and explain policy or authority-boundary changes in the PR. Do not include credentials, private keys, runtime tokens, or local `.vld/runtime/` state. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
