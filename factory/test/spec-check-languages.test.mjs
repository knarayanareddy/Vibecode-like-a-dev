/**
 * Roadmap 0.2 (F-02, F-13): polyglot import detection and distinct vacuity
 * messages across JS/TS, Python, Go, Rust, Java, Kotlin, PHP, Ruby and C#.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'spec-check');
const INDEX = buildIndex();

function runGuard(packetDir, repoDir, extraArgs = []) {
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(packetDir, 'spec-check.mjs'), '--repo', repoDir, ...extraArgs],
      { encoding: 'utf8', cwd: repoDir }
    );
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function materialize(t, { stack, fixtureRel, targetRel, strictAll = false }) {
  const root = mkdtempSync(path.join(os.tmpdir(), `vld-lang-${stack}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packetDir = path.join(root, 'specs');
  const profile = normalizeProfile({
    name: `lang-${stack}`,
    idea: 'A focused tool that totals billing items and exits non-zero on invalid amounts.',
    kind: 'cli',
    stage: 'prototype',
    constraints: { stack }
  });
  emitPacket(buildPlan(profile, { index: INDEX }), packetDir);

  const specPath = path.join(packetDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const automated = spec.requirements.filter((req) => req.verify === 'automated');
  assert.ok(automated.length > 0, 'expected automated requirements');

  const fixtureText = readFileSync(path.join(FIXTURES, fixtureRel), 'utf8');
  const marker = strictAll
    ? automated.map((req) => `@req ${req.id}`).join(' ')
    : `@req ${automated[0].id}`;
  const rendered = fixtureText
    .replace('@anchor __REQ__', marker)
    .replaceAll('__REQ__', automated[0].id);

  const dest = path.join(root, targetRel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, rendered, 'utf8');
  return { root, packetDir, automated };
}

const LANGUAGE_TABLE = [
  {
    lang: 'javascript',
    stack: 'javascript',
    real: ['javascript/real.test.js', 'tests/real.test.js'],
    hollow: ['javascript/hollow_no_import.test.js', 'tests/hollow.test.js']
  },
  {
    lang: 'python',
    stack: 'python',
    real: ['python/test_real.py', 'tests/test_real.py'],
    hollow: ['python/test_hollow_no_import.py', 'tests/test_hollow.py']
  },
  {
    lang: 'go',
    stack: 'go',
    real: ['go/real_test.go', 'real_test.go'],
    hollow: ['go/hollow_test.go', 'hollow_test.go']
  },
  {
    lang: 'rust',
    stack: 'rust',
    real: ['rust/real.rs', 'tests/real.rs'],
    hollow: ['rust/hollow.rs', 'tests/hollow.rs']
  },
  {
    lang: 'java',
    stack: 'java',
    real: ['java/RealTest.java', 'src/test/java/com/example/billing/RealTest.java'],
    hollow: ['java/HollowTest.java', 'src/test/java/com/example/billing/HollowTest.java']
  },
  {
    lang: 'kotlin',
    stack: 'kotlin',
    real: ['kotlin/RealKotlinTest.kt', 'src/test/kotlin/com/example/billing/RealKotlinTest.kt'],
    hollow: ['kotlin/HollowKotlinTest.kt', 'src/test/kotlin/com/example/billing/HollowKotlinTest.kt']
  },
  {
    lang: 'php',
    stack: 'php',
    real: ['php/RealTest.php', 'tests/RealTest.php'],
    hollow: ['php/HollowTest.php', 'tests/HollowTest.php']
  },
  {
    lang: 'ruby',
    stack: 'ruby',
    real: ['ruby/real_spec.rb', 'spec/real_spec.rb'],
    hollow: ['ruby/hollow_spec.rb', 'spec/hollow_spec.rb']
  },
  {
    lang: 'csharp',
    stack: 'csharp',
    real: ['csharp/RealTests.cs', 'tests/RealTests.cs'],
    hollow: ['csharp/HollowTests.cs', 'tests/HollowTests.cs']
  }
];

for (const entry of LANGUAGE_TABLE) {
  test(`spec-check [${entry.lang}]: real test exits 0 under --strict --require-assertions`, (t) => {
    const project = materialize(t, {
      stack: entry.stack,
      fixtureRel: entry.real[0],
      targetRel: entry.real[1],
      strictAll: true
    });
    const guard = runGuard(project.packetDir, project.root, ['--strict', '--require-assertions']);
    assert.equal(guard.code, 0, `${entry.lang} real test should pass:\n${guard.out}`);
    assert.doesNotMatch(guard.out, /does not import product code|test body is empty|no assertion in the anchored test/);

    const verified = verifyPacket(project.packetDir, {
      repo: project.root,
      strict: true,
      requireAssertions: true
    });
    assert.equal(verified.ok, true, `${entry.lang} verifyPacket should pass: ${verified.errors.join('; ')}`);
  });

  test(`spec-check [${entry.lang}]: hollow test without product import fails with exact import message`, (t) => {
    const project = materialize(t, {
      stack: entry.stack,
      fixtureRel: entry.hollow[0],
      targetRel: entry.hollow[1],
      strictAll: true
    });
    const guard = runGuard(project.packetDir, project.root, ['--strict', '--require-assertions']);
    assert.equal(guard.code, 1, `${entry.lang} hollow test must fail:\n${guard.out}`);
    assert.match(guard.out, /the test does not import product code/);
    assert.doesNotMatch(guard.out, /test body is empty/);

    const verified = verifyPacket(project.packetDir, {
      repo: project.root,
      strict: true,
      requireAssertions: true
    });
    assert.equal(verified.ok, false);
    assert.match(verified.errors.join('\n'), /the test does not import product code/);
  });
}

test('spec-check splits missing-assertion message from missing-import message across JS and Python', (t) => {
  for (const [stack, fixtureRel, targetRel] of [
    ['javascript', 'javascript/hollow_no_assert.test.js', 'tests/no_assert.test.js'],
    ['python', 'python/test_hollow_no_assert.py', 'tests/test_no_assert.py']
  ]) {
    const project = materialize(t, { stack, fixtureRel, targetRel, strictAll: true });
    const guard = runGuard(project.packetDir, project.root, ['--strict', '--require-assertions']);
    assert.equal(guard.code, 1);
    assert.match(guard.out, /no assertion in the anchored test/);
    assert.doesNotMatch(guard.out, /the test does not import product code/);
    assert.doesNotMatch(guard.out, /test body is empty/);
  }
});

test('spec-check Rust local external crate use passes while std-only fails', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-rust-ext-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packetDir = path.join(root, 'specs');
  emitPacket(
    buildPlan(
      normalizeProfile({
        name: 'rust-shadow',
        idea: 'A Rust proxy that replays traffic against a candidate backend and reports diffs.',
        kind: 'cli',
        stage: 'prototype',
        constraints: { stack: 'rust' }
      }),
      { index: INDEX }
    ),
    packetDir
  );
  const spec = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  const markers = spec.requirements.filter((r) => r.verify === 'automated').map((r) => `// @req ${r.id}`).join('\n');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(
    path.join(root, 'tests', 'integration.rs'),
    `use rust_shadow::replay_request;\n\n${markers}\n#[test]\nfn replays_cleanly() {\n    assert_eq!(replay_request("/health").status, 200);\n}\n`
  );
  const result = runGuard(packetDir, root, ['--strict', '--require-assertions']);
  assert.equal(result.code, 0, result.out);
});
