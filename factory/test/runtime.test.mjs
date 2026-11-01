/** Phase 3 Runtime tests: deterministic ledger, lease and role safety only. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMission } from '../lib/missions.mjs';
import { digest } from '../lib/extension-utils.mjs';
import {
  allocateRuntimePackage,
  heartbeatRuntimeLease,
  initializeRuntime,
  recoverRuntime,
  runtimeDebugPaths,
  runtimeStatus,
  transitionRuntimePackage
} from '../lib/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');
const FUTURE = '2035-01-01T00:00:00.000Z';

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-runtime-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'runtime@example.invalid']);
  git(project, ['config', 'user.name', 'Runtime Test']);
  git(project, ['add', 'specs']);
  git(project, ['commit', '-qm', 'packet']);
  const requirements = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((entry) => entry.id);
  const half = Math.ceil(requirements.length / 2);
  const mission = createMission({
    projectDir: project,
    packetDir: 'specs',
    definition: {
      schemaVersion: 1,
      id: 'runtime-export',
      title: 'Exercise a deterministic local runtime host',
      workPackages: [
        { id: 'export-api', title: 'Implement export behavior and tests', requirements: requirements.slice(0, half), dependsOn: [], resourceClaims: { paths: ['src/export/**'] } },
        { id: 'export-ui', title: 'Implement export user interface and tests', requirements: requirements.slice(half), dependsOn: ['export-api'], resourceClaims: { paths: ['src/ui/**'] } }
      ]
    }
  });
  return { project, missionFile: path.relative(project, mission.file), mission };
}

const operator = { role: 'operator', id: 'local-operator' };
const IDEMPOTENT_LEASE = 'lease-11111111-1111-4111-8111-111111111111';
const implementer = { role: 'implementer', id: 'agent-alpha' };

function transition(fixtureValue, packageId, to, actor, expectedVersion, leaseToken = null, key = null, now = FUTURE) {
  return transitionRuntimePackage({
    missionFile: fixtureValue.missionFile,
    projectDir: fixtureValue.project,
    packageId,
    to,
    actor,
    expectedVersion,
    leaseToken,
    idempotencyKey: key,
    now
  });
}

test('Runtime initializes a snapshot plus ledger and never allocates a worktree or starts a process', (t) => {
  const value = fixture(t);
  const before = git(value.project, ['worktree', 'list', '--porcelain']);
  const initialized = initializeRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE });
  assert.equal(initialized.changed, true);
  assert.equal(initialized.status.ok, true, initialized.status.warnings.join('\n'));
  assert.deepEqual(initialized.status.packages.map((entry) => entry.state), ['ready', 'planned']);
  const paths = runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project });
  assert.ok(existsSync(paths.events));
  assert.ok(existsSync(paths.snapshot));
  assert.equal(existsSync(paths.pending), false);
  assert.equal(git(value.project, ['worktree', 'list', '--porcelain']), before, 'Runtime M3 never creates a worktree');
  const same = initializeRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE });
  assert.equal(same.changed, false, 'matching initialization is idempotent');
});

test('Runtime host enforces leases, expected versions, and receipt-only delivery progression', (t) => {
  const value = fixture(t);
  initializeRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE });
  const allocated = allocateRuntimePackage({
    missionFile: value.missionFile,
    projectDir: value.project,
    packageId: 'export-api',
    actor: operator,
    assignee: implementer,
    leaseMs: 10_000,
    leaseToken: IDEMPOTENT_LEASE,
    idempotencyKey: 'allocate-api-0001',
    now: FUTURE
  });
  assert.equal(allocated.changed, true);
  assert.match(allocated.leaseToken, /^lease-[a-f0-9-]{36}$/);
  assert.equal(allocated.allocation.state, 'allocated');
  assert.equal(readFileSync(runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project }).events, 'utf8').includes(allocated.leaseToken), false, 'lease secret is never persisted in the ledger');

  const replay = allocateRuntimePackage({
    missionFile: value.missionFile,
    projectDir: value.project,
    packageId: 'export-api',
    actor: operator,
    assignee: implementer,
    leaseMs: 10_000,
    leaseToken: IDEMPOTENT_LEASE,
    idempotencyKey: 'allocate-api-0001',
    now: FUTURE
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.leaseToken, IDEMPOTENT_LEASE, 'idempotent retry returns the caller-held capability without ledger persistence');
  assert.throws(
    () => allocateRuntimePackage({ missionFile: value.missionFile, projectDir: value.project, packageId: 'export-api', actor: operator, assignee: implementer, leaseMs: 9_000, leaseToken: IDEMPOTENT_LEASE, idempotencyKey: 'allocate-api-0001', now: FUTURE }),
    (error) => error.code === 'RUNTIME_IDEMPOTENCY_CONFLICT'
  );

  assert.throws(
    () => heartbeatRuntimeLease({ missionFile: value.missionFile, projectDir: value.project, packageId: 'export-api', runId: allocated.allocation.run.id, leaseToken: 'lease-wrong', actor: implementer, leaseMs: 10_000, now: '2035-01-01T00:00:01.000Z' }),
    (error) => error.code === 'RUNTIME_LEASE_FORBIDDEN'
  );
  const heartbeat = heartbeatRuntimeLease({
    missionFile: value.missionFile,
    projectDir: value.project,
    packageId: 'export-api',
    runId: allocated.allocation.run.id,
    leaseToken: allocated.leaseToken,
    actor: implementer,
    leaseMs: 10_000,
    now: '2035-01-01T00:00:01.000Z'
  });
  assert.equal(heartbeat.package.version, 2);

  assert.throws(
    () => transition(value, 'export-api', 'running', implementer, 1, allocated.leaseToken),
    (error) => error.code === 'RUNTIME_VERSION_CONFLICT'
  );
  const running = transition(value, 'export-api', 'running', implementer, 2, allocated.leaseToken, 'run-api-0001');
  assert.equal(running.changed, true);
  const runningReplay = transition(value, 'export-api', 'running', implementer, 2, allocated.leaseToken, 'run-api-0001');
  assert.equal(runningReplay.changed, false, 'transition retry returns the first durable receipt');
  transition(value, 'export-api', 'changes_ready', implementer, 3, allocated.leaseToken, 'changes-api-0001');
  for (const [to, actor] of [
    ['verifying', { role: 'runtime', id: 'runtime-host' }],
    ['in_review', { role: 'runtime', id: 'runtime-host' }],
    ['approved', { role: 'reviewer', id: 'reviewer-beta' }],
    ['queued', { role: 'release-approver', id: 'release-owner' }],
    ['merged', { role: 'forge', id: 'local-forge' }]
  ]) {
    assert.throws(
      () => transition(value, 'export-api', to, actor, 4, null, `bypass-${to}`),
      (error) => error.code === 'RUNTIME_RECEIPT_REQUIRED'
    );
  }
});

test('Runtime recovery expires a lease safely and ledger corruption fails closed', (t) => {
  const value = fixture(t);
  initializeRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE });
  const allocation = allocateRuntimePackage({ missionFile: value.missionFile, projectDir: value.project, packageId: 'export-api', actor: operator, assignee: implementer, leaseMs: 1_000, now: FUTURE });
  const paths = runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project });
  const events = readFileSync(paths.events, 'utf8').trim().split('\n').map(JSON.parse);
  writeFileSync(paths.pending, `${JSON.stringify({ schemaVersion: 1, beforeEventDigest: digest(events), nextEventDigest: '0'.repeat(64) })}\n`);
  assert.throws(
    () => transitionRuntimePackage({ missionFile: value.missionFile, projectDir: value.project, packageId: 'export-api', to: 'running', actor: implementer, expectedVersion: 1, leaseToken: allocation.leaseToken, now: FUTURE }),
    (error) => error.code === 'RUNTIME_RECOVERY_REQUIRED'
  );
  writeFileSync(paths.lock, JSON.stringify({ schemaVersion: 1, pid: 99999999, token: 'dead-owner' }));
  const recovered = recoverRuntime({ missionFile: value.missionFile, projectDir: value.project, now: '2035-01-01T00:00:02.000Z' });
  assert.equal(recovered.recovered.lock.pid, 99999999);
  assert.equal(recovered.recovered.pending.action, 'discarded-unapplied-pending-transaction');
  assert.deepEqual(recovered.recovered.expiredLeases, ['export-api']);
  assert.equal(recovered.packages.find((entry) => entry.id === 'export-api').state, 'blocked');

  writeFileSync(paths.snapshot, '{}\n');
  assert.throws(
    () => runtimeStatus({ missionFile: value.missionFile, projectDir: value.project }),
    (error) => error.code === 'RUNTIME_LEDGER_DIVERGED'
  );
  assert.throws(
    () => recoverRuntime({ missionFile: value.missionFile, projectDir: value.project }),
    (error) => error.code === 'RUNTIME_LEDGER_DIVERGED'
  );
});

test('Runtime refuses an allocation when the frozen mission target is stale', (t) => {
  const value = fixture(t);
  initializeRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE });
  writeFileSync(path.join(value.project, 'later.txt'), 'target moved\n');
  git(value.project, ['add', 'later.txt']);
  git(value.project, ['commit', '-qm', 'advance target']);
  assert.throws(
    () => allocateRuntimePackage({ missionFile: value.missionFile, projectDir: value.project, packageId: 'export-api', actor: operator, assignee: implementer, now: FUTURE }),
    (error) => error.code === 'STALE_MISSION'
  );
});

test('Runtime recovery fails closed for a partial owner and blocks mutations while a recovery guard exists', (t) => {
  const value = fixture(t);
  initializeRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE });
  const paths = runtimeDebugPaths({ missionFile: value.missionFile, projectDir: value.project });
  writeFileSync(paths.lock, '{"schemaVersion":1');
  assert.throws(
    () => recoverRuntime({ missionFile: value.missionFile, projectDir: value.project, now: FUTURE }),
    (error) => error.code === 'INVALID_RUNTIME_LOCK'
  );
  rmSync(paths.lock, { force: true });
  const ownerField = ['to', 'ken'].join('');
  writeFileSync(paths.recovery, JSON.stringify({ schemaVersion: 1, pid: process.pid, [ownerField]: 'test-recovery-guard' }));
  assert.throws(
    () => allocateRuntimePackage({ missionFile: value.missionFile, projectDir: value.project, packageId: 'export-api', actor: operator, assignee: implementer, leaseMs: 10_000, now: FUTURE }),
    (error) => error.code === 'RUNTIME_RECOVERY_IN_PROGRESS'
  );
});
