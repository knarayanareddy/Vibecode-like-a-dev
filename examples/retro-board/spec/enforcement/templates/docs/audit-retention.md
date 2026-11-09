# Audit retention attestation

Complete one row per audit destination. The gate checks that this file exists and names
the retention period; it cannot verify the storage actually refuses deletes.

| Destination | Contents | Append-only mechanism | Retention period | Who can read | Evidence location |
| --- | --- | --- | --- | --- | --- |
| | | WORM bucket / append-only table / external SIEM | 6 years | | |

## Required statements

- Retention period: the number of years the record is kept, and the date the policy was agreed.
- Deletion path: who, if anyone, can delete an audit record, and under what approval.
- Restore path: how a record is retrieved for a compliance review, and how long that takes.
