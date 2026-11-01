/** CI contracts: pinned supply chain, manual live evidence, parallel coverage and portability. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Git may check workflow files out with CRLF on Windows; policy matching is line-ending agnostic.
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const FULL_SHA = /^[a-f0-9]{40}$/;

function actionReferences(workflow) {
  return [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
}

// Keep a portability failure concise: Node otherwise prints the complete workflow
// as an assertion "actual" value, which obscures the useful runner diagnostic.
function mustMatch(value, pattern, message) {
  assert.ok(pattern.test(value), message ?? `expected ${pattern} to match`);
}

function mustNotMatch(value, pattern, message) {
  assert.ok(!pattern.test(value), message ?? `expected ${pattern} not to match`);
}

test('CI pins every third-party action, has read-only permissions and keeps one aggregate required check', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const live = read('.github', 'workflows', 'live-agent-benchmark.yml');
  const refs = [...actionReferences(ci), ...actionReferences(live)];
  assert.ok(refs.length >= 3);
  for (const ref of refs) {
    const [, revision] = ref.split('@');
    assert.match(revision, FULL_SHA, `${ref} must use a full immutable revision`);
  }
  mustMatch(ci, /^permissions:\n  contents: read$/m);
  mustMatch(live, /^permissions:\n  contents: read$/m);
  mustMatch(ci, /^  check:\n    name: check\n    if: \$\{\{ always\(\) \}\}\n    needs: \[core, integration, packed-distribution, acp-v1-bridge, evaluations, stress, portable-smoke\]/m);
  assert.match(read('.github', 'dependabot.yml'), /package-ecosystem: github-actions/);
});

test('CI separates deterministic evaluations/stress work and validates the portable Node suite', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  mustMatch(ci, /^  integration:/m);
  mustMatch(ci, /^  packed-distribution:/m);
  mustMatch(ci, /^  evaluations:/m);
  mustMatch(ci, /^  stress:/m);
  mustMatch(ci, /^  portable-smoke:/m);
  mustMatch(ci, /os: \[macos-latest, windows-latest\]/);
  mustMatch(ci, /name: Full portable test suite[\s\S]*?shell: bash[\s\S]*?NODE_OPTIONS=--test-reporter=dot npm test/);
  mustNotMatch(ci, /portable-test\.log|Portable npm test failure/);
  mustMatch(ci, /deterministic outcome calibration/);
  mustNotMatch(ci, /actions\/[\w-]+@v\d/);
});

test('live outcome evidence is manually dispatched, approval-environment gated and artifacted', () => {
  const live = read('.github', 'workflows', 'live-agent-benchmark.yml');
  mustMatch(live, /workflow_dispatch:/);
  mustNotMatch(live, /^  pull_request:|^  push:/m);
  mustMatch(live, /environment: live-agent-benchmark/);
  mustMatch(live, /options: \[openai, anthropic\]/);
  mustMatch(live, /--out artifacts\/outcome-report\.json/);
  mustMatch(live, /case "\$BENCHMARK_PROVIDER" in openai\|anthropic/);
  mustMatch(live, /--model "\$BENCHMARK_MODEL"/);
  mustNotMatch(live, /--model "\$\{\{ inputs\.model \}\}"/);
  mustMatch(live, /actions\/upload-artifact@[a-f0-9]{40}/);
  mustMatch(live, /scripts\/write-live-benchmark-provenance\.mjs --out artifacts\/provenance\.json/);
  mustNotMatch(live, /JSON\.stringify[\s\S]*?\\\\n/);
  mustMatch(live, /retention-days: 90/);
});


test('live benchmark provenance generation writes parseable JSON evidence', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vld-provenance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'nested', 'provenance.json');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'write-live-benchmark-provenance.mjs'), '--out', output], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BENCHMARK_PROVIDER: 'openai',
      BENCHMARK_MODEL: 'test-model-2026',
      BENCHMARK_TASKS: 'brownfield',
      BENCHMARK_COMMIT: 'a'.repeat(40),
      BENCHMARK_RUN_ID: '12345',
      BENCHMARK_RUN_ATTEMPT: '2',
      BENCHMARK_RUNNER_OS: 'Linux',
      ImageOS: 'ubuntu24',
      ImageVersion: '20261030.1'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(output, 'utf8');
  assert.ok(text.endsWith('\n'), 'the artifact is conventional newline-terminated JSON, not a literal backslash-n suffix');
  const provenance = JSON.parse(text);
  assert.deepEqual(
    { provider: provenance.provider, model: provenance.model, tasks: provenance.tasks, commit: provenance.commit, runId: provenance.runId, runAttempt: provenance.runAttempt, runnerOs: provenance.runnerOs, runnerImageOs: provenance.runnerImageOs, runnerImageVersion: provenance.runnerImageVersion },
    { provider: 'openai', model: 'test-model-2026', tasks: 'brownfield', commit: 'a'.repeat(40), runId: '12345', runAttempt: '2', runnerOs: 'Linux', runnerImageOs: 'ubuntu24', runnerImageVersion: '20261030.1' }
  );
  assert.equal(provenance.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(provenance.generatedAt)), 'provenance records when this empirical run occurred');
});

test('public CLI calls local processes unconfined rather than claiming a read-only sandbox', () => {
  const result = spawnSync(process.execPath, ['factory/cli.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /local processes are unconfined \(no VLD write authority\)/);
  assert.doesNotMatch(result.stdout, /local processes are read-only without a sandbox/);
});


test('lint skips linked files and directory loops instead of parsing outside the requested root', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-lint-links-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'vld-lint-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(path.join(root, 'valid.mjs'), 'export const valid = true;\n');
  writeFileSync(path.join(outside, 'invalid.mjs'), 'this is not valid JavaScript {{{\n');
  symlinkSync(path.join(outside, 'invalid.mjs'), path.join(root, 'outside.mjs'));
  mkdirSync(path.join(root, 'nested'));
  symlinkSync(root, path.join(root, 'nested', 'loop'), 'dir');

  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lint.mjs'), '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 modules parse/);
});


test('README quick start names Node 22 and both supported npm and source paths', () => {
  const readme = read('README.md');
  assert.match(readme, /Node\.js 22 or newer/);
  assert.match(readme, /npx --yes github:knarayanareddy\/Vibecode-like-a-dev/);
  assert.match(readme, /npm install --global github:knarayanareddy\/Vibecode-like-a-dev/);
  assert.match(readme, /git clone https:\/\/github\.com\/knarayanareddy\/Vibecode-like-a-dev/);
});
