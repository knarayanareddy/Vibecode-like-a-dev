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
  mustMatch(ci, /name: Full portable test suite[\s\S]*?NODE_OPTIONS=--test-reporter=dot npm test > portable-test\.log[\s\S]*?Portable npm test failure/);
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
  mustMatch(live, /provenance\.json/);
  mustMatch(live, /retention-days: 90/);
});

test('public CLI calls local processes unconfined rather than claiming a read-only sandbox', () => {
  const result = spawnSync(process.execPath, ['factory/cli.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /local processes are unconfined \(no VLD write authority\)/);
  assert.doesNotMatch(result.stdout, /local processes are read-only without a sandbox/);
});
