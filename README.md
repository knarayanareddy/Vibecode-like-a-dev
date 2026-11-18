# vibecode-like-a-dev (`vld`)

Turn a one-paragraph product idea or an existing repository into a deterministic, executable specification packet (`specs/`) enforced in CI — and optionally executed inside an OS-confined autonomous build and review loop.

- **Zero runtime dependencies** · Requires **Node.js 22 or newer** (`.nvmrc` pinned).
- **Polyglot & compliance-ready:** **36 primitives**, **10 language stacks** (`typescript`, `javascript`, `python`, `go`, `rust`, `java`, `kotlin`, `csharp`, `ruby`, `php`), and **10 regulatory overlays** (`gdpr`, `hipaa`, `ccpa`, `pci-dss`, `soc2`, `coppa`, `ferpa`, `sox`, `dora`, `eu-ai-act`).
- **Deterministic compiler:** identical `profile.json` inputs compile byte-for-byte identical EARS requirements (`spec.json`), custom business rules (`REQ-C01…`), design docs (`--lean` available for minimal prompt tokens), drift guards (`spec-check.mjs`), and CI gates (`enforcement/gates.mjs`).
- **Sandboxed execution & audit:** opt-in 5-backend confinement (`oci`, `bwrap`, `linux-ns`, `darwin-seatbelt`, `node-permission`), bounded self-repair (`vld build`), isolated 6-category spec review (`vld review`), continuous drift detection (`vld drift`), governed GitHub v1 delivery, and SHA-256 hash-chained `evidence.jsonl` (`vld evidence`).

## Quick Start

Requires **Node.js 22 or newer**:

```bash
# Run directly without installing
npx --yes github:knarayanareddy/Vibecode-like-a-dev init my-app --interactive
npx --yes github:knarayanareddy/Vibecode-like-a-dev compile my-app/profile.json -o my-app/specs

# Or install globally
npm install --global github:knarayanareddy/Vibecode-like-a-dev

# Or run, test and deploy from source
git clone https://github.com/knarayanareddy/Vibecode-like-a-dev
cd Vibecode-like-a-dev && npm test && npm run check
```

## Core Workflow

```bash
vld adopt . -o profile.json                              # infer profile from an existing repo
vld plan profile.json --explain                          # preview rigor tier (0-3), risk hints & rules
vld compile profile.json -o specs                        # emit packet (add --lean for compact context)
vld verify specs --repo . --strict --require-assertions  # enforce @req test coverage & assertions
vld drift check --packet specs --base-ref main --record  # detect unanchored changes & weakened tests
vld doctor                                               # verify Node, Git, sandbox, packet & audit chain
vld migrate                                              # upgrade legacy profiles, policies & packets
```

### Experimental Autonomous Runtime & Governance

See [`docs/EXPERIMENTAL.md`](docs/EXPERIMENTAL.md) for the compiler/runtime boundary and confinement model:

```bash
vld experimental sandbox conformance                     # run 8 live filesystem/network/credential probes
vld experimental build profile.json --adapter sandboxed-cli --executable /usr/bin/node --arg agent.mjs
vld review prepare --packet specs --base-ref main -o .vld/review-packet.json
vld evidence verify && vld studio serve .vld/mission.json
```

## Published Benchmarks & Calibration Caveat

All numbers are reproduced offline by `npm run eval` and `npm run stress` and verified against this file in CI (`scripts/check-readme-metrics.mjs`):

| Suite | Scope | Measured Result |
| --- | --- | --- |
| Stress corpus | **18 product ideas** + 30 adversarial profiles | **18/18 verified & byte-identical**, 0 findings |
| Practice & routing evals | 36 primitives · 30 routing · 40 custom rules | **100.0% recall@1** · **96.8% routing F1** · **96.1% rules F1** |
| Outcome harness (calibration) | **34 tasks** × 3 arms (102 workspaces) | **98.0%** drift catch (95% CI **93.1%–99.5%**), **100.0%** naive patches gated |
| Context budget | Full packet vs `--lean` | ~16.6k tokens full; use `--lean` for low-token loops |

*Calibration caveat:* the committed 34-task result in [`docs/results/calibration-34.json`](docs/results/calibration-34.json) runs in fixture calibration mode (no live model invoked) to verify oracle solvability, structural gate catch rates, and defect-probe sensitivity. Full split metrics and live-model runner instructions are in [`docs/results/BENCHMARK-REPORT.md`](docs/results/BENCHMARK-REPORT.md).

## What to commit from `.vld/`

Commit reviewable configuration and lockfiles (`.vld/modules.json`, `.vld/catalog.json`, `.vld/catalog-root.json`, `.vld/stores.json`, `.vld/workflows/*.json`). Keep ephemeral runtime logs, worktrees, agent caches, and opt-in local telemetry ignored via `.gitignore`. Telemetry (`vld telemetry status`) is **disabled by default** and never makes automatic network calls.

## Documentation & Examples

- **Guides & Reference:** [`docs/GUIDE.md`](docs/GUIDE.md) · [`docs/CLI.md`](docs/CLI.md) · [`docs/AUTHORING.md`](docs/AUTHORING.md) · [`prompts/bootstrap.md`](prompts/bootstrap.md)
- **Examples & Case Studies:** [`examples/retro-board/`](examples/retro-board/) · [`docs/CASE-STUDIES.md`](docs/CASE-STUDIES.md) · [`docs/STRESS-TEST.md`](docs/STRESS-TEST.md)
- **Architecture & Governance:** [`docs/EXPERIMENTAL.md`](docs/EXPERIMENTAL.md) · [`docs/COMPARATIVE-STUDY.md`](docs/COMPARATIVE-STUDY.md) · [`SECURITY.md`](SECURITY.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT.
