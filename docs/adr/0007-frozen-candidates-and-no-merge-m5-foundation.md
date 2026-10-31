# ADR-0007: Frozen candidates and no-merge M5 foundation

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** VLD maintainers

## Context

M2 assigns an implementation branch/worktree and M3 owns lifecycle transitions.
M4 can record an adapter outcome, but an adapter must not thereby gain authority to
choose a candidate, execute a verifier, approve itself, update a target branch or
use ambient forge credentials. A worktree CWD is also not process isolation.

The Phase 5 target includes project verification, local merge and an optional forge
adapter. Those operations have materially different containment, credential and
recovery requirements. Treating them as one implementation would create an
attractive but unsafe implicit `git merge`/`gh` capability.

## Decision

Ship a closed local foundation first.

1. `runtime delivery submit` freezes an exact candidate tuple in the Runtime JSONL
   ledger. The candidate must be the clean current `HEAD` of its healthy allocated
   package worktree, descend from the frozen allocation base, be reachable from the
   allocated branch, match the frozen mission target/packet, and (when named) link
   to a completed M4 adapter receipt. The live lease token authorizes only this
   submission and is never stored.
2. A closed delivery policy has exactly one verifier: VLD's in-process packet
   verifier. Its `commands` list is intentionally empty. There is no shell string,
   project command, inherited environment or agent-selected executable.
3. Verification creates a Runtime-lock-serialized, detached temporary worktree at
   the frozen target SHA, integrates the exact candidate with fixed Git argv and
   records either a conflict or a bounded/redacted check receipt. The worktree is
   forcibly removed in `finally`; no branch/ref is updated.
4. A review receipt is bound to candidate SHA, target SHA and policy digest. The
   reducer enforces a reviewer role different from the implementer. Queueing
   repeats the identity binding and requires a release-approver role.
5. M5 has **no merge, push, PR, provider, credential or GitHub CLI capability**.
   `queued` is an auditable local terminal handoff, not a claim that a default
   branch has been updated or that forge branch protection has been replaced.

Runtime's current-mission guard blocks all new candidate/verification/review/queue
mutations if packet or target authority drifts. The immutable old receipts remain
visible; a fresh reviewed mission/runtime and candidate are required. This is a
fail-closed invalidation rather than a dangerous attempt to reinterpret an old
approval.

## Consequences

- The foundation proves exact candidate/review/integration receipt semantics while
  keeping M5 CI deterministic and process-free.
- An integration conflict blocks automatically; no agent receives a hidden
  conflict-resolution task.
- A future sandboxed project-check runner must introduce a reviewed structured-argv
  schema, environment classification, timeout/resource bounds, containment tests
  and receipt migration.
- A future local/forge merge adapter must be separately authorized, revalidate the
  target immediately before mutation, be transaction/recovery tested, use explicit
  credential references (never ambient `gh` authentication), and retain forge
  branch protection as external enforcement.
