# The experimental runtime

`vld` ships two things that were built together and are not the same thing.

| | What it is | What it promises |
| --- | --- | --- |
| **The compiler** (`vld init`, `plan`, `compile`, `verify`, `change`, `index`, `catalog`, `store`, `export`) | Deterministic, dependency-free ESM. Reads a profile, writes a specification packet, checks a repository against it. | That the packet is complete, internally consistent and enforced by a command you can run anywhere Node runs. |
| **The runtime** (`vld runtime`, `workspace`, `mission`, `workflow`, `agent`, `studio`) | Missions, Git worktrees, agent adapters, a local HTTP server, forge export. | Nothing about isolation. |

## Why this page exists

The runtime orchestration modules are roughly 3.7k lines inside a package whose
headline claim is "a specification an agent can execute". Measured on its own, that
claim is about the compiler. The runtime is a different risk: it allocates Git
worktrees, starts processes and serves a local API.

**`local-process` and ACP peers are unconfined same-user host processes on every
supported OS.** `read-only`, `network: false` and `credentialAccess: false` deny VLD
authority and inherited environment values. They do **not** stop the executable from
using whatever files, credentials and network access the invoking OS user already
has. A process working directory is not a sandbox.

That is why these commands are called experimental, why `vld <command>` prints a note
pointing at this page, and why no runtime command is described as a supported part of
the enforcement loop.

## How the boundary is enforced

- `vld experimental <command> …` is the documented spelling. It dispatches to the
  same handlers.
- The bare spelling (`vld runtime …`) still works, because it is in the published CLI
  contract and scripts depend on it. It prints a note identifying the command as
  experimental.
- `factory/test/core-boundary.test.mjs` fails if a compiler module imports a runtime
  module, or if a runtime module is reachable from the compiler entry point.

## What would make this supported

A sandbox adapter that demonstrates, with tests, denial of: filesystem access outside
the workspace, credential fixtures, network egress, and process execution beyond the
declared command. Until then, the honest statement is the one above, and it is
repeated wherever the runtime is described.

## Planned split

The intended packaging is `@vld/core` (plan, compile, verify, change, mcp) with a
frozen API, and `@vld/runtime` for missions, worktrees, adapters and Studio. This
release does not publish two packages; it separates the *documented* surface so the
split is a packaging change rather than a rewrite.
