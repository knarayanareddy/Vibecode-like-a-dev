# vibecode-like-a-dev

Turn a one-paragraph product idea or an existing repository into a deterministic, executable specification packet (`specs/`) enforced in CI across 10 language stacks and 9 regulatory overlays — with zero runtime dependencies.

## Start in 60 seconds

```bash
vld init my-app --interactive
vld compile my-app/profile.json -o my-app/specs
vld doctor --project my-app
```

## Documentation Map

- **[User Guide](./GUIDE.md)** — Greenfield compilation, brownfield `vld adopt`, custom rules, change management, sandboxed `vld build`, independent review, drift detection, and upgrade migrations.
- **[CLI Reference](./CLI.md)** — Auto-generated reference for every `vld` command and flag.
- **[Production Case Studies](./CASE-STUDIES.md)** — Three end-to-end verified polyglot systems (Go fintech ledger, Python HIPAA/EU AI Act clinical triage, and TypeScript+Go+Rust multi-service SaaS).
- **[Benchmark Report](./results/BENCHMARK-REPORT.md)** — 34-task multi-arm evaluation with Wilson 95% confidence intervals and explicit structural vs behavioral separation.
- **[18-Idea Stress Test](./STRESS-TEST.md)** — Byte-identical compilation across all 10 language stacks, 9 regulatory overlays, and 30 adversarial profiles.
- **[Runtime & Sandbox Boundary](./EXPERIMENTAL.md)** — Compiler vs runtime separation, 5-backend sandbox engine, receipt-gated delivery, and local Studio governance.
