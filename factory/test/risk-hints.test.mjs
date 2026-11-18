/**
 * Roadmap P1.1 & P1.2 regression suite:
 *   - 84-idea labelled corpus (`examples/risk-corpus.json`) meets recall >= 0.90
 *     and precision >= 0.80 across all 7 risk flags and all 10 regimes (incl. CCPA)
 *   - Every match across multiple sentences is grouped by flag with sentence + cue
 *   - Negation windows ("never stores personal data", "no credit cards") and dated
 *     waivers (valid vs expired) behave deterministically without mutating profiles
 *   - Adversarial Test B (kids 8-12 clubs + chat + Stripe pocket money + parent email)
 *     and Adversarial Test E (EU therapy clinics + Twilio + Stripe + per-clinic DB + portal)
 *   - `vld plan` and `vld compile` are strict by default in v0.21.0; `--advisory`
 *     downgrades to warnings with an unmistakable advisory banner
 *   - `vld migrate` generates expiring `riskWaivers` stubs for legacy profiles
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateRiskScanner } from '../../scripts/eval-risk-scanner.mjs';
import { migrateProject } from '../lib/migrate.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile, REGULATIONS, RISK_FLAGS } from '../lib/profile.mjs';
import { scanAllIdeaCues, scanRiskHints } from '../lib/risk-hints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const INDEX = buildIndex();

test('P1.1 labelled risk-corpus (>= 80 ideas) achieves recall >= 0.90 and precision >= 0.80 on every flag and regime', () => {
  const report = evaluateRiskScanner();
  assert.ok(report.corpusSize >= 80, `expected >= 80 ideas, got ${report.corpusSize}`);
  assert.equal(report.ok, true, `scanner failed thresholds:\n${report.failures.join('\n')}`);
  for (const flag of RISK_FLAGS) {
    assert.ok(report.perFlag[flag].recall >= 0.9, `${flag} recall ${report.perFlag[flag].recall} < 0.90`);
    assert.ok(report.perFlag[flag].precision >= 0.8, `${flag} precision ${report.perFlag[flag].precision} < 0.80`);
  }
  for (const regime of ['coppa', 'gdpr', 'hipaa', 'pci-dss', 'ccpa', 'ferpa', 'soc2', 'sox', 'dora', 'eu-ai-act']) {
    assert.ok(REGULATIONS.includes(regime), `REGULATIONS includes ${regime}`);
    assert.ok(report.perRegime[regime].recall >= 0.9, `${regime} recall < 0.90`);
    assert.ok(report.perRegime[regime].precision >= 0.8, `${regime} precision < 0.80`);
  }
});

test('P1.1 CCPA overlay compiles valid requirements and gates', () => {
  const profile = normalizeProfile({
    name: 'ca-storefront',
    idea: 'A consumer storefront for California consumers honouring CCPA Do Not Sell or Share and Sec-GPC signals.',
    kind: 'web-app',
    stage: 'production',
    users: { scale: 'medium' },
    traits: ['auth', 'persistence'],
    risks: {
      pii: true,
      payments: false,
      regulated: true,
      multiTenant: false,
      destructiveWrites: false,
      publicFacing: true,
      integrations: false
    },
    regulation: ['ccpa']
  });
  const plan = buildPlan(profile, { index: INDEX });
  assert.equal(plan.rigor.tier, 3);
  assert.ok(plan.requirements.some((r) => r.key === 'data.ccpa-opt-out-gpc'));
  assert.ok(plan.requirements.some((r) => r.key === 'data.ccpa-know-and-delete'));
  assert.ok(plan.gates.some((g) => g.id === 'G3-SUBJECT-RIGHTS'));
});

test('P1.1 scanner returns all matches grouped by flag with sentence + cue, respects negations and dated waivers', () => {
  const raw = scanAllIdeaCues(
    'Checkout accepts credit cards via Stripe. Back-office settles invoices and issues refunds via Braintree. It never stores personal data and drops no tables.'
  );
  const pay = raw.risks.find((r) => r.flag === 'payments');
  assert.ok(pay, 'payments detected');
  assert.ok(pay.matches.length >= 3, `expected >= 3 grouped matches for payments, got ${pay.matches.length}`);
  assert.ok(pay.cues.includes('psp-and-cards'));
  assert.ok(pay.cues.includes('money-movement-and-billing'));
  for (const m of pay.matches) {
    assert.ok(m.cue && m.phrase && m.sentence);
  }
  assert.equal(raw.risks.some((r) => r.flag === 'pii'), false, 'negated PII must not fire');
  assert.equal(raw.risks.some((r) => r.flag === 'destructiveWrites'), false, 'negated table drops must not fire');

  // Dated waiver valid on 2026-11-16, expired on 2027-06-01.
  const profile = normalizeProfile({
    name: 'waiver-demo',
    idea: 'Sandbox billing simulator that generates mock payouts for local QA engineers.',
    kind: 'cli',
    stage: 'mvp',
    risks: { payments: false },
    riskWaivers: [{ flag: 'payments', reason: 'Synthetic sandbox fixtures only; zero real funds moved.', expires: '2027-01-15' }]
  });
  const active = scanRiskHints(profile, { referenceDate: '2026-11-16' });
  assert.equal(active.unflaggedRisks.length, 0);
  assert.equal(active.waivedRisks.length, 1);

  const expired = scanRiskHints(profile, { referenceDate: '2027-06-01' });
  assert.equal(expired.unflaggedRisks.length, 1);
  assert.equal(expired.expiredWaivers.length, 1);
  assert.equal(expired.unflaggedRisks[0].expiredWaiver, '2027-01-15');
  assert.equal(profile.risks.payments, false, 'scanner never mutates profile.risks');
});

test('P1.1 & P1.2 Adversarial Test B (kids 8-12 club + Stripe) and Test E (EU therapy clinics) are blocked by default; --advisory prints banner', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-risk-adv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Adversarial Test B: user declares all risks: {} on a kids 8-12 club + chat + Stripe app!
  const testBFile = path.join(dir, 'test-b.json');
  writeFileSync(
    testBFile,
    JSON.stringify({
      name: 'kids-clubhouse',
      idea: 'Kids aged 8-12 build clubs, chat with friends, and send pocket-money gifts via Stripe. Parents approve with email.',
      kind: 'web-app',
      stage: 'mvp',
      risks: {}
    }, null, 2)
  );

  // Default `vld plan` (no --strict needed!) MUST refuse with exit code 2 and list every unflagged risk.
  const planB = spawnSync(process.execPath, [CLI, 'plan', testBFile], { encoding: 'utf8' });
  assert.equal(planB.status, 2, `Test B must fail by default:\n${planB.stdout}\n${planB.stderr}`);
  for (const flag of ['risks.regulated', 'risks.pii', 'risks.payments', 'risks.publicFacing', 'risks.integrations']) {
    assert.ok(planB.stderr.includes(flag), `Test B names missing ${flag}`);
  }

  // Default `vld compile` also refuses without `--advisory`.
  const compileB = spawnSync(process.execPath, [CLI, 'compile', testBFile, '-o', path.join(dir, 'out-b')], { encoding: 'utf8' });
  assert.equal(compileB.status, 2);

  // `--advisory` opts out with an explicit, unmistakable banner and suggests COPPA.
  const advisoryB = spawnSync(process.execPath, [CLI, 'plan', testBFile, '--advisory', '--explain'], { encoding: 'utf8' });
  assert.equal(advisoryB.status, 0, advisoryB.stderr);
  assert.match(advisoryB.stderr, /ADVISORY MODE \(--advisory\)/);
  assert.match(advisoryB.stdout, /coppa/i);

  // Adversarial Test E: EU therapy clinics SaaS.
  const testEScan = scanAllIdeaCues(
    'SaaS for EU clinics scheduling therapy appointments, SMS reminders via Twilio, Stripe billing, separate database per clinic, patient portal.'
  );
  const flaggedE = new Set(testEScan.risks.map((r) => r.flag));
  for (const flag of ['regulated', 'pii', 'payments', 'multiTenant', 'publicFacing', 'integrations']) {
    assert.ok(flaggedE.has(flag), `Test E flags ${flag}`);
  }
  const regimesE = new Set(testEScan.regimes.map((r) => r.regime));
  assert.ok(regimesE.has('gdpr'), 'Test E detects GDPR');
  assert.ok(regimesE.has('hipaa'), 'Test E detects HIPAA/clinical');
});

test('P1.2 vld migrate auto-generates expiring riskWaivers stubs so legacy profiles pass strict plan', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-migrate-waiver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const profPath = path.join(dir, 'profile.json');
  writeFileSync(
    profPath,
    JSON.stringify({
      name: 'legacy-billing-helper',
      idea: 'Internal ledger assistant that reconciles subscription billing and sends alerts via Slack API.',
      kind: 'api',
      stage: 'mvp',
      traits: ['persistence'],
      risks: {}
    }, null, 2)
  );

  // Before migrate: fails default strict plan.
  assert.equal(spawnSync(process.execPath, [CLI, 'plan', profPath], { encoding: 'utf8' }).status, 2);

  // Run migrate: generates 90-day expiring waiver stubs + backup.
  const mig = migrateProject({ projectDir: dir, referenceDate: '2026-11-16', waiverDays: 90, recordEvidence: false });
  assert.equal(mig.ok, true);
  const migrated = JSON.parse(readFileSync(profPath, 'utf8'));
  assert.equal(migrated.riskWaivers.length, 2);
  assert.ok(migrated.riskWaivers.every((w) => w.expires === '2027-02-14' && /MIGRATION STUB/.test(w.reason)));

  // After migrate: passes default strict plan cleanly!
  const after = spawnSync(process.execPath, [CLI, 'plan', profPath], { encoding: 'utf8' });
  assert.equal(after.status, 0, after.stderr);
});
