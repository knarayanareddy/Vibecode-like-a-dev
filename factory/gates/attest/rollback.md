# Rollback and kill-switch attestation

> Copy this file to `enforcement/rollback.md` and fill in every field after executing
> the rollback or kill switch in staging or production. The gate `G3-ROLLBACK` reads
> this path: a rollback procedure nobody has executed is a paragraph.

- **Date:** YYYY-MM-DD
- **Executed:** <command, deployment revert, or runbook step that was run, and by whom>
- **Flag:** <feature flag or kill-switch name, or "deployment revert" when none applies>

## Outcome

- **Time to take effect:** <seconds/minutes from trigger to clean traffic>
- **Data compatibility:** <confirm the previous code version ran cleanly against the current schema>
