---
id: security.secrets-and-supply-chain
title: Secrets and supply chain hygiene
module: security
summary: Keep credentials out of the repository and make the dependency graph small, pinned and auditable.
tier_min: 1
cost: low
priority: 2
tags: [secrets, dependencies, supply-chain, sbom, pinning]
triggers: [api key, env file, secret, dependency, lockfile, supply chain, audit]
enforces: []
artifacts: [03-architecture.md, 05-verification.md]
---

# Secrets and supply chain hygiene

Two things are almost guaranteed in a generated project: a `.env` file with real keys in the first commit, and a dependency tree of 900 packages, half of which arrived transitively and none of which are pinned.

Both are cheap to prevent on day one and unpleasant to fix after an incident.

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

## Anti-patterns

- **A `.env` committed "just for the demo".** It will be rotated by nobody and found by everyone.
- **Secrets in test fixtures.** Test credentials are real credentials more often than anyone admits.
- **`*` version ranges.** You get a different program tomorrow with no diff to review.
- **Adding a dependency for three lines of logic.** You just outsourced a decision to a stranger's release schedule.

## Why it works

Both problems are cumulative and irreversible in the wrong direction: leaked keys cannot be unleaked, and a large dependency tree cannot be made small quickly. The controls are cheap, mechanical, and they run without anyone remembering them, which is the only kind of control that survives a busy week.

## Cost and when to skip

Very low: an hour of setup, minutes per month. There is no tier where skipping this is a good trade.
