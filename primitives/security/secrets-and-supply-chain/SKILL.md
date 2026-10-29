---
id: security.secrets-and-supply-chain
title: Secrets and supply chain hygiene
module: security
summary: Keep credentials out of the repository and make the dependency graph small, pinned and auditable.
obligation: "In {project}, no credential is in the repository, and every dependency that reaches {aPrimary} is pinned, installed from a lockfile and audited in CI."
tier_min: 1
cost: low
priority: 2
tags: [secrets, dependencies, supply-chain, sbom, pinning]
triggers: [api key, env file, secret, dependency, lockfile, supply chain, audit]
enforces: []
gates: [G1-SECRETS]
artifacts: [03-architecture.md, 05-verification.md]
---

# Secrets and supply chain hygiene

Two things are almost guaranteed in a generated project: a `.env` file with real keys in the first commit, and a dependency tree of 900 packages, half of which arrived transitively and none of which are pinned.

Both are cheap to prevent on day one and unpleasant to fix after an incident.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, no credential is in the repository, and every dependency that reaches {aPrimary} is pinned, installed from a lockfile and audited in CI.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Always, from the first commit.

## The practice

**Secrets**

1. **Nothing sensitive in the repository, ever.** No `.env`, no keys in code, no credentials in test fixtures, including "temporary" ones.
2. **Commit `.env.example`** with every variable name and a placeholder, and validate the environment at startup so a missing variable fails loudly with its name.
3. **Configuration comes from the environment**; secrets come from a secret manager where one exists.
4. **Rotate on leak, immediately.** Assume a committed key is compromised even if the commit was amended; it exists in clone history and possibly in a log.
5. **Prevent with a pre-commit hook and a CI secret scan**, because intention is not a control.
6. **Never log the values.** Log the presence of configuration, not its content.

**Supply chain**

1. **Commit the lockfile** and use `npm ci` / `uv sync --frozen` in CI.
2. **Pin the runtime version.** Not "latest".
3. **Keep the tree small.** Every dependency is an unreviewed vendor with repository access to your build. Prefer the standard library for small jobs.
4. **Audit at release**: `npm audit` or `pip-audit` in CI, with a policy for how fast high-severity findings must be resolved.
5. **Review transitive additions.** A one-line dependency can add thirty packages; check the diff to the lockfile.
6. **Record the exit**: for each significant dependency, what it would take to remove it (that is the ADR).

## Checklist

- [ ] `.gitignore` covers `.env`, credentials, local databases and build output.
- [ ] `.env.example` is complete and current.
- [ ] Startup validation names every missing variable.
- [ ] Secret scanning runs in CI.
- [ ] Lockfile committed; CI installs from it.
- [ ] Dependency audit runs in CI with a documented response time.
- [ ] Runtime version pinned in the repository.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A `.env` anywhere in git history.
- Secrets stored in repository settings rather than CI.
- No runtime version pinned in the repository.
- An audit disabled with no replacement.
- A dependency added with no version pin and no ADR.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The repository is private. | Private repositories leak too. | Secrets in CI configuration only. |
| We will rotate the key later. | Later is after the incident. | Rotate the moment it is committed. |
| The `.env` is gitignored, so we are safe. | Gitignore does not untrack history. | Purge the history and rotate. |
| The dependency audit fails on transitive noise. | Then document a response time instead of disabling it. | Triaged, dated exceptions. |
| Lockfiles are for libraries. | Every application is reproducible or it is not deployable. | Commit it and install from it. |

## Anti-patterns

- **A `.env` committed "just for the demo".** It will be rotated by nobody and found by everyone.
- **Secrets in test fixtures.** Test credentials are real credentials more often than anyone admits.
- **`*` version ranges.** You get a different program tomorrow with no diff to review.
- **Adding a dependency for three lines of logic.** You just outsourced a decision to a stranger's release schedule.

## Why it works

Both problems are cumulative and irreversible in the wrong direction: leaked keys cannot be unleaked, and a large dependency tree cannot be made small quickly. The controls are cheap, mechanical, and they run without anyone remembering them, which is the only kind of control that survives a busy week.

## Cost and when to skip

Very low: an hour of setup, minutes per month. There is no tier where skipping this is a good trade.
