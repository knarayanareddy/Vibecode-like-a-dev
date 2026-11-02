# Contributing

Thanks for improving VLD. Changes should preserve the boundary between reviewed input, deterministic compiler output, and optional local runtime state.

## Before opening a pull request

1. Start with a focused test or regression when behavior changes.
2. Run `npm run lint`, `npm test`, and `npm run check` for compiler/policy changes.
3. Regenerate and inspect committed packets when generator output changes: `npm run dogfood` and `node factory/cli.mjs compile examples/retro-board/profile.json -o examples/retro-board/spec --force`.
4. Do not hand-edit generated packet output; change the profile, policy, routing, template, or approved change source instead.
5. Keep dependencies out unless an ADR explains the durable trade-off. The core CLI deliberately has no runtime dependencies.

## Reviews and security

Keep changes small and explain policy or authority-boundary changes in the PR. Do not include credentials, private keys, runtime tokens, or local `.vld/runtime/` state. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
