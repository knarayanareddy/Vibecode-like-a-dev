/**
 * Public command journeys for VLD's optional platform layer. Module, adapter and
 * workflow unit tests cover schemas; these prove that the one executable parses
 * real flags, persists the expected state and never invokes an external agent.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


test('public mission journey freezes a packet/target and reports stale target state without launching an agent', async (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-mission-cli-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  cpSync(path.join(ROOT, 'examples', 'retro-board', 'spec'), path.join(project, 'specs'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'mission@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Mission Test'], { cwd: project });
  execFileSync('git', ['add', 'specs'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'packet'], { cwd: project });

  const requirements = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((requirement) => requirement.id);
  writeFileSync(path.join(project, 'definition.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'report-export',
    title: 'Implement report export in an isolated package',
    workPackages: [{ id: 'export-api', title: 'Implement export behavior with tests', requirements, dependsOn: [], resourceClaims: { paths: ['src/export/**', 'test/export/**'] } }]
  }, null, 2)}
`);

  const initialized = await cli(['mission', 'init', 'definition.json', '--packet', 'specs', '--project', project, '--json']);
  assert.equal(initialized.code, 0, initialized.stderr);
  const mission = JSON.parse(initialized.stdout);
  assert.equal(mission.ok, true);
  assert.ok(existsSync(path.join(project, 'missions', 'report-export', 'mission.json')));
  assert.match(mission.mission.target.commit, /^[a-f0-9]{40}$/);
  assert.equal(existsSync(path.join(project, '.vld', 'runtime')), false, 'the mission command does not start a runtime');

  const validated = await cli(['mission', 'validate', 'missions/report-export/mission.json', '--project', project, '--json']);
  assert.equal(validated.code, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).ok, true);

  const workspace = await cli(['workspace', 'create', 'missions/report-export/mission.json', 'export-api', '--project', project, '--json']);
  assert.equal(workspace.code, 0, workspace.stderr);
  const allocation = JSON.parse(workspace.stdout).allocation;
  assert.ok(existsSync(allocation.worktree));
  assert.match(allocation.branch, /^vld\/report-export\/export-api$/);
  const workspaceStatus = await cli(['workspace', 'status', 'missions/report-export/mission.json', '--project', project, '--json']);
  assert.equal(workspaceStatus.code, 0, workspaceStatus.stderr);
  assert.equal(JSON.parse(workspaceStatus.stdout).packageStatus[0].status.state, 'healthy');
  const workspaceRemoved = await cli(['workspace', 'remove', 'missions/report-export/mission.json', 'export-api', '--project', project, '--json']);
  assert.equal(workspaceRemoved.code, 0, workspaceRemoved.stderr);
  assert.equal(existsSync(allocation.worktree), false);

  const runtimeInitialized = await cli(['runtime', 'init', 'missions/report-export/mission.json', '--project', project, '--json']);
  assert.equal(runtimeInitialized.code, 0, runtimeInitialized.stderr);
  assert.equal(JSON.parse(runtimeInitialized.stdout).status.packages[0].state, 'ready');
  const runtimeAllocated = await cli(['runtime', 'allocate', 'missions/report-export/mission.json', 'export-api', '--assignee', 'agent-alpha', '--project', project, '--json']);
  assert.equal(runtimeAllocated.code, 0, runtimeAllocated.stderr);
  const runtimeLease = JSON.parse(runtimeAllocated.stdout).leaseToken;
  assert.match(runtimeLease, /^lease-/);
  const runtimeState = await cli(['runtime', 'status', 'missions/report-export/mission.json', '--project', project, '--json']);
  assert.equal(runtimeState.code, 0, runtimeState.stderr);
  assert.equal(JSON.parse(runtimeState.stdout).packages[0].state, 'allocated');

  const runtimeWorkspace = await cli(['workspace', 'create', 'missions/report-export/mission.json', 'export-api', '--project', project, '--json']);
  assert.equal(runtimeWorkspace.code, 0, runtimeWorkspace.stderr);
  const fakePolicy = {
    schemaVersion: 1, id: 'cli-fake-policy', adapter: 'fake', mode: 'write-workspace',
    capabilities: { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: false, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true, credentialAccess: false, gitPush: false, gitMerge: false },
    limits: { durationMs: 1000, outputBytes: 1024, retryBudget: 0 }, environment: {}, command: { script: 'succeed', executable: null, args: [] }
  };
  writeFileSync(path.join(project, 'agent-policy.json'), `${JSON.stringify(fakePolicy)}\n`);
  const agentRun = await cli(['runtime', 'agent', 'run', 'missions/report-export/mission.json', 'export-api', '--policy', 'agent-policy.json', '--lease-token', runtimeLease, '--project', project, '--json']);
  assert.equal(agentRun.code, 0, agentRun.stderr);
  assert.equal(JSON.parse(agentRun.stdout).status.packages[0].state, 'changes_ready');
  const agentStatus = await cli(['runtime', 'agent', 'status', 'missions/report-export/mission.json', '--project', project, '--json']);
  assert.equal(agentStatus.code, 0, agentStatus.stderr);
  assert.equal(JSON.parse(agentStatus.stdout).agentRuns[0].adapter, 'fake');

  writeFileSync(path.join(project, 'README.md'), '# next target\n');
  execFileSync('git', ['add', 'README.md'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'target moved'], { cwd: project });
  const stale = await cli(['mission', 'status', 'missions/report-export/mission.json', '--project', project, '--json']);
  assert.equal(stale.code, 1, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).stale[0].kind, 'target');

  const missingPacket = await cli(['mission', 'init', 'definition.json', '--project', project]);
  assert.equal(missingPacket.code, 2);
  assert.match(missingPacket.stderr, /requires --packet/);
  const packetWithoutValue = await cli(['mission', 'init', 'definition.json', '--project', project, '--packet']);
  assert.equal(packetWithoutValue.code, 2);
  assert.match(packetWithoutValue.stderr, /requires --packet/);
  const targetWithoutValue = await cli(['mission', 'init', 'definition.json', '--project', project, '--packet', 'specs', '--target']);
  assert.equal(targetWithoutValue.code, 2);
  assert.match(targetWithoutValue.stderr, /--target requires a ref value/);
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
  const assets = await cli(['store', 'assets', 'team-playbook', '--project', consumer, '--json']);
  assert.equal(assets.code, 0, assets.stderr); assert.equal(JSON.parse(assets.stdout).stores[0].assets[0].id, 'review-guidance');
  const copied = await cli(['store', 'copy', 'team-playbook', 'review-guidance', '--project', consumer, '--json']);
  assert.equal(copied.code, 0, copied.stderr); assert.match(JSON.parse(copied.stdout).output, /docs[\\/]shared[\\/]team-playbook[\\/]review-guidance\.md$/);

  writeFileSync(path.join(source, 'review.md'), '# Review\n\nReview changed evidence before release.\n');
  execFileSync('git', ['add', '.'], { cwd: source }); execFileSync('git', ['commit', '-q', '-m', 'refresh candidate'], { cwd: source });
  const preview = await cli(['store', 'diff', 'team-playbook', '--project', consumer, '--json']);
  assert.equal(preview.code, 0, preview.stderr);
  const previewJson = JSON.parse(preview.stdout);
  assert.equal(previewJson.changes.changed, true);
  const missingAcknowledgement = await cli(['store', 'update', 'team-playbook', '--project', consumer]);
  assert.equal(missingAcknowledgement.code, 2); assert.match(missingAcknowledgement.stderr, /--acknowledge/);
  const updated = await cli(['store', 'update', 'team-playbook', '--acknowledge', previewJson.next.commit, '--project', consumer, '--json']);
  assert.equal(updated.code, 0, updated.stderr); assert.equal(JSON.parse(updated.stdout).store.acknowledgedCommit, previewJson.next.commit);

  const unsafe = await cli(['store', 'add', 'unsafe', '--bad', '--project', consumer]);
  assert.equal(unsafe.code, 2); assert.match(unsafe.stderr, /safe Git URL|Usage/); assert.equal(unsafe.stdout, '');
});

test('public export journey emits a bounded Spec Kit and Kiro view without replacing packet authority', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-export-cli-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const packet = path.join(ROOT, 'examples', 'retro-board', 'spec');

  const specKit = await cli(['export', 'spec-kit', packet, '--out', path.join(workspace, 'spec-kit'), '--json']);
  assert.equal(specKit.code, 0, specKit.stderr);
  assert.equal(JSON.parse(specKit.stdout).source.project, 'retro-board');
  assert.ok(existsSync(path.join(workspace, 'spec-kit', '.specify', 'memory', 'constitution.md')));

  const kiro = await cli(['export', 'kiro', packet, '--out', path.join(workspace, 'kiro')]);
  assert.equal(kiro.code, 0, kiro.stderr);
  assert.match(kiro.stdout, /generated, one-way interoperability/);
  assert.ok(existsSync(path.join(workspace, 'kiro', '.kiro', 'specs', 'vld-packet', 'requirements.md')));

  const invalid = await cli(['export', 'made-up', packet, '--out', path.join(workspace, 'invalid')]);
  assert.equal(invalid.code, 2); assert.match(invalid.stderr, /unknown export format/);
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

  const noArtifacts = await cli(['artifact', 'verify', '--project', project, '--json']);
  assert.equal(noArtifacts.code, 1);
  assert.equal(JSON.parse(noArtifacts.stdout).ok, false);
  assert.equal(noArtifacts.stderr, '');

  const missingAdapter = await cli(['agent', 'install', 'invented-agent', '--project', project]);
  assert.equal(missingAdapter.code, 2);
  assert.match(missingAdapter.stderr, /unknown agent adapter/);
  assert.equal(existsSync(path.join(project, '.agents')), false, 'a rejected adapter performs no installation');
});
