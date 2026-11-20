/**
 * Roadmap P1.3 — Cross-Rule Contradiction, Infeasible Latency & Duplicate Suite.
 *
 * Covers:
 *   - 32 adversarial rule pairs (contradictions + infeasible latency floors + duplicates/subsumption)
 *   - Adversarial Test D ("Delete all data immediately" ⟂ "Retain financial records 7 years"
 *     and "Every API call responds in < 5ms" ⟂ "Every call logs to external AI API")
 *   - Latency floors: AI >= 200ms, cross-region sync >= 60ms, payment rails >= 1000ms
 *   - `profile.conflicts` explicit precedence resolution unblocks strict `plan`/`compile`
 *   - `specs/rule-lint.json` emission and `vld plan --explain` rendering
 *   - Zero false positives across all committed profiles, case studies, and stress ideas
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { lintRawRuleList, parseRuleAst } from '../lib/rule-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const INDEX = buildIndex();

const ADVERSARIAL_CONTRADICTION_PAIRS = [
  // Retention vs immediate deletion (incl. Test D)
  ['test-d-retention-vs-delete', 'Delete all data immediately when a user requests closure.', 'Retain all financial records for 7 years.'],
  ['gdpr-wipe-vs-audit-keep', 'Erase all customer records immediately on request.', 'Keep all customer records for 5 years for compliance.'],
  ['purge-logs-vs-retain-logs', 'Permanently delete all logs immediately after processing.', 'Retain all logs for at least 365 days.'],
  ['destroy-messages-vs-archive', 'Wipe all user data immediately upon logout.', 'Preserve all user data for 90 days.'],
  // Immutability vs deletion/mutation
  ['immutable-audit-vs-delete', 'Audit logs are immutable and must never be deleted.', 'Administrators can permanently delete any audit log at any time.'],
  ['append-only-ledger-vs-edit', 'Ledger entries are append-only and can never be modified.', 'Users can edit all ledger entries at any time.'],
  ['readonly-records-vs-overwrite', 'All records are read-only once created.', 'Operators can overwrite all records immediately.'],
  ['no-delete-invoice-vs-purge', 'Invoices must never be deleted from storage.', 'Users can permanently delete any invoice immediately.'],
  // Zero storage / stateless vs persistence
  ['stateless-vs-store-profiles', 'The service is stateless and never stores any user data.', 'Store all user profiles in the database for 2 years.'],
  ['zero-pii-vs-retain-pii', 'Never persist any personal data on disk.', 'Retain customer personal data for 180 days.'],
  ['no-log-storage-vs-save-logs', 'Never store any request payloads.', 'Save every request payload for 30 days.'],
  // Offline / no-network vs external API calls
  ['offline-vs-stripe-call', 'The application is offline-only and never makes outbound network calls.', 'Every checkout charges the customer via external API in real time.'],
  ['airgapped-vs-openai', 'Operate completely air-gapped with no internet access.', 'Send every document to OpenAI for classification.'],
  ['no-external-api-vs-webhook', 'Must not call any external API or remote server.', 'Forward every event to a third-party API webhook synchronously.'],
  // Anonymous access vs mandatory authentication
  ['anon-all-vs-auth-all', 'Allow anonymous access to all API routes without login.', 'Every API endpoint must require authentication.'],
  ['no-login-vs-mfa-all', 'No authentication is required to submit requests.', 'All requests must require MFA verification.'],
  ['guest-access-vs-reject-unauth', 'Permit unauthenticated requests across the service.', 'Reject all unauthenticated requests with 401.'],
  // Plaintext vs mandatory encryption
  ['plaintext-data-vs-encrypt-all', 'Store all data in plaintext for fast debugging.', 'All data must be encrypted at rest with AES-256.'],
  ['unencrypted-export-vs-encrypt-export', 'Write every backup export without encryption.', 'All backup exports must be encrypted before storage.'],
  // Auto-approval vs mandatory human approval
  ['auto-payout-vs-dual-approval', 'Automatically disburse all payouts with no human approval.', 'Every payout requires dual approval before settlement.'],
  ['auto-refund-vs-manual-review', 'Instantly refund all refund requests without manual review.', 'All refunds require manual approval from finance.'],
  ['auto-deploy-vs-human-approval', 'Auto-deploy every release without human intervention.', 'All deployments require human-in-the-loop approval.'],
  // Export/sharing prohibition vs requirement
  ['forbid-export-vs-require-export', 'Never export any user data outside the workspace.', 'Must export all user data to customers on demand.'],
  // Disjoint numeric bounds
  ['password-max8-vs-min12', 'Passwords must be at most 8 characters.', 'Passwords must be at least 12 characters.'],
  ['session-15m-vs-24h', 'User sessions expire within 15 minutes.', 'User sessions must remain active for at least 24 hours.'],
  ['log-retention-max30d-vs-min7y', 'Retain audit logs for at most 30 days.', 'Retain audit logs for at least 7 years.'],
  ['webhook-no-retry-vs-min5', 'Never retry failed webhooks.', 'Retry failed webhooks at least 5 times.'],
  ['upload-max5mb-vs-min50mb', 'Uploads must be at most 5 MB.', 'Uploads must be at least 50 MB.'],
  ['concurrent-sessions-1-vs-5', 'Allow only a single active session per user.', 'Support at least 5 concurrent sessions per user.'],
  // Infeasible latency floors (incl. Test D)
  ['test-d-5ms-vs-external-ai', 'Every API call responds in < 5ms.', 'Every API call logs to an external AI API.'],
  ['ai-under-50ms', 'AI model inference completions must respond within 50ms.', 'All prompts are scored synchronously by an LLM API.'],
  ['cross-region-under-10ms', 'Cross-region synchronous replication must respond within 10ms.', 'Keep secondary replicas consistent across continents.'],
  ['payment-rail-under-100ms', 'Card authorization over Stripe payment rails must complete within 100ms.', 'Log every authorization code.']
];

test('P1.3 parses rules into structured EARS AST tuples and catches all 33 adversarial contradiction & infeasibility pairs', () => {
  assert.ok(ADVERSARIAL_CONTRADICTION_PAIRS.length >= 30);

  const sampleAst = parseRuleAst({
    id: 'REQ-C01',
    key: 'custom.retain',
    origin: 'profile',
    sourceRule: 'Retain audit logs for at least 7 years.'
  });
  assert.equal(sampleAst.subject, 'audit-log');
  assert.equal(sampleAst.modal, 'shall');
  assert.equal(sampleAst.predicate, 'retain');
  assert.equal(sampleAst.quantity, 7);
  assert.equal(sampleAst.unit, 'years');
  assert.equal(sampleAst.negated, false);

  for (const [name, ruleA, ruleB] of ADVERSARIAL_CONTRADICTION_PAIRS) {
    const result = lintRawRuleList([ruleA, ruleB]);
    assert.equal(
      result.ok,
      false,
      `expected adversarial pair [${name}] to fail rule-lint:\n  A: ${ruleA}\n  B: ${ruleB}\n  got: ${JSON.stringify(result)}`
    );
    assert.ok(result.blockingCount >= 1, `[${name}] produces >= 1 blocking finding`);
  }
});

test('P1.3 detects near-duplicates and strict numeric subsumption as warnings without blocking', () => {
  const dup = lintRawRuleList([
    'Require two-factor authentication for administrator accounts.',
    'Require two-factor authentication on all administrator accounts.'
  ]);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicates.length, 1);
  assert.equal(dup.duplicates[0].kind, 'duplicate');

  const sub = lintRawRuleList([
    'Passwords must be at least 16 characters long.',
    'Passwords must be at least 12 characters long.'
  ]);
  assert.equal(sub.ok, true);
  assert.equal(sub.duplicates.length, 1);
  assert.equal(sub.duplicates[0].kind, 'subsumed');
  assert.equal(sub.duplicates[0].stronger, 'REQ-C01');
  assert.equal(sub.duplicates[0].subsumed, 'REQ-C02');

  // Carve-outs ("except where a legal hold applies") prevent false-positive contradictions!
  const carved = lintRawRuleList([
    'Delete all user personal data immediately on request except financial records under legal hold.',
    'Retain financial records for 7 years.'
  ]);
  assert.equal(carved.ok, true, `carved-out pair must pass: ${JSON.stringify(carved.contradictions)}`);
});

test('P1.3 Adversarial Test D blocks compile until resolved in profile.conflicts, emits specs/rule-lint.json, and renders in --explain', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-rule-lint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const profFile = path.join(dir, 'profile.json');
  const baseProfile = {
    name: 'contradictory-ledger',
    idea: 'An accounting archive API for internal finance analysts categorizing journal entries.',
    kind: 'api',
    stage: 'mvp',
    traits: ['persistence'],
    risks: {
      pii: false,
      payments: false,
      regulated: false,
      multiTenant: false,
      destructiveWrites: true,
      publicFacing: false,
      integrations: true
    },
    rules: [
      { slug: 'delete-now', text: 'Delete all data immediately on user request.' },
      { slug: 'retain-7y', text: 'Retain all data for 7 years.' },
      { slug: 'fast-5ms', text: 'Every API call responds in < 5ms.' },
      { slug: 'ai-every-call', text: 'Every API call logs to an external AI API.' }
    ]
  };
  writeFileSync(profFile, JSON.stringify(baseProfile, null, 2));

  // Strict plan fails naming REQ-Cxx ⟂ REQ-Cyy and infeasible latency!
  const blocked = spawnSync(process.execPath, [CLI, 'plan', profFile], { encoding: 'utf8' });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /REQ-C\d{2} ⟂ REQ-C\d{2}/);
  assert.match(blocked.stderr, /200ms/);

  // Resolve both conflicts explicitly in profile.conflicts and compile -> succeeds + writes specs/rule-lint.json!
  const resolvedProfile = {
    ...baseProfile,
    conflicts: [
      {
        rules: ['delete-now', 'retain-7y'],
        winner: 'retain-7y',
        reason: 'Statutory 7-year ledger retention supersedes immediate erasure; non-ledger PII erased immediately.'
      },
      {
        rules: ['fast-5ms', 'ai-every-call'],
        winner: 'fast-5ms',
        reason: 'External AI audit logging moved off the request path into an async background queue.'
      }
    ]
  };
  writeFileSync(profFile, JSON.stringify(resolvedProfile, null, 2));

  const explain = spawnSync(process.execPath, [CLI, 'plan', profFile, '--explain'], { encoding: 'utf8' });
  assert.equal(explain.status, 0, explain.stderr);
  assert.match(explain.stdout, /rule lint/);
  assert.match(explain.stdout, /resolved -> winner/);

  const outDir = path.join(dir, 'specs');
  const compiled = spawnSync(process.execPath, [CLI, 'compile', profFile, '-o', outDir, '--force'], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const ruleLintDoc = JSON.parse(readFileSync(path.join(outDir, 'rule-lint.json'), 'utf8'));
  assert.equal(ruleLintDoc.ok, true);
  assert.equal(ruleLintDoc.rulesChecked, 4);
  assert.equal(ruleLintDoc.resolvedConflicts.length, 2);
});

test('P1.3 zero false positives across root profile, retro-board, case studies, and stress corpus', () => {
  const profilePaths = [
    path.join(ROOT, 'profile.json'),
    path.join(ROOT, 'examples', 'retro-board', 'profile.json')
  ];
  const csRoot = path.join(ROOT, 'examples', 'case-studies');
  for (const entry of readdirSync(csRoot)) {
    const p = path.join(csRoot, entry, 'profile.json');
    profilePaths.push(p);
  }
  const ideasRoot = path.join(ROOT, 'examples', 'ideas');
  for (const file of readdirSync(ideasRoot)) {
    if (file.endsWith('.json') && file !== 'expected.json') {
      profilePaths.push(path.join(ideasRoot, file));
    }
  }
  for (const file of profilePaths) {
    const { profile, errors } = loadProfile(file);
    if (errors.length > 0) continue;
    const plan = buildPlan(profile, { index: INDEX, profileDir: path.dirname(file) });
    assert.equal(
      plan.ruleLint.ok,
      true,
      `unexpected rule-lint false positive in ${path.relative(ROOT, file)}: ${JSON.stringify([...plan.ruleLint.contradictions, ...plan.ruleLint.infeasible])}`
    );
  }
});
