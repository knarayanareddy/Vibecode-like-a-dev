# Benchmark Report (v0.20.0)

Every figure in this report is produced directly by the committed, zero-dependency evaluation suite (`npm run eval` and `npm run stress`) and enforced against `README.md` in CI via `node scripts/check-readme-metrics.mjs`.

## 1. Compiler & Knowledge-Base Benchmarks

| Benchmark | Command | Corpus | Result |
| --- | --- | --- | --- |
| Practice library retrieval | `node scripts/eval-library.mjs` | 36 primitives / 45 profiles / 1,088 obligations | **100.0% recall@1** (0 structural failures) |
| Obligation specificity | `node scripts/eval-specificity.mjs` | 39 full packets (238 pairs) | **30% mean / 46% worst** boilerplate ratio |
| Intent-to-primitive routing | `node scripts/eval-routing.mjs` | 77 routing prompts (8 negatives) | **93.8% precision · 100.0% recall · 96.8% F1** |
| Custom rule EARS compiler | `node scripts/eval-rules.mjs` | 50 custom-rule items | **100.0% precision · 92.5% recall · 96.1% F1** |
| Multi-stack stress corpus | `node scripts/stress-test.mjs` | 18 product ideas (10 stacks, 9 regulatory overlays) | **18/18 verified · 18/18 byte-identical · 0 findings** |
| Adversarial input fuzzing | `node scripts/stress-adversarial.mjs` | 30 adversarial / injection profiles | **30/30 handled cleanly** (24 safely compiled, 6 rejected) |
| Live sandbox conformance | `vld sandbox conformance` | 8 adversarial probes × active backends | **8/8 pass on `linux-ns` · 8/8 pass on `node-permission`** |

## 2. 34-Task Multi-Arm Outcome Harness (`docs/results/calibration-34.json`)

**Scope & honesty note:** `calibration-34.json` executes starter, naive, reference, and post-merge drift-mutation workspaces across all **34 tasks × 3 arms = 102 workspaces** inside Node `--permission` isolation with **no live LLM invoked**. Structural gate enforcement and behavioral execution are reported separately below so fixture calibration is never conflated with live-model win rates.

### Structural Metrics (CI Gate & Drift Enforcement)

| Arm | Naive Patch Blocked Pre-Review (95% CI) | Total Drift Catch (95% CI) | Anchor-Drop Catch | Gate-Regression Catch | Mean Context Tokens |
| --- | --- | --- | --- | --- | --- |
| `no-spec` | 0.0% (0.0%–10.2%) | 0.0% (0.0%–3.6%) | 0.0% | 0.0% | 167 |
| `generic-spec` | 0.0% (0.0%–10.2%) | 0.0% (0.0%–3.6%) | 0.0% | 0.0% | 729 |
| `vld-packet` | **100.0%** (89.8%–100.0%) | **98.0%** (93.1%–99.5%) | **100.0%** | **94.1%** | 16,552 (full) |

### Behavioral Calibration Metrics (Oracle Solvability & Semantic Probes)

| Arm | Reference Oracle Merge Rate (95% CI) | Review-Clean Rate (95% CI) | Reference Mean Defects | Semantic-Weaken Drift Catch (95% CI) |
| --- | --- | --- | --- | --- |
| `no-spec` | 100.0% (89.8%–100.0%) | 100.0% (89.8%–100.0%) | 0.00 | 0.0% (0.0%–10.2%) |
| `generic-spec` | 100.0% (89.8%–100.0%) | 100.0% (89.8%–100.0%) | 0.00 | 0.0% (0.0%–10.2%) |
| `vld-packet` | **100.0%** (89.8%–100.0%) | **100.0%** (89.8%–100.0%) | **0.00** | **100.0%** (89.8%–100.0%) |

### Coverage by Category (34 Tasks)

- **Greenfield (8 tasks):** includes rate limiters, idempotent double-entry multi-currency ledgers (`adv-25`), and EU AI Act autonomous tool gates (`adv-26`) — 100.0% drift catch.
- **Brownfield (8 tasks):** includes multi-tenant search isolation (`adv-27`) and HMAC-SHA256 webhook replay guards (`adv-28`) — 100.0% drift catch.
- **Bugfix (6 tasks):** includes OAuth2 PKCE S256 state/replay defense (`adv-29`) and optimistic concurrency inventory locking (`adv-30`) — 94.4% drift catch.
- **Refactor (6 tasks):** includes GDPR Article 17 erasure cascades preserving tax totals (`adv-31`) and per-upstream circuit breakers (`adv-32`) — 100.0% drift catch.
- **Systems (6 tasks):** includes checkpoint shippers, partitioned FIFO transactional outboxes (`adv-33`), and SHA-256 hash-chained compliance logs (`adv-34`) — 94.4% drift catch.

## 3. Running Live Model Benchmarks

Use `.github/workflows/live-agent-benchmark.yml` or run locally with an API key:

```bash
OPENAI_API_KEY=... node scripts/eval-outcome.mjs --runner openai --model gpt-4o --out docs/results/live-gpt-4o.json
ANTHROPIC_API_KEY=... node scripts/eval-outcome.mjs --runner anthropic --out docs/results/live-claude.json
```
