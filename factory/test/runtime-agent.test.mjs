/** M4 adapter host tests: fake lifecycle plus a constrained local process. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMission } from '../lib/missions.mjs';
import { runRuntimeAgent, runtimeAgentStatus } from '../lib/runtime-agent.mjs';
import { allocateRuntimePackage, initializeRuntime, runtimeDebugPaths } from '../lib/runtime.mjs';
import { createWorkspace } from '../lib/workspaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-runtime-agent-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'agent-runtime@example.invalid']);
  git(project, ['config', 'user.name', 'Runtime Agent Test']);
  git(project, ['add', 'specs']);
  git(project, ['commit', '-qm', 'packet']);
  const requirements = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((entry) => entry.id);
  const mission = createMission({
    projectDir: project,
    packetDir: 'specs',
    definition: { schemaVersion: 1, id: 'agent-runtime', title: 'Exercise a constrained Runtime adapter host', workPackages: [{ id: 'agent-work', title: 'Exercise one isolated package adapter run', requirements, dependsOn: [], resourceClaims: { paths: ['src/**'] } }] }
  });
  const missionFile = path.relative(project, mission.file);
  createWorkspace({ missionFile, packageId: 'agent-work', projectDir: project });
  initializeRuntime({ missionFile, projectDir: project });
  const allocated = allocateRuntimePackage({
    missionFile,
    projectDir: project,
    packageId: 'agent-work',
    assignee: { role: 'implementer', id: 'agent-alpha' },
    leaseMs: 30_000
  });
  return { project, missionFile, allocated };
}

function fakePolicy(script) {
  return {
    schemaVersion: 1,
    id: `fake-${script}-policy`,
    adapter: 'fake',
    mode: 'write-workspace',
    capabilities: {
      readWorkspace: true,
      writeWorkspace: true,
      runDeclaredCommands: false,
      network: false,
      streamEvents: true,
      cancel: true,
      reconnect: true,
      sandbox: true,
      credentialAccess: false,
      gitPush: false,
      gitMerge: false
    },
    limits: { durationMs: 1_000, outputBytes: 1_024, retryBudget: 0 },
    environment: {},
    command: { script, executable: null, args: [] }
  };
}

function localProcessPolicy(script) {
  return {
    schemaVersion: 1,
    id: 'local-process-policy',
    adapter: 'local-process',
    mode: 'read-only',
    capabilities: {
      readWorkspace: true,
      writeWorkspace: false,
      runDeclaredCommands: true,
      network: false,
      streamEvents: true,
      cancel: true,
      reconnect: false,
      sandbox: false,
      credentialAccess: false,
      gitPush: false,
      gitMerge: false
    },
    limits: { durationMs: 2_000, outputBytes: 1_024, retryBudget: 0 },
    environment: { LANG: 'C' },
    command: { script: null, executable: process.execPath, args: [script] }
  };
}

test('M4 host requires both an allocated Runtime lease and healthy M2 workspace, then records a redacted fake receipt before changes_ready', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.project, 'agent-policy.json'), `${JSON.stringify(fakePolicy('succeed'))}\n`);
  const result = await runRuntimeAgent({
    missionFile: value.missionFile,
    packageId: 'agent-work',
    policyFile: 'agent-policy.json',
    leaseToken: value.allocated.leaseToken,
    projectDir: value.project
  });
  assert.equal(result.ok, true);
  assert.equal(result.status.packages[0].state, 'changes_ready');
  assert.equal(result.agentRun.adapter, 'fake');
  assert.equal(result.events.some((event) => event.type === 'completed'), true);
  const status = runtimeAgentStatus({ missionFile: value.missionFile, projectDir: value.project });
  assert.equal(status.agentRuns.length, 1);
  assert.equal(status.agentRuns[0].outcome, 'completed');
  const ledger = readFileSync(runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project }).events, 'utf8');
  assert.equal(ledger.includes(value.allocated.leaseToken), false);
  assert.equal(ledger.includes(value.project), false, 'runtime agent receipt stores workspace digest, never raw path');
});

test('M4 host blocks a failed fake adapter and never lets a policy bypass Runtime state ownership', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.project, 'agent-policy.json'), `${JSON.stringify(fakePolicy('fail'))}\n`);
  const result = await runRuntimeAgent({
    missionFile: value.missionFile,
    packageId: 'agent-work',
    policyFile: 'agent-policy.json',
    leaseToken: value.allocated.leaseToken,
    projectDir: value.project
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentRun.outcome, 'failed');
  assert.equal(result.status.packages[0].state, 'blocked');
  await assert.rejects(
    runRuntimeAgent({ missionFile: value.missionFile, packageId: 'agent-work', policyFile: 'agent-policy.json', leaseToken: value.allocated.leaseToken, projectDir: value.project }),
    (error) => error.code === 'RUNTIME_AGENT_NOT_ALLOCATED'
  );
});

test('M4 host turns cancellation into a durable receipt and blocked package', async (t) => {
  const value = fixture(t);
  writeFileSync(path.join(value.project, 'agent-policy.json'), `${JSON.stringify(fakePolicy('succeed'))}\n`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1);
  const result = await runRuntimeAgent({
    missionFile: value.missionFile,
    packageId: 'agent-work',
    policyFile: 'agent-policy.json',
    leaseToken: value.allocated.leaseToken,
    projectDir: value.project,
    signal: controller.signal
  });
  clearTimeout(timer);
  assert.equal(result.ok, false);
  assert.equal(result.agentRun.outcome, 'cancelled');
  assert.equal(result.status.packages[0].state, 'blocked');
});

test('M4 host runs one exact read-only local argv and stores only redacted process output', async (t) => {
  const value = fixture(t);
  const executableFixture = path.join(value.project, 'local-adapter-fixture.mjs');
  writeFileSync(executableFixture, `console.log('cwd=' + process.cwd()); console.log('token=runtime-agent-output-secret');`);
  writeFileSync(path.join(value.project, 'agent-policy.json'), `${JSON.stringify(localProcessPolicy(executableFixture))}\n`);
  const result = await runRuntimeAgent({
    missionFile: value.missionFile,
    packageId: 'agent-work',
    policyFile: 'agent-policy.json',
    leaseToken: value.allocated.leaseToken,
    projectDir: value.project
  });
  assert.equal(result.ok, true);
  assert.equal(result.agentRun.adapter, 'local-process');
  assert.equal(result.agentRun.output.summary.includes('runtime-agent-output-secret'), false);
  assert.equal(result.agentRun.output.summary.includes(value.project), false);
  assert.match(result.agentRun.output.summary, /token=\[REDACTED\]/);
});
