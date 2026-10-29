---
id: testing.contract-tests
title: Contract tests and real fixtures
module: testing
summary: Test adapters against recorded reality, not against a mock you wrote from the docs.
obligation: "In {project}, every external service that {aPrimary} depends on is tested against a recorded response — one success, one failure — rather than a mock written from the documentation."
tier_min: 2
cost: medium
priority: 5
tags: [contract-testing, fixtures, integrations, mocks, pacts]
triggers: [contract test, integration test, mock, fixture, third party api]
enforces: [api.contract, integration.retries]
artifacts: [05-verification.md, 04-contracts.md]
---

# Contract tests and real fixtures

Every mock is a guess about someone else's system, frozen at the moment of guessing. The mock returns the shape you expected, the real API returns the shape it has, and the difference is discovered by a user.

Contract tests replace the guess with a recording: capture one real interaction, commit it, test your adapter against it.

## In this product

Generated per product from the profile — the braces are slots the packet fills:

> In {project}, every external service that {aPrimary} depends on is tested against a recorded response — one success, one failure — rather than a mock written from the documentation.

That sentence is generated from the profile, so it names this product's own nouns. If it would read the same for any product of this kind, the idea behind the profile is too thin to bind the practice — fix the idea, not the sentence.

## When this applies

Any consumed external interface (payment provider, auth provider, email, storage, third-party API) and any interface you expose to another team.

## The practice

**For consumed interfaces:**

1. Capture a real response once, including a failure response (4xx and 5xx if the vendor allows).
2. Store it as a fixture with the date and the API version in the filename.
3. Test the adapter against the fixture: parsing, error mapping, retry classification, timeout behaviour.
4. Re-capture on a schedule or when the vendor announces a change. A stale fixture is a false comfort, so date it visibly.

**For exposed interfaces:**

1. Assert the response shape against the contract, not against a snapshot of your own output.
2. Cover one example per status code you actually return.
3. Assert the error envelope for validation failure and unknown route.
4. Fail the build on a breaking change: removed field, narrowed type, new required request field.

**For both:** classify errors explicitly. The rule that prevents the classic bug:

| Upstream | Retry? |
| --- | --- |
| 400, 401, 403, 404, 422 | No — the request is wrong and will stay wrong |
| 408, 425, 429, 5xx | Yes, with backoff and jitter, bounded |
| Network timeout | Yes, with an idempotency key |

## Checklist

- [ ] Every external dependency has at least one recorded success and one recorded failure fixture.
- [ ] Fixtures record the vendor API version and capture date.
- [ ] Error classification is explicit and tested.
- [ ] Tests run without network access.
- [ ] A contract change fails CI before merge.
- [ ] No mock of your own domain to test your own domain.

## Red flags

These are the observable signals that the practice is being skipped. Each one is something a reviewer can point at in a diff, rather than a belief about what the author intended.

- A hand-written mock of an external service.
- Fixtures with no capture date.
- No recorded failure response.
- Contract tests that only run locally.
- A vendor change that passed CI silently.

## Anti-rationalization

The excuse on the left is what a competent person says when they skip this. The middle column is why it does not survive the first real change; the right column is the smallest thing that satisfies the practice anyway.

| Excuse | What is actually true | What to do instead |
| --- | --- | --- |
| The docs describe the response. | The docs describe the last version. | Record a real response once. |
| A mock is faster. | A mock you wrote tests your assumptions. | Record once, replay in CI. |
| We only consume the API. | Consumers break when it changes. | Test the consumer side of the contract too. |
| Fixtures age, so we update them in place. | Updating without a version hides a breaking change. | Record the version and the capture date. |
| Tests need the network to be realistic. | Then they are not tests. | Run from fixtures, offline. |

## Anti-patterns

- **Hand-written mocks of vendor APIs.** They encode your assumptions and pass forever.
- **Testing against the vendor's sandbox in CI.** Slow, flaky, rate-limited, and it fails when the vendor has an incident.
- **Snapshot of a whole response.** Any new field breaks the test, so it gets updated blindly.
- **Retry on everything.** Retrying a 400 is how a harmless bug becomes a traffic spike.

## Why it works

Most integration failures are shape mismatches, not logic errors, and they are invisible to unit tests with mocks. A recorded real payload tests the boundary you do not control, at a cost of a few kilobytes and zero network.

## Cost and when to skip

Medium: an hour per integration, plus a re-capture reminder. Skip at tier 1 if the integration is not load-bearing; never skip for payments, auth or anything that moves money or permissions.
