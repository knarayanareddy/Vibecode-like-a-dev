/**
 * Delta spec tests.
 *
 * A change proposal is the brownfield half of the promise: it must declare what
 * it changes, what it would break, how the breakage would be noticed, and how to
 * undo it. Each of those is a test here.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyChange, emitChange, planChange, renderChange, validateChange, verifyChange } from '../lib/change.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';

const index = buildIndex();

function packet() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-change-'));
  const profile = normalizeProfile({
    name: 'retro-board',
    idea: 'A retrospective board where a team votes on cards and leaves with three agreed actions.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true }
  });
  const plan = buildPlan(profile, { index });
  const { outDir } = emitPacket(plan, path.join(root, 'spec'));
  const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
  return { root, outDir, spec, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function change(overrides = {}) {
  return {
    id: 'add-export',
    title: 'Facilitators can export a board',
    why: 'Without an export the board is a dead end after the meeting, and teams keep a parallel spreadsheet.',
    risk: 'high',
    add: [
      {
        key: 'feature.export',
        title: 'A facilitator can export a board',
        area: 'api',
        statement: 'The facilitator of a board can download one file containing every card, its column and its vote count, for a board they own.',
        failurePath: 'An export of an empty board returns a header-only file rather than an error.',
        acceptance: ['Given a board with cards, when the facilitator exports, then one row per card is present.'],
        verify: 'automated'
      }
    ],
    modify: [{ key: 'api.error-envelope', addAcceptance: ['Given a failed export, when it fails, then the envelope carries EXPORT_FAILED.'] }],
    remove: [
      {
        key: 'ui.design-tokens',
        why: 'Token enforcement is deferred until the component library is consolidated; enforcing it now blocks the feature.',
        replaceWith: 'Manual review against the palette'
      }
    ],
    probe: ['Export a board with two participants and compare the row count with the visible cards.'],
    rollback: 'Remove the route and the module; no schema change, so redeploying the previous image is enough.',
    ...overrides
  };
}

test('a change is validated: empty, unknown references and thin rationale all fail', () => {
  assert.deepEqual(validateChange(change()), []);

  const empty = validateChange({ id: 'x', title: 't', why: 'a reason long enough to count', risk: 'low' });
  assert.match(empty.join('\n'), /at least one requirement/);

  const thin = validateChange(change({ why: 'because' }));
  assert.match(thin.join('\n'), /why: required/);

  const missingFailurePath = change();
  missingFailurePath.add[0].failurePath = '';
  assert.match(validateChange(missingFailurePath).join('\n'), /failurePath: required/);

  const badKey = change();
  badKey.add[0].key = 'export';
  assert.match(validateChange(badKey).join('\n'), /namespaced kebab-case/);
});

test('a high-risk change without a probe or rollback is rejected', () => {
  const errors = validateChange(change({ probe: [], rollback: '' }));
  assert.match(errors.join('\n'), /probe: a high-risk change needs/);
  assert.match(errors.join('\n'), /rollback: required/);

  // The same change at medium risk is allowed, because the ceremony should scale.
  assert.deepEqual(validateChange(change({ risk: 'medium', probe: [], rollback: '' })), []);
});

test('references are resolved against the packet, not invented', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  assert.deepEqual(plan.errors, []);

  const bogusModify = planChange({
    packetDir: p.outDir,
    change: change({ modify: [{ key: 'does.not-exist', statement: 'x'.repeat(50) }] })
  });
  assert.match(bogusModify.errors.join('\n'), /is not in this packet/);

  const duplicate = planChange({
    packetDir: p.outDir,
    change: change({ add: [change().add[0], change().add[0]] })
  });
  assert.match(duplicate.errors.join('\n'), /added twice/);

  const existing = planChange({
    packetDir: p.outDir,
    change: change({ add: [{ ...change().add[0], key: 'core.non-goals' }], modify: [], remove: [] })
  });
  assert.match(existing.errors.join('\n'), /already exists in this packet/);
});

test('the delta produces valid manifest arithmetic and keeps criteria identifiers stable', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  const before = p.spec.requirements.length;

  assert.equal(plan.added.length, 1);
  assert.equal(plan.removed.length, 1);
  assert.equal(plan.afterSpec.requirements.length, before + 1 - 1);

  const added = plan.afterSpec.requirements.find((requirement) => requirement.key === 'feature.export');
  assert.ok(added);
  assert.equal(added.status, 'todo');
  assert.match(added.id, /^REQ-\d{3}$/);
  assert.ok(!p.spec.requirements.some((requirement) => requirement.id === added.id), 'new ids do not collide');

  const modified = plan.afterSpec.requirements.find((requirement) => requirement.key === 'api.error-envelope');
  const original = p.spec.requirements.find((requirement) => requirement.key === 'api.error-envelope');
  assert.ok(modified.acceptance.length > original.acceptance.length);
  assert.deepEqual(
    modified.acceptance.slice(0, original.acceptance.length).map((criteria) => criteria.id),
    original.acceptance.map((criteria) => criteria.id),
    'existing AC ids are preserved, because anchors cite them'
  );

  assert.ok(!plan.afterSpec.requirements.some((requirement) => requirement.key === 'ui.design-tokens'));
});

test('the blast radius names areas, obligations, practices and orphaned anchors', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  assert.deepEqual(plan.blastRadius.areas.sort(), ['api', 'frontend']);
  assert.ok(plan.blastRadius.obligations.some((obligation) => /contract inventory/i.test(obligation)));
  assert.ok(plan.blastRadius.practices.some((practice) => practice.id === 'architecture.api-contract-first'));

  const removed = p.spec.requirements.find((requirement) => requirement.key === 'ui.design-tokens');
  assert.ok(plan.blastRadius.orphanedAnchors.some((entry) => entry.id === removed.id));
  assert.ok(plan.blastRadius.obligations.some((obligation) => /stray anchor/.test(obligation)));
});

test('impact is classified by what the change touches', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const removed = planChange({ packetDir: p.outDir, change: change() });
  assert.equal(removed.impact, 'major', 'removals are major');

  // Adding an API requirement changes a contract, so it is major even with no removals.
  const additiveApi = planChange({
    packetDir: p.outDir,
    change: change({ modify: [], remove: [] })
  });
  assert.equal(additiveApi.impact, 'major');

  // Adding a purely presentational requirement is minor.
  const presentational = change({ modify: [], remove: [], risk: 'medium', probe: [], rollback: '' });
  presentational.add = [
    {
      ...presentational.add[0],
      key: 'feature.empty-state-copy',
      area: 'frontend',
      title: 'An empty board explains what to do next'
    }
  ];
  assert.equal(planChange({ packetDir: p.outDir, change: presentational }).impact, 'minor');

  const patchOnly = planChange({
    packetDir: p.outDir,
    change: change({
      add: [],
      remove: [],
      modify: [{ key: 'core.non-goals', addAcceptance: ['Given a review, when an unlisted capability appears, then the diff is rejected.'] }],
      risk: 'low',
      probe: [],
      rollback: ''
    })
  });
  assert.equal(patchOnly.impact, 'patch');
});

test('emitting a change writes a reviewable packet and verifies', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  const out = path.join(p.root, 'changes', 'add-export');
  const result = emitChange(plan, out);

  const names = result.written.map((file) => file.name).sort();
  assert.deepEqual(names, ['delta.json', 'proposal.md', 'spec.after.json', 'tasks.md']);

  const proposal = readFileSync(path.join(out, 'proposal.md'), 'utf8');
  assert.match(proposal, /## ADDED/);
  assert.match(proposal, /## MODIFIED/);
  assert.match(proposal, /## REMOVED/);
  assert.match(proposal, /## Blast radius/);
  assert.match(proposal, /## Probe/);
  assert.match(proposal, /## Rollback/);

  const tasks = readFileSync(path.join(out, 'tasks.md'), 'utf8');
  assert.match(tasks, /spec-check\.mjs/);
  assert.match(tasks, /@req REQ-\d{3}/);

  const report = verifyChange(out);
  assert.deepEqual(report.errors, []);
  assert.ok(report.ok);
});

test('emitting refuses to overwrite without force, and an invalid change writes nothing', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  const out = path.join(p.root, 'changes', 'add-export');
  emitChange(plan, out);
  assert.throws(() => emitChange(plan, out), /already exists/);
  assert.doesNotThrow(() => emitChange(plan, out, { force: true }));

  const invalid = planChange({ packetDir: p.outDir, change: change({ probe: [] }) });
  assert.throws(() => emitChange(invalid, path.join(p.root, 'bad'), { force: true }), /not valid/);
  assert.ok(!existsSync(path.join(p.root, 'bad')));
});

test('a change is reproducible: rendering twice gives identical files', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const first = renderChange(planChange({ packetDir: p.outDir, change: change() }));
  const second = renderChange(planChange({ packetDir: p.outDir, change: change() }));

  for (const [name, content] of first) {
    assert.equal(content, second.get(name), `${name} is not reproducible`);
  }
});

test('applying copies the manifest over a backup, and refuses twice', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  const applied = applyChange(plan);

  assert.ok(existsSync(applied.backupPath));
  const after = JSON.parse(readFileSync(applied.specPath, 'utf8'));
  assert.ok(after.requirements.some((requirement) => requirement.key === 'feature.export'));
  assert.ok(!after.requirements.some((requirement) => requirement.key === 'ui.design-tokens'));

  assert.throws(() => applyChange(plan), /already exists from an earlier apply/);
});

test('verification catches a tampered delta and unbalanced arithmetic', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  const out = path.join(p.root, 'changes', 'add-export');
  emitChange(plan, out);

  const deltaPath = path.join(out, 'delta.json');
  const delta = JSON.parse(readFileSync(deltaPath, 'utf8'));
  delta.requirementsAfter += 1;
  writeFileSync(deltaPath, JSON.stringify(delta, null, 2));
  assert.match(verifyChange(out).errors.join('\n'), /claims|arithmetic/);

  const restored = { ...delta, requirementsAfter: delta.requirementsAfter - 1, why: 'short' };
  writeFileSync(deltaPath, JSON.stringify(restored, null, 2));
  assert.match(verifyChange(out).errors.join('\n'), /rationale/);
});

test('a change directory without its artefacts does not verify', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const out = path.join(p.root, 'changes', 'empty');
  const plan = planChange({ packetDir: p.outDir, change: change() });
  emitChange(plan, out);
  rmSync(path.join(out, 'proposal.md'));

  const report = verifyChange(out);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /no proposal\.md/);
});
