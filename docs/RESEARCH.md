# Prior art: what has been tried, what worked, what did not

Research notes as of **October 2026**. Sources are linked; the numbers come from third-party write-ups and one published benchmark, so treat them as directional rather than precise. The point of this document is to justify the design choices in the compiler, not to win a comparison.

## The short version

Spec-driven development (SDD) went from a novelty to a feature in about eighteen months. The idea won; the ceremony lost. The tools that survived are the ones that made specs cheap, and the unsolved problem is the same everywhere: **the spec and the code diverge, and nothing notices.**

Our design follows directly from three findings:

1. **Volume is the main complaint.** Reviewers abandoned tools that generated a sea of markdown for small features.
2. **Completeness beats length.** Specs with observable acceptance criteria correlate with higher merge rates; longer specs do not.
3. **Nothing enforces agreement.** The field's stated open problem is drift. Tools either ignore it or ask a human to notice.

## The landscape

| Tool | What it is | Strongest idea | Documented weakness |
| --- | --- | --- | --- |
| **GitHub Spec Kit** | MIT CLI + slash-command templates, 30+ agents, `constitution → specify → clarify → plan → tasks → implement` | Agent-agnostic artifacts in git; a repository constitution | Verbosity and review overload; branch-per-spec; no enforcement after the fact |
| **AWS Kiro** | Commercial spec-first IDE (VS Code fork) + CLI, three files: `requirements.md` (EARS), `design.md`, `tasks.md` | Lightest of the flagship tools; requirements with observable behaviour | Spec drift is its documented Achilles heel; IDE and AWS lock-in |
| **BMAD-METHOD** | MIT, ~21 agent personas, PRD → architecture → stories, scale-adaptive tracks | Adversarial review and explicit planning before code | Heavy process and token cost; steep learning curve; poor fit for small work |
| **OpenSpec** | MIT, npm CLI, one folder per change with proposal/design/tasks + delta requirements | Built for brownfield modification, lowest overhead, never calls a model | No notion of which engineering practices apply; no verification of the spec |
| **Tessl** | Commercial, spec-as-source code generation + library spec registry | Treats the spec as the source and the code as generated | Beta; the framework itself was wound down and the business moved to a registry |
| **Spec Kitty** | Community fork of Spec Kit with git worktree orchestration | Parallel feature work with real isolation | Fork maintenance; inherits Spec Kit's volume |
| **Superpowers / skills ecosystems** | Agent skills and plugins that enforce a brainstorm → plan → TDD → review loop | Methodology that travels across harnesses; progressive disclosure | Packaging, not selection or enforcement |
| **GSD / Ralph loop** | Lightweight context-engineered SDD; stateless iteration | Speed and low ceremony for solo work | Little structure for risk-bearing domains |

Sources: [spec-compare](https://github.com/cameronsjo/spec-compare), [OpenSpec vs Spec Kit vs BMAD](https://aicodingpatterns.com/en/patterns/openspec-vs-spec-kit-vs-bmad/), [Particula: Spec Kit vs Kiro vs Tessl](https://particula.tech/blog/spec-driven-development-tools-spec-kit-vs-kiro-vs-tessl), [field study, mid-2026](https://github.com/ianhxu/agentic-engineering-field-study/blob/main/04-spec-driven-development.md), [2muchcoffee: what each one actually is](https://2muchcoffee.com/blog/spec-driven-development-tools/).

### Maturity model worth adopting

A useful framing from the comparison projects: SDD has three levels.

1. **Spec-first** — specs precede code but are discarded (Spec Kit, Kiro, BMAD).
2. **Spec-anchored** — specs persist and evolve with the code (OpenSpec, Spec Kitty).
3. **Spec-as-source** — only specs are edited; code regenerates (Tessl, unproven).

Almost everyone stalls between 1 and 2, because level 2 requires investing in enforcement that produces no immediate visible progress. That gap is the entire reason this project exists. We aim firmly at level 2 with mechanical checks, and we do not pretend level 3 works.

## What the evidence says

One public benchmark ran 50 production-shaped tickets across Spec Kit, Kiro, BMAD, OpenSpec and a no-spec control ([Uvik, 2026](https://uvik.net/spec-driven-development-benchmark/)):

- Merge rates: **80-82%** with a spec workflow versus 60-90% without, depending on ticket type. The gain concentrates on feature work (80-90% vs 60%) and is **absent on bug fixes**, where no-spec tied or won.
- **Spec completeness** (median 6-7 of 8) mattered more than spec length. Merge rate at completeness ≥6 was **~92%**; the median spec was 106-188 lines.
- Spec-phase tokens were **32-44%** of total spend. Overhead is real but not dominant.
- Reviewers rated BMAD's spec review effort 2/5 versus 4/5 for the lighter tools.

Independent practitioner write-ups reinforce the shape of the problem:

- Spec Kit generated **~1,300 lines of markdown for a simple date-display feature** (marmelab, cited in the field study). Verdict from another reviewer: "I'd rather review code than all these markdown files."
- A Lightweight-tools advocate measured Spec Kit as **"10x slower, more ceremony, same bugs"** on a real project ([Scott Logic, via the field study](https://github.com/ianhxu/agentic-engineering-field-study/blob/main/04-spec-driven-development.md)).
- Kiro turned a small bug fix into **four user stories with sixteen acceptance criteria** (Böckeler, summarised in [this analysis](https://juliantellez.com/blog/what-spec-driven-development-is)).
- Thoughtworks places SDD in the **Assess** ring, not Adopt, explicitly rejecting "specs alone suffice" ([summary and critique](https://dev.to/krlz/spec-driven-development-in-2026-what-it-is-the-tooling-and-how-teams-actually-use-it-2fk2)).
- In the same piece, agents were observed **ignoring parts of their own spec** — in one run regenerating classes the research step had already documented as existing. Control is partly illusory.

The uncomfortable synthesis: **a spec only helps if somebody reads it, and only protects you if something checks the code against it.** Long specs are unread; unchecked specs are wrong. Every design decision below follows from those two sentences.

## Recurring failure modes (consensus across sources)

| Failure | What it looks like | Our response |
| --- | --- | --- |
| **Spec drift** | Requirements and code diverge within weeks; the spec becomes a confident lie | `@req` anchors + `spec-check.mjs` + a `todo/done` ratchet, enforced in CI |
| **Over-ceremony** | Hundreds of lines for a small feature; process cost exceeds the feature | Computed tier, per-tier practice cap, hard line ceiling that fails verification |
| **Agent non-compliance** | The agent skips mandated tests or invents scope anyway | Hard rules in the handoff, one requirement per session, independent review prompt, stop rules |
| **Double review burden** | Reviewing the spec *and* the code | The spec is short and structured; the traceability table is the review artefact |
| **False confidence** | Tests pass against a wrong spec | Acceptance criteria include failure paths; adversarial review checks criteria, not code style |
| **Waterfall in disguise** | Phases become gates that block learning | Explicit "escape hatch": a wrong requirement changes the requirement first, in a reviewable diff |

## What we adopted, and from whom

- **From Spec Kit:** artifacts in git, agent-agnostic markdown, the repository "constitution" as the top-level contract.
- **From Kiro:** three-file lightness as a default for small work (our tier 0 is one file), and requirements phrased as observable behaviour. We deliberately did *not* adopt EARS notation verbatim — it optimises for specifiers in regulated contexts, and at small scale it is noise.
- **From BMAD:** adversarial review as a separate role with a separate objective, and scale-adaptive planning. We implemented adaptivity as a computed tier rather than a roster of personas, and review as a paste-ready prompt rather than an agent.
- **From OpenSpec:** the insight that brownfield change is the real problem. Delta specs are on our roadmap and not yet implemented; claiming otherwise would be dishonest.
- **From the Agent Skills ecosystem:** `SKILL.md` frontmatter, one-line trigger descriptions, progressive disclosure, references one hop deep, and "keep the body under 500 lines" as a hard authoring rule.

## What we deliberately rejected

- **Persona theatre.** Named agents passing documents to each other increases token cost and produces the appearance of rigour. A checklist with reasons does the same job for a fraction of the spend.
- **Spec-as-source code generation.** Editing only specs and regenerating code sounds elegant and remains unproven; it also makes the reviewer's job harder, not easier.
- **A model in the planning path.** If a model selects the practices, the plan is not reproducible, not diffable, and not auditable. Selection is declarative; only the writing of project-specific content should involve a model, and that is the human's job at compile time.
- **Framework lock-in.** Markdown and JSON, readable by any tool. No MCP requirement, no IDE requirement, no account.
- **Coverage targets.** They reward executing code, not checking it. Mutation testing, where affordable, measures the thing coverage pretends to.

## Open problems

1. **Semantic drift.** Anchors catch a requirement losing its test; they cannot catch a test that proves the wrong thing, or a requirement quietly reinterpreted. Detecting that needs either executable specifications or a second model reading both — both are unresolved.
2. **Selection accuracy.** Predicates encode judgement. A project that mis-describes itself gets the wrong rigor, and the failure is silent.
3. **Agent non-compliance.** Instructions in a document are advisory to a model. The mechanical gates are not. This is why the packet puts its weight on CI rather than on prose.
4. **Small-change ergonomics.** A one-line change does not deserve a packet. Delta specs and a `--quick` path are the obvious answers; neither is built.
5. **No shared benchmark.** Every tool in this space argues from design intuition. The field needs a public task set with merge rate, defect and drift metrics. Proposal below.

## How to evaluate this properly

A benchmark worth trusting would need:

- **40-60 tickets** across five shapes: greenfield feature, brownfield change, bug fix with a failing test, refactor with green tests, test-writing.
- **Four arms**: no spec; a strong generic prompt; Spec Kit or Kiro as the incumbent; this packet.
- **Fixed agent and model** per arm, multiple runs, same repository starting points.
- **Metrics**: merge rate, review defects per merged ticket, rework rounds, spec drift after four weeks of follow-up changes, wall-clock, tokens, cost per merged ticket.
- **A drift probe**: after merge, make three requirement-changing edits and measure whether the spec or the check catches them.

The honest expectation, given the published numbers, is a gain on feature and data-pipeline tickets, little gain on bug fixes, and the largest gain on **drift** — which is the metric nobody else currently reports.
