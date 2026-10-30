---
id: agent.handoff-packet
title: Agent handoff packet
module: agent
summary: A short body of context that makes the spec usable by any agent, without a chat history.
obligation: "In {project}, a new session can start on the first {primary} requirement from the repository alone, without the chat that produced it."
tier_min: 0
cost: low
priority: 1
tags: [handoff, agents, prompt, brief, agnostic]
triggers: [handoff, handoff prompt, handoff brief, hand to agent, new session, lovable, replit, claude code]
enforces: []
advisory_reason: "The compiler emits the handoff for every packet, and whether an agent follows it is not visible in the repository, so no gate can fail on it."
advisory: true
artifacts: [07-agent-handoff.md, AGENTS.md]
---

# Agent handoff packet

A specification that requires a conversation to interpret is not a specification. The test is simple: can a capable agent, with no memory of how the spec was written, open the repository and produce work that a reviewer accepts?

Most spec-driven tooling fails here. It generates an impressive pile of markdown and a human still has to explain what to do first, in a chat, every session.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, a new session can start on the first {primary} requirement from the repository alone, without the chat that produced it.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Always. This is the last mile that decides whether any of the rest is used.

## The practice

Produce four things, in this order of importance:

1. **A brief under 450 words** that a person can paste as the first message anywhere. It contains: the product in one sentence, the rules, the scope, the starting phase, and the instruction to stop and report. If it does not fit, the spec has failed to prioritise.
2. **A protocol document** describing the loop, hard rules, escalation triggers and report format. This is what an agent reads once and follows many times.
3. **An entry file** at a path agents actually look for (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, or a link in `README.md`) that points at the protocol and the manifest, and lists the real commands.
4. **A machine-readable manifest** (`spec.json`) with requirements, gates and status, so a tool can check work without parsing prose.

Rules for the writing:

- **Say what to do, not what to be.** "Write the failing test first" beats "embrace a quality mindset".
- **One requirement per session.** Context windows reward focus; big asks produce broad, shallow diffs.
- **State the stop condition.** Without it, agents continue past the task into invention.
- **Make the commands real.** A protocol with invented commands teaches agents to guess.
- **Assume no history.** Every pronoun must have a referent in the repository.

## Checklist

- [ ] Brief is under 450 words and paste-ready.
- [ ] Entry file exists at a conventional path and names the real commands.
- [ ] Manifest lists requirements with status and anchors.
- [ ] Stop-and-report instruction is explicit.
- [ ] Protocol names what the agent must not do.
- [ ] A new session can start from the repository alone.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- The brief names a command that does not exist in the repository.
- Requirements are summarised ("build the booking flow") instead of cited by id.
- There is no stop-and-report instruction, or it says "continue until done".
- The entry document restates `05-verification.md` instead of pointing at it.
- It was last edited before the last behaviour change.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The agent has the whole repository, it can work it out. | It starts cold; what it cannot find in ten minutes it invents. | Name the entry file and the three commands it needs. |
| A longer brief is more helpful. | Past 450 words the model reads the first and last paragraph. | Cut to what changes behaviour and link the rest. |
| I will update the handoff at the end. | By then the protocol describes code you no longer have. | Change it in the same commit as the behaviour. |
| The decisions are in the chat history. | The next agent gets the repository, not your transcript. | Decisions belong in `03-architecture.md`, not in a message. |
| `spec.json` has the anchors, that is enough. | An agent that never opens it trusts your summary instead. | Put the current requirement and its anchor in the brief. |

## Anti-patterns

- **A 40-page prompt.** Instructions dilute; the important rule ends up on page 30.
- **Tool-specific lock-in.** Write once, adapt the entry file per tool; the content should be portable.
- **A protocol with no gates.** The agent decides when it is done, which means it decides what done means.
- **Assuming the agent read everything.** Point at what to read and when, rather than listing a reading order for the whole repository.

## Why it works

An agent's behaviour is bounded by what it can find and how specifically it is instructed. A short, rule-shaped packet raises the floor for every session, and it survives model changes, tool changes and human handoffs, which no chat history does.

## Cost and when to skip

Low: an hour, mostly editing for length. Never skip it; without it, the spec is a document rather than a system.
