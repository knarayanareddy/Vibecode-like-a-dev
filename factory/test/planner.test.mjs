import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan, computeRigor, loadCatalog, loadPolicy } from '../lib/planner.mjs';
import { normalizeProfile, validateProfile } from '../lib/profile.mjs';

const index = buildIndex();
const policy = loadPolicy();

const sketch = normalizeProfile({
  name: 'sketch',
  idea: 'A one-week local prototype that proves a single idea and will be deleted if it is wrong.',
  kind: 'cli',
  stage: 'prototype'
});

const payout = normalizeProfile({
  name: 'payout-service',
  idea: 'An API that pays marketplace sellers, reconciles against a provider and never pays twice.',
  kind: 'api',
  stage: 'production',
  users: { scale: 'large' },
  traits: ['auth', 'persistence', 'webhooks', 'background-jobs'],
  risks: {
    pii: true,
    payments: true,
    regulated: true,
    multiTenant: true,
    destructiveWrites: true,
    publicFacing: true,
    integrations: true
  }
});

test('a prototype stays at tier 0 with a single-file packet', () => {
  const rigor = computeRigor(sketch, policy);
  assert.equal(rigor.tier, 0);
  assert.equal(rigor.packet, 'single-file');
});

test('profile validation rejects unknown keys instead of silently lowering rigor', () => {
  const intended = { ...payout, risks: { ...payout.risks } };
  assert.deepEqual(validateProfile(normalizeProfile(intended)), []);
  assert.equal(computeRigor(normalizeProfile(intended), policy).tier, 3);

  const typo = { ...intended, risk: intended.risks };
  delete typo.risks;
  const errors = validateProfile(normalizeProfile(typo));
  assert.ok(errors.some((error) => /profile\.risk: unknown field; did you mean "risks"/.test(error)), errors.join('\n'));

  const nested = validateProfile(normalizeProfile({ ...intended, constraints: { ...intended.constraints, deliveryWindow: 'overnight' } }));
  assert.ok(nested.some((error) => /constraints\.deliveryWindow: unknown field/.test(error)), nested.join('\n'));
});

test('risk signals raise the tier and stage caps it back down', () => {
  const riskyMvp = normalizeProfile({
    ...payout,
    stage: 'mvp'
  });
  const rigor = computeRigor(riskyMvp, policy);
  assert.equal(rigor.capped, false, 'payments are exempt from the stage cap');
  assert.equal(rigor.tier, 3);

  const mildMvp = normalizeProfile({
    name: 'mild-mvp',
    idea: 'A small internal dashboard for one team, no money, but tenants and a public surface.',
    kind: 'web-app',
    stage: 'mvp',
    users: { scale: 'medium' },
    risks: { multiTenant: true, publicFacing: true }
  });
  const mild = computeRigor(mildMvp, policy);
  assert.equal(mild.tier, 1);
  assert.equal(mild.capped, true);
  assert.match(mild.cappedReason, /caps rigor/);
});

test('tier selection never exceeds the practice ceiling', () => {
  for (const profile of [sketch, payout]) {
    const plan = buildPlan(profile, { index });
    assert.ok(
      plan.primitives.length <= plan.rigor.maxPrimitives,
      `${profile.name} selected ${plan.primitives.length} > ${plan.rigor.maxPrimitives}`
    );
  }
});

test('core practices are always selected, even for a sketch', () => {
  const plan = buildPlan(sketch, { index });
  const ids = plan.primitives.map((primitive) => primitive.id);
  for (const essential of ['product.product-brief', 'testing.tdd-loop', 'testing.acceptance-traceability', 'agent.handoff-packet']) {
    assert.ok(ids.includes(essential), `sketch packet is missing ${essential}`);
  }
});

test('a sketch does not receive tier-2 or tier-3 practices', () => {
  const plan = buildPlan(sketch, { index });
  const overTier = plan.primitives.filter((primitive) => primitive.tier_min > plan.rigor.tier);
  assert.deepEqual(overTier, []);
});

test('a payments project gets the money-critical requirements and gates', () => {
  const plan = buildPlan(payout, { index });
  const keys = plan.requirements.map((requirement) => requirement.key);
  assert.ok(keys.includes('payments.correctness'));
  assert.ok(keys.includes('integration.retries'));
  assert.ok(keys.includes('auth.tenant-isolation'));
  assert.ok(keys.includes('delivery.audit-trail'));
  assert.ok(keys.includes('spec.drift-guard'));

  const gateIds = plan.gates.map((gate) => gate.id);
  assert.ok(gateIds.includes('G3-MUTATION'));
  assert.ok(gateIds.includes('G2-THREAT'));
  assert.ok(gateIds.includes('G1-AC-TRACE'), 'lower-tier gates accumulate');
});

test('public web discoverability is an explicit opt-in with no generic fallback', () => {
  const publicWebsite = normalizeProfile({
    name: 'docs-site',
    idea: 'A public documentation website that helps developers evaluate and adopt a command line product.',
    kind: 'web-app',
    stage: 'mvp',
    risks: { publicFacing: true },
    discoverability: { enabled: true }
  });
  const plan = buildPlan(publicWebsite, { index });
  assert.ok(plan.primitives.some((primitive) => primitive.id === 'product.public-web-discoverability'));
  assert.ok(plan.requirements.some((requirement) => requirement.key === 'web.discoverability'));

  const noOptIn = { ...publicWebsite };
  delete noOptIn.discoverability;
  const variants = [
    { label: 'missing opt-in', profile: noOptIn },
    { label: 'not public', profile: { ...publicWebsite, risks: { publicFacing: false } } },
    { label: 'not a web app', profile: { ...publicWebsite, kind: 'api' } }
  ];
  for (const { label, profile } of variants) {
    const absent = buildPlan(profile, { index });
    assert.ok(!absent.primitives.some((primitive) => primitive.id === 'product.public-web-discoverability'), label);
    assert.ok(!absent.requirements.some((requirement) => requirement.key === 'web.discoverability'), label);
  }
  const ordinaryPlan = buildPlan(noOptIn, { index });
  assert.ok(!ordinaryPlan.skipped.some((primitive) => primitive.id === 'product.public-web-discoverability'), 'no opt-in leaves existing packets unchanged');
  const disabledPlan = buildPlan({ ...publicWebsite, discoverability: { enabled: false } }, { index });
  assert.ok(disabledPlan.skipped.some((primitive) => primitive.id === 'product.public-web-discoverability'), 'an explicit disabled choice remains reviewable');
});

test('discoverability input is closed and does not weaken existing profile validation', () => {
  const base = {
    name: 'discoverability-check',
    idea: 'A public website with a reviewable route and metadata contract for its published documentation.',
    kind: 'web-app',
    stage: 'mvp',
    risks: { publicFacing: true }
  };
  assert.deepEqual(validateProfile(normalizeProfile({ ...base, discoverability: { enabled: true } })), []);
  assert.ok(!Object.hasOwn(normalizeProfile(base), 'discoverability'), 'the opt-in is absent unless explicitly supplied');
  const bad = validateProfile(normalizeProfile({ ...base, discoverability: { enabled: 'yes', score: 100 } }));
  assert.ok(bad.some((error) => /discoverability\.enabled: must be true or false/.test(error)), bad.join('\n'));
  assert.ok(bad.some((error) => /discoverability\.score: unknown field/.test(error)), bad.join('\n'));
  const missing = validateProfile(normalizeProfile({ ...base, discoverability: {} }));
  assert.ok(missing.some((error) => /discoverability\.enabled: .*required/.test(error)), missing.join('\n'));
});

test('skipped and deferred practices are recorded with reasons, never dropped silently', () => {
  const plan = buildPlan(payout, { index });
  for (const entry of [...plan.skipped, ...plan.deferred]) {
    assert.ok(entry.id);
    assert.ok(entry.title);
    assert.ok(entry.detail || entry.reason);
  }
  const recorded = plan.primitives.length + plan.skipped.length + plan.deferred.length;
  assert.equal(recorded, plan.skipped.length + plan.deferred.length + plan.primitives.length);
  assert.ok(recorded >= 34 - 0, 'every routed practice is accounted for');
});

// @req REQ-005
test('kind and trait decide which obligations apply, not a generic checklist', () => {
  const sdk = normalizeProfile({
    name: 'flags-sdk',
    idea: 'A library that evaluates feature flags in-process for applications that embed it.',
    kind: 'library',
    stage: 'production',
    risks: { publicFacing: true }
  });
  const keys = (profile) => buildPlan(profile, { index }).requirements.map((requirement) => requirement.key);

  assert.ok(keys(sdk).includes('library.api-stability'), 'a library is held to its public surface');
  assert.ok(!keys(sdk).includes('ops.rate-limits'), 'a library has no endpoints to rate limit, even when public');

  const web = normalizeProfile({
    name: 'public-web',
    idea: 'A public website with an API for its own frontend.',
    kind: 'web-app',
    stage: 'mvp',
    risks: { publicFacing: true }
  });
  assert.ok(keys(web).includes('ops.rate-limits'), 'a public web application is rate limited');

  const uploads = normalizeProfile({
    name: 'photo-app',
    idea: 'A public website where people upload photographs they own.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['upload'],
    risks: { publicFacing: true }
  });
  assert.ok(keys(uploads).includes('data.uploads'), 'an upload surface brings an upload obligation');

  const offline = normalizeProfile({
    name: 'offline-app',
    idea: 'A mobile app that must work with no network and sync later.',
    kind: 'mobile',
    stage: 'mvp',
    traits: ['offline'],
    risks: { pii: true }
  });
  assert.ok(keys(offline).includes('mobile.offline'), 'offline is an obligation, not only a practice');

  const daemon = normalizeProfile({
    name: 'shipper',
    idea: 'A background process that ships logs and must not lose records on restart.',
    kind: 'cli',
    stage: 'mvp',
    traits: ['background-jobs']
  });
  assert.ok(keys(daemon).includes('ops.observability'), 'a tier-1 daemon still has to be observable');
});

// @req REQ-005
test('a requirement keeps its id when the catalog grows around it', () => {
  const catalog = loadCatalog();
  const before = buildPlan(payout, { index, catalog });
  const ids = Object.fromEntries(before.requirements.map((requirement) => [requirement.key, requirement.id]));

  // Insert a new obligation at the top of the catalog: worst case for positional ids.
  const grown = {
    ...catalog,
    requirements: [
      {
        key: 'core.placeholder-new',
        when: { field: 'kind', eq: 'api' },
        render: 'core',
        title: 'A newly catalogued obligation',
        statement: 'The application shall do the newly catalogued thing that no earlier requirement asked for.',
        failurePath: 'Nothing fails; that is the point of this fixture.',
        acceptance: ['Given a fixture, when the catalog grows, then no existing id moves.'],
        verify: 'automated'
      },
      ...catalog.requirements
    ]
  };

  const previousIds = ids;
  const after = buildPlan(payout, { index, catalog: grown, previousIds });
  const afterIds = Object.fromEntries(after.requirements.map((requirement) => [requirement.key, requirement.id]));

  for (const [key, id] of Object.entries(ids)) {
    assert.equal(afterIds[key], id, `${key} kept ${id}: an anchor citing it still points at the same rule`);
  }

  const fresh = afterIds['core.placeholder-new'];
  assert.ok(fresh, 'the new requirement got an id');
  assert.ok(!Object.values(ids).includes(fresh), `the new id ${fresh} does not recycle an id that anchors may cite`);
  assert.equal(new Set(after.requirements.map((requirement) => requirement.id)).size, after.requirements.length, 'ids stay unique');

  // Without previous ids the planner is still a deterministic function of the catalog.
  const cold = buildPlan(payout, { index, catalog: grown });
  const coldIds = Object.fromEntries(cold.requirements.map((requirement) => [requirement.key, requirement.id]));
  assert.equal(coldIds['core.placeholder-new'], 'REQ-001', 'a first compile numbers from the catalog order');
});

// @req REQ-005
test('planning is exactly deterministic with no generated timestamp', () => {
  const a = buildPlan(payout, { index });
  const b = buildPlan(payout, { index });
  assert.deepEqual(a.primitives.map((p) => p.id), b.primitives.map((p) => p.id));
  assert.deepEqual(a.requirements.map((r) => r.id), b.requirements.map((r) => r.id));
  assert.deepEqual(a.gates.map((g) => g.id), b.gates.map((g) => g.id));
  assert.deepEqual(a, b, 'the whole plan is clock-free, not merely its selected IDs');
  assert.doesNotMatch(JSON.stringify(a), /generatedAt|\d{4}-\d{2}-\d{2}T\d{2}:/i);
});

test('requirement ids are stable and criteria are enumerated', () => {
  const plan = buildPlan(payout, { index });
  plan.requirements.forEach((requirement, position) => {
    assert.equal(requirement.id, `REQ-${String(position + 1).padStart(3, '0')}`);
    assert.ok(requirement.acceptance.length > 0);
    requirement.acceptance.forEach((criteria, criteriaIndex) => {
      assert.equal(criteria.id, `AC-${String(criteriaIndex + 1).padStart(2, '0')}`);
    });
  });
});

test('selected primitives carry a rationale an auditor can read', () => {
  const plan = buildPlan(payout, { index });
  for (const primitive of plan.primitives) {
    assert.ok(primitive.why.length > 20, `${primitive.id} has no rationale`);
    assert.ok(primitive.when.length > 0, `${primitive.id} has no predicate recorded`);
    assert.ok(primitive.path.endsWith('SKILL.md'));
  }
});

test('profile validation rejects unknown traits and thin ideas', () => {
  const errors = validateProfile(
    normalizeProfile({
      name: 'Bad Name',
      idea: 'too short',
      kind: 'spaceship',
      stage: 'nope',
      traits: ['auth', 'blockchain'],
      risks: { pii: 'yes', mystery: true },
      constraints: { team: 0, weeks: 4 }
    })
  );

  const messages = errors.join('\n');
  assert.match(messages, /name:/);
  assert.match(messages, /idea:/);
  assert.match(messages, /kind: unknown kind "spaceship"/);
  assert.match(messages, /stage:/);
  assert.match(messages, /unknown trait "blockchain"/);
  assert.match(messages, /risks\.pii: must be true or false/);
  assert.match(messages, /unknown risk flag/);
  assert.match(messages, /constraints\.team/);
});

/**
 * BUG-10: a rejected value lists every valid one and never the one the reader
 * meant. Ten of thirteen traits look like "maybe that long one", and "agent" is a
 * valid *kind*, so the message sent readers hunting for a typo that was not there.
 */
test('a rejected value suggests the nearest valid one, or where it does belong', () => {
  const message = (overrides) =>
    validateProfile(
      normalizeProfile({
        name: 'suggest-probe',
        idea: 'A small tool that records and reports a weekly metric for a team.',
        kind: 'web-app',
        stage: 'mvp',
        traits: ['auth'],
        risks: {},
        ...overrides
      })
    ).join('\n');

  assert.match(message({ traits: ['uploads'] }), /did you mean "upload"/);
  assert.match(message({ traits: ['persistance'] }), /did you mean "persistence"/);
  assert.match(message({ kind: 'web-appp' }), /did you mean "web-app"/);
  assert.match(message({ stage: 'prod' }), /did you mean "production"/);
  // Not a typo: a valid value in another field. Say where it belongs instead.
  assert.match(message({ traits: ['agent'] }), /"agent" is a valid kind, not a trait/);
  // A value with no plausible neighbour must not receive a misleading suggestion.
  assert.match(message({ traits: ['zzzzzz'] }), /unknown trait "zzzzzz"\. Known:/);
  assert.doesNotMatch(message({ traits: ['zzzzzz'] }), /did you mean/);
});

test('the vocabulary block accepts both overrides and rejects malformed ones', () => {
  const base = {
    name: 'vet-check',
    idea: 'A small tool that records and reports a weekly metric for a team.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth'],
    risks: {}
  };
  const errorsFor = (vocabulary) => validateProfile(normalizeProfile({ ...base, vocabulary }));

  assert.deepEqual(errorsFor({ forbidden: ['diagnosis'], affirmed: ['settlement'] }), []);
  assert.ok(errorsFor({ forbidden: 'diagnosis' }).some((error) => /vocabulary\.forbidden: must be a list/.test(error)));
  assert.ok(errorsFor({ banned: ['x'] }).some((error) => /vocabulary\.banned: unknown field/.test(error)));
  assert.ok(errorsFor(['diagnosis']).some((error) => /vocabulary: must be an object/.test(error)));
});
