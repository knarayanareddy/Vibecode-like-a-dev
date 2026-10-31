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

## Signed catalog trust incident

A catalog remote is transport, not authority. If an index/package/payload signature,
expiry, publisher identity or digest fails:

1. **Quarantine:** do not run `vld catalog update`; preserve `.vld/catalog.json`,
   `.vld/catalog-root.json` and the affected `.vld/catalogs/CATALOG_ID` directory
   for review. `vld catalog status CATALOG_ID` performs an offline verification and records
   the failed trust decision without contacting a remote.
2. **Contain:** copied content is inert and cannot execute or enable itself. Locate
   its explicit provenance with `.vld/catalog-copies.json`; stop treating affected
   copies as reviewed guidance until their publisher/digest is confirmed. There is
   no catalog-based agent, plugin, shell or compiler-policy execution path to
   disable in v1.
3. **Rollback:** retain the existing lock/cache rather than acknowledging a changed
   commit. Restore a previously reviewed catalog cache/lock from version control or
   a backup only after `catalog status` passes against the still-trusted root.
4. **Revoke/rotate:** obtain the publisher's reviewed replacement root metadata.
   Root rotation requires its exact digest acknowledgement and signatures meeting
   the currently trusted root threshold, for example: `vld catalog trust
   reviewed-root-v2.json --acknowledge SHA256_OF_REVIEWED_ROOT`. Re-add/review
   catalogs under the new root; do not hand-edit catalog locks.
5. **Audit:** review `catalog.json` for package publisher/version/digest and
   `catalog-copies.json` for affected output paths, then record the incident and
   recovery decision in the project's normal review trail.

## Optional ACP/GitHub provider incident

The M8 packages are opt-in integrations, not part of the default Runtime path.
If an ACP peer fails, times out, disconnects or requests an unsupported capability,
treat its host receipt as a failed/cancelled run and inspect `vld runtime agent
status`; do not infer a successful package transition from a peer message. Stop the
peer process, keep its credential-free policy and Runtime receipt for review, then
reallocate through the normal explicit workflow if appropriate. The ACP client does
not retain its prompt or transcript and does not have a recovery authority.

If a GitHub request returns an identity mismatch, rate limit, network error or
ambiguous merge result, do **not** replay a merge request. Preserve the immutable
GitHub plan digest and query the forge manually for the PR number, head SHA and
target SHA. Recreate a reviewed plan only if those identities still equal its frozen
candidate/approval/queue tuple; otherwise return to the ordinary candidate/
verification/review path. Revoke or rotate the caller's GitHub credential through
GitHub—not VLD—because VLD never stores it. GitHub branch protection and
organization authorization remain external enforcement points.

## What this document does not cover

Nothing runs as a service, so there is no availability incident to run down. If that
changes — a hosted renderer, a registry — this file needs a real escalation path
before it is claimed.
