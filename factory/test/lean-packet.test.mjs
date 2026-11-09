/**
 * BLK-3: the central claim — agents ship better with the packet — has never been
 * measured on a live model, and the packet costs a lot of context.
 *
 * Two things can be settled without an API key, and only those are asserted here:
 * the lean arm exists and is materially cheaper, and the honest numbers are
 * published rather than implied. Whether lean lift exceeds full lift is a question
 * for `eval-outcome --runner cmd|openai|anthropic`; it is not asserted, because a
 * test that guesses the answer is worse than no test.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const profile = () =>
  normalizeProfile({
    name: 'carepath',
    idea:
      'A multi-tenant telehealth platform for small clinics. A clinic admin books an appointment for a patient with a clinician. Admins can delete a clinic and all its data, which must be recoverable for 30 days. Every read of a patient record must be audited. A clinic must never see another clinic\'s patients.',
    kind: 'web-app',
    stage: 'production',
    traits: ['auth', 'admin', 'persistence'],
    risks: { pii: true, regulated: true, multiTenant: true, destructiveWrites: true, publicFacing: true }
  });

function emit(t, options) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-lean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  emitPacket(buildPlan(profile(), { index: buildIndex() }), dir, { force: true, ...options });
  const size = (file) => readFileSync(path.join(dir, file), 'utf8').length;
  return {
    dir,
    files: readdirSync(dir),
    tokens: Math.round((size('AGENTS.md') + size('spec.json')) / 4),
    spec: JSON.parse(readFileSync(path.join(dir, 'spec.json'), 'utf8'))
  };
}

test('the lean arm emits the entry point and the manifest, and no prose documents', (t) => {
  const lean = emit(t, { lean: true });
  assert.ok(lean.files.includes('AGENTS.md'));
  assert.ok(lean.files.includes('spec.json'));
  assert.ok(lean.files.includes('spec-check.mjs'), 'the checker ships, because a lean packet still has to fail');
  const prose = lean.files.filter((file) => /^\d\d-.*\.md$/.test(file));
  assert.deepEqual(prose, [], `lean packet must not ship the narrative documents, found ${prose.join(', ')}`);
});

test('the lean arm keeps every requirement, so it is cheaper rather than smaller', (t) => {
  const full = emit(t, {});
  const lean = emit(t, { lean: true });
  assert.equal(lean.spec.requirements.length, full.spec.requirements.length, 'no requirement may be dropped to save tokens');
  for (const requirement of lean.spec.requirements) {
    assert.ok(requirement.statement?.length > 0, `${requirement.id} keeps its statement`);
    assert.ok(Array.isArray(requirement.acceptance) && requirement.acceptance.length > 0, `${requirement.id} keeps its criteria`);
  }
  // What it drops is decision provenance, not obligations. A profile that skipped
  // nothing is a legitimate case, so the assertion is about the field staying empty
  // when a full packet would have carried entries.
  assert.deepEqual(lean.spec.skipped, []);
  assert.equal(lean.spec.overlays.length, full.spec.overlays.length, 'every overlay still counts');
});

test('the lean arm is materially cheaper than the full one', (t) => {
  const full = emit(t, {});
  const lean = emit(t, { lean: true });
  assert.ok(
    lean.tokens < full.tokens * 0.6,
    `lean is ${lean.tokens} tokens against full ${full.tokens}: it must be a real reduction, not a rounding`
  );
  // The target in the audit was 1.5k tokens. Reaching it means dropping acceptance
  // criteria, which would make the cheap arm weaker rather than leaner. The budget is
  // recorded here so the gap between what is shipped and what was asked for is visible.
  assert.ok(lean.tokens > 1500, `lean is ${lean.tokens} tokens; reaching 1.5k requires cutting criteria and is not done`);
});

test('the lean packet still verifies', async (t) => {
  const { verifyPacket } = await import('../lib/verify.mjs');
  const lean = emit(t, { lean: true });
  const report = verifyPacket(lean.dir);
  // Some document checks legitimately fail in a lean packet; the requirement, anchor
  // and rigor checks must not.
  const structural = report.errors.filter((error) => !/missing required document/.test(error));
  assert.deepEqual(structural, [], `lean packet has structural errors: ${structural.join(' | ')}`);
});

test('the context cost is published, with the calibration caveat attached', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /--lean/, 'the lean arm is documented');
  assert.match(
    readme,
    /never been run against a live model|no live model|calibration/i,
    'the README must not imply the live claim has been measured'
  );
  const results = path.join(ROOT, 'docs', 'results');
  assert.ok(readdirSync(results).length > 0, 'docs/results is where a live run would be committed');
});
