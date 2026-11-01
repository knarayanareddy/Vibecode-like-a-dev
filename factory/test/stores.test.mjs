import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addStore, copyStoreAsset, initStore, previewStoreRefresh, readStoreAsset, readStoreState, refreshStore, storeStatus, validateRepository } from '../lib/stores.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function makeStore(root, id = 'team-playbook') {
  const source = path.join(root, 'source');
  initStore({ directory: source, id, title: 'Team delivery playbook' });
  writeFileSync(path.join(source, 'templates.md'), '# Review notes\n\nKeep requirement links and release evidence reviewable.\n');
  writeFileSync(path.join(source, 'product-brief.md'), '# Product Brief: shared\n\n**Status:** Draft\n\n## Problem\n\n[Describe the user problem.]\n');
  const manifest = JSON.parse(readFileSync(path.join(source, 'vld-store.json'), 'utf8'));
  manifest.assets.push(
    { id: 'review-notes', kind: 'guidance', file: 'templates.md' },
    { id: 'product-brief-template', kind: 'artifact-template', artifact: 'product-brief', file: 'product-brief.md' }
  );
  writeFileSync(path.join(source, 'vld-store.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  git(source, ['init']); git(source, ['add', '.']);
  git(source, ['-c', 'user.name=VLD Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'initial store']);
  return source;
}

test('Git-backed stores pin a validated snapshot and detect cached asset drift without contacting a remote', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = makeStore(root); const project = path.join(root, 'consumer');
  mkdirSync(project, { recursive: true });

  const added = addStore({ projectDir: project, id: 'team-playbook', repository: `file://${source}` });
  assert.match(added.store.commit, /^[a-f0-9]{40}$/);
  assert.equal(added.store.assets[0].id, 'review-notes');
  assert.ok(existsSync(path.join(project, '.vld', 'stores', 'team-playbook', 'templates.md')));
  assert.equal(storeStatus(project).ok, true);
  const template = readStoreAsset({ projectDir: project, storeId: 'team-playbook', assetId: 'product-brief-template', kind: 'artifact-template' });
  assert.equal(template.asset.artifact, 'product-brief');
  const copied = copyStoreAsset({ projectDir: project, storeId: 'team-playbook', assetId: 'review-notes' });
  assert.match(copied.output, /docs\/shared\/team-playbook\/review-notes\.md$/);
  assert.match(readFileSync(copied.output, 'utf8'), /requirement links/);
  assert.throws(() => copyStoreAsset({ projectDir: project, storeId: 'team-playbook', assetId: 'review-notes', out: '../escape.md' }), /inside the project/);
  assert.throws(() => addStore({ projectDir: project, id: 'team-playbook', repository: `file://${source}` }), /already locked/);

  writeFileSync(path.join(project, '.vld', 'stores', 'team-playbook', 'templates.md'), 'locally changed');
  const drift = storeStatus(project, 'team-playbook');
  assert.equal(drift.ok, false);
  assert.match(drift.stores[0].drift.join('\n'), /asset content differs/);
});

test('store validation refuses unsafe remotes and invalid manifests without writing a lock', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-store-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'consumer'); mkdirSync(project, { recursive: true });
  assert.throws(() => validateRepository('--upload-pack=bad'), /safe Git URL/);
  assert.throws(() => validateRepository('https://token@example.test/playbook.git'), /credential-free/);
  assert.throws(() => addStore({ projectDir: project, id: 'unsafe', repository: '--upload-pack=bad' }), /safe Git URL/);

  const source = path.join(root, 'invalid'); initStore({ directory: source, id: 'other-store', title: 'Other store' });
  git(source, ['init']); git(source, ['add', '.']); git(source, ['-c', 'user.name=VLD Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'bad id']);
  assert.throws(() => addStore({ projectDir: project, id: 'wanted-store', repository: `file://${source}` }), /does not match requested/);
  assert.equal(readStoreState(project).exists, false, 'a rejected clone must not create a project lock');
});

test('store refresh is a non-mutating reviewed preview followed by an exact commit acknowledgement', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-store-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = makeStore(root); const project = path.join(root, 'consumer');
  mkdirSync(project, { recursive: true });
  const initial = addStore({ projectDir: project, id: 'team-playbook', repository: `file://${source}` });
  const before = readFileSync(path.join(project, '.vld', 'stores.json'), 'utf8');

  writeFileSync(path.join(source, 'templates.md'), '# Review notes\n\nReview the changed requirement evidence before release.\n');
  const manifest = JSON.parse(readFileSync(path.join(source, 'vld-store.json'), 'utf8'));
  manifest.assets.push({ id: 'release-guidance', kind: 'guidance', file: 'release.md' });
  writeFileSync(path.join(source, 'release.md'), '# Release\n\nA human approves the release.\n');
  writeFileSync(path.join(source, 'vld-store.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  git(source, ['add', '.']); git(source, ['-c', 'user.name=VLD Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'reviewed refresh candidate']);

  const preview = previewStoreRefresh({ projectDir: project, id: 'team-playbook' });
  assert.equal(preview.current.commit, initial.store.commit);
  assert.notEqual(preview.next.commit, initial.store.commit);
  assert.equal(preview.changes.commitChanged, true);
  assert.deepEqual(preview.changes.assets.added.map((asset) => asset.id), ['release-guidance']);
  assert.deepEqual(preview.changes.assets.changed.map((asset) => asset.id), ['review-notes']);
  assert.equal(readFileSync(path.join(project, '.vld', 'stores.json'), 'utf8'), before, 'preview must not alter the lock');

  assert.throws(() => refreshStore({ projectDir: project, id: 'team-playbook' }), /--acknowledge/);
  assert.throws(() => addStore({ projectDir: project, id: 'team-playbook', repository: `file://${source}`, refresh: true }), /exact reviewed commit acknowledgement/);
  assert.throws(() => refreshStore({ projectDir: project, id: 'team-playbook', acknowledge: initial.store.commit }), /does not match previewed commit/);
  assert.equal(readFileSync(path.join(project, '.vld', 'stores.json'), 'utf8'), before, 'failed acknowledgements must not alter the lock');

  const refreshed = refreshStore({ projectDir: project, id: 'team-playbook', acknowledge: preview.next.commit });
  assert.equal(refreshed.store.commit, preview.next.commit);
  assert.equal(refreshed.store.acknowledgedCommit, preview.next.commit);
  assert.equal(storeStatus(project, 'team-playbook').ok, true);
});


test('store assets and copied outputs reject intermediate symbolic-link escapes', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-store-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = makeStore(root); const project = path.join(root, 'consumer'); const outside = path.join(root, 'outside');
  mkdirSync(project, { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'escaped.md'), '# outside\n');
  symlinkSync(outside, path.join(source, 'linked'), 'dir');
  const manifest = JSON.parse(readFileSync(path.join(source, 'vld-store.json'), 'utf8'));
  manifest.assets.push({ id: 'escaped-asset', kind: 'guidance', file: 'linked/escaped.md' });
  writeFileSync(path.join(source, 'vld-store.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  git(source, ['add', '.']); git(source, ['-c', 'user.name=VLD Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'symlink asset']);

  assert.throws(
    () => addStore({ projectDir: project, id: 'team-playbook', repository: `file://${source}` }),
    (error) => error.code === 'INVALID_STORE_MANIFEST' && /not a real directory/.test(error.message)
  );

  // Use a separate valid pinned store to test output containment independently.
  const safe = makeStore(path.join(root, 'safe-root'));
  addStore({ projectDir: project, id: 'team-playbook', repository: `file://${safe}` });
  symlinkSync(outside, path.join(project, 'docs'), 'dir');
  assert.throws(
    () => copyStoreAsset({ projectDir: project, storeId: 'team-playbook', assetId: 'review-notes' }),
    (error) => error.code === 'INVALID_STORE_OUTPUT'
  );
  assert.equal(existsSync(path.join(outside, 'shared', 'team-playbook', 'review-notes.md')), false);
});
