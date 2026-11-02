# Discoverability readiness artifact

`discoverability-readiness` is a **human-authored, packet-linked, locally verified advisory record** for an explicitly opted-in public web application. It turns a reviewed public-route decision into an auditable local handoff; it is not an SEO audit or a statement from any external authority.

## Eligibility and authority

The command is intentionally unavailable unless the project profile has all three of:

```json
{
  "kind": "web-app",
  "risks": { "publicFacing": true },
  "discoverability": { "enabled": true }
}
```

It also requires a compiled packet containing the `web.discoverability` requirement. `init` records the SHA-256 digest of the exact local `specs/spec.json` bytes and the packet’s assigned requirement ID. `validate` recalculates that digest, so a changed or regenerated packet invalidates the old readiness record until a person rechecks and updates it.

This is deliberately narrower than a provider report. It performs no crawler, browser automation, external network request, API call, credential lookup, ranking check, indexing check, traffic check, or citation check. It does not prove that a reviewer is a particular person, that a provider accepted content, or that a page was indexed. The human review fields are an accountable record supplied by the project, not an independently authenticated identity claim.

## Commands

Compile the opted-in profile first, then create a draft:

```sh
vld compile profile.json -o specs
vld discoverability-readiness init --project . --packet specs
```

By default this safely creates `docs/discoverability-readiness.md`. Use `--out <path>` (or the compatible `--file <path>` alias) for another project-contained path and `--force` only when deliberately replacing the record.

Fill in the draft, have its contents reviewed, and check it locally:

```sh
vld discoverability-readiness validate --project . --packet specs --strict
```

`--json` emits the same deterministic local report for automation. Ordinary validation fails for missing required evidence, an ineligible/disabled/absent profile, a missing `web.discoverability` requirement, malformed records, or a stale packet digest. `--strict` also rejects warnings, including the generated Draft status and unfilled template placeholders.

## Required record contents

The validator requires these sections:

1. **Packet Authority** — packet path, SHA-256 digest, and the exact discoverability requirement ID.
2. **Scope and Advisory Boundary** — the intended discovery surface and an explicit statement that the record is local evidence rather than provider authority or an outcome claim.
3. **Canonical Origin and Locale Policy** — one non-loopback HTTPS canonical origin plus a locale or URL-policy decision.
4. **Indexable Route Inventory** — a human-authored table with at least one public route class.
5. **Excluded Route Inventory** — a human-authored table recording routes that are noindex, absent, or otherwise excluded.
6. **Metadata and Social Contract** — rendered title, description, canonical URL, and social metadata behavior.
7. **Structured Data Evidence** — JSON-LD/structured-data source and a local check of its rendered or maintained facts.
8. **Local Verification Evidence** — the command run and its observed local outcome.
9. **Human Review Record** — reviewer/review group, date, decision, and notes.
10. **Requirement Links** — the packet’s discoverability requirement ID.

The checks establish that those local claims are complete and still linked to the reviewed packet. They do not turn narrative into evidence of indexing, rankings, external citation, or real-world user discovery.

## Review and refresh procedure

- Treat the route inventories as product decisions, not as a generated crawl result.
- Record only facts supported by the project’s own rendered output and maintained source.
- Re-run the stated local route-level tests before approving the record.
- When `specs/spec.json` changes, rerun `validate`. A digest mismatch means re-review is required; do not copy the new digest without reviewing the record against the new packet.
- Keep the record in source control alongside the profile and packet inputs so the human decision is reviewable.
