# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.20.x` | Yes (active security fixes) |
| `< 0.20.0` | Upgrade via `vld migrate` |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for suspected security vulnerabilities.

1. Use [GitHub Private Vulnerability Reporting](https://github.com/knarayanareddy/Vibecode-like-a-dev/security/advisories/new) on `knarayanareddy/Vibecode-like-a-dev`.
2. Include the `vld --version` output, operating system, Node.js version, sandbox backend (`vld sandbox probe`), and a minimal reproduction.
3. Initial triage response target: **72 hours**. Fix and coordinated advisory target: **14 days** for high/critical findings.

## Security Architecture & Boundaries

- **Zero runtime dependencies:** VLD ships zero npm `dependencies` and emits a verifiable CycloneDX 1.5 SBOM (`sbom.cdx.json`, checked via `node scripts/generate-sbom.mjs --check`).
- **Compiler vs Runtime separation:** the deterministic compiler never imports or spawns agent/runtime processes (enforced in CI by `factory/test/core-boundary.test.mjs`).
- **Layered execution confinement (ADR 0011):** `sandboxed-cli`, `sandboxed-acp`, and `vld build` execute untrusted agents under `oci` (rootless Podman/Docker + `seccomp-default.json`), `bwrap`, `linux-ns` (user+net+mount namespaces), `darwin-seatbelt`, or `node-permission`, scrubbing host credentials and binding SHA-256 execution receipts. Pass `--require-os` to fail closed when no OS-level backend is present; legacy `local-cli` remains unconfined.
- **Studio & Runtime API:** binds strictly to loopback (`127.0.0.1`/`::1`), requires per-session bearer tokens, enforces nonce-based CSP, and never renders untrusted strings with `innerHTML`.
- **Governed GitHub delivery & audit (ADR 0012):** pins outbound API calls to `https://api.github.com`, keeps tokens in memory only, verifies commit SHA identity before PR comment or merge, scrubs secret patterns from `.vld/evidence/evidence.jsonl`, and keeps telemetry disabled by default.
