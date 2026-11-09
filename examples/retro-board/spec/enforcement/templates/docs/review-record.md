# Two-person review record

> Copy to `docs/review-record.md`. The gate `G2-REVIEW` reads this path — one record
> per change that touches production data or money.

| Date | Change | Author | Reviewer | Decision |
| --- | --- | --- | --- | --- |
| YYYY-MM-DD | <what changed> | <name> | <name> | approved / rejected |

The reviewer must not be the author. An "approved" row written by the author is worse
than an empty table: it records a review that did not happen.
