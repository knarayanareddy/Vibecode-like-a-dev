/**
 * Delta spec tests.
 *
 * A change proposal is the brownfield half of the promise: it must declare what
 * it changes, what it would break, how the breakage would be noticed, and how to
 * undo it. Each of those is a test here.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyChange, archiveChange, emitChange, planChange, recompilePacket, renderChange, staticImportsOf, validateChange, verifyChange } from '../lib/change.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { enableModules } from '../lib/modules.mjs';
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

function recordReviewedEvidence({ root, changeDir, plan }) {
  enableModules({ projectDir: root, ids: 'review' });
  const ids = [...plan.added.map((requirement) => requirement.id), ...plan.modified.map(({ target }) => target.id), ...plan.removed.map(({ target }) => target.id)];
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'review-brief.md'), `# Review Brief: retro-board\n\n**Status:** Approved\n\n## Change Summary\n\nThe proposed requirement delta and resulting packet were reviewed before archival.\n\n## Requirements Under Review\n\n${ids.map((id) => `- ${id}`).join('\n')}\n\n## Risk and Invariants\n\nThe review protects the stated acceptance criteria and the documented rollback boundary.\n\n## Evidence\n\nThe generated packet and linked tests were reviewed against the change proposal.\n\n## Review Questions\n\nDo the linked requirements retain executable evidence after the proposed delta?\n\n## Decision\n\nApproved by the accountable reviewer with the stated rollback condition.\n`);
  const evidence = JSON.parse(readFileSync(path.join(changeDir, 'evidence.json'), 'utf8'));
  evidence.artifacts = [{ kind: 'review-brief', file: 'docs/review-brief.md', requirements: ids }];
  writeFileSync(path.join(changeDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(path.join(changeDir, 'evidence.md'), readFileSync(path.join(changeDir, 'evidence.md'), 'utf8').replace('**Status:** Pending', '**Status:** Approved'));
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
        statement: 'When the facilitator of a board requests an export, the application shall produce one file containing every card, its column and its vote count for that board.',
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

test('a title-only requirement change is valid, changes the manifest, and is visible without inventing test work', (t) => {
  const p = packet();
  t.after(p.cleanup);
  const target = p.spec.requirements[0];
  const titleOnly = change({
    id: 'clarify-title',
    title: 'Clarify a requirement title',
    risk: 'low',
    add: [],
    remove: [],
    modify: [{ key: target.key, title: `${target.title} clearly` }],
    probe: [],
    rollback: ''
  });
  assert.deepEqual(validateChange(titleOnly), []);
  const plan = planChange({ packetDir: p.outDir, change: titleOnly });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.afterSpec.requirements.find((entry) => entry.id === target.id).title, `${target.title} clearly`);
  const rendered = renderChange(plan);
  assert.match(rendered.get('proposal.md'), /\| title \|/);
  assert.match(rendered.get('tasks.md'), /title-only clarification; no behaviour or anchor changes are implied/);
});

test('change-added anchors follow the packet stack and verification mode', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-change-go-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = normalizeProfile({
    name: 'go-change', idea: 'A Go service records durable approval decisions for a release queue.', kind: 'api', stage: 'mvp',
    constraints: { stack: 'Go 1.23' }, traits: ['persistence']
  });
  const { outDir } = emitPacket(buildPlan(profile, { index }), path.join(root, 'spec'));
  const delta = change({
    id: 'go-anchor', title: 'Add Go-verified export', risk: 'low', modify: [], remove: [], probe: [], rollback: '',
    add: [{ ...change().add[0], key: 'feature.go-export', title: 'An export has a Go test', verify: 'automated' }]
  });
  const plan = planChange({ packetDir: outDir, change: delta });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.added[0].anchor, 'tests/api/feature-go-export.test.go');

  const manual = planChange({ packetDir: outDir, change: { ...delta, id: 'manual-anchor', add: [{ ...delta.add[0], verify: 'manual' }] } });
  assert.equal(manual.added[0].anchor, null);
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
    change: change({ modify: [{ key: 'does.not-exist', statement: `The application shall ${'x'.repeat(50)}.` }] })
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
  assert.deepEqual(names, ['delta.json', 'design.md', 'evidence.json', 'evidence.md', 'proposal.md', 'spec.after.json', 'tasks.md']);

  const proposal = readFileSync(path.join(out, 'proposal.md'), 'utf8');
  assert.match(proposal, /## ADDED/);
  assert.match(proposal, /## MODIFIED/);
  assert.match(proposal, /## REMOVED/);
  assert.match(proposal, /## Blast radius/);
  assert.match(proposal, /## Probe/);
  assert.match(proposal, /## Rollback/);

  const design = readFileSync(path.join(out, 'design.md'), 'utf8');
  assert.match(design, /## Decisions/);
  assert.match(design, /## Alternatives Considered/);

  const evidence = readFileSync(path.join(out, 'evidence.md'), 'utf8');
  assert.match(evidence, /## Artifact Register/);
  assert.match(evidence, /## Release Decision/);

  const tasks = readFileSync(path.join(out, 'tasks.md'), 'utf8');
  assert.match(tasks, /design\.md/);
  assert.match(tasks, /evidence\.json/);
  assert.match(tasks, /spec-check\.mjs/);
  assert.match(tasks, /@req REQ-\d{3}/);

  const pending = verifyChange(out, { projectDir: p.root });
  assert.equal(pending.ok, false);
  assert.match(pending.errors.join('\n'), /evidence\.json needs at least one linked reviewed artifact/);
  recordReviewedEvidence({ root: p.root, changeDir: out, plan });
  const report = verifyChange(out, { projectDir: p.root });
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

test('change apply rejects a final backup symlink rather than colliding with or overwriting its target', (t) => {
  const p = packet();
  t.after(p.cleanup);
  const plan = planChange({ packetDir: p.outDir, change: change() });
  const outside = path.join(p.root, 'outside-backup.json');
  writeFileSync(outside, '{"outside":true}\n');
  symlinkSync(outside, path.join(p.outDir, 'spec.json.bak'), 'file');

  assert.throws(() => applyChange(plan, { force: true }), (error) => error.code === 'UNSAFE_MANAGED_PATH');
  assert.equal(readFileSync(outside, 'utf8'), '{"outside":true}\n');
  assert.equal(JSON.parse(readFileSync(path.join(p.outDir, 'spec.json'), 'utf8')).requirements.some((requirement) => requirement.key === 'feature.export'), false);
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

// ---------------------------------------------------------------- archive

/**
 * A packet whose profile is on disk, the way the CLI produces one. The archive step
 * needs to know where the profile is, so this fixture reproduces that link instead
 * of hand-writing `spec.project.profile`.
 */
function packetWithProfile() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-archive-'));
  const profileFile = path.join(root, 'profile.json');
  const raw = {
    name: 'retro-board',
    idea: 'A retrospective board where a team votes on cards and leaves with three agreed actions.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true }
  };
  writeFileSync(profileFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const plan = buildPlan(normalizeProfile(raw), { index, profileDir: root });
  plan.profileLabel = 'profile.json';
  const { outDir } = emitPacket(plan, path.join(root, 'spec'));

  const delta = planChange({ packetDir: outDir, change: change() });
  const changeDir = path.join(root, 'changes', 'add-export');
  emitChange(delta, changeDir);
  recordReviewedEvidence({ root, changeDir, plan: delta });

  return { root, profileFile, outDir, changeDir, delta, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write a profile fixture, creating its directory. */
function writeFileSyncSafe(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const snapshot = (root) => {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
};

test('archive rejects final and intermediate managed symlinks before profile, history, or packet promotion', async (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);
  const outside = path.join(p.root, 'outside');
  mkdirSync(outside);
  mkdirSync(path.join(p.root, 'overlays'));
  symlinkSync(path.join(outside, 'overlay.json'), path.join(p.root, 'overlays', 'change-add-export.json'), 'file');

  await assert.rejects(
    () => archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: p.profileFile }),
    (error) => error.code === 'UNSAFE_MANAGED_PATH'
  );
  assert.equal(existsSync(path.join(outside, 'overlay.json')), false);
  assert.equal(JSON.parse(readFileSync(p.profileFile, 'utf8')).overlays, undefined);

  rmSync(path.join(p.root, 'overlays'), { recursive: true, force: true });
  mkdirSync(path.join(p.outDir, 'changes'), { recursive: true });
  symlinkSync(outside, path.join(p.outDir, 'changes', 'archive'), 'dir');
  await assert.rejects(
    () => archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: p.profileFile }),
    (error) => error.code === 'UNSAFE_MANAGED_PATH'
  );
  assert.equal(existsSync(path.join(outside, 'add-export', 'delta.json')), false);
});

test('archiving folds the delta into the profile, the history and the packet', async (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);

  const result = await archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: p.profileFile });

  // 1. The source of truth: the profile now lists an overlay, and the overlay carries
  //    the delta, so the next compile cannot drop it.
  const profile = JSON.parse(readFileSync(p.profileFile, 'utf8'));
  assert.deepEqual(profile.overlays, ['change-add-export']);
  const overlay = JSON.parse(readFileSync(result.overlayPath, 'utf8'));
  assert.equal(overlay.layer, 'team');
  assert.equal(overlay.provenance.change, 'add-export');
  assert.deepEqual(overlay.addRequirements.map((requirement) => requirement.key), ['feature.export']);
  assert.match(overlay.addRequirements[0].statement, / shall /, 'the archived requirement is still an EARS statement');

  // 2. The recompiled packet keeps the requirement, with its provenance and its id.
  const spec = JSON.parse(readFileSync(path.join(p.outDir, 'spec.json'), 'utf8'));
  const added = spec.requirements.find((requirement) => requirement.key === 'feature.export');
  assert.ok(added, 'the requirement survives the recompile');
  assert.equal(added.id, p.delta.added[0].id, 'the id the delta assigned is the id the packet keeps: anchors stay valid');
  assert.equal(added.origin, 'overlay:change-add-export');
  assert.ok(spec.overlays.some((entry) => entry.id === 'change-add-export'));

  // 3. History shows the merge.
  const history = JSON.parse(readFileSync(path.join(p.outDir, 'changes', 'history.json'), 'utf8'));
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].id, 'add-export');
  assert.deepEqual(history.entries[0].added, ['feature.export']);
  assert.deepEqual(history.entries[0].modified, ['api.error-envelope']);
  assert.deepEqual(history.entries[0].retired.map((entry) => entry.id), [p.delta.removed[0].target.id]);
  assert.deepEqual(history.retiredRequirementIds.map((entry) => entry.id), [p.delta.removed[0].target.id], 'retired IDs survive outside the active manifest');
  assert.equal(history.entries[0].evidence.artifacts[0].kind, 'review-brief');
  assert.deepEqual(history.entries[0].compile.dropped, ['ui.design-tokens'], 'the removal is recorded as a drop, next to the change that caused it');
  assert.equal(spec.history, undefined, 'the manifest stays a pure function of its inputs');

  // 4. The change directory is kept with the packet that absorbed it.
  assert.ok(existsSync(path.join(p.outDir, 'changes', 'archive', 'add-export', 'delta.json')));
});

test('archiving refuses a change whose reviewed evidence was withdrawn or altered', async (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);
  const evidence = path.join(p.changeDir, 'evidence.md');
  writeFileSync(evidence, readFileSync(evidence, 'utf8').replace('**Status:** Approved', '**Status:** Pending'));
  await assert.rejects(
    () => archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: p.profileFile }),
    /change evidence is not ready to archive[\s\S]*status must be Approved/
  );
  assert.equal(existsSync(path.join(p.root, 'overlays', 'change-add-export.json')), false, 'a failed evidence check writes no profile overlay');
});

test('retired history IDs are reserved when a later overlay introduces a new requirement', (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);
  const original = JSON.parse(readFileSync(path.join(p.outDir, 'spec.json'), 'utf8'));
  const retiredId = original.requirements.find((requirement) => requirement.key === 'core.domain-invariants').id;

  // Model the durable archive history after a previous change removed the highest
  // active requirement. The next recompile must reserve that retired number.
  const profile = JSON.parse(readFileSync(p.profileFile, 'utf8'));
  profile.overlays = ['retire-max-id'];
  writeFileSync(p.profileFile, `${JSON.stringify(profile, null, 2)}\n`);
  mkdirSync(path.join(p.root, 'overlays'), { recursive: true });
  writeFileSync(path.join(p.root, 'overlays', 'retire-max-id.json'), `${JSON.stringify({
    id: 'retire-max-id', layer: 'team', title: 'Retire max id',
    why: 'The fixture models a reviewed archival removal of the highest active requirement identity.',
    remove: [{ key: 'core.domain-invariants', why: 'The archived fixture deliberately retires this identifier before a later addition.' }]
  }, null, 2)}\n`);
  recompilePacket(p.profileFile, p.outDir);
  mkdirSync(path.join(p.outDir, 'changes'), { recursive: true });
  writeFileSync(path.join(p.outDir, 'changes', 'history.json'), `${JSON.stringify({
    schemaVersion: 1, packet: 'spec', entries: [], retiredRequirementIds: [{ id: retiredId, key: 'core.domain-invariants', change: 'retire-max-id' }]
  }, null, 2)}\n`);

  profile.overlays.push('later-new-rule');
  writeFileSync(p.profileFile, `${JSON.stringify(profile, null, 2)}\n`);
  writeFileSync(path.join(p.root, 'overlays', 'later-new-rule.json'), `${JSON.stringify({
    id: 'later-new-rule', layer: 'team', title: 'Later rule',
    why: 'The fixture adds a new requirement after an earlier maximum identifier was retired.',
    addRequirements: [{
      key: 'ops.later-new-rule', title: 'Later requirement', area: 'core',
      statement: 'When the fixture recompiles after a retirement, the application shall assign a fresh requirement identifier.',
      failurePath: 'A stale anchor is rebound to a newly added requirement.', acceptance: ['A fresh identifier is visible.'], verify: 'manual'
    }]
  }, null, 2)}\n`);

  recompilePacket(p.profileFile, p.outDir);
  const after = JSON.parse(readFileSync(path.join(p.outDir, 'spec.json'), 'utf8'));
  const added = after.requirements.find((requirement) => requirement.key === 'ops.later-new-rule');
  assert.ok(added);
  assert.notEqual(added.id, retiredId, 'a historical retired identifier must not be recycled');
});

test('change planning reserves historical identifiers that are no longer active', (t) => {
  const p = packet();
  t.after(p.cleanup);
  mkdirSync(path.join(p.outDir, 'changes'), { recursive: true });
  writeFileSync(path.join(p.outDir, 'changes', 'history.json'), `${JSON.stringify({
    schemaVersion: 1,
    packet: 'spec',
    entries: [],
    retiredRequirementIds: [{ id: 'REQ-999', key: 'historical.retired-rule', change: 'retire-max-id' }]
  }, null, 2)}\n`);
  const planned = planChange({ packetDir: p.outDir, change: change() });
  assert.equal(planned.errors.length, 0, planned.errors.join('\n'));
  assert.equal(planned.added[0].id, 'REQ-1000', 'the next change id follows the highest retired identity');
});

test('a staging recompile failure leaves profile, packet, overlay, archive and history byte-for-byte unchanged', async (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);
  const before = snapshot(p.root);

  await assert.rejects(
    () => archiveChange({
      packetDir: p.outDir,
      changeDir: p.changeDir,
      profilePath: p.profileFile,
      recompileFn: () => { throw new Error('simulated staged compiler failure'); }
    }),
    /simulated staged compiler failure/
  );

  const after = snapshot(p.root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, content] of before) assert.equal(after.get(file), content, `${file} changed after a failed archive`);
});

test('apply -> archive -> recompile is idempotent', async (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);

  await archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: p.profileFile });
  const first = snapshot(p.root);

  await archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: p.profileFile });
  const second = snapshot(p.root);
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort(), 'a second archive adds no files');
  for (const [file, content] of first) {
    assert.equal(second.get(file), content, `${file} changed on the second archive`);
  }

  // A fresh compile from the same profile must land on the same manifest: that is
  // what "the overlay is the source of truth" has to mean.
  const before = readFileSync(path.join(p.outDir, 'spec.json'), 'utf8');
  recompilePacket(p.profileFile, p.outDir);
  assert.equal(readFileSync(path.join(p.outDir, 'spec.json'), 'utf8'), before);

  const history = JSON.parse(readFileSync(path.join(p.outDir, 'changes', 'history.json'), 'utf8'));
  assert.equal(history.entries.length, 1, 'the same change is one history entry, not two');
});

test('a recorded profile path that resolves to a different project is refused', async (t) => {
  const p = packetWithProfile();
  t.after(p.cleanup);

  // The packet records "profile.json" as the CLI was given it. Resolved from a
  // directory where that name belongs to another project, the archive must refuse:
  // writing an overlay into the wrong profile looks like success and loses the delta.
  const elsewhere = path.join(p.root, 'elsewhere');
  const decoy = path.join(elsewhere, 'profile.json');
  writeFileSyncSafe(decoy, { name: 'some-other-product', idea: 'A decoy profile that must never receive this overlay.', kind: 'api', stage: 'mvp' });

  await assert.rejects(
    () => archiveChange({ packetDir: p.outDir, changeDir: p.changeDir, profilePath: decoy }),
    /is the profile for "some-other-product", not "retro-board"/
  );
  assert.equal(existsSync(path.join(elsewhere, 'overlays')), false, 'nothing was written next to the decoy');
});

test('archiving without a profile path refuses instead of dropping the delta', async (t) => {
  const p = packet();
  t.after(p.cleanup);

  const out = path.join(p.root, 'changes', 'add-export');
  emitChange(planChange({ packetDir: p.outDir, change: change() }), out);

  await assert.rejects(() => archiveChange({ packetDir: p.outDir, changeDir: out }), /does not record where its profile lives/);
});
/**
 * BUG-08: the blast radius named requirements, never the code they reach.
 *
 * `planChange` reported areas, gate collisions and practices. When six anchored
 * tests import one shared module, the module is where the change actually lands,
 * and listing the tests without it leaves the real surface invisible. Computing
 * it needs the repository, so it is opt-in and absent by default rather than
 * empty: an empty list would read as "nothing else is affected".
 */
test('the blast radius names shared modules reached from anchored tests', (t) => {
  const p = packet();
  t.after(p.cleanup);

  // A repository where every anchored test imports one shared module.
  const repo = path.join(p.root, 'repo');
  mkdirSync(path.join(repo, 'src', 'http'), { recursive: true });
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'http', 'envelope.ts'), 'export const envelope = (x) => x;\n');
  const automated = p.spec.requirements.filter((requirement) => requirement.verify === 'automated');
  assert.ok(automated.length >= 2, 'fixture needs at least two automated requirements');

  const spec = JSON.parse(JSON.stringify(p.spec));
  // Re-point anchors on the *clone* that gets written, not on p.spec.
  const automatedInSpec = spec.requirements.filter((requirement) => requirement.verify === 'automated');
  for (const [offset, requirement] of automatedInSpec.slice(0, 2).entries()) {
    const file = `tests/t${offset + 1}.spec.ts`;
    requirement.anchor = file;
    writeFileSync(
      path.join(repo, file),
      `import { envelope } from '../src/http/envelope.ts';\nit('case ${offset + 1}', () => expect(envelope(1)).toBe(1));\n`
    );
  }
  writeFileSync(path.join(p.outDir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);

  const plan = planChange({
    packetDir: p.outDir,
    projectDir: repo,
    change: {
      id: 'modify-envelope',
      title: 'Change the error envelope',
      why: 'Every client parses this envelope, so its shape is a contract we cannot change quietly.',
      risk: 'medium',
      modify: [
        {
          key: automated[0].key,
          statement: 'The error envelope shall name the failing field so a client can render it.',
          failurePath: 'A client cannot tell which field was rejected.'
        }
      ]
    }
  });

  assert.deepEqual(plan.blastRadius.source.testFiles.map((entry) => entry.file), ['tests/t1.spec.ts']);
  assert.deepEqual(plan.blastRadius.source.modules, [
    { file: 'src/http/envelope.ts', importedBy: ['tests/t1.spec.ts'] }
  ]);
});

test('without a project the blast radius omits the source section rather than lying', (t) => {
  const p = packet();
  t.after(p.cleanup);

  const plan = planChange({ packetDir: p.outDir, change: change() });
  assert.equal(plan.blastRadius.source, undefined, 'no repository means no graph, not an empty one');
});

test('static import extraction ignores packages and keeps relative specifiers', () => {
  const source = [
    "import a from './a.ts';",
    "import { b } from '../lib/b';",
    "import fs from 'node:fs';",
    "import x from 'lodash';",
    "const c = require('./c');",
    "const d = await import('./d');",
    "export { e } from './e';"
  ].join('\n');
  assert.deepEqual(staticImportsOf(source).sort(), ['../lib/b', './a.ts', './c', './d', './e'].sort());
});
