/**
 * End-to-end: compile a packet, then try to break it.
 * These tests are the specification of the enforcement promise.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const result = emitPacket(plan, path.join(root, 'spec'));
  return { root, outDir: result.outDir, plan, progress: result.progress, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

test('recompiling keeps the progress of requirements that are already proven', (t) => {
  const project = compileTemp(makeProject('progress'));
  t.after(project.cleanup);

  const specPath = path.join(project.outDir, 'spec.json');
  const before = JSON.parse(readFileSync(specPath, 'utf8'));
  const done = before.requirements.find((requirement) => requirement.verify === 'automated');
  const pending = before.requirements.find((requirement) => requirement.id !== done.id && requirement.verify === 'automated');

  Object.assign(before.requirements.find((entry) => entry.id === done.id), { status: 'done', anchor: 'tests/custom/location.test.ts' });
  Object.assign(before.requirements.find((entry) => entry.id === pending.id), { status: 'blocked' });
  writeFileSync(specPath, JSON.stringify(before, null, 2));

  // Simulate a policy change: the packet is regenerated from scratch.
  const regenerated = emitPacket(project.plan, project.outDir, { force: true });
  assert.equal(regenerated.progress.carried, 2);

  const after = JSON.parse(readFileSync(specPath, 'utf8'));
  const afterDone = after.requirements.find((entry) => entry.id === done.id);
  const afterPending = after.requirements.find((entry) => entry.id === pending.id);

  assert.equal(afterDone.status, 'done', 'a proven requirement stays proven');
  assert.equal(afterDone.anchor, 'tests/custom/location.test.ts', 'a moved anchor survives');
  assert.equal(afterPending.status, 'blocked');
  assert.equal(after.history.carriedForward, 2);

  // When the profile changes, policy selects a different set. Requirements that
  // drop out take their progress with them, and that must be reported rather than
  // disappearing quietly.
  const asCli = buildPlan(
    normalizeProfile({
      name: 'cli-shape',
      idea: 'The same product described as a command-line tool instead of a web application.',
      kind: 'cli',
      stage: 'mvp',
      traits: ['auth']
    }),
    { index }
  );
  const dropped = emitPacket(asCli, project.outDir, { force: true });
  assert.ok(dropped.progress.removed.length > 0, 'a changed profile drops requirements, and says so');
});

test('a first compile has nothing to carry forward', (t) => {
  const project = compileTemp(makeProject('fresh'));
  t.after(project.cleanup);
  assert.equal(project.progress.carried, 0);
  assert.equal(
    JSON.parse(readFileSync(path.join(project.outDir, 'spec.json'), 'utf8')).history,
    undefined,
    'a packet with no history does not carry an empty history record'
  );
});

test('recompiling with nothing to carry produces the same bytes as a fresh compile', (t) => {
  const project = compileTemp(makeProject('noop'));
  t.after(project.cleanup);

  const recompiled = emitPacket(project.plan, project.outDir, { force: true });
  assert.equal(recompiled.progress.carried, 0);
  assert.equal(recompiled.progress.removed.length, 0);

  const freshDir = path.join(path.dirname(project.outDir), 'fresh-copy');
  emitPacket(project.plan, freshDir, { force: true });

  assert.equal(
    readFileSync(path.join(project.outDir, 'spec.json'), 'utf8'),
    readFileSync(path.join(freshDir, 'spec.json'), 'utf8'),
    'an unchanged recompile is byte-identical to a fresh compile'
  );
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
  // The fixture quotes a bad anchor on purpose, so the line suppresses it.
  // This fixture must contain a bad anchor, yet must not itself look like one to a
  // static scan. Building the marker at runtime keeps both properties true.
  const marker = ['@', 'req '].join('');
  writeFileSync(path.join(repo, 'tests', 'stray.test.ts'), `// ${marker}REQ-999\ntest("x", () => {});\n`);

  const report = verifyPacket(project.outDir, { repo });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /cites unknown requirement REQ-999/);
});

test('a suppressed marker is not an anchor, and the count is reported', (t) => {
  const project = compileTemp(makeProject('suppressed'));
  t.after(project.cleanup);

  const marker = ['@', 'req '].join('');
  const repo = path.join(project.root, 'repo');
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  writeFileSync(path.join(repo, 'tests', 'docs-example.test.ts'), `// ${marker}REQ-999  // @req-ignore: quoting the marker in an example\n`);
  writeFileSync(path.join(repo, 'tests', 'real.test.ts'), `// ${marker}REQ-999\n`);

  const report = verifyPacket(project.outDir, { repo });
  assert.match(report.errors.join('\n'), /cites unknown requirement REQ-999/);
  assert.equal(report.errors.filter((error) => /REQ-999/.test(error)).length, 1, 'only the unsuppressed line fails');
  assert.ok(report.info.some((line) => /1 anchor\(s\) ignored/.test(line)), 'suppression is reported, not silent');
});

test('anchors.exclude removes a path from the scan', (t) => {
  const project = compileTemp(makeProject('excluded'));
  t.after(project.cleanup);

  const marker = ['@', 'req '].join('');
  const repo = path.join(project.root, 'repo');
  mkdirSync(path.join(repo, 'tests', 'fixtures'), { recursive: true });
  writeFileSync(path.join(repo, 'tests', 'fixtures', 'sample.test.ts'), `// ${marker}REQ-999\n`);

  const strictReport = verifyPacket(project.outDir, { repo });
  assert.match(strictReport.errors.join('\n'), /cites unknown requirement REQ-999/);

  const specPath = path.join(project.outDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.anchors = { exclude: ['tests/fixtures/**'] };
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  assert.equal(verifyPacket(project.outDir, { repo }).ok, true);
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

/**
 * The checker shipped inside a packet is a second implementation of the drift
 * rule, because it may not import from this repository. Two implementations mean
 * two chances to disagree, and the copy is the one users actually run — so this
 * runs it as a process and requires the same verdict as the factory verifier on
 * the same repository, in both directions.
 */
function runShippedChecker(packetDir, repo, strict = false) {
  const args = [path.join(packetDir, 'spec-check.mjs'), '--repo', repo];
  if (strict) args.push('--strict');
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ''}` };
  }
}

/** Anchor every automated requirement in a test file, the way an honest repo would. */
function anchorEverything(packetDir, repo) {
  const spec = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  const automated = spec.requirements.filter((requirement) => requirement.verify === 'automated');
  for (const requirement of automated) {
    writeFileSync(
      path.join(repo, 'tests', `${requirement.key.replace(/\./g, '-')}.test.ts`),
      `// @req ${requirement.id}\ntest('${requirement.key}', () => { expect(true).toBe(true); });\n`
    );
    const target = path.join(packetDir, 'spec.json');
    const next = JSON.parse(readFileSync(target, 'utf8'));
    const entry = next.requirements.find((candidate) => candidate.id === requirement.id);
    entry.status = 'done';
    entry.anchor = `tests/${requirement.key.replace(/\./g, '-')}.test.ts`;
    writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  }
  return automated;
}

test('the shipped checker and the factory verifier reach the same verdict', (t) => {
  const project = compileTemp(makeProject('parity'));
  t.after(project.cleanup);

  const checker = readFileSync(path.join(project.outDir, 'spec-check.mjs'), 'utf8');
  assert.ok(!checker.includes("from 'node:fs/promises'"), 'the checker stays dependency-free');

  const repo = path.join(project.root, 'repo');
  mkdirSync(repo, { recursive: true });
  const automated = anchorEverything(project.outDir, repo);
  assert.ok(automated.length > 0, 'the fixture packet has automated requirements to anchor');

  // Both agree when the work is proven.
  assert.equal(verifyPacket(project.outDir, { repo, strict: true }).ok, true);
  const clean = runShippedChecker(project.outDir, repo, true);
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /PASS/);

  // Both agree when a requirement marked done loses its test. Resolve the path the
  // fixture actually wrote, not the example path the generator suggested.
  const victim = automated[0];
  const victimTest = path.join(repo, 'tests', `${victim.key.replace(/\./g, '-')}.test.ts`);
  assert.ok(existsSync(victimTest), 'the fixture wrote the test it is about to delete');
  rmSync(victimTest);
  const factoryVerdict = verifyPacket(project.outDir, { repo, strict: true });
  const shippedVerdict = runShippedChecker(project.outDir, repo, true);
  assert.equal(factoryVerdict.ok, false);
  assert.equal(shippedVerdict.code, 1);
  assert.match(shippedVerdict.stdout, new RegExp(victim.id), 'the shipped checker names the requirement it lost');

  // Both agree when an anchor names a requirement that does not exist.
  // Built at runtime: a literal marker in this repository would make the guard
  // fail on the test that proves the guard rejects unknown requirements.
  const strayMarker = ['@', 'req '].join('');
  writeFileSync(path.join(repo, 'tests', 'stray.test.ts'), `// ${strayMarker}REQ-999\ntest('stray', () => {});\n`);
  assert.equal(verifyPacket(project.outDir, { repo, strict: true }).ok, false);
  assert.equal(runShippedChecker(project.outDir, repo, true).code, 1);
});

test('a packet without a browser interface does not ask for a browser test', (t) => {
  const project = compileTemp(
    normalizeProfile({ name: 'go-cli', idea: 'A command-line tool that never renders a page.', kind: 'cli', stage: 'production', constraints: { stack: 'go' } })
  );
  t.after(project.cleanup);

  const plan = readFileSync(path.join(project.outDir, '05-verification.md'), 'utf8');
  const layers = plan.slice(plan.indexOf('## 1. Test layers'), plan.indexOf('## 2.'));
  assert.ok(!/Playwright/.test(layers), 'no Playwright row for a product with no browser');
  assert.match(layers, /go test/);
});

test('a single-file packet never points at documents it does not ship', (t) => {
  // Tier 0 ships spec.md, spec.json, AGENTS.md and the checker. An instruction to
  // read 05-verification.md there is an instruction to read a missing file.
  const project = compileTemp(
    normalizeProfile({ name: 'sketch', idea: 'A one-week prototype of a note-taking CLI that will be deleted if it is wrong.', kind: 'cli', stage: 'prototype' })
  );
  t.after(project.cleanup);

  const shipped = readdirSync(project.outDir);
  const text = shipped
    .filter((file) => file.endsWith('.md'))
    .map((file) => readFileSync(path.join(project.outDir, file), 'utf8'))
    .join('\n');

  const referenced = [...text.matchAll(/\b(0[0-7]-[a-z-]+\.md)\b/g)].map((match) => match[1]);
  const missing = [...new Set(referenced)].filter((file) => !shipped.includes(file));
  assert.deepEqual(missing, [], `packet references documents it does not ship: ${missing.join(', ')}`);
});

test('a single-file packet states the stack it is asking for', (t) => {
  const project = compileTemp(
    normalizeProfile({
      name: 'go-sketch',
      idea: 'A one-week prototype written in a language the packet must not guess at.',
      kind: 'cli',
      stage: 'prototype',
      constraints: { stack: 'go' }
    })
  );
  t.after(project.cleanup);

  const text = readFileSync(path.join(project.outDir, 'spec.md'), 'utf8');
  assert.match(text, /\bGo\b/, 'the declared stack is named');
  assert.match(text, /go test/, 'the commands match the declared stack');
});

test('the idea\'s own rules that no requirement covers are listed, not dropped', (t) => {
  const project = compileTemp(
    makeProject('unmapped', {
      idea: 'A booking service for therapists. A booking must never double-book a therapist, and a cancellation must free the slot immediately.'
    })
  );
  t.after(project.cleanup);

  const brief = readFileSync(path.join(project.outDir, '01-product-brief.md'), 'utf8');
  assert.match(brief, /Obligations in the idea with no requirement yet/);
  assert.match(brief, /never double-book a therapist/, 'the rule the catalog cannot know is quoted back');
});

test('an idea whose rules the catalog already covers produces no gap list', (t) => {
  const project = compileTemp(
    makeProject('covered', {
      // The rule the catalog does carry: server-side authorization, deny by default.
      idea: 'An API where an actor must be authorized server-side before reading any record.',
      traits: ['auth', 'persistence'],
      risks: { pii: true }
    })
  );
  t.after(project.cleanup);

  const brief = readFileSync(path.join(project.outDir, '01-product-brief.md'), 'utf8');
  assert.ok(!brief.includes('Obligations in the idea with no requirement yet'), 'no invented gap when the catalog covers it');
});

test('a packet never borrows vocabulary from another product', (t) => {
  // The domain model used to illustrate "name your own nouns" with the example
  // project's nouns. A payments packet then talked about a retro board.
  const project = compileTemp(makeProject('vocab', { kind: 'library', traits: [], risks: { payments: true } }));
  t.after(project.cleanup);

  const text = readdirSync(project.outDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => readFileSync(path.join(project.outDir, file), 'utf8'))
    .join('\n');

  for (const borrowed of ['retro board', 'retro-board', 'board, card, vote']) {
    assert.ok(!text.toLowerCase().includes(borrowed), `packet mentions "${borrowed}", which belongs to an example project`);
  }
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
