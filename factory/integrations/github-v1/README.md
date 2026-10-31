# Optional VLD GitHub v1 adapter

This is a narrow programmatic GitHub REST boundary. VLD Core does not import it,
discover tokens, invoke `gh`, push branches, serve webhooks or store forge
configuration. Normal VLD CI injects fixture `fetch` responses and never calls
GitHub.

A surrounding, deliberately privileged operator creates an immutable plan from
an exact VLD candidate, independent approval and queued tuple, then supplies an
in-memory token to the adapter. The adapter's functions are:

- `createGitHubPullRequestPlan` — validate/bind the VLD tuple, exact head SHA,
  base branch, required remote checks and merge permission into a digest.
- `publishGitHubPullRequest` — create or update a PR and reject a returned head,
  base, SHA or URL that differs from the plan.
- `inspectGitHubPullRequest` — read exact PR, check and review facts.
- `requestGitHubMerge` — request only the planned SHA after required remote
  checks/review facts pass. GitHub authorization and branch protection still
  decide whether a merge occurs.

Do not read a token from `process.env`, a project file, browser storage or a
command line. The caller owns its credential broker and must keep the token out
of logs. On identity mismatch, rate limit, network error or ambiguous merge,
do not retry automatically: follow the root [incident runbook](../../../docs/runbook.md).

The adapter is deliberately not wired to a Runtime CLI mutation yet. A future
typed forge endpoint must define credential brokerage, target revalidation,
durable provider receipts, idempotency and ambiguity recovery before it is
allowed to call this package.
