/**
 * BLK-1: a declared trait must produce an obligation.
 *
 * Four of thirteen traits — realtime, search, notifications, i18n — had no catalog
 * template at all, so declaring them raised the tier and added nothing to build. A
 * profile could also set `risks.regulated: true` and receive a tier-3 packet with
 * zero HIPAA, PHI or encryption requirements, because "regulated" was a weight
 * rather than a regime.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile, REGULATIONS, TRAITS, validateProfile } from '../lib/profile.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const index = buildIndex();

function compile(overrides = {}) {
  const profile = normalizeProfile({
    name: 'coverage',
    idea: 'A multi-tenant telehealth platform for small clinics where an admin books an appointment for a patient and a clinician writes the visit note.',
    kind: 'web-app',
    stage: 'production',
    users: { scale: 'medium' },
    traits: [],
    risks: {},
    ...overrides
  });
  const plan = buildPlan(profile, { index });
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-trait-'));
  const result = emitPacket(plan, path.join(root, 'spec'));
  return { plan, root, outDir: result.outDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('every trait in the vocabulary has at least one catalog template', () => {
  const catalog = JSON.parse(readFileSync(new URL('../catalog/requirements.json', import.meta.url), 'utf8'));
  const covered = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.field === 'traits' && typeof node.includes === 'string') covered.add(node.includes);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  for (const requirement of catalog.requirements) {
    for (const trait of requirement.traits ?? []) covered.add(trait);
    walk(requirement.when);
  }
  const missing = TRAITS.filter((trait) => !covered.has(trait));
  assert.deepEqual(missing, [], `traits with no template: ${missing.join(', ')}`);
});

test('a profile declaring each trait compiles and verifies with a requirement behind it', () => {
  for (const trait of TRAITS) {
    const project = compile({
      name: `trait-${trait}`,
      traits: [trait],
      // Give the trait room to be selected at a realistic tier.
      risks: { pii: true, publicFacing: true, multiTenant: true }
    });
    try {
      const spec = JSON.parse(readFileSync(path.join(project.outDir, 'spec.json'), 'utf8'));
      const carriers = spec.requirements.filter((requirement) => (requirement.traits ?? []).includes(trait));
      assert.ok(carriers.length > 0, `declaring "${trait}" produced no requirement that discharges it`);

      const report = verifyPacket(project.outDir, { strict: false });
      const coverageErrors = report.errors.filter((error) => error.startsWith(`trait ${trait} has no requirement`));
      assert.deepEqual(coverageErrors, [], `verify rejects the ${trait} profile: ${coverageErrors.join('; ')}`);
    } finally {
      project.cleanup();
    }
  }
});

test('verify fails a packet whose declared trait has no requirement, and accepts a dated waiver', () => {
  // `mobile.offline` only applies to mobile profiles at tier >= 1, so a web-app
  // that declares `offline` legitimately has nothing selected for it. That is the
  // gap the check exists to surface: the trait promised an obligation the packet
  // does not contain.
  // Exercise the rule directly: a packet that declares a trait no requirement
  // carries must fail, whatever the catalog happens to select today.
  const project = compile({ traits: ['search'], risks: { pii: true } });
  try {
    const specPath = path.join(project.outDir, 'spec.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    for (const requirement of spec.requirements) requirement.traits = (requirement.traits ?? []).filter((trait) => trait !== 'search');
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    const report = verifyPacket(project.outDir, { strict: false });
    assert.ok(
      report.errors.some((error) => error.includes('trait search has no requirement')),
      'an uncovered trait must be an error, not a notice'
    );
  } finally {
    project.cleanup();
  }

  // The waiver is explicit, dated debt: it must carry a reason and an expiry.
  const waived = compile({
    traits: ['search'],
    risks: { pii: true },
    traitWaivers: [{ trait: 'search', reason: 'Search is deferred to version two by the product owner', expires: '2027-01-01' }]
  });
  try {
    const specPath = path.join(waived.outDir, 'spec.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    for (const requirement of spec.requirements) requirement.traits = (requirement.traits ?? []).filter((trait) => trait !== 'search');
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    const report = verifyPacket(waived.outDir, { strict: false });
    assert.deepEqual(report.errors.filter((error) => error.startsWith('trait ')), []);
  } finally {
    waived.cleanup();
  }
});

test('a waiver without a reason or expiry is rejected by profile validation', () => {
  const errors = validateProfile(
    normalizeProfile({
      name: 'bad-waiver',
      idea: 'A clinic booking system with a long enough idea sentence to pass validation.',
      kind: 'web-app',
      stage: 'mvp',
      traitWaivers: [{ trait: 'offline', reason: 'soon' }, { trait: 'nonsense', reason: 'a good enough reason', expires: 'whenever' }]
    })
  );
  assert.ok(errors.some((error) => /traitWaivers\[0\]\.reason/.test(error)));
  assert.ok(errors.some((error) => /traitWaivers\[0\]\.expires/.test(error)));
  assert.ok(errors.some((error) => /traitWaivers\[1\]\.trait/.test(error)));
});

test('a named regulation adds its obligations, not just rigor', () => {
  const base = {
    traits: ['auth', 'persistence'],
    risks: { pii: true, regulated: true, multiTenant: true, destructiveWrites: true }
  };
  const withoutRegime = compile(base);
  const withHipaa = compile({ ...base, regulation: ['hipaa'] });
  try {
    const before = JSON.parse(readFileSync(path.join(withoutRegime.outDir, 'spec.json'), 'utf8'));
    const after = JSON.parse(readFileSync(path.join(withHipaa.outDir, 'spec.json'), 'utf8'));

    const text = (spec) => JSON.stringify(spec.requirements);
    assert.equal(/hipaa|phi|encrypt|minimum necessary/i.test(text(before)), false, 'an unnamed regime must not invent obligations');
    assert.match(text(after), /protected health information/i);
    assert.match(text(after), /encrypt/i);
    assert.match(text(after), /minimum necessary/i);
    assert.match(text(after), /six years/i);
    assert.ok(after.requirements.length > before.requirements.length, 'the regime adds requirements');

    // Selection is automatic from the regime; the profile did not list the overlay.
    assert.ok(!before.project.regulation.length);
    assert.deepEqual(after.project.regulation, ['hipaa']);
    assert.equal(verifyPacket(withHipaa.outDir, { strict: true }).ok, true);
  } finally {
    withoutRegime.cleanup();
    withHipaa.cleanup();
  }
});

test('every regulation in the vocabulary resolves to a shipped overlay', () => {
  for (const regime of REGULATIONS) {
    const project = compile({ traits: ['auth'], risks: { pii: true, regulated: true }, regulation: [regime] });
    try {
      const spec = JSON.parse(readFileSync(path.join(project.outDir, 'spec.json'), 'utf8'));
      const origin = spec.requirements.filter((requirement) => String(requirement.origin).includes(regime));
      assert.ok(origin.length > 0, `regulation "${regime}" selected no requirement`);
    } finally {
      project.cleanup();
    }
  }
});

test('an unknown regulation is rejected rather than ignored', () => {
  const errors = validateProfile(
    normalizeProfile({
      name: 'bad-regime',
      idea: 'A clinic booking system with a long enough idea sentence to pass validation.',
      kind: 'web-app',
      stage: 'mvp',
      regulation: ['sox']
    })
  );
  assert.ok(errors.some((error) => /unknown regime "sox"/.test(error)));
});
