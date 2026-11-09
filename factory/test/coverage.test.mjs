/**
 * BUG-2 / BUG-3: the packet must notice when it disagrees with the idea.
 *
 * The coverage detector was a bag of words, wrong in both directions: it reported a
 * tenant rule as unmapped because the idea says `clinic` and the requirement says
 * `tenant`, and it credited a read-audit rule to a requirement that only audits
 * changes. Nothing compared the idea with the requirements at all, so a packet could
 * promise "recoverable for 30 days" and also "remove every copy in one operation".
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPinnedRules, obligationCoverage, unmappedObligations } from '../lib/emit/derive.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const index = buildIndex();

const TENANT = {
  id: 'REQ-008',
  title: 'Tenant isolation',
  statement: "Two clinics cannot see or affect each other's appointment data through any query, handler or export path.",
  acceptance: []
};
const CHANGE_AUDIT = {
  id: 'REQ-017',
  title: 'Append-only audit trail for privileged actions',
  statement: 'When a privileged or destructive action succeeds or fails, the application shall append an immutable record of actor, action, target, time and outcome.',
  acceptance: []
};

test('a tenant rule is covered by a tenant-isolation requirement, whatever noun the idea used', () => {
  const [entry] = obligationCoverage(
    { idea: "A clinic must never see another clinic's patients." },
    [TENANT]
  );
  assert.equal(entry.state, 'covered', `got ${entry.state}: ${entry.why}`);
  assert.equal(entry.by, 'REQ-008', 'the covering requirement is named so the author can disagree');
});

test('an audit of changes does not cover an audit of reads', () => {
  const [entry] = obligationCoverage(
    { idea: 'Every read of a patient record must be audited.' },
    [CHANGE_AUDIT]
  );
  assert.notEqual(entry.state, 'covered', 'a change-audit requirement must not satisfy a read-audit rule');
  assert.equal(entry.by, 'REQ-017');
  assert.equal(entry.state, 'partial', 'the difference is the access mode, not the subject');
});

test('a rule nothing resembles is unmapped, not partially covered by one shared noun', () => {
  const traffic = {
    id: 'REQ-002',
    title: 'The primary journey works end to end',
    statement: 'The application shall carry one record through the journey from first step to last.',
    acceptance: []
  };
  const [entry] = obligationCoverage(
    { idea: 'A booking must never double-book a therapist, and a cancellation must free the slot immediately.' },
    [traffic]
  );
  assert.equal(entry.state, 'unmapped', `got ${entry.state} via ${entry.by}: ${entry.why}`);
});

test('the idea cannot cover itself through the domain text', () => {
  const idea = 'A booking must never double-book a therapist, and a cancellation must free the slot immediately.';
  // Passing the idea back as "domain text" is exactly the self-coverage bug.
  const [entry] = obligationCoverage({ idea }, [], idea);
  assert.equal(entry.state, 'unmapped');
  assert.deepEqual(unmappedObligations({ idea }, lines(), idea), [idea]);
});

function lines() {
  return [];
}

test('an author can pin a rule to the requirement that covers it', () => {
  const idea = 'Every read of a patient record must be audited.';
  const coverage = obligationCoverage({ idea }, [CHANGE_AUDIT]);
  assert.equal(coverage[0].state, 'partial');

  const pinned = applyPinnedRules(
    { idea, rules: [{ text: 'Every read of a patient record must be audited.', covers: 'REQ-017', why: 'the acceptance criteria were amended to cover reads' }] },
    coverage
  );
  assert.equal(pinned[0].state, 'covered');
  assert.equal(pinned[0].by, 'REQ-017');
});

function compile(overrides = {}) {
  const profile = normalizeProfile({
    name: 'contradiction',
    kind: 'web-app',
    stage: 'production',
    users: { scale: 'medium' },
    traits: ['auth', 'persistence'],
    risks: { pii: true, regulated: true, multiTenant: true, destructiveWrites: true },
    ...overrides
  });
  const plan = buildPlan(profile, { index });
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-conflict-'));
  const result = emitPacket(plan, path.join(root, 'spec'));
  return { plan, outDir: result.outDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a recoverable-deletion idea selects the grace-period variant, not the one-shot erasure', () => {
  const withGrace = compile({
    idea: 'A multi-tenant telehealth platform for small clinics. Admin can delete a clinic and all its data, which must be recoverable for 30 days.'
  });
  try {
    const spec = JSON.parse(readFileSync(path.join(withGrace.outDir, 'spec.json'), 'utf8'));
    const keys = spec.requirements.map((requirement) => requirement.key);
    assert.ok(keys.includes('data.lifecycle-grace'), 'the grace variant must be selected');
    assert.ok(!keys.includes('data.lifecycle'), 'the one-shot erasure rule must not also be selected');
    const grace = spec.requirements.find((requirement) => requirement.key === 'data.lifecycle-grace');
    assert.match(grace.statement, /grace period/i);
  } finally {
    withGrace.cleanup();
  }

  const plain = compile({
    idea: 'A multi-tenant telehealth platform for small clinics where an admin erases a patient record on request.'
  });
  try {
    const keys = JSON.parse(readFileSync(path.join(plain.outDir, 'spec.json'), 'utf8')).requirements.map((requirement) => requirement.key);
    assert.ok(keys.includes('data.lifecycle'), 'an erasure idea still gets the erasure rule');
    assert.ok(!keys.includes('data.lifecycle-grace'), 'no grace period unless the idea asks for one');
  } finally {
    plain.cleanup();
  }
});

test('verify reports a contradiction between the idea and a requirement', () => {
  const project = compile({
    idea: 'Admin can delete a clinic and all its data, which must be recoverable for 30 days.'
  });
  try {
    // Force the contradictory pair the compiler now avoids, to prove the check fires.
    const specPath = path.join(project.outDir, 'spec.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    spec.requirements = spec.requirements.filter((requirement) => requirement.key !== 'data.lifecycle-grace');
    spec.requirements.push({
      id: 'REQ-099',
      key: 'data.lifecycle',
      area: 'data',
      origin: 'catalog',
      title: 'Data lifecycle: retention, export and deletion',
      statement: 'When a subject asks for their data to be deleted, the application shall remove every field, derived row and cached copy about that subject in one operation.',
      acceptance: [{ id: 'AC-01', text: 'A deleted record has no remaining copy.' }],
      verify: 'automated',
      traits: [],
      anchor: 'tests/data/requirement.test.mjs',
      status: 'todo'
    });
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    const lenient = verifyPacket(project.outDir);
    assert.ok(
      lenient.warnings.some((warning) => /contradict/.test(warning)),
      `expected a contradiction warning, got: ${lenient.warnings.join(' | ')}`
    );

    const strict = verifyPacket(project.outDir, { strict: true });
    assert.ok(
      strict.errors.some((error) => /contradict/.test(error)),
      '--strict must turn the contradiction into an error'
    );
  } finally {
    project.cleanup();
  }
});
