/**
 * Roadmap Phase 1 (1.1–1.6) end-to-end tests:
 *   1.1 Deterministic risk-hint scanner, riskWaivers, --strict, plan --explain
 *   1.2 Regulation overlays: coppa, ferpa, sox, dora, eu-ai-act (+ existing 4)
 *   1.3 Domain-noun confidence floor (<0.6), qualifier vetoes, glossary disambiguation
 *   1.4 Custom profile.rules -> stable REQ-Cxx, appended criteria, change archive write-back
 *   1.5 Rule extraction v2 (compound splits, thresholds, specific test stubs, eval corpus)
 *   1.6 agent.autonomy-limits primitive, agent.* requirements, G2-AUTONOMY, MCP rank-1
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyChange, archiveChange, emitChange, planChange } from '../lib/change.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { ownRulesFor, ruleTestStub } from '../lib/emit/derive.mjs';
import { vocabularyFor } from '../lib/emit/vocabulary.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { handleMessage } from '../lib/mcp.mjs';
import { enableModules } from '../lib/modules.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { REGULATIONS, normalizeProfile, validateProfile } from '../lib/profile.mjs';
import { scanRiskHints } from '../lib/risk-hints.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'cli.mjs');
const INDEX = buildIndex();

function runCli(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

test('1.1 risk-hint scanner flags unflagged telehealth risks, enforces --strict, honours dated waivers and respects negation', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-risk-hints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const base = {
    name: 'telehealth-intake',
    idea: 'A telehealth intake portal where patients submit clinical notes and therapy sessions across clinics; each clinic has its own isolated workspace.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: {}
  };
  const profilePath = path.join(root, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(base, null, 2));

  const scan = scanRiskHints(normalizeProfile(base));
  const flags = scan.unflaggedRisks.map((h) => h.flag);
  assert.ok(flags.includes('regulated'), `expected regulated in ${flags}`);
  assert.ok(flags.includes('pii'), `expected pii in ${flags}`);
  assert.ok(flags.includes('multiTenant'), `expected multiTenant in ${flags}`);
  assert.ok(scan.suggestedRegimes.some((r) => r.regime === 'hipaa'));

  // Compiler purity: profile.risks is never mutated.
  assert.deepEqual(base.risks, {});

  // --explain surfaces fired, unflagged, waived and suggested regime lines.
  const explain = runCli(['plan', profilePath, '--explain']);
  assert.equal(explain.status, 0, explain.stderr);
  assert.match(explain.stdout, /explain · signal & vocabulary trace:/);
  assert.match(explain.stdout, /risks\.regulated <-/);
  assert.match(explain.stdout, /regulation "hipaa" <-/);

  // --strict rejects unwaived risk signals.
  const strictFail = runCli(['plan', profilePath, '--strict']);
  assert.equal(strictFail.status, 2);
  assert.match(strictFail.stderr, /unflagged risk signal\(s\)/);

  // Dated future waivers satisfy --strict; expired waivers still fail.
  const waivedPath = path.join(root, 'waived.json');
  writeFileSync(
    waivedPath,
    JSON.stringify({
      ...base,
      riskWaivers: flags.map((flag) => ({
        flag,
        reason: 'Synthetic fixture dataset only, no real clinics or people.',
        expires: '2099-12-31'
      }))
    }, null, 2)
  );
  const strictWaived = runCli(['plan', waivedPath, '--strict', '--explain']);
  assert.equal(strictWaived.status, 0, strictWaived.stderr);
  assert.match(strictWaived.stdout, /waived until 2099-12-31/);

  const expiredPath = path.join(root, 'expired.json');
  writeFileSync(
    expiredPath,
    JSON.stringify({
      ...base,
      riskWaivers: flags.map((flag) => ({
        flag,
        reason: 'Old temporary demo exception from early prototype.',
        expires: '2020-01-01'
      }))
    }, null, 2)
  );
  const strictExpired = runCli(['plan', expiredPath, '--strict']);
  assert.equal(strictExpired.status, 2);
  assert.match(strictExpired.stderr, /waiver expired 2020-01-01/);

  // Benign prose with negations emits zero false-positive risk hints.
  const benign = normalizeProfile({
    name: 'local-markdown-linter',
    idea: 'A local CLI that checks heading order in markdown notes. It never stores personal data, accepts no credit cards, and calls no third-party APIs.',
    kind: 'cli',
    stage: 'mvp',
    traits: [],
    risks: {}
  });
  const benignScan = scanRiskHints(benign);
  assert.deepEqual(benignScan.unflaggedRisks, []);
});

test('1.2 all 9 regulation overlays (including coppa, ferpa, sox, dora, eu-ai-act) compile valid packets with enforceable gates', (t) => {
  assert.deepEqual(REGULATIONS, ['hipaa', 'gdpr', 'pci-dss', 'soc2', 'coppa', 'ferpa', 'sox', 'dora', 'eu-ai-act']);

  const expectedByRegime = {
    coppa: ['privacy.parental-consent', 'G3-PARENTAL-CONSENT'],
    ferpa: ['education.legitimate-interest-access', 'G3-FERPA-DISCLOSURE'],
    sox: ['finance.segregation-of-duties', 'G3-SOX-CONTROLS'],
    dora: ['resilience.ict-incident-classification', 'G3-DORA-RESILIENCE'],
    'eu-ai-act': ['ai.eu-human-oversight', 'G3-AI-OVERSIGHT']
  };

  for (const [regime, [reqKey, gateId]] of Object.entries(expectedByRegime)) {
    const root = mkdtempSync(path.join(os.tmpdir(), `vld-reg-${regime}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outDir = path.join(root, 'specs');
    const profile = normalizeProfile({
      name: `app-${regime}`,
      idea: regime === 'coppa'
        ? 'An interactive reading club where children under 13 borrow illustrated storybooks after parental consent.'
        : 'A regulated workflow handling audited submissions across verified organisations with strict approvals.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'persistence'],
      risks: { regulated: true, pii: true, multiTenant: true },
      regulation: [regime]
    });
    assert.deepEqual(validateProfile(profile), []);
    const plan = buildPlan(profile, { index: INDEX });
    assert.equal(plan.rigor.tier, 3);
    assert.ok(plan.requirements.some((r) => r.key === reqKey), `${regime} missing ${reqKey}`);
    assert.ok(plan.gates.some((g) => g.id === gateId), `${regime} missing ${gateId}`);

    emitPacket(plan, outDir);
    const verification = verifyPacket(outDir);
    assert.equal(verification.ok, true, `${regime} packet failed verify: ${verification.errors.join('; ')}`);
  }
});

test('1.3 noun confidence rejects autonomous/clinical qualifiers, enforces --strict at tier>=2, and disambiguates glossary collisions', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-vocab-conf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Autonomous agent idea never names "autonomous" as primary entity.
  const autoVocab = vocabularyFor({
    kind: 'agent',
    idea: 'An autonomous coding agent that inspects failed builds, edits pull requests and opens targeted patches.'
  });
  assert.notEqual(autoVocab.primary, 'autonomous');
  assert.notEqual(autoVocab.primary, 'autonomy');

  // Qualifier-only tier-2 profile has confidence < 0.6, falls back to neutral "record",
  // and fails --strict until profile.domain is added.
  const vagueProfile = {
    name: 'vague-tier2',
    idea: 'A modern automated resilient scalable system designed to be fast, flexible and reliable for internal operators.',
    kind: 'api',
    stage: 'production',
    traits: ['auth', 'persistence'],
    risks: { multiTenant: true, integrations: true },
    constraints: { stack: 'typescript' }
  };
  const vagueVocab = vocabularyFor(vagueProfile);
  assert.equal(vagueVocab.lowConfidence, true);
  assert.ok(vagueVocab.confidence < 0.6, `expected confidence < 0.6, got ${vagueVocab.confidence}`);
  assert.equal(vagueVocab.primary, 'record');

  const vaguePath = path.join(root, 'vague.json');
  writeFileSync(vaguePath, JSON.stringify(vagueProfile, null, 2));
  const strictRefused = runCli(['compile', vaguePath, '-o', path.join(root, 'out1'), '--strict']);
  assert.equal(strictRefused.status, 2);
  assert.match(strictRefused.stderr, /primary domain noun confidence/);

  // Adding explicit profile.domain makes confidence 1.0 and passes --strict.
  const explicitPath = path.join(root, 'explicit.json');
  writeFileSync(explicitPath, JSON.stringify({ ...vagueProfile, domain: { entity: 'workorder', actors: ['operator'] } }, null, 2));
  const strictOk = runCli(['compile', explicitPath, '-o', path.join(root, 'out2'), '--strict']);
  assert.equal(strictOk.status, 0, strictOk.stderr);

  // Glossary collision: therapy `session` vs auth `Session` are explicitly disambiguated.
  const outTherapy = path.join(root, 'therapy-spec');
  const therapyProfile = normalizeProfile({
    name: 'therapy-notes',
    idea: 'A portal where clinicians schedule a session, write notes after each session, and lock completed sessions.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true }
  });
  emitPacket(buildPlan(therapyProfile, { index: INDEX }), outTherapy);
  const domainMd = readFileSync(path.join(outTherapy, '02-domain-model.md'), 'utf8');
  assert.match(domainMd, /\*\*session \(domain\)\*\*/);
  assert.match(domainMd, /\*\*Session \(system\)\*\*/);
  assert.doesNotMatch(domainMd, /\|\s*\*\*Session\*\*\s*\|/);
});

test('1.4 custom profile.rules emit stable REQ-Cxx requirements, verify via spec-check, and survive change archive --to-profile-rules', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-custom-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const profileData = {
    name: 'payout-service',
    idea: 'A settlement service managing merchant payouts. Refunds over $500 require dual approval before disbursement.',
    kind: 'api',
    stage: 'production',
    traits: ['auth', 'payments', 'persistence'],
    risks: { payments: true, pii: true },
    constraints: { stack: 'typescript' },
    rules: [
      'Refunds over $500 require dual approval before disbursement.',
      {
        slug: 'daily-payout-limit',
        title: 'Daily seller payout limit',
        text: 'A seller cannot receive more than one settled payout per UTC calendar day.',
        area: 'data',
        acceptance: [
          'Given a seller who already received a payout today, when a second payout is requested for the same UTC day, then the service rejects it.'
        ]
      },
      {
        text: 'Every currency conversion rounds half-even in minor units.',
        covers: 'payments.correctness',
        appendCriterion: true
      }
    ]
  };

  const outDir = path.join(root, 'specs');
  const plan1 = buildPlan(normalizeProfile(profileData), { index: INDEX });
  plan1.profileLabel = 'profile.json';
  emitPacket(plan1, outDir);
  const spec1 = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
  const custom1 = spec1.requirements.filter((r) => r.origin === 'profile');
  assert.equal(custom1.length, 2);
  assert.ok(custom1.every((r) => /^REQ-C\d{2,}$/.test(r.id)));
  const idByKey1 = Object.fromEntries(custom1.map((r) => [r.key, r.id]));

  // Appended criterion landed on payments.correctness.
  const payReq = spec1.requirements.find((r) => r.key === 'payments.correctness');
  assert.ok(payReq.acceptance.some((ac) => /currency conversion/i.test(ac.text)));

  // Reordering profile.rules preserves every REQ-Cxx ID on recompile!
  const reordered = { ...profileData, rules: [...profileData.rules].reverse() };
  const prevIds = Object.fromEntries(spec1.requirements.map((r) => [r.key, r.id]));
  const plan2 = buildPlan(normalizeProfile(reordered), { index: INDEX, previousIds: prevIds });
  const custom2 = plan2.requirements.filter((r) => r.origin === 'profile');
  const idByKey2 = Object.fromEntries(custom2.map((r) => [r.key, r.id]));
  assert.deepEqual(idByKey2, idByKey1);

  // spec-check.mjs validates and recognises custom REQ-Cxx test anchors.
  const firstCustom = custom1[0];
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'rules.ts'), 'export const checkLimit = (n: number) => n <= 1;\n');
  const reqTag = ['@', 'req'].join('');
  writeFileSync(
    path.join(root, 'tests', 'custom.test.ts'),
    `import assert from 'node:assert/strict';\nimport { checkLimit } from '../src/rules.ts';\ntest('custom rule', () => { // ${reqTag} ${firstCustom.id}\n  assert.equal(checkLimit(1), true);\n});\n`
  );
  const verified = verifyPacket(outDir, { repo: root, requireAssertions: true });
  assert.equal(verified.ok, true, verified.errors.join('; '));
  assert.ok(verified.passes.some((msg) => /1 automated requirement\(s\) proven by test anchors/.test(msg)), JSON.stringify(verified.passes));

  // Archive a `vld change` delta back into profile.rules and recompile --force.
  const profileFile = path.join(root, 'profile.json');
  writeFileSync(profileFile, `${JSON.stringify(profileData, null, 2)}\n`);
    const changeDef = {
    id: 'chargeback-freeze',
    title: 'Freeze seller payouts on open chargeback',
    why: 'High chargeback disputes must hold outbound settlement until resolved by billing operations.',
    risk: 'low',
    add: [
      {
        key: 'custom.chargeback-freeze',
        title: 'Open chargebacks freeze outbound payouts',
        area: 'security',
        statement: 'When a seller account has an unresolved chargeback, the application shall hold outbound payouts until an operator clears the dispute.',
        failurePath: 'If dispute status cannot be loaded, outbound payout defaults to held rather than disbursing.',
        acceptance: [
          'Given a seller with an open chargeback, when payout batching runs, then that seller payout is placed on hold.'
        ],
        verify: 'automated'
      }
    ],
    modify: [],
    remove: []
  };
  const changeDir = path.join(root, 'changes', 'chargeback-freeze');
  const planned = planChange({ packetDir: outDir, change: changeDef, projectDir: root });
  assert.deepEqual(planned.errors, []);
  emitChange(planned, changeDir, { force: true });
  applyChange(planned, outDir, { force: true });
  const addedId = planned.added[0].id;
  enableModules({ projectDir: root, ids: 'review' });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(
    path.join(root, 'docs', 'review-brief.md'),
    `# Review Brief: payout-service\n\n**Status:** Approved\n\n## Change Summary\n\nThe proposed requirement delta and resulting packet were reviewed before archival.\n\n## Requirements Under Review\n\n- ${addedId} — Open chargebacks freeze outbound payouts until cleared.\n\n## Risk and Invariants\n\nThe review protects the stated acceptance criteria and the documented rollback boundary.\n\n## Evidence\n\nThe generated packet and linked tests were reviewed against the change proposal.\n\n## Review Questions\n\nDo the linked requirements retain executable evidence after the proposed delta?\n\n## Decision\n\nApproved by the accountable reviewer with the stated rollback condition.\n`
  );
  const evidence = JSON.parse(readFileSync(path.join(changeDir, 'evidence.json'), 'utf8'));
  evidence.artifacts = [{ kind: 'review-brief', file: 'docs/review-brief.md', requirements: [addedId] }];
  writeFileSync(path.join(changeDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(
    path.join(changeDir, 'evidence.md'),
    readFileSync(path.join(changeDir, 'evidence.md'), 'utf8').replace('**Status:** Pending', '**Status:** Approved')
  );

  await archiveChange({ packetDir: outDir, changeDir, profilePath: profileFile, toProfileRules: true });
  const updatedProfile = JSON.parse(readFileSync(profileFile, 'utf8'));
  assert.ok(updatedProfile.rules.some((r) => typeof r === 'object' && r.slug === 'chargeback-freeze'));

  // Fresh recompile preserves custom.chargeback-freeze directly from profile.rules!
  const freshDir = path.join(root, 'specs-fresh');
  const recompileRun = runCli(['compile', profileFile, '-o', freshDir, '--force']);
  assert.equal(recompileRun.status, 0, recompileRun.stderr);
  const freshSpec = JSON.parse(readFileSync(path.join(freshDir, 'spec.json'), 'utf8'));
  assert.ok(freshSpec.requirements.some((r) => r.key === 'custom.chargeback-freeze' && r.origin === 'profile'));
});

test('1.5 rule extraction v2 splits compound clauses and generates rule-specific test stubs', () => {
  const rules = ownRulesFor({
    idea:
      'A marketplace where local makers list handmade ceramics. ' +
      'Cancelled orders must release reserved stock within 5 minutes; shipped orders cannot be edited. ' +
      'All payout rows must remain immutable, while operators may only refund after dual approval.'
  });
  assert.equal(rules.length, 4, `expected 4 split rules, got: ${JSON.stringify(rules)}`);
  assert.match(ruleTestStub(rules[0]), /boundary test around "within 5 minutes"/);
  assert.match(ruleTestStub(rules[1]), /negative test/);
  assert.match(ruleTestStub(rules[2]), /immutability test/);
});

test('1.6 agent.autonomy-limits selects agent.* requirements, gates tier>=2 agents with G2-AUTONOMY, and ranks #1 in MCP search', () => {
  const agentProfile = normalizeProfile({
    name: 'pr-remediation-agent',
    idea: 'An incident-response agent that reads failing CI alerts, proposes pull-request fixes and runs repository checks.',
    kind: 'agent',
    stage: 'production',
    traits: ['ai', 'webhooks', 'persistence'],
    risks: { destructiveWrites: true, integrations: true, multiTenant: true }
  });
  const plan = buildPlan(agentProfile, { index: INDEX });
  assert.ok(plan.rigor.tier >= 2);
  assert.ok(plan.primitives.some((p) => p.id === 'agent.autonomy-limits'));
  for (const key of ['agent.action-boundaries', 'agent.approval-gate', 'agent.budget-and-killswitch']) {
    assert.ok(plan.requirements.some((r) => r.key === key), `missing ${key}`);
  }
  assert.ok(plan.gates.some((g) => g.id === 'G2-AUTONOMY'), 'tier>=2 agent should carry G2-AUTONOMY');

  // Ordinary tier-2 non-agent web app does NOT inherit G2-AUTONOMY.
  const webPlan = buildPlan(
    normalizeProfile({
      name: 'team-wiki',
      idea: 'A collaborative wiki where engineering teams write and search internal design documents.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'search', 'persistence'],
      risks: { pii: true, multiTenant: true }
    }),
    { index: INDEX }
  );
  assert.equal(webPlan.rigor.tier, 2);
  assert.equal(webPlan.gates.some((g) => g.id === 'G2-AUTONOMY'), false);

  // MCP search_primitives ranks agent.autonomy-limits first for autonomous-agent safety queries.
  const res = handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'search_primitives', arguments: { query: 'autonomous agent tool allowlist kill switch human confirmation' } }
  });
  const parsed = JSON.parse(res.result.content[0].text);
  const topHit = (parsed.matches ?? parsed.results)[0];
  assert.equal(topHit.id, 'agent.autonomy-limits');
});
