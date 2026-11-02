import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadProfile, normalizeProfile, validateProfile } from '../lib/profile.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const valid = { name: 'shape-contract', idea: 'A profile fixture proves policy-bearing input types fail closed before compilation.', kind: 'api', stage: 'mvp', traits: ['payments'], overlays: ['org-baseline'] };

test('profile normalization records malformed root and policy-bearing container shapes instead of dropping them', () => {
  for (const raw of [null, ['not', 'an', 'object'], { ...valid, traits: 'payments' }, { ...valid, overlays: 'two-person-review' }, { ...valid, risks: [] }, { ...valid, users: null }, { ...valid, constraints: 'fast' }]) {
    const errors = validateProfile(normalizeProfile(raw));
    assert.ok(errors.length > 0, JSON.stringify(raw));
    assert.match(errors.join('\n'), /profile: must be a JSON object|traits: must be|overlays: must be|risks: must be|users: must be|constraints: must be/);
  }
  assert.deepEqual(validateProfile(normalizeProfile(valid)), []);
});

test('null and wrong container profile documents return CLI input exit 2 rather than a raw TypeError', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-profile-shape-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, raw] of [['null', null], ['traits', { ...valid, traits: 'payments' }], ['overlays', { ...valid, overlays: 'two-person-review' }], ['valid', valid]]) {
    const file = path.join(dir, `${name}.json`); writeFileSync(file, `${JSON.stringify(raw)}\n`);
    const result = spawnSync(process.execPath, [CLI, 'plan', file, '--json'], { encoding: 'utf8' });
    if (name === 'valid') assert.equal(result.status, 0, result.stderr);
    else {
      assert.equal(result.status, 2, `${name}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /TypeError/);
    }
  }
  const loaded = loadProfile(path.join(dir, 'null.json'));
  assert.match(loaded.errors.join('\n'), /profile: must be a JSON object/);
});
