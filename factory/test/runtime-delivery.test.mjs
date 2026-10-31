/** M5: exact candidates, disposable integration verification, review and queue. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMission } from '../lib/missions.mjs';
import { defaultDeliveryPolicy, validateDeliveryPolicy } from '../lib/delivery-policy.mjs';
import { approveRuntimeDeliveryCandidate, queueRuntimeDeliveryCandidate, runtimeDeliveryStatus, submitRuntimeDeliveryCandidate, verifyRuntimeDeliveryCandidate } from '../lib/runtime-delivery.mjs';
import { allocateRuntimePackage, initializeRuntime, runtimeDebugPaths } from '../lib/runtime.mjs';
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
  const workspace = git(value.project, ['worktree', 'list', '--porcelain']).split('\n').find((line) => line.startsWith('worktree ') && line !== `worktree ${value.project}`)?.slice('worktree '.length);
  return { agent, workspace };
}

test('M5 freezes the allocated branch head, verifies it in a removed detached worktree, then binds independent approval and a queue receipt', async (t) => {
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
