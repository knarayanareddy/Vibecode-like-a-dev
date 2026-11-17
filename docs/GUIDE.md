# User Guide

`vibecode-like-a-dev` (`vld`) compiles a short `profile.json` into a self-contained specification packet (`specs/`) with EARS requirements (`spec.json`), eight concise design documents, a polyglot test-traceability guard (`spec-check.mjs`), and mechanical CI gates (`enforcement/gates.mjs`).

## 1. Create or Adopt a Profile

```bash
# Guided interactive wizard
vld init . --interactive

# Or infer a profile directly from an existing repo (10 language stacks)
vld adopt . -o profile.json
```

Declare project-specific business rules directly inside `profile.json`:

```json
{
  "rules": [
    "When a transfer exceeds EUR 10000, the ledger shall require dual operator sign-off.",
    {
      "id": "rate-cap",
      "area": "ops",
      "statement": "When an API key exceeds 120 requests per minute, the gateway shall return HTTP 429.",
      "failurePath": "Malformed rate headers are rejected with HTTP 400."
    }
  ],
  "regulation": ["gdpr", "dora"]
}
```

Supported language stacks (`constraints.stack` string or multi-service object `{ "web": "typescript", "api": "go", "worker": "rust" }`): `typescript`, `javascript`, `python`, `go`, `rust`, `java`, `kotlin`, `csharp`, `ruby`, `php`.

Supported regulatory overlays (`regulation`): `gdpr`, `hipaa`, `pci-dss`, `soc2`, `coppa`, `ferpa`, `sox`, `dora`, `eu-ai-act`.

## 2. Plan, Compile, and Verify

```bash
vld plan profile.json --explain          # inspect tier (0-3), risk hints, primitives & rules
vld compile profile.json -o specs        # emit full packet (add --lean for minimal prompt tokens)
vld verify specs --repo . --strict --require-assertions
vld ci init --packet specs               # write PR gate workflow
```

Tag automated tests in any supported language with `@req REQ-001` (or `@req REQ-C01` for custom rules). `spec-check.mjs` verifies that every automated requirement has a real test inside the stack's runner glob, imports product code, and contains assertions.

## 3. Evolve Specs & Guard Against Continuous Drift

```bash
vld change init add-sso --packet specs
vld change apply changes/add-sso --packet specs --to-profile-rules
vld drift check --packet specs --base-ref origin/main --record
vld drift init-workflow --packet specs   # scheduled + PR continuous drift check
vld drift init-oracles --packet specs    # stack-aware Tier 3 semantic-oracles.json
```

## 4. Autonomous Sandboxed Build, Review & Audit Chain

```bash
vld sandbox probe                        # inspect oci / bwrap / linux-ns / seatbelt / node-permission
vld sandbox conformance                  # run all 8 live isolation probes
vld build profile.json --adapter sandboxed-cli --executable /usr/bin/node --arg agent.mjs --max-repairs 3
vld review prepare --packet specs --base-ref main -o .vld/review-packet.json
vld evidence verify                      # verify SHA-256 hash chain in .vld/evidence/evidence.jsonl
vld evidence export --format markdown -o docs/audit-bundle.md
```

## 5. Health Check, Telemetry & Upgrades

```bash
vld doctor                               # verify Node, Git, sandbox, profile, packet & audit chain
vld migrate                              # upgrade legacy profiles, policies & packets with .bak backups
vld telemetry status                     # disabled by default; zero automatic network calls
```
