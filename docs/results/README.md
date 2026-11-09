# Live results

This directory holds **raw, dated results from a real model run**, committed as JSON
with the provenance needed to reproduce them. It is empty because no live run has
been published yet. That is the honest state of the central claim, and the reason
this directory exists is so the gap is a missing file rather than a missing paragraph.

## What is here instead, today

Everything `npm run eval` prints is **deterministic calibration**: a fixed harness
applies the specification to hand-written reference implementations and counts what a
naive implementation would have shipped. It measures whether the checks can fail, not
whether a model works better with the packet. The README says so, and the numbers
should be read that way.

## What a live result requires

1. Provider credentials for a paid API (`openai` or `anthropic`), supplied as the
   `live-agent-benchmark` environment secret in GitHub Actions — the workflow is
   `workflow_dispatch` only, precisely so it cannot run by accident.
2. At least two agent configurations across the 24 tasks × 3 arms, with a minimum of
   one seed per cell and preferably three (the variance between seeds is the part
   people skip, and it is usually larger than the effect).
3. A committed artifact per run:
   `docs/results/YYYY-MM-DD-<provider>-<model>-<task-filter>.json` containing the raw
   outcome report, the exact model identifier, the provider's reported token usage,
   the run id and the git SHA of the packet that was measured.
4. Confidence intervals, not point estimates. With 24 tasks a 100% merge rate and a
   92% merge rate are frequently the same result.

## The comparison that matters

Report **cost per merged task**, not merge rate and token cost separately. The packet
is expensive per attempt; if it raises the merge rate enough, it is cheaper per
shipped result. A table with the two numbers apart invites the reader to pick the one
that supports their prior.

```bash
# the harness (no credentials needed to see what it would do)
node scripts/eval-outcome.mjs --runner cmd --unsafe-command --agent-cmd "claude -p …"

# live, paid, manual
node scripts/eval-outcome.mjs --runner openai --model <exact-model-id>
```

## The lean arm

`vld compile … --lean` emits `AGENTS.md` and `spec.json` only. On the repository's own
profile it is roughly **2.9k tokens against 6.5k** for the same two files in the full
packet, with every requirement and every acceptance criterion intact — it drops the
narrative documents and the record of what was rejected. The audit that prompted this
arm suggested a 1.5k target; reaching that means dropping criteria, which would make
the cheap arm weaker rather than leaner, so it was not done. Use it as the fourth arm
once a live run is available and let the result pick the default.
