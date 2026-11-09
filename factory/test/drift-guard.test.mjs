/**
 * BLK-2: the drift guard could be satisfied by a test that proves nothing.
 *
 * Three vacuous shapes passed in every mode, including `--require-assertions`:
 * `expect(true).toBe(true)`, an anchored `test.skip`, and an empty test body. And
 * `done` was a string anybody could type into spec.json.
 *
 * Each case below runs the packet's own checker against a fixture, because the claim
 * is about the shipped file, not about a helper the tests call.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A repository with a compiled packet and one controllable test file. */
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'packet');
  const profile = normalizeProfile({
    name: 'drift-fixture',
    idea: 'A small tool that records and reports a weekly metric for a team.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true }
  });
  emitPacket(buildPlan(profile, { index: buildIndex() }), packageDir);
  writeFileSync(path.join(root, 'README.md'), '# App\n\n```bash\nnpm test\n```\n');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'run.js'), 'export const run = () => 0;\n');

  const specPath = path.join(packageDir, 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const automated = spec.requirements.filter((requirement) => requirement.verify === 'automated');
  assert.ok(automated.length > 0, 'the fixture packet has an automated requirement');

  return {
    root,
    specPath,
    spec,
    target: automated[0].id,
    writeTest: (body) => {
      mkdirSync(path.join(root, 'tests'), { recursive: true });
      writeFileSync(path.join(root, 'tests', 'journey.test.ts'), body);
    },
    markDone: (ids) => {
      const current = JSON.parse(readFileSync(specPath, 'utf8'));
      for (const requirement of current.requirements) {
        requirement.status = ids.includes(requirement.id) ? 'done' : 'todo';
      }
      writeFileSync(specPath, JSON.stringify(current, null, 2));
    },
    run: (...args) => {
      try {
        const stdout = execFileSync(
          process.execPath,
          [path.join(packageDir, 'spec-check.mjs'), '--repo', root, ...args],
          { encoding: 'utf8', cwd: root }
        );
        return { code: 0, out: stdout };
      } catch (error) {
        return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
      }
    }
  };
}

test('expect(true).toBe(true) is an error, not a pass', (t) => {
  const f = fixture(t);
  f.writeTest(`import { run } from '../src/run.js';\n// @req ${f.target}\ntest('looks like a test', () => { expect(true).toBe(true); });\n`);
  const result = f.run();
  assert.equal(result.code, 1, 'a literal assertion cannot prove a requirement');
  // The message names the call, so the reader does not have to find the line.
  assert.match(result.out, /cannot fail/);
});

test('a skipped or todo test carrying an anchor is an error', (t) => {
  const f = fixture(t);
  f.writeTest(`import { run } from '../src/run.js';\n// @req ${f.target}\ntest.skip('never runs', () => { expect(run()).toBe(0); });\n`);
  const result = f.run();
  assert.equal(result.code, 1);
  assert.match(result.out, /skipped, todo or disabled/);
});

test('an empty test body and an import-free test file are rejected', (t) => {
  const empty = fixture(t);
  empty.writeTest(`import { run } from '../src/run.js';\n// @req ${empty.target}\ntest('nothing', () => {});\n`);
  const emptyResult = empty.run('--require-assertions');
  assert.equal(emptyResult.code, 1);
  assert.match(emptyResult.out, /test body is empty/);

  const orphan = fixture(t);
  orphan.writeTest(`// @req ${orphan.target}\ntest('magic', () => { expect(compute()).toBe(1); });\n`);
  const orphanResult = orphan.run('--require-assertions');
  assert.equal(orphanResult.code, 1);
  assert.match(orphanResult.out, /imports nothing/);
});

test('a real test still passes, so the guard is not a blanket refusal', (t) => {
  const f = fixture(t);
  f.writeTest(
    `import { run } from '../src/run.js';\n// @req ${f.target}\ntest('${f.target} runs from a clean clone', () => { expect(run()).toBe(0); });\n`
  );
  const result = f.run('--require-assertions');
  assert.equal(result.code, 0, result.out);
});

test('done without a passing test in the report is an error', (t) => {
  const f = fixture(t);
  f.markDone([f.target]);
  f.writeTest(
    `import { run } from '../src/run.js';\n// @req ${f.target}\ntest('${f.target} works', () => { expect(run()).toBe(0); });\n`
  );

  // The test failed in the run: done is a stale claim.
  writeFileSync(path.join(f.root, 'report.tap'), `TAP version 13\nnot ok 1 - ${f.target} works\nok 2 - something else\n1..2\n`);
  const failed = f.run('--report', 'report.tap');
  assert.equal(failed.code, 1);
  assert.match(failed.out, new RegExp(`${f.target} is marked done, but no passing test`));

  // The test passed in the run: the claim is justified.
  writeFileSync(path.join(f.root, 'report.tap'), `TAP version 13\nok 1 - ${f.target} works\n1..1\n`);
  assert.equal(f.run('--report', 'report.tap').code, 0);
});

test('the report reader understands vitest JSON and JUnit XML too', (t) => {
  const f = fixture(t);
  f.markDone([f.target]);
  f.writeTest(
    `import { run } from '../src/run.js';\n// @req ${f.target}\ntest('${f.target} works', () => { expect(run()).toBe(0); });\n`
  );

  writeFileSync(
    path.join(f.root, 'vitest.json'),
    JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { fullName: `${f.target} works`, status: 'passed' },
            { fullName: 'other', status: 'failed' }
          ]
        }
      ]
    })
  );
  assert.equal(f.run('--report', 'vitest.json').code, 0, 'vitest JSON is understood');

  writeFileSync(
    path.join(f.root, 'junit.xml'),
    `<?xml version="1.0"?>\n<testsuite name="s" tests="1"><testcase name="${f.target} works" classname="journey" /></testsuite>\n`
  );
  assert.equal(f.run('--report', 'junit.xml').code, 0, 'JUnit XML is understood');

  writeFileSync(
    path.join(f.root, 'junit-failed.xml'),
    `<?xml version="1.0"?>\n<testsuite name="s" tests="1"><testcase name="${f.target} works" classname="journey"><failure message="x" /></testcase></testsuite>\n`
  );
  assert.equal(f.run('--report', 'junit-failed.xml').code, 1, 'a failed JUnit case does not justify done');
});

test('the generated CI workflow runs the strict flags by default', (t) => {
  const f = fixture(t);
  // The safe path must be the default one: a team that never reads the flags still
  // gets strict drift checking.
  // fileURLToPath, not URL.pathname: on Windows pathname yields "/D:/a/...", which
  // path.resolve then mangles into a path that does not exist.
  const cliPath = path.resolve(HERE, '..', 'cli.mjs');
  execFileSync(process.execPath, [cliPath, 'ci', 'init', '--project', f.root, '--packet', 'packet'], { cwd: f.root });
  const workflow = readFileSync(path.join(f.root, '.github', 'workflows', 'spec.yml'), 'utf8');
  assert.match(workflow, /spec-check\.mjs --repo \. --strict --require-assertions/);
  assert.match(workflow, /--report test-report\.json/, 'the evidence path is documented in the workflow it generates');
});
/**
 * BLK-1: the tautology rule was written per call style, so every style it did not
 * name was a hole. `assert.equal(1, 1)` — the idiom this repository's own tests
 * use — passed, because the pattern matched `assert(...)` and never
 * `assert.<method>(`. The check is now structural: read the arguments, and call it
 * vacuous when every argument is a literal or when it compares a name to itself.
 */
for (const [label, body] of [
  ['assert.equal', 'assert.equal(1, 1);'],
  ['assert.ok', 'assert.ok(true);'],
  ['assert.strictEqual', "assert.strictEqual('a', 'a');"],
  ['assert.equal on one name', "assert.equal(state, state);"]
]) {
  test(`a tautology in ${label} form is an error, not a pass`, (t) => {
    const f = fixture(t);
    f.writeTest(`import { run } from '../src/run.js';\n// @req ${f.target}\ntest('looks like a test', () => { ${body} });\n`);
    const result = f.run();
    assert.equal(result.code, 1, `${body} cannot prove a requirement`);
    assert.match(result.out, /cannot fail/);
  });
}

test('an assertion on computed values is not vacuous', (t) => {
  const f = fixture(t);
  // The mirror of the rule above: `add(1, 1)` contains literals but is not itself a
  // literal, and rejecting it would make the check hostile to real tests.
  f.writeTest(
    `import { run } from '../src/run.js';
// @req ${f.target}
const add = (a, b) => a + b;
test('computes', () => { assert.equal(add(1, 1), 2); assert.ok(run() === 0); });
`
  );
  const result = f.run('--require-assertions');
  assert.doesNotMatch(result.out, /cannot fail/);
});

test('a test file that imports only test infrastructure does not reach the product', (t) => {
  const f = fixture(t);
  // `import from 'node:test'` satisfied the old import rule, so "imports nothing"
  // never fired for any file that looked like a test.
  f.writeTest(
    `import test from 'node:test';
import assert from 'node:assert/strict';
// @req ${f.target}
test('asserts on nothing in particular', () => { assert.equal(Date.now() > 0, true); });
`
  );
  const result = f.run('--require-assertions');
  assert.equal(result.code, 1);
  assert.match(result.out, /imports nothing/);
});

/**
 * The flag exists and works; this pins that the repository actually *uses* it.
 *
 * `--require-assertions` is off by default upstream because a half-written test is
 * normal during development. That default is right for an emitted packet and wrong
 * for this repository, whose own drift guard is the check that is supposed to catch
 * a weakened test. Without the flag the report prints the notice and the job exits 0,
 * so an agent can hollow a test out and CI still goes green — the exact failure the
 * audit named. A follow-up that drops the flag would restore that gap silently, so
 * the workflow file itself is asserted here.
 */
test('this repository runs its drift guard with --require-assertions', () => {
  const workflow = readFileSync(path.join(HERE, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const specCheckLines = workflow
    .split('\n')
    .filter((line) => /run:.*spec-check\.mjs/.test(line) && /--repo \./.test(line));
  assert.ok(specCheckLines.length > 0, 'ci.yml must run the repository drift guard');
  for (const line of specCheckLines) {
    assert.match(line, /--require-assertions/, `drift guard must pass --require-assertions: ${line.trim()}`);
  }
});
