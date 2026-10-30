# Runbook: vibecode-like-a-dev

- **Owner:** the repository maintainer (`@knarayanareddy`), who answers issues and
  cuts releases.
- **Escalation channel:** GitHub issues on this repository. There is no pager: the
  product is a CLI and a document generator with no hosted service, so "down" means
  the tool produces a wrong packet, not that a page is failing.
- **Service:** the `vld` CLI and the packets it compiles.

## First three diagnostic steps

1. `node factory/cli.mjs index --check` — if the index is stale, the catalog and the
   primitives on disk disagree, and every downstream symptom is a consequence.
2. `npm test` — the round trip from profile to packet is covered end to end; a red
   test names the layer.
3. `git log -1 --stat` and the version in `package.json` — most reports describe a
   packet compiled by an older release.

## Rollback

`npm i -g vibecode-like-a-dev@<previous>` restores the published CLI in seconds.
Packets are plain files under version control, so a bad packet is reverted with
`git checkout -- <packet>` and regenerated with `vld compile … --force`.

## What this document does not cover

Nothing runs as a service, so there is no availability incident to run down. If that
changes — a hosted renderer, a registry — this file needs a real escalation path
before it is claimed.
