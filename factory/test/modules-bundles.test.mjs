import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyBundle, applyBundleToProfile, getBundle, listBundles } from '../lib/bundles.mjs';
import { enableModules, listModules, moduleStatus, resolveModules } from '../lib/modules.mjs';

const PROFILE = {
  name: 'module-lab',
  idea: 'A compact project used to prove optional VLD modules and starter bundles behave predictably.',
  kind: 'web-app',
  stage: 'mvp',
  users: { scale: 'small' },
  traits: [],
  risks: {},
  constraints: { team: 2, weeks: 4, stack: 'typescript', mustUse: [] }
};

test('builtin module and bundle catalogues validate, and dependency expansion is deterministic', () => {
  const modules = listModules();
  assert.deepEqual(modules.errors, []);
  assert.deepEqual(modules.modules.map((module) => module.id), ['architecture', 'delivery', 'product', 'qa', 'review']);

  const resolved = resolveModules('review,qa');
  assert.deepEqual(resolved.map((module) => module.id), ['product', 'architecture', 'delivery', 'review', 'qa']);
  assert.throws(() => resolveModules('not-a-module'), /unknown module/);
  assert.throws(() => resolveModules('product,product'), /provided twice/);

  const bundles = listBundles();
  assert.deepEqual(bundles.errors, []);
  assert.deepEqual(bundles.bundles.map((bundle) => bundle.id), ['regulated-payments', 'startup-saas']);
  assert.equal(getBundle('startup-saas').modules.length, 5);
});

test('module locks include dependencies, are idempotent, and report source drift', (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-modules-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));

  const first = enableModules({ projectDir: project, ids: 'review' });
  assert.equal(first.changed, true);
  assert.deepEqual(first.added, ['product', 'architecture', 'delivery', 'review']);
  const lock = path.join(project, '.vld', 'modules.json');
  assert.ok(existsSync(lock));
  assert.deepEqual(JSON.parse(readFileSync(lock, 'utf8')).modules.map((entry) => entry.id), ['architecture', 'delivery', 'product', 'review']);
  assert.equal(moduleStatus(project).ok, true);

  const second = enableModules({ projectDir: project, ids: 'review' });
  assert.equal(second.changed, false, 'an identical enable request does not rewrite the lock');

  const tampered = JSON.parse(readFileSync(lock, 'utf8'));
  tampered.modules[0].digest = '0'.repeat(64);
  writeFileSync(lock, JSON.stringify(tampered));
  const status = moduleStatus(project);
  assert.equal(status.ok, false);
  assert.match(status.drift[0].reason, /differs from shipped/);

  // Re-enabling is an explicit acknowledgement of a reviewed manifest update and
  // refreshes the lock; drift must be recoverable rather than permanent.
  const refreshed = enableModules({ projectDir: project, ids: 'review' });
  assert.ok(refreshed.updated.includes('architecture'));
  assert.equal(moduleStatus(project).ok, true);
});

test('bundles only add explicit risk and trait policy, enable modules, and have a no-write dry run', (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-bundle-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const profilePath = path.join(project, 'profile.json');
  writeFileSync(profilePath, `${JSON.stringify(PROFILE, null, 2)}\n`);

  const dry = applyBundle({ id: 'regulated-payments', projectDir: project, profilePath, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(existsSync(path.join(project, '.vld', 'modules.json')), false, 'dry run creates no project state');
  assert.deepEqual(JSON.parse(readFileSync(profilePath, 'utf8')), PROFILE, 'dry run does not touch the profile');

  const applied = applyBundle({ id: 'regulated-payments', projectDir: project, profilePath });
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.changes.traits, ['auth', 'payments', 'persistence', 'webhooks']);
  assert.deepEqual(applied.changes.risks, ['payments', 'regulated', 'pii', 'integrations']);
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.deepEqual(profile.traits, ['auth', 'payments', 'persistence', 'webhooks']);
  assert.equal(profile.risks.payments, true);
  assert.equal(profile.risks.regulated, true);
  assert.equal(moduleStatus(project).ok, true);

  const again = applyBundle({ id: 'regulated-payments', projectDir: project, profilePath });
  assert.equal(again.changed, false, 'reapplying a bundle is idempotent');
  assert.deepEqual(again.changes, { traits: [], risks: [], overlays: [], constraints: [] });
});

test('a bundle cannot silently replace a scalar project constraint', () => {
  const raw = { ...PROFILE, constraints: { ...PROFILE.constraints, stack: 'typescript' } };
  const synthetic = {
    id: 'synthetic',
    profile: { constraints: { stack: 'python' } }
  };
  assert.throws(() => applyBundleToProfile(raw, synthetic), /would replace constraints\.stack/);
});
