/**
 * Domain hints.
 *
 * A requirement tells us that "money must be correct under retries". It does not
 * tell us what the aggregate is called. These hints are the bridge: candidate
 * terms, aggregates and invariants that the spec proposes and the human confirms.
 *
 * Everything here is marked as a candidate in the emitted packet. Nothing invents
 * certainty: definitions are prompts to a human, invariants are testable claims.
 */

export const TERM_HINTS = {
  'core.runnable': [],
  'core.non-goals': [],
  'data.persistence': [
    { term: 'Record', definition: 'A row that outlives the request that created it; candidate name to be replaced with the domain term.' },
    { term: 'Snapshot', definition: 'A copy of state captured at a point in time for restore purposes.' }
  ],
  'data.lifecycle': [
    { term: 'Data subject', definition: 'The natural person whose personal data is stored.' },
    { term: 'Retention window', definition: 'The maximum time a field may exist before deletion.' }
  ],
  'auth.identity': [
    { term: 'Account', definition: 'The durable identity record; owns credentials and profile.' },
    { term: 'Session', definition: 'A revocable grant of access with an expiry.' }
  ],
  'auth.authorization': [
    { term: 'Actor', definition: 'The principal performing an action; a person, service or system job.' },
    { term: 'Policy', definition: 'A named rule deciding whether an actor may perform an action on a resource.' },
    { term: 'Grant', definition: 'An assignment of a role or permission to an actor.' }
  ],
  'auth.tenant-isolation': [
    { term: 'Tenant', definition: 'The isolation boundary for data and configuration.' },
    { term: 'Membership', definition: 'The link between an account and a tenant, carrying its roles.' }
  ],
  'ui.accessibility': [{ term: 'Primary journey', definition: 'The shortest path a user takes to receive the product\'s core value.' }],
  'ui.states': [
    { term: 'Empty state', definition: 'What the user sees when there is no data, including the next action.' },
    { term: 'Loading state', definition: 'What the user sees before data arrives; must not shift layout.' }
  ],
  'ui.design-tokens': [{ term: 'Token', definition: 'A named design decision (colour, space, type) referenced instead of a literal.' }],
  'ux.error-taxonomy': [
    { term: 'Correctable error', definition: 'Caused by user input; fixable by the user; shown inline.' },
    { term: 'Retryable error', definition: 'Caused by a transient dependency failure; offers retry.' },
    { term: 'Unexpected error', definition: 'Unclassified failure; generic message plus support code; logged with correlation ID.' }
  ],
  'api.contract': [{ term: 'Contract', definition: 'The machine-readable description of an interface that both sides compile against.' }],
  'api.error-envelope': [{ term: 'Machine code', definition: 'A stable string identifying an error class; changes are breaking.' }],
  'integration.retries': [
    { term: 'Idempotency key', definition: 'A caller-supplied identifier that makes a retried request safe to replay.' },
    { term: 'Event', definition: 'An immutable fact published by a producer; consumers must tolerate redelivery.' }
  ],
  'payments.correctness': [
    { term: 'Charge', definition: 'A single attempt to move money; may fail without any transfer.' },
    { term: 'Ledger entry', definition: 'An immutable debit or credit; corrections are new entries, never edits.' },
    { term: 'Settlement', definition: 'The provider\'s final reconciliation of captured funds.' },
    { term: 'Entitlement', definition: 'What the customer is allowed to do because of a payment.' }
  ],
  'ai.guardrails': [
    { term: 'Prompt contract', definition: 'The declared input schema and output schema for a model call.' },
    { term: 'Evaluation set', definition: 'A versioned set of inputs with expected properties used to judge a prompt change.' }
  ],
  'ops.observability': [
    { term: 'Correlation ID', definition: 'An identifier propagated across a request\'s logs and outbound calls.' },
    { term: 'SLO', definition: 'A target for a measurable reliability property, with an error budget.' }
  ],
  'ops.rate-limits': [{ term: 'Window', definition: 'The time bucket over which a limit is enforced.' }],
  'delivery.audit-trail': [{ term: 'Audit record', definition: 'An append-only fact recording actor, action, target, time and outcome.' }],
  'pipeline.idempotency': [
    { term: 'Watermark', definition: 'The position a stage has processed up to; makes replay bounded and repeatable.' },
    { term: 'Partition', definition: 'A unit of output addressed by key, enabling deterministic replay.' }
  ],
  'library.api-stability': [{ term: 'Public surface', definition: 'Everything a consumer may legally import; guarded by a snapshot test.' }],
  'cli.ergonomics': [{ term: 'Command grammar', definition: 'The documented shape of commands, flags and exit codes.' }],
  'spec.drift-guard': [{ term: 'Anchor', definition: 'An @req marker in a test file binding a test to a requirement identifier.' }]
};

export const AGGREGATE_HINTS = {
  'data.persistence': [
    { name: 'Record', invariants: ['Every record has a stable identity that never changes.', 'Deleted records are soft-deleted only if a retention rule allows it.'] }
  ],
  'data.lifecycle': [
    { name: 'DataSubject', invariants: ['A deletion request removes every field tagged personal across all tables.', 'Deletion completion is recorded without retaining the deleted data.'] }
  ],
  'auth.identity': [
    { name: 'Account', invariants: ['An account has exactly one active credential set at a time.', 'A revoked session can never be un-revoked; a new session is issued instead.'] },
    { name: 'Session', invariants: ['A session has an absolute expiry that cannot be extended by activity indefinitely.', 'A session token is verified server-side before any state change.'] }
  ],
  'auth.authorization': [
    { name: 'Policy', invariants: ['Deny is the default when no policy matches.', 'A policy decision never depends on client-supplied roles.'] }
  ],
  'auth.tenant-isolation': [
    { name: 'Membership', invariants: ['A membership belongs to exactly one tenant and one account.', 'All tenant-scoped queries carry the tenant key from the authenticated context.'] }
  ],
  'integration.retries': [
    { name: 'IdempotencyKey', invariants: ['A key may be consumed once per operation scope.', 'Replaying a consumed key returns the original outcome and performs no new side effect.'] }
  ],
  'payments.correctness': [
    { name: 'Payment', invariants: ['Amounts are integer minor units with an explicit currency.', 'A payment intent can transition from pending to captured at most once.', 'Every state transition writes exactly one ledger entry.'] },
    { name: 'Ledger', invariants: ['Entries are immutable; corrections are compensating entries.', 'Sum of debits minus credits equals zero per settled transaction.'] }
  ],
  'ai.guardrails': [
    { name: 'ModelCall', invariants: ['Every call has a token budget, a timeout and a declared output schema.', 'Output failing schema validation is never rendered as trusted content.'] }
  ],
  'pipeline.idempotency': [
    { name: 'StageRun', invariants: ['A stage run is keyed by (stage, window) and may execute at most once as effective.', 'Replaying a window does not change the output partition.'] }
  ],
  'library.api-stability': [
    { name: 'PublicSurface', invariants: ['Every exported symbol is covered by a snapshot test.', 'A removed export requires a major version.'] }
  ],
  'ops.audit-trail': [
    { name: 'AuditRecord', invariants: ['Records are append-only; application code has no update or delete grant.', 'Records never contain secrets or full personal data.'] }
  ]
};

/** Higher-level contexts implied by traits and kind. */
export const CONTEXT_HINTS = {
  auth: { name: 'Identity & Access', owns: ['Account', 'Session', 'Policy', 'Membership'], notes: 'Authenticates and authorises; other contexts receive an actor, never a password.' },
  admin: { name: 'Administration', owns: ['AdminAction'], notes: 'Privileged operations; every write emits an audit record.' },
  payments: { name: 'Billing', owns: ['Payment', 'Ledger', 'Entitlement'], notes: 'Talks to the payment provider through one adapter; exposes entitlements, not charges.' },
  realtime: { name: 'Realtime', owns: ['Channel', 'Subscription'], notes: 'Fan-out only; never the source of truth for domain state.' },
  search: { name: 'Search', owns: ['Index', 'Query'], notes: 'Derived projection; rebuildable from the core context, never authoritative.' },
  upload: { name: 'Media', owns: ['Asset', 'ScanResult'], notes: 'Validates type and size before storage; scanning is asynchronous.' },
  notifications: { name: 'Notifications', owns: ['Template', 'Delivery'], notes: 'Consumes events; must tolerate duplicates and out-of-order delivery.' },
  webhooks: { name: 'Integrations', owns: ['Endpoint', 'Delivery', 'IdempotencyKey'], notes: 'Owns inbound verification and outbound retries.' },
  ai: { name: 'Assistance', owns: ['ModelCall', 'PromptContract'], notes: 'Isolated so model failures never block the primary journey.' },
  'background-jobs': { name: 'Jobs', owns: ['Job', 'Attempt'], notes: 'At-least-once execution; handlers must be idempotent.' },
  offline: { name: 'Sync', owns: ['ChangeLog', 'Conflict'], notes: 'Client-side truth is provisional; server resolves conflicts deterministically.' },
  i18n: { name: 'Localisation', owns: ['Message', 'Locale'], notes: 'No user-facing string is concatenated in code.' }
};

export function termsFor(requirements) {
  const seen = new Set();
  const rows = [];
  for (const requirement of requirements) {
    for (const hint of TERM_HINTS[requirement.key] ?? []) {
      if (seen.has(hint.term)) continue;
      seen.add(hint.term);
      rows.push({ ...hint, source: requirement.id });
    }
  }
  return rows;
}

export function aggregatesFor(requirements) {
  const seen = new Set();
  const rows = [];
  for (const requirement of requirements) {
    for (const hint of AGGREGATE_HINTS[requirement.key] ?? []) {
      if (seen.has(hint.name)) continue;
      seen.add(hint.name);
      rows.push({ ...hint, source: requirement.id });
    }
  }
  return rows;
}

export function contextsFor(profile) {
  const fromTraits = profile.traits
    .map((trait) => CONTEXT_HINTS[trait])
    .filter(Boolean);

  const core = {
    name: 'Core',
    owns: ['the product\'s central aggregate (name it)'],
    notes: 'Owns the rules that make this product itself. No framework or vendor imports.'
  };

  return [core, ...fromTraits];
}
