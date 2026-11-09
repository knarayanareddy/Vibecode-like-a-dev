/**
 * BLK-4: the people who need enforcement most run it least. It lived in a script the
 * agent had to choose to run, so a chat-only builder got a brief and nothing that
 * fails. `vld ci init` moves the check outside the agent loop: a required pull-request
 * job fails regardless of what the agent did.
 *
 * The integration test the audit asks for is here: initialise in an empty repository,
 * then prove the generated workflow's own commands fail on a stray anchor.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

function cli(args, options = {}) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: options.cwd ?? ROOT }) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** An empty repository with a compiled packet at `packet/`. */
function emptyRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'app');
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# App\n\n```bash\nnpm test\n```\n');

  const profile = normalizeProfile({
    name: 'ci-fixture',
    idea: 'A small tool that records and reports a weekly metric for a team.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true }
  });
  emitPacket(buildPlan(profile, { index: buildIndex() }), path.join(repo, 'packet'));
  return repo;
}

test('ci init writes a workflow that runs the packet with the strict flags', (t) => {
  const repo = emptyRepo(t);
  const result = cli(['ci', 'init', '--project', repo, '--packet', 'packet']);
  assert.equal(result.code, 0, result.stderr);

  const workflow = readFileSync(path.join(repo, '.github', 'workflows', 'spec.yml'), 'utf8');
  assert.match(workflow, /node packet\/spec-check\.mjs --repo \. --strict/);
  assert.match(workflow, /node packet\/enforcement\/gates\.mjs --repo \. --json/);
  assert.match(workflow, /\$GITHUB_STEP_SUMMARY/, 'the result is visible where non-developers look');
  assert.match(workflow, /on:\n  pull_request:/, 'it must run on a pull request');
});

test('the generated workflow fails on a fixture with a stray anchor', (t) => {
  const repo = emptyRepo(t);
  cli(['ci', 'init', '--project', repo, '--packet', 'packet']);

  // Green first: an anchor-free repository passes the strict check.
  const clean = execFileSync(process.execPath, [path.join(repo, 'packet', 'spec-check.mjs'), '--repo', '.'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.match(clean, /PASS/);

  // Then a stray anchor: exactly what the workflow's first step runs.
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  writeFileSync(
    path.join(repo, 'tests', 'stray.test.ts'),
    '// @req REQ-999 this requirement is not in the packet\ntest("nothing", () => { expect(1).toBe(1); });\n'
  );

  let failed = false;
  let output = '';
  try {
    execFileSync(process.execPath, [path.join(repo, 'packet', 'spec-check.mjs'), '--repo', '.', '--strict'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.ok(failed, 'a stray anchor must fail the check the workflow runs');
  assert.match(output, /REQ-999/);
});

test('ci init refuses to guess or to overwrite', (t) => {
  const repo = emptyRepo(t);
  const missing = cli(['ci', 'init', '--project', repo, '--packet', 'packet/does-not-exist']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no packet at/);

  assert.equal(cli(['ci', 'init', '--project', repo, '--packet', 'packet']).code, 0);
  const again = cli(['ci', 'init', '--project', repo, '--packet', 'packet']);
  assert.notEqual(again.code, 0, 'an existing workflow is the team\'s, not ours to replace');
  assert.match(again.stderr, /already exists/);

  const forced = cli(['ci', 'init', '--project', repo, '--packet', 'packet', '--force']);
  assert.equal(forced.code, 0, '--force is the explicit opt-in');
});

test('the packet ships a summary renderer, so the action needs no install', (t) => {
  const repo = emptyRepo(t);
  const summary = path.join(repo, 'packet', 'enforcement', 'summary.mjs');
  assert.ok(existsSync(summary), 'enforcement/summary.mjs is generated with the runner');

  // The renderer reads a gate report and prints the table; it never re-checks.
  writeFileSync(
    path.join(repo, 'report.json'),
    JSON.stringify({
      gates: 2,
      pass: 1,
      fail: 1,
      pending: 0,
      results: [
        { id: 'G0-RUN', status: 'pass', detail: 'README names one command' },
        { id: 'G2-AUTHZ', status: 'fail', detail: 'no authorization test' }
      ]
    })
  );
  const out = execFileSync(process.execPath, [summary, 'report.json'], { cwd: repo, encoding: 'utf8' });
  assert.match(out, /### Specification enforcement — FAIL/);
  assert.match(out, /\| `G0-RUN` \| ✅ pass \|/);
  assert.match(out, /\| `G2-AUTHZ` \| ❌ fail \| no authorization test \|/);
});

test('the repository ships a composite action a non-developer can add', () => {
  const actionPath = path.join(ROOT, '.github', 'actions', 'spec-check', 'action.yml');
  assert.ok(existsSync(actionPath), 'the action exists');
  const action = readFileSync(actionPath, 'utf8');
  assert.match(action, /using: 'composite'/);
  for (const input of ['packet', 'strict', 'comment', 'github-token']) {
    assert.match(action, new RegExp(`\\n  ${input}:`), `the action exposes "${input}"`);
  }
  assert.match(action, /GITHUB_STEP_SUMMARY/, 'it publishes a readable table');
  assert.match(action, /gh pr comment/, 'and it can post that table on the pull request');
});
