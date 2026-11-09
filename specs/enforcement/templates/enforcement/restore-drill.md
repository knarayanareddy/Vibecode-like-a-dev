# Restore drill attestation

> Copy this file to `enforcement/restore-drill.md` and fill in every field after running
> the drill against a real snapshot. The gate `G3-RESTORE` reads this path: an untested
> backup is a hope, not a recovery plan.

- **Date:** YYYY-MM-DD
- **Restored:** <snapshot identifier, environment, and tables/buckets recovered>
- **Verified by:** <person who checked row counts, invariants and application boot>

## Timings and integrity check

- **Recovery point (RPO observed):** <age of the snapshot>
- **Recovery time (RTO observed):** <wall-clock time from start to healthy check>
- **Invariant check:** <the domain query or smoke test run against the restored data>
