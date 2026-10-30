/**
 * Public command journeys for VLD's optional platform layer. Module, adapter and
 * workflow unit tests cover schemas; these prove that the one executable parses
 * real flags, persists the expected state and never invokes an external agent.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

async function cli(args) {
  try {
    const result = await run(process.execPath, [CLI, ...args], { cwd: ROOT });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const PROFILE = {
  name: 'platform-journey',
  idea: 'A SaaS project used to test VLD bundles, coding-agent handoffs and the resumable discovery workflow.',
  kind: 'web-app',
  stage: 'mvp',
  users: { scale: 'small' },
  traits: [],
  risks: {},
  constraints: { team: 2, weeks: 4, stack: 'typescript', mustUse: [] }
};

test('public platform journey: bundle, module lock, Codex handoff and discovery workflow', async (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-platform-cli-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const profile = path.join(project, 'profile.json');
  writeFileSync(profile, `${JSON.stringify(PROFILE, null, 2)}\n`);

  const listed = await cli(['module', 'list', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).modules.length, 5);

  const dry = await cli(['bundle', 'apply', 'startup-saas', '--project', project, '--profile', profile, '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(existsSync(path.join(project, '.vld')), false, 'dry run does not create hidden state');

  const bundled = await cli(['bundle', 'apply', 'startup-saas', '--project', project, '--profile', profile]);
  assert.equal(bundled.code, 0, bundled.stderr);
  assert.match(bundled.stdout, /applied bundle startup-saas/);
  const profileAfter = JSON.parse(readFileSync(profile, 'utf8'));
  assert.deepEqual(profileAfter.traits, ['auth', 'persistence']);
  assert.equal(profileAfter.risks.publicFacing, true);

  const locked = await cli(['module', 'verify', '--project', project, '--json']);
  assert.equal(locked.code, 0, locked.stderr);
  assert.equal(JSON.parse(locked.stdout).ok, true);

  const installed = await cli(['agent', 'install', 'codex', '--project', project]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.ok(existsSync(path.join(project, '.agents', 'skills', 'vld-discovery', 'SKILL.md')));
  const agents = await cli(['agent', 'status', 'codex', '--project', project, '--json']);
  assert.equal(agents.code, 0, agents.stderr);
  assert.equal(JSON.parse(agents.stdout).ok, true);

  const preview = await cli(['workflow', 'run', 'discovery', '--project', project, '--profile', profile, '--json']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).started, false, 'run previews until --execute is explicit');

  const started = await cli(['workflow', 'run', 'discovery', '--project', project, '--profile', profile, '--execute', '--json']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).steps[0].status, 'ready');

  const completedIntent = await cli([
    'workflow', 'complete', 'discovery', 'capture-intent',
    '--project', project,
    '--evidence', 'Product owner reviewed users, non-goals and risk flags before planning.',
    '--json'
  ]);
  assert.equal(completedIntent.code, 0, completedIntent.stderr);

  const planRan = await cli(['workflow', 'run', 'discovery', '--project', project, '--execute', '--json']);
  assert.equal(planRan.code, 0, planRan.stderr);
  assert.deepEqual(JSON.parse(planRan.stdout).executed.map((entry) => entry.id), ['plan']);

  for (const [step, evidence] of [
    ['draft-brief', 'Product brief created at docs/product-brief.md with assumptions tied to VLD requirements.'],
    ['approve-brief', 'Accountable owner approved the bounded brief for architecture and delivery work.']
  ]) {
    const completed = await cli(['workflow', 'complete', 'discovery', step, '--project', project, '--evidence', evidence]);
    assert.equal(completed.code, 0, completed.stderr);
  }
  const status = await cli(['workflow', 'status', 'discovery', '--project', project, '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.ok(JSON.parse(status.stdout).steps.every((step) => step.status === 'complete'));
});

test('public store journey pins a file-backed Git snapshot and reports clean failures', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-store-cli-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const source = path.join(workspace, 'source'); const consumer = path.join(workspace, 'consumer');
  const initialized = await cli(['store', 'init', source, '--id', 'team-playbook', '--title', 'Team playbook', '--json']);
  assert.equal(initialized.code, 0, initialized.stderr);
  writeFileSync(path.join(source, 'review.md'), '# Review\n\nKeep evidence linked to the reviewed requirements.\n');
  const manifest = JSON.parse(readFileSync(path.join(source, 'vld-store.json'), 'utf8'));
  manifest.assets.push({ id: 'review-guidance', kind: 'guidance', file: 'review.md' });
  writeFileSync(path.join(source, 'vld-store.json'), JSON.stringify(manifest));
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source }); execFileSync('git', ['commit', '-q', '-m', 'store'], { cwd: source });
  mkdirSync(consumer);
  const added = await cli(['store', 'add', 'team-playbook', `file://${source}`, '--project', consumer, '--json']);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).store.assets.length, 1);
  const status = await cli(['store', 'status', 'team-playbook', '--project', consumer, '--json']);
  assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).ok, true);
  const unsafe = await cli(['store', 'add', 'unsafe', '--bad', '--project', consumer]);
  assert.equal(unsafe.code, 2); assert.match(unsafe.stderr, /safe Git URL|Usage/); assert.equal(unsafe.stdout, '');
});

test('public platform failures are clean usage/input errors, not agent invocations or stack traces', async (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-platform-errors-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));

  const unknownModule = await cli(['module', 'enable', 'imaginary', '--project', project]);
  assert.equal(unknownModule.code, 2);
  assert.equal(unknownModule.stdout, '');
  assert.match(unknownModule.stderr, /unknown module/);
  assert.doesNotMatch(unknownModule.stderr, /^\s+at\s/m);

  // Enable the workflow dependency first, so this checks the distinct lifecycle
  // failure rather than treating a missing module as an implicit approval.
  const enabled = await cli(['module', 'enable', 'product', '--project', project]);
  assert.equal(enabled.code, 0, enabled.stderr);
  const missingEvidence = await cli(['workflow', 'complete', 'discovery', 'capture-intent', '--project', project]);
  assert.equal(missingEvidence.code, 2);
  assert.match(missingEvidence.stderr, /has not started/);
  assert.doesNotMatch(missingEvidence.stderr, /^\s+at\s/m);

  const missingAdapter = await cli(['agent', 'install', 'invented-agent', '--project', project]);
  assert.equal(missingAdapter.code, 2);
  assert.match(missingAdapter.stderr, /unknown agent adapter/);
  assert.equal(existsSync(path.join(project, '.agents')), false, 'a rejected adapter performs no installation');
});
