# The experimental runtime

`vld` ships two things that were built together and are not the same thing.

| | What it is | What it promises |
| --- | --- | --- |
| **The compiler** (`vld init`, `plan`, `compile`, `verify`, `change`, `index`, `catalog`, `store`, `export`) | Deterministic, dependency-free ESM. Reads a profile, writes a specification packet, checks a repository against it. | That the packet is complete, internally consistent and enforced by a command you can run anywhere Node runs. |
| **The runtime** (`vld runtime`, `workspace`, `mission`, `workflow`, `agent`, `studio`, `sandbox`, `build`) | Missions, Git worktrees, sandboxed and unconfined adapters, repair loops, a local HTTP server, forge orchestration. | Explicit per-backend confinement verified by live probes and recorded in signed/digested sandbox receipts (ADR 0011). |

## Unconfined vs sandboxed adapters

**`local-process` and bare `acp-v1` peers (policy v1) are unconfined same-user host processes on every supported OS.** For those adapters, `read-only`, `network: false`
and `credentialAccess: false` deny VLD authority and inherited environment values;
they do **not** stop the executable from using whatever files, credentials and
network access the invoking OS user already has. A process working directory is not a
sandbox, so policy v1 permanently denies them VLD workspace writes.

**`sandboxed-cli`, `sandboxed-acp` and `delivery-policy` v2 verifiers run through
`factory/lib/sandbox/` (ADR 0011):**

| Backend | Confinement class | Mechanism |
| --- | --- | --- |
| `oci` | `os-container` | Rootless Docker/Podman with `--network=none`, `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, `seccomp-default.json`, and a single workspace bind mount. |
| `bwrap` | `os-namespace` | Linux Bubblewrap (`--unshare-all --die-with-parent`), empty `tmpfs` over home/credential paths, read-only system mounts, scoped workspace mount. |
| `linux-ns` | `os-namespace` | Linux `unshare` user + network + mount + PID namespaces, isolated unconfigured loopback, `tmpfs`-masked home/temp/credential paths, `ro`/`rw` workspace bind, scrubbed env, and Node `--permission` defense-in-depth. |
| `darwin-seatbelt` | `os-seatbelt` | macOS `sandbox-exec` deny-default profile blocking network egress, credential reads, and writes outside the workspace. |
| `node-permission` | `runtime-permission` | Portable Node >=22 `--permission` boundary restricting filesystem read/write paths and denying child spawns, workers, and outbound sockets via preload guard. |

Every sandboxed run records its exact `backend` and `confinementClass` in a
`sandboxReceipt` binding the policy digest, before/after workspace tree digests,
redacted output digest, and resource-claim check. Run `vld sandbox probe` to inspect
available backends on the current host and `vld sandbox conformance` to execute all
eight live denial probes.

## How the boundary is enforced

- `vld experimental <command> …` is the documented spelling. It dispatches to the
  same handlers.
- The bare spelling (`vld runtime …`, `vld build …`, `vld sandbox …`) also works and
  prints a note identifying the command as part of the experimental runtime rather
  than the deterministic compiler.
- `factory/test/core-boundary.test.mjs` fails if any compiler module imports a
  runtime, sandbox, repair, or build module directly or transitively.
- `factory/test/sandbox.test.mjs` executes the eight-probe conformance harness
  against the active sandbox backend on every CI run.

## Planned split

The intended packaging remains `@vld/core` (plan, compile, verify, change, mcp) with
a frozen zero-dependency API, and `@vld/runtime` for missions, worktrees, sandboxed
adapters, repair, `build`, and Studio.
