---
id: agent.autonomy-limits
title: Agent autonomy limits and action boundaries
module: agent
summary: Bound every autonomous tool loop with an explicit tool allowlist, human confirmation before destructive actions, step and cost budgets, prompt-injection separation, sandbox containment, a live kill switch and an append-only action log.
obligation: "In {project}, every autonomous action on {aPrimary} passes a closed tool allowlist, a step/cost budget and a human confirmation gate before any destructive or external write executes."
tier_min: 1
cost: medium
priority: 4
tags: [agent-safety, autonomy, tool-allowlist, human-in-the-loop, kill-switch, prompt-injection, sandbox]
triggers: [agent autonomy, autonomous agent, tool allowlist, human confirmation, kill switch, step budget, tool injection, runaway agent, action log, sandboxed tool execution]
enforces: [agent.action-boundaries, agent.approval-gate, agent.budget-and-killswitch]
gates: [G2-AUTONOMY]
artifacts: [03-architecture.md, 04-contracts.md, 05-verification.md]
---

# Agent autonomy limits and action boundaries

A model call that returns text can only say something wrong; an agent loop that calls tools can delete rows, email customers, push commits and spend money while nobody watches. Treating an autonomous agent like an ordinary chatbot with extra functions confuses output validation with capability containment.

Autonomy is budgeted and enforced outside the prompt. System prompts state intent; typed policy dispatchers, human confirmation tokens, sandbox boundaries and hard counters enforce it.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, every autonomous action on {aPrimary} passes a closed tool allowlist, a step/cost budget and a human confirmation gate before any destructive or external write executes.

## When this applies

Every project with `kind: "agent"`, every `automation` project using `ai`, and any AI feature permitted to perform destructive writes or invoke external mutating tools.

## The practice

Seven mechanical controls sit between the model's proposed tool call and the real world:

1. **Closed tool allowlist and typed schemas.** Each task registers the exact tool names and parameter schemas it may invoke. Unknown tools, shell strings and extra arguments fail closed in the dispatcher before touching an adapter.
2. **Human confirmation before irreversible side effects.** Classify every tool as `read`, `reversible-write` or `destructive/external`. Tools in the third class halt the run, present the exact diff or payload, and execute only with a signed, single-use human approval tied to that payload digest.
3. **Hard step, token, wall-clock and spend budgets.** Cap loop iterations, cumulative tokens, elapsed duration and monetary cost per run. Hitting any ceiling stops the loop cleanly and records the budget reason rather than retrying blindly.
4. **Prompt-injection separation.** Untrusted content retrieved from files, web pages, emails, tickets or webhooks enters data channels only and can never grant permissions, widen the allowlist or bypass confirmation — enforce dual-check or privilege drop after reading untrusted data.
5. **Sandboxed execution.** Code execution, filesystem edits and subprocess tools run inside an isolated sandbox with read-only inputs, scoped writable directories, restricted egress and zero ambient host credentials.
6. **Immediate kill switch.** Operators and callers can trip a per-run or global kill switch that cancels pending model calls, revokes active tool leases and prevents queued retries from firing.
7. **Append-only action log.** Persist every proposed, approved, denied and executed tool call with run id, step number, tool name, parameter digest, policy verdict, actor/approver and outcome.

## Checklist

- [ ] Tool dispatcher enforces a closed per-task allowlist and rejects unrecognised tools or schema violations.
- [ ] Every tool declares its side-effect class (`read`, `reversible-write`, `destructive`).
- [ ] Destructive and external-send tools require a single-use human approval bound to the exact payload hash.
- [ ] Per-run step count, token budget, wall-clock timeout and cost cap terminate runaway loops deterministically.
- [ ] Untrusted retrieved content cannot trigger privileged tools without explicit policy or human approval.
- [ ] Tool execution carrying filesystem or process authority runs inside an isolated sandbox with no ambient secrets.
- [ ] A live kill switch halts active runs within one step, and every tool decision writes to an append-only action log.

## Red flags

- A tool takes a raw shell command, raw SQL string or arbitrary URL straight from model output.
- Confirmation is phrased as `"Ask the user before deleting"` in the system prompt with no server-side gate.
- Agent loops use `while (true)` or unbounded recursion with no step counter or spend ceiling.
- Content fetched from an external issue, email or document feeds into the same turn that holds write or send credentials.
- No kill switch exists short of restarting the whole process or revoking the vendor API key.
- Tool calls log only on success, hiding denied or injected attempts.

## Anti-rationalization

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The system prompt tells the agent never to delete production data. | One injected ticket or hallucinated argument overrides polite prose. | Enforce allowlists and approval tokens in the tool dispatcher, never in prompt text. |
| Human approval slows down an autonomous workflow. | Approving one irreversible action takes seconds; recovering from a runaway batch takes days. | Let reads and reversible drafts run freely; gate only destructive and external effects. |
| Provider rate limits will stop a runaway loop. | Account-wide rate limits fire after hundreds of bad writes and dollars burned. | Enforce per-run step, token, time and dollar ceilings before every iteration. |
| The agent only reads internal data, so prompt injection does not apply. | Internal tickets, logs, PR comments and uploads all contain untrusted external text. | Tag retrieved content as untrusted and block unapproved privileged tool calls after ingestion. |
| We can debug bad runs from application stdout. | Interleaved console logs cannot prove who approved a side effect or what arguments ran. | Write every proposed, denied and executed tool call to an append-only action log. |

## Anti-patterns

- **Ambient god-tool.** Exposing one generic HTTP or bash tool instead of narrow, domain-specific operations.
- **Blanket session approval.** Treating `"approve all for this run"` as equivalent to approving a specific destructive payload.
- **Retry on policy denial.** Feeding an authorization rejection back into an unlimited repair loop until the agent routes around it.
- **Unscoped credentials in the tool environment.** Passing cloud or database admin keys into the same process that runs generated code.

## Why it works

Separating what the model may *propose* from what the runtime will *execute* makes autonomy auditable and bounded. Even a fully compromised or hallucinating completion stays trapped inside its tool allowlist, step budget, approval gate and sandbox.

## Cost and when to skip

Medium: one policy-enforcing tool dispatcher, budget counters, an approval token check and an action-log table. Skip only when the model never invokes tools or triggers automated side effects.
