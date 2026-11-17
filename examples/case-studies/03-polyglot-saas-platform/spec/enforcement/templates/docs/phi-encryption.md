# PHI encryption attestation

One row per PHI store. Fill it in before the first production deployment and review it
at each key rotation. This record is the evidence the gate looks for; the gate cannot
tell whether the key policy is sound, only that an owner asserted it.

| Store | What it holds | In transit | At rest | Key owner | Rotation interval | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| primary database | patient records, visit notes | TLS 1.2+ | AES-256, provider-managed | | 90 days | |
| object storage | uploaded documents | TLS 1.2+ | SSE-KMS | | 90 days | |
| backups | full database snapshots | TLS 1.2+ | encrypted with the same key policy | | 90 days | |
| log sink | request logs (no PHI allowed) | TLS 1.2+ | encrypted | | 90 days | |

## What this record does not prove

- That no PHI is written to a log, a fixture or an error message. Only the test named by
  the requirement can show that.
- That the rotation actually happened. The interval is a claim; the key manager is the
  authority.
