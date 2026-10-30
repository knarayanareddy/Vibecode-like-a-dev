import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addStore, initStore, readStoreState, storeStatus, validateRepository } from '../lib/stores.mjs';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function makeStore(root, id = 'team-playbook') {
  const source = path.join(root, 'source');
  initStore({ directory: source, id, title: 'Team delivery playbook' });
  writeFileSync(path.join(source, 'templates.md'), '# Review notes\n\nKeep requirement links and release evidence reviewable.\n');
  const manifest = JSON.parse(readFileSync(path.join(source, 'vld-store.json'), 'utf8'));
  manifest.assets.push({ id: 'review-notes', kind: 'guidance', file: 'templates.md' });
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
