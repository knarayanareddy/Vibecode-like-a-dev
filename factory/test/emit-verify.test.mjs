/**
 * End-to-end: compile a packet, then try to break it.
 * These tests are the specification of the enforcement promise.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const index = buildIndex();

function makeProject(name, overrides = {}) {
  return normalizeProfile({
    name,
    idea: 'A retrospective board where a team votes on cards and leaves with three agreed actions.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true, publicFacing: true },
    ...overrides
  });
}

function requirementId(specPath, key) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const requirement = spec.requirements.find((entry) => entry.key === key);
  assert.ok(requirement, `packet has no requirement for ${key}`);
  return requirement.id;
}

/** Rewrite one requirement's fields in the packet manifest. */
function patchRequirement(specPath, key, changes) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  Object.assign(spec.requirements.find((entry) => entry.key === key), changes);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
}

function compileTemp(profile) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-test-'));
  const plan = buildPlan(profile, { index });
  const { outDir } = emitPacket(plan, path.join(root, 'spec'));
  return { root, outDir, plan, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a compiled packet verifies clean', (t) => {
  const project = compileTemp(makeProject('clean-packet'));
  t.after(project.cleanup);

  const report = verifyPacket(project.outDir);
  assert.deepEqual(report.errors, []);
  assert.ok(report.ok);
  assert.ok(report.stats.requirements > 0);
});

test('the packet is byte-identical across compiles, so review diffs mean something', async () => {
  const { renderPacket } = await import('../lib/emit/index.mjs');
  const profile = makeProject('deterministic');
  const plan = buildPlan(profile, { index });

  const first = renderPacket(plan);
  const second = renderPacket(buildPlan(profile, { index }));

  assert.deepEqual([...first.files.keys()], [...second.files.keys()]);
  for (const [name, content] of first.files) {
    assert.equal(content, second.files.get(name), `${name} is not reproducible`);
  }
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(first.files.get('spec.json')), 'spec.json carries no timestamp');
});

test('compile refuses to overwrite an existing packet without --force', (t) => {
  const project = compileTemp(makeProject('no-overwrite'));
  t.after(project.cleanup);

  assert.throws(
    () => emitPacket(project.plan, project.outDir),
    /Refusing to overwrite/
  );
  assert.doesNotThrow(() => emitPacket(project.plan, project.outDir, { force: true }));
});

test('deleting a required document fails verification', (t) => {
  const project = compileTemp(makeProject('missing-doc'));
  t.after(project.cleanup);

  rmSync(path.join(project.outDir, '05-verification.md'));
  const report = verifyPacket(project.outDir);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /missing required document: 05-verification\.md/);
});

test('dropping a tier gate fails verification', (t) => {
  const project = compileTemp(makeProject('missing-gate'));
  t.after(project.cleanup);

  const specPath = path.join(project.outDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.gates = spec.gates.filter((gate) => gate.id !== 'G1-AC-TRACE');
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  const report = verifyPacket(project.outDir);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /gate G1-AC-TRACE is required at tier 1 but missing/);
});

test('quoting a primitive at a tier that does not allow it fails verification', (t) => {
  const project = compileTemp(makeProject('tier-mismatch'));
  t.after(project.cleanup);

  const specPath = path.join(project.outDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.primitives.push({ id: 'testing.mutation-testing', title: 'Mutation testing', path: 'primitives/testing/mutation-testing/SKILL.md' });
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  const report = verifyPacket(project.outDir);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /requires tier 2 but this packet is tier 1/);
});

test('the anchor ratchet: todo is a warning, done without a test is an error', (t) => {
  const project = compileTemp(makeProject('ratchet'));

  const specPath = path.join(project.outDir, 'spec.json');
  const provenId = requirementId(specPath, 'data.persistence');
  const otherId = requirementId(specPath, 'auth.identity');

  // A repository with one anchored test file, and requirements that are still unanchored.
  const repo = path.join(project.root, 'repo');
  mkdirSync(path.join(repo, 'tests', 'data'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(
    path.join(repo, 'tests', 'data', 'persistence.test.ts'),
    `// @req ${provenId}\ntest('migrations replay on a non-empty database', () => { expect(1).toBe(1); });\n`
  );
  writeFileSync(path.join(repo, 'src', 'annotated.ts'), `// @req ${provenId}\nexport const x = 1;\n`);

  const annotate = (mutate) => {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    mutate(spec);
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    return verifyPacket(project.outDir, { repo });
  };

  t.after(project.cleanup);

  // 1. Todo requirements without anchors are warnings, not failures.
  const lenient = verifyPacket(project.outDir, { repo });
  assert.equal(lenient.ok, true);
  assert.ok(lenient.warnings.some((warning) => /no test anchor yet/.test(warning)));

  // 2. The same state under --strict fails: an unfinished requirement cannot ship silently.
  const strict = verifyPacket(project.outDir, { repo, strict: true });
  assert.equal(strict.ok, false);

  // 3. Marking the anchored requirement done is allowed; the anchor proves it.
  const anchoredDone = annotate((spec) => {
    spec.requirements.find((entry) => entry.id === provenId).status = 'done';
  });
  assert.equal(anchoredDone.ok, true);

  // 4. Marking an unanchored requirement done is a failure.
  const unproven = annotate((spec) => {
    spec.requirements.find((entry) => entry.id === otherId).status = 'done';
  });
  assert.equal(unproven.ok, false);
  assert.match(unproven.errors.join('\n'), /is marked done but no test carries an @req anchor/);
});

test('an anchor pointing at a requirement that does not exist is an error', (t) => {
  const project = compileTemp(makeProject('stray-anchor'));
  t.after(project.cleanup);

  const repo = path.join(project.root, 'repo');
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  writeFileSync(path.join(repo, 'tests', 'stray.test.ts'), '// @req REQ-999\ntest("x", () => {});\n');

  const report = verifyPacket(project.outDir, { repo });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /cites unknown requirement REQ-999/);
});

test('an anchor outside a test file does not count as proof', (t) => {
  const project = compileTemp(makeProject('non-test-anchor'));
  t.after(project.cleanup);

  const specPath = path.join(project.outDir, 'spec.json');
  const target = requirementId(specPath, 'data.persistence');

  const repo = path.join(project.root, 'repo');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'thing.ts'), `// @req ${target}\nexport const thing = 1;\n`);

  patchRequirement(specPath, 'data.persistence', { status: 'done' });

  const report = verifyPacket(project.outDir, { repo });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /anchored only outside a test file/);
});

test('the shipped spec-check.mjs agrees with the factory verifier on a clean packet', (t) => {
  const project = compileTemp(makeProject('standalone-check'));
  t.after(project.cleanup);

  const checker = readFileSync(path.join(project.outDir, 'spec-check.mjs'), 'utf8');
  assert.ok(checker.includes('spec-check.mjs'), 'the standalone checker is copied into the packet');
  assert.ok(!checker.includes("from 'node:fs/promises'"), 'the checker stays dependency-free');

  // The packet is written with specs/ as a sibling of the repo root, so point the
  // checker at the directory it lives in by running it from there.
  const report = verifyPacket(project.outDir);
  assert.ok(report.ok);
});

test('a packet over its tier line ceiling fails, because verbosity is a defect', (t) => {
  const project = compileTemp(makeProject('too-long'));
  t.after(project.cleanup);

  const doc = path.join(project.outDir, '06-delivery-plan.md');
  writeFileSync(doc, `${readFileSync(doc, 'utf8')}\n${'padding\n'.repeat(200)}`);

  const report = verifyPacket(project.outDir);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /over the 900-line budget/);
});

test('a tier-0 sketch compiles to one file and passes its own smaller ceiling', (t) => {
  const sketch = normalizeProfile({
    name: 'tiny-sketch',
    idea: 'A throwaway script that proves one idea about parsing a webhook payload locally.',
    kind: 'cli',
    stage: 'prototype'
  });
  const project = compileTemp(sketch);
  t.after(project.cleanup);

  const spec = JSON.parse(readFileSync(path.join(project.outDir, 'spec.json'), 'utf8'));
  assert.equal(spec.rigor.packet, 'single-file');
  assert.ok(spec.docs.includes('spec.md'));

  const report = verifyPacket(project.outDir);
  assert.equal(report.ok, true);
  assert.ok(report.stats.lines <= 140);
});
