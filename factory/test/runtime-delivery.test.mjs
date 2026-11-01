/** M5: exact candidates, disposable integration verification, review and queue. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMission } from '../lib/missions.mjs';
import { defaultDeliveryPolicy, validateDeliveryPolicy } from '../lib/delivery-policy.mjs';
import { approveRuntimeDeliveryCandidate, queueRuntimeDeliveryCandidate, runtimeDeliveryStatus, submitRuntimeDeliveryCandidate, verifyRuntimeDeliveryCandidate } from '../lib/runtime-delivery.mjs';
import { allocateRuntimePackage, initializeRuntime, recordRuntimeForgePlan, runtimeDebugPaths, runtimeStatus } from '../lib/runtime.mjs';
import { exportRuntimeForgePlan, prepareRuntimeForgePlan, writeRuntimeForgePlan } from '../lib/runtime-forge.mjs';
import { digest } from '../lib/extension-utils.mjs';
import { requestGitHubMerge } from '../integrations/github-v1/index.mjs';
import { runRuntimeAgent } from '../lib/runtime-agent.mjs';
import { createWorkspace } from '../lib/workspaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fakePolicy() {
  return {
    schemaVersion: 1,
    id: 'delivery-fake-agent',
    adapter: 'fake',
    mode: 'write-workspace',
    capabilities: { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: false, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true, credentialAccess: false, gitPush: false, gitMerge: false },
    limits: { durationMs: 1_000, outputBytes: 1_024, retryBudget: 0 },
    environment: {},
    command: { script: 'succeed', executable: null, args: [] }
  };
}

function fixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-runtime-delivery-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'delivery@example.invalid']);
  git(project, ['config', 'user.name', 'Delivery Test']);
  git(project, ['add', 'specs']);
  git(project, ['commit', '-qm', 'packet']);
  const requirements = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((entry) => entry.id);
  const mission = createMission({
    projectDir: project,
    packetDir: 'specs',
    definition: { schemaVersion: 1, id: 'delivery-runtime', title: 'Exercise M5 delivery identity', workPackages: [{ id: 'delivery-work', title: 'A delivery candidate package', requirements, dependsOn: [], resourceClaims: { paths: ['src/**'] } }] }
  });
  const missionFile = path.relative(project, mission.file);
  createWorkspace({ missionFile, packageId: 'delivery-work', projectDir: project });
  initializeRuntime({ missionFile, projectDir: project });
  const allocated = allocateRuntimePackage({ missionFile, projectDir: project, packageId: 'delivery-work', assignee: { role: 'implementer', id: 'agent-alpha' }, leaseMs: 30_000 });
  writeFileSync(path.join(project, 'agent-policy.json'), `${JSON.stringify(fakePolicy())}\n`);
  writeFileSync(path.join(project, 'delivery-policy.json'), `${JSON.stringify(defaultDeliveryPolicy())}\n`);
  return { project, missionFile, allocated };
}

async function changesReady(value) {
  const agent = await runRuntimeAgent({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'agent-policy.json', leaseToken: value.allocated.leaseToken, projectDir: value.project });
  assert.equal(agent.ok, true);
  const primary = realpathSync(value.project);
  const workspace = git(value.project, ['worktree', 'list', '--porcelain']).split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((entry) => realpathSync(entry) !== primary);
  return { agent, workspace };
}

test('M5 delivery foundation and M8.1 forge export bind only a verified approved queued tuple', async (t) => {
  const value = fixture(t);
  const { agent, workspace } = await changesReady(value);
  const candidateSha = git(workspace, ['rev-parse', 'HEAD']);
  const beforeWorktrees = git(value.project, ['worktree', 'list', '--porcelain']);
  const submitted = submitRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', leaseToken: value.allocated.leaseToken, candidateSha, adapterRunId: agent.agentRun.id, projectDir: value.project });
  assert.equal(submitted.package.state, 'verifying');
  assert.equal(submitted.candidate.candidateSha, candidateSha);
  assert.equal(submitted.candidate.missionId, 'delivery-runtime');
  assert.equal(submitted.candidate.packageId, 'delivery-work');
  assert.equal(submitted.candidate.policyDigest.length, 64);
  const verified = verifyRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', projectDir: value.project });
  assert.equal(verified.verification.outcome, 'passed');
  assert.equal(verified.package.state, 'in_review');
  assert.equal(git(value.project, ['worktree', 'list', '--porcelain']), beforeWorktrees, 'M5 integration worktree is removed after verification');
  const approved = approveRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', candidateId: submitted.candidate.id, actor: { role: 'reviewer', id: 'reviewer-beta' }, reason: 'independent packet and candidate review passed', projectDir: value.project });
  assert.equal(approved.package.state, 'approved');
  const queued = queueRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', candidateId: submitted.candidate.id, actor: { role: 'release-approver', id: 'release-gamma' }, projectDir: value.project });
  assert.equal(queued.package.state, 'queued');
  const status = runtimeDeliveryStatus({ missionFile: value.missionFile, projectDir: value.project });
  assert.equal(status.delivery.length, 4);
  assert.deepEqual(status.delivery.map((entry) => Object.keys(entry).find((key) => ['candidate', 'verification', 'approval', 'queue'].includes(key))), ['candidate', 'verification', 'approval', 'queue']);
  const ledger = readFileSync(runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project }).events, 'utf8');
  assert.equal(ledger.includes(value.allocated.leaseToken), false, 'delivery ledger has no lease secret');
  assert.equal(ledger.includes(workspace), false, 'delivery ledger has no worktree path');
  assert.equal(ledger.includes('git push'), false);
  const cli = JSON.parse(execFileSync(process.execPath, [CLI, 'runtime', 'delivery', 'status', value.missionFile, '--project', value.project, '--json'], { encoding: 'utf8' }));
  assert.equal(cli.delivery.length, 4, 'public CLI exposes only Runtime-derived delivery receipts');
  assert.equal(JSON.stringify(cli).includes(value.allocated.leaseToken), false);

  const forgeRequest = {
    missionFile: value.missionFile,
    packageId: 'delivery-work',
    candidateId: submitted.candidate.id,
    repository: 'example/vld-runtime',
    headRef: 'vld/delivery-work',
    requiredChecks: ['lint', 'packet-check'],
    projectDir: value.project,
    now: '2026-11-01T00:00:00.000Z'
  };
  const prepared = prepareRuntimeForgePlan(forgeRequest);
  assert.equal(prepared.plan.allowMergeRequest, false, 'offline export plans can never authorize merge requests');
  assert.equal(prepared.plan.headSha, submitted.candidate.candidateSha);
  assert.equal(prepared.forge.queueId, queued.queue.id);
  assert.equal(prepared.forge.verificationDigest.length, 64);
  assert.equal(prepared.plan.requiredChecks.join(','), 'lint,packet-check');

  const dryRun = JSON.parse(execFileSync(process.execPath, [CLI, 'runtime', 'forge', 'plan-export', value.missionFile, 'delivery-work', '--project', value.project, '--candidate', submitted.candidate.id, '--actor', 'release-approver:release-gamma', '--repository', 'example/vld-runtime', '--head-ref', 'vld/delivery-work', '--checks', 'packet-check,lint', '--dry-run', '--json'], { encoding: 'utf8' }));
  assert.equal(dryRun.dryRun, true);
  assert.equal(runtimeDeliveryStatus({ missionFile: value.missionFile, projectDir: value.project }).delivery.length, 4, 'dry run writes neither a receipt nor an output file');

  const unsignedPlan = { ...prepared.plan };
  delete unsignedPlan.digest;
  const credentialPlan = { ...unsignedPlan, body: 'authorization: fictional-value', digest: digest({ ...unsignedPlan, body: 'authorization: fictional-value' }) };
  await assert.rejects(
    async () => recordRuntimeForgePlan({ missionFile: value.missionFile, packageId: 'delivery-work', projectDir: value.project, actor: { role: 'release-approver', id: 'release-gamma' }, forge: { ...prepared.forge, plan: credentialPlan } }),
    (error) => error.code === 'INVALID_RUNTIME_FORGE_RECEIPT'
  );
  await assert.rejects(
    async () => recordRuntimeForgePlan({ missionFile: value.missionFile, packageId: 'delivery-work', projectDir: value.project, actor: { role: 'release-approver', id: 'release-gamma' }, forge: { ...prepared.forge, candidateSha: '0'.repeat(40) } }),
    (error) => error.code === 'INVALID_RUNTIME_FORGE_RECEIPT'
  );
  const hostPathPlan = { ...unsignedPlan, title: `/tmp/${prepared.candidateId}`, digest: digest({ ...unsignedPlan, title: `/tmp/${prepared.candidateId}` }) };
  await assert.rejects(
    async () => recordRuntimeForgePlan({ missionFile: value.missionFile, packageId: 'delivery-work', projectDir: value.project, actor: { role: 'release-approver', id: 'release-gamma' }, forge: { ...prepared.forge, plan: hostPathPlan } }),
    (error) => error.code === 'INVALID_RUNTIME_FORGE_RECEIPT'
  );
  await assert.rejects(
    async () => recordRuntimeForgePlan({ missionFile: value.missionFile, packageId: 'delivery-work', projectDir: value.project, actor: { role: 'reviewer', id: 'reviewer-beta' }, forge: prepared.forge }),
    (error) => error.code === 'RUNTIME_ACTOR_FORBIDDEN'
  );

  const exported = exportRuntimeForgePlan({ ...forgeRequest, actor: { role: 'release-approver', id: 'release-gamma' } });
  assert.equal(exported.changed, true);
  assert.equal(exported.forge.id, prepared.forge.id);
  const replay = exportRuntimeForgePlan({ ...forgeRequest, now: '2026-11-02T00:00:00.000Z', actor: { role: 'release-approver', id: 'release-gamma' } });
  assert.equal(replay.changed, false, 'the same evidence and plan replays the original durable receipt');
  assert.equal(replay.forge.exportedAt, exported.forge.exportedAt);
  let providerCalls = 0;
  await assert.rejects(
    async () => requestGitHubMerge({ client: { request() { providerCalls += 1; } }, plan: exported.plan, pullNumber: 7 }),
    (error) => error.code === 'GITHUB_MERGE_NOT_ALLOWED'
  );
  assert.equal(providerCalls, 0, 'a safe exported plan cannot initiate a provider request');
  await assert.rejects(
    async () => writeRuntimeForgePlan({ projectDir: value.project, outFile: '.vld/forge.json', plan: exported.plan }),
    (error) => error.code === 'INVALID_RUNTIME_FORGE_PATH'
  );

  const cliPlan = JSON.parse(execFileSync(process.execPath, [CLI, 'runtime', 'forge', 'plan-export', value.missionFile, 'delivery-work', '--project', value.project, '--candidate', submitted.candidate.id, '--actor', 'release-approver:release-gamma', '--repository', 'example/vld-runtime', '--head-ref', 'vld/delivery-work', '--checks', 'packet-check,lint', '--out', 'review/forge-plan.json', '--json'], { encoding: 'utf8' }));
  assert.equal(cliPlan.changed, false, 'CLI plan export uses the replay-validated receipt');
  assert.equal(cliPlan.output.file, 'review/forge-plan.json');
  const writtenPlan = JSON.parse(readFileSync(path.join(value.project, 'review', 'forge-plan.json'), 'utf8'));
  assert.deepEqual(writtenPlan, exported.plan, 'CLI writes the exact reviewed immutable plan');
  assert.equal(JSON.stringify(cliPlan).includes(value.project), false, 'public output never contains project paths');

  const forgeStatus = runtimeDeliveryStatus({ missionFile: value.missionFile, projectDir: value.project });
  assert.equal(forgeStatus.delivery.length, 5);
  assert.equal(forgeStatus.delivery.at(-1).forge.plan.digest, exported.plan.digest);
  const forgeLedger = readFileSync(runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project }).events, 'utf8');
  assert.equal(forgeLedger.includes(value.project), false, 'forge ledger has no project path');
  assert.equal(forgeLedger.includes('fictional-value'), false, 'forge ledger rejects credential-like material');
  assert.equal(forgeLedger.includes('gh auth'), false);

  writeFileSync(path.join(value.project, 'authority-change.txt'), 'target moved\n');
  git(value.project, ['add', 'authority-change.txt']);
  git(value.project, ['commit', '-qm', 'move frozen target']);
  await assert.rejects(
    async () => prepareRuntimeForgePlan(forgeRequest),
    (error) => error.code === 'STALE_MISSION'
  );

  const eventsPath = runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project }).events;
  const tampered = readFileSync(eventsPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  tampered.at(-1).forge.plan.title = 'tampered approved plan';
  writeFileSync(eventsPath, `${tampered.map((event) => JSON.stringify(event)).join('\n')}\n`);
  await assert.rejects(
    async () => runtimeStatus({ missionFile: value.missionFile, projectDir: value.project }),
    (error) => error.code === 'INVALID_RUNTIME_LEDGER'
  );
});

test('M5 blocks a candidate when its integrated packet digest differs and retains only a bounded check receipt', async (t) => {
  const value = fixture(t);
  const { agent, workspace } = await changesReady(value);
  const spec = path.join(workspace, 'specs', 'spec.json');
  writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n`);
  git(workspace, ['add', 'specs/spec.json']);
  git(workspace, ['commit', '-qm', 'change packet bytes']);
  const candidateSha = git(workspace, ['rev-parse', 'HEAD']);
  submitRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', leaseToken: value.allocated.leaseToken, candidateSha, adapterRunId: agent.agentRun.id, projectDir: value.project });
  const verified = verifyRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', projectDir: value.project });
  assert.equal(verified.verification.outcome, 'failed');
  assert.equal(verified.package.state, 'blocked');
  assert.equal(verified.verification.checks[0].output.summary.includes(workspace), false);
  assert.equal(verified.verification.checks[0].output.digest.length, 64);
});

test('M5 rejects candidate SHA/branch mismatch and self-review before any verification or queue action', async (t) => {
  const value = fixture(t);
  const { agent, workspace } = await changesReady(value);
  const candidateSha = git(workspace, ['rev-parse', 'HEAD']);
  await assert.rejects(
    async () => submitRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', leaseToken: value.allocated.leaseToken, candidateSha: '0'.repeat(40), adapterRunId: agent.agentRun.id, projectDir: value.project }),
    (error) => error.code === 'CANDIDATE_NOT_BRANCH_HEAD'
  );
  const submitted = submitRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', leaseToken: value.allocated.leaseToken, candidateSha, adapterRunId: agent.agentRun.id, projectDir: value.project });
  verifyRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', projectDir: value.project });
  await assert.rejects(
    async () => approveRuntimeDeliveryCandidate({ missionFile: value.missionFile, packageId: 'delivery-work', policyFile: 'delivery-policy.json', candidateId: submitted.candidate.id, actor: { role: 'reviewer', id: 'agent-alpha' }, reason: 'not independent', projectDir: value.project }),
    (error) => error.code === 'INVALID_RUNTIME_LEDGER' || error.code === 'SELF_REVIEW_FORBIDDEN'
  );
  const status = runtimeDeliveryStatus({ missionFile: value.missionFile, projectDir: value.project });
  assert.equal(status.packages[0].state, 'in_review');
  assert.equal(status.delivery.length, 2);
});

test('M5 delivery policy remains closed: arbitrary project verifier commands and merge/push capability are rejected', () => {
  const unsafeCommand = defaultDeliveryPolicy();
  unsafeCommand.verification.commands = ['npm test'];
  assert.equal(validateDeliveryPolicy(unsafeCommand).ok, false);
  const unsafeMerge = defaultDeliveryPolicy();
  unsafeMerge.merge.push = true;
  assert.equal(validateDeliveryPolicy(unsafeMerge).ok, false);
});
