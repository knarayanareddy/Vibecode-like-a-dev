/** CI contracts: pinned supply chain, manual live evidence, parallel coverage and portability. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('CI pins every third-party action, has read-only permissions and keeps one aggregate required check', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const live = read('.github', 'workflows', 'live-agent-benchmark.yml');
  const refs = [...actionReferences(ci), ...actionReferences(live)];
  assert.ok(refs.length >= 3);
  for (const ref of refs) {
    const [, revision] = ref.split('@');
    assert.match(revision, FULL_SHA, `${ref} must use a full immutable revision`);
  }
  assert.match(ci, /^permissions:\n  contents: read$/m);
  assert.match(live, /^permissions:\n  contents: read$/m);
  assert.match(ci, /^  check:\n    name: check\n    if: \$\{\{ always\(\) \}\}\n    needs: \[core, integration, packed-distribution, acp-v1-bridge, evaluations, stress, portable-smoke\]/m);
  assert.match(read('.github', 'dependabot.yml'), /package-ecosystem: github-actions/);
});

test('CI separates deterministic evaluations/stress work and validates the portable Node suite', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  assert.match(ci, /^  integration:/m);
  assert.match(ci, /^  packed-distribution:/m);
  assert.match(ci, /^  evaluations:/m);
  assert.match(ci, /^  stress:/m);
  assert.match(ci, /^  portable-smoke:/m);
  assert.match(ci, /os: \[macos-latest, windows-latest\]/);
  assert.match(ci, /name: Full portable test suite[\s\S]*?NODE_OPTIONS=--test-reporter=dot npm test > portable-test\.log[\s\S]*?Portable npm test failure/);
  assert.match(ci, /deterministic outcome calibration/);
  assert.doesNotMatch(ci, /actions\/[\w-]+@v\d/);
});

test('live outcome evidence is manually dispatched, approval-environment gated and artifacted', () => {
  const live = read('.github', 'workflows', 'live-agent-benchmark.yml');
  assert.match(live, /workflow_dispatch:/);
  assert.doesNotMatch(live, /^  pull_request:|^  push:/m);
  assert.match(live, /environment: live-agent-benchmark/);
  assert.match(live, /options: \[openai, anthropic\]/);
  assert.match(live, /--out artifacts\/outcome-report\.json/);
  assert.match(live, /case "\$BENCHMARK_PROVIDER" in openai\|anthropic/);
  assert.match(live, /--model "\$BENCHMARK_MODEL"/);
  assert.doesNotMatch(live, /--model "\$\{\{ inputs\.model \}\}"/);
  assert.match(live, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(live, /provenance\.json/);
  assert.match(live, /retention-days: 90/);
});

test('public CLI calls local processes unconfined rather than claiming a read-only sandbox', () => {
  const result = spawnSync(process.execPath, ['factory/cli.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /local processes are unconfined \(no VLD write authority\)/);
  assert.doesNotMatch(result.stdout, /local processes are read-only without a sandbox/);
});
