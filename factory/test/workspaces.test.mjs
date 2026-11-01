/**
 * Worktree allocation tests.
 *
 * These use real temporary Git repositories and real `git worktree` commands.
 * They intentionally prove no agent, model, arbitrary project command, push or
 * merge is involved in the Phase 2 workspace foundation.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createMission } from '../lib/missions.mjs';
import {
  createWorkspace,
  inspectWorkspaceLock,
  recoverWorkspaces,
  removeWorkspace,
  setWorkspaceLockTestHook,
  workspaceStatus
} from '../lib/workspaces.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function workspaceEntries(project) {
  return git(project, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree '));
}

function createFixture(t, { overlap = false } = {}) {
  const container = mkdtempSync(path.join(os.tmpdir(), 'vld-workspace-'));
  const project = path.join(container, 'project');
  mkdirSync(project);
  t.after(() => rmSync(container, { recursive: true, force: true }));
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'workspace-test@example.invalid']);
  git(project, ['config', 'user.name', 'Workspace Test']);
  git(project, ['add', 'specs']);
  git(project, ['commit', '-qm', 'packet']);

  const ids = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((entry) => entry.id);
  const halfway = Math.ceil(ids.length / 2);
  const definition = {
    schemaVersion: 1,
    id: 'parallel-export',
    title: 'Implement parallel export work packages safely',
    workPackages: [
      {
        id: 'export-api',
        title: 'Implement export API behavior and tests',
        requirements: ids.slice(0, halfway),
        dependsOn: [],
        resourceClaims: { paths: ['src/export/**', 'test/export/**'] }
      },
      {
        id: 'export-ui',
        title: 'Implement export UI behavior and tests',
        requirements: ids.slice(halfway),
        dependsOn: [],
        resourceClaims: { paths: overlap ? ['src/export/**'] : ['src/ui/**', 'test/ui/**'] }
      }
    ]
  };
  const created = createMission({ definition, projectDir: project, packetDir: 'specs' });
  return { container, project, missionFile: path.relative(project, created.file), mission: created.mission };
}

async function cli(args) {
  try {
    const result = await run(process.execPath, [CLI, ...args], { cwd: ROOT });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('workspace creation uses a sibling managed root, is idempotent, and isolates files between packages', (t) => {
  const fixture = createFixture(t);
  const first = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project });
  assert.equal(first.changed, true);
  assert.match(first.allocation.id, /^workspace-[a-f0-9-]{36}$/);
  assert.match(first.allocation.branch, /^vld\/parallel-export\/export-api$/);
  assert.equal(first.allocation.baseCommit, fixture.mission.target.commit);
  assert.ok(existsSync(first.allocation.worktree));
  assert.ok(first.allocation.worktree.startsWith(path.join(realpathSync(fixture.container), '.vld-worktrees')));
  assert.equal(first.allocation.worktree.startsWith(fixture.project), false, 'worktree is never created inside the project checkout');
  assert.equal(workspaceEntries(fixture.project).length, 2, 'primary checkout plus one allocation');

  const duplicate = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.allocation.id, first.allocation.id);
  assert.equal(workspaceEntries(fixture.project).length, 2, 'idempotent allocation does not create a second worktree');

  const second = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-ui', projectDir: fixture.project });
  assert.equal(second.changed, true);
  assert.equal(workspaceEntries(fixture.project).length, 3);
  writeFileSync(path.join(first.allocation.worktree, 'only-api.txt'), 'isolated work\n');
  assert.equal(existsSync(path.join(second.allocation.worktree, 'only-api.txt')), false, 'uncommitted files do not leak across worktrees');

  const status = workspaceStatus({ missionFile: fixture.missionFile, projectDir: fixture.project });
  assert.equal(status.ok, true, status.errors.join('\n'));
  assert.deepEqual(status.packageStatus.map((entry) => entry.status.state), ['healthy', 'healthy']);
  const state = JSON.parse(readFileSync(path.join(fixture.project, '.vld', 'workspaces.json'), 'utf8'));
  assert.equal(state.allocations.length, 2);
  assert.equal(state.receipts.length, 0);
});

test('workspace safety centralizes the ledger and refuses malformed state or a symlinked registered worktree', (t) => {
  const fixture = createFixture(t);
  const nested = path.join(fixture.project, 'nested');
  mkdirSync(nested);
  assert.throws(
    () => createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: nested }),
    (error) => error.code === 'WORKSPACE_PRIMARY_CHECKOUT_REQUIRED'
  );
  writeFileSync(path.join(fixture.project, 'bad-mission.json'), '{}\n');
  const malformedMission = workspaceStatus({ missionFile: 'bad-mission.json', projectDir: fixture.project });
  assert.equal(malformedMission.ok, false);
  assert.ok(malformedMission.errors.length > 0);
  assert.throws(
    () => removeWorkspace({ missionFile: 'bad-mission.json', packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'INVALID_MISSION'
  );

  const allocation = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }).allocation;
  const stateFile = path.join(fixture.project, '.vld', 'workspaces.json');
  const malformed = JSON.parse(readFileSync(stateFile, 'utf8'));
  malformed.unexpected = true;
  writeFileSync(stateFile, `${JSON.stringify(malformed, null, 2)}\n`);
  assert.throws(
    () => createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-ui', projectDir: fixture.project }),
    (error) => error.code === 'INVALID_WORKSPACE_STATE'
  );
  delete malformed.unexpected;
  writeFileSync(stateFile, `${JSON.stringify(malformed, null, 2)}\n`);
  const externalState = path.join(fixture.container, 'external-workspace-state.json');
  writeFileSync(externalState, '{"outside":true}\n');
  rmSync(stateFile);
  symlinkSync(externalState, stateFile);
  assert.throws(
    () => workspaceStatus({ missionFile: fixture.missionFile, projectDir: fixture.project }),
    (error) => error.code === 'INVALID_WORKSPACE_STATE'
  );
  assert.equal(readFileSync(externalState, 'utf8'), '{"outside":true}\n');
  rmSync(stateFile);
  writeFileSync(stateFile, `${JSON.stringify(malformed, null, 2)}\n`);

  const outside = path.join(fixture.container, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'must-not-delete.txt'), 'outside managed root\n');
  rmSync(allocation.worktree, { recursive: true, force: true });
  symlinkSync(outside, allocation.worktree, 'dir');
  const status = workspaceStatus({ missionFile: fixture.missionFile, projectDir: fixture.project });
  assert.equal(status.ok, false);
  assert.equal(status.packageStatus[0].status.state, 'drifted');
  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_RECOVERY_REQUIRED'
  );
  assert.equal(readFileSync(path.join(outside, 'must-not-delete.txt'), 'utf8'), 'outside managed root\n');
});

test('overlapping resource claims warn but do not falsely claim that worktrees prevent merge conflicts', (t) => {
  const fixture = createFixture(t, { overlap: true });
  createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project });
  const second = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-ui', projectDir: fixture.project });
  assert.equal(second.changed, true);
  assert.match(second.warnings.join('\n'), /overlaps allocated package "export-api"/);
});

test('clean removal preserves safety, while dirty or committed work requires exact discard acknowledgement', (t) => {
  const fixture = createFixture(t);
  const allocation = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }).allocation;
  writeFileSync(path.join(allocation.worktree, 'draft.txt'), 'do not erase without acknowledgement\n');

  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_DIRTY'
  );
  git(allocation.worktree, ['add', 'draft.txt']);
  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_DIRTY'
  );
  writeFileSync(path.join(allocation.worktree, 'draft.txt'), 'staged and unstaged work\n');
  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_DIRTY'
  );
  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project, discard: true, acknowledge: 'workspace-wrong' }),
    (error) => error.code === 'WORKSPACE_ACKNOWLEDGEMENT_REQUIRED'
  );
  const discarded = removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project, discard: true, acknowledge: allocation.id });
  assert.equal(discarded.changed, true);
  assert.equal(discarded.discarded, true);
  assert.equal(existsSync(allocation.worktree), false);
  assert.equal(gitSucceeds(fixture.project, ['show-ref', '--verify', '--quiet', `refs/heads/${allocation.branch}`]), false);
  const afterDiscard = JSON.parse(readFileSync(path.join(fixture.project, '.vld', 'workspaces.json'), 'utf8'));
  assert.equal(afterDiscard.allocations.length, 0);
  assert.deepEqual(afterDiscard.receipts[0].discarded, true);

  const committed = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }).allocation;
  assert.notEqual(committed.id, allocation.id, 'a new allocation lifetime gets a new discard acknowledgement');
  writeFileSync(path.join(committed.worktree, 'committed.txt'), 'preserve committed branch work\n');
  git(committed.worktree, ['add', 'committed.txt']);
  git(committed.worktree, ['commit', '-qm', 'workspace progress']);
  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_HAS_COMMITS'
  );
  assert.throws(
    () => removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project, discard: true, acknowledge: allocation.id }),
    (error) => error.code === 'WORKSPACE_ACKNOWLEDGEMENT_REQUIRED'
  );
  removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project, discard: true, acknowledge: committed.id });

  const clean = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }).allocation;
  const removed = removeWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project });
  assert.equal(removed.discarded, false);
  assert.equal(existsSync(clean.worktree), false);
  assert.equal(workspaceEntries(fixture.project).length, 1);
});


test('recover reaps stale locks and reconciles interrupted removal without deleting a remaining branch', (t) => {
  const fixture = createFixture(t);
  const allocation = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }).allocation;
  const lock = inspectWorkspaceLock(fixture.project);
  writeFileSync(lock.directory, JSON.stringify({ schemaVersion: 1, pid: 99999999, token: 'stale' }));
  const staleRecovered = recoverWorkspaces({ missionFile: fixture.missionFile, projectDir: fixture.project });
  assert.equal(staleRecovered.ok, true, staleRecovered.errors.join('\n'));
  assert.equal(staleRecovered.recoveredLock.owner.pid, 99999999);
  assert.equal(existsSync(lock.directory), false);

  const stateFile = path.join(fixture.project, '.vld', 'workspaces.json');
  const interrupted = JSON.parse(readFileSync(stateFile, 'utf8'));
  interrupted.allocations[0].status = 'removing';
  interrupted.allocations[0].removal = { discarded: false };
  writeFileSync(stateFile, `${JSON.stringify(interrupted, null, 2)}\n`);
  const reset = recoverWorkspaces({ missionFile: fixture.missionFile, projectDir: fixture.project });
  assert.deepEqual(reset.reset, [allocation.id]);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).allocations[0].status, 'allocated');

  // Recovery identifies the authored mission by its stable source, rather than
  // orphaning an interrupted removal merely because the reviewed title changed.
  const editedMission = JSON.parse(readFileSync(path.join(fixture.project, fixture.missionFile), 'utf8'));
  editedMission.title = 'Edited after interrupted removal';
  writeFileSync(path.join(fixture.project, fixture.missionFile), `${JSON.stringify(editedMission, null, 2)}\n`);
  const editedStatus = workspaceStatus({ missionFile: fixture.missionFile, projectDir: fixture.project });
  assert.equal(editedStatus.ok, false);
  assert.match(editedStatus.warnings.join('\n'), /different revision of this mission/);
  const disappeared = JSON.parse(readFileSync(stateFile, 'utf8'));
  disappeared.allocations[0].status = 'removing';
  disappeared.allocations[0].removal = { discarded: false };
  writeFileSync(stateFile, `${JSON.stringify(disappeared, null, 2)}\n`);
  git(fixture.project, ['worktree', 'remove', '--force', allocation.worktree]);
  const finalized = recoverWorkspaces({ missionFile: fixture.missionFile, projectDir: fixture.project });
  assert.deepEqual(finalized.finalized, [{ id: allocation.id, branchRetained: true }]);
  const after = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(after.allocations.length, 0);
  assert.equal(after.receipts[0].branchRetained, true, 'recovery preserves a branch rather than silently deleting work');
  assert.equal(gitSucceeds(fixture.project, ['show-ref', '--verify', '--quiet', `refs/heads/${allocation.branch}`]), true);
});

function gitSucceeds(project, args) {
  try {
    execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('an active repository lock blocks mutation, and competing CLI allocators never create duplicate worktrees', async (t) => {
  const fixture = createFixture(t);
  const lock = inspectWorkspaceLock(fixture.project);
  writeFileSync(lock.directory, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'active-test' }));
  assert.throws(
    () => createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_LOCKED'
  );
  rmSync(lock.directory, { recursive: true, force: true });
  symlinkSync(path.join(fixture.container, 'missing-lock-target'), lock.directory);
  assert.throws(
    () => createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'INVALID_WORKSPACE_LOCK'
  );
  assert.throws(
    () => recoverWorkspaces({ missionFile: fixture.missionFile, projectDir: fixture.project }),
    (error) => error.code === 'INVALID_WORKSPACE_LOCK'
  );
  rmSync(lock.directory, { force: true });

  const args = ['workspace', 'create', fixture.missionFile, 'export-api', '--project', fixture.project, '--json'];
  const [first, second] = await Promise.all([cli(args), cli(args)]);
  const outcomes = [first, second];
  assert.ok(outcomes.some((result) => result.code === 0), outcomes.map((result) => result.stderr).join('\n'));
  assert.ok(outcomes.every((result) => result.code === 0 || /workspace repository is locked/.test(result.stderr)), outcomes.map((result) => `${result.code}: ${result.stderr}`).join('\n'));
  const state = JSON.parse(readFileSync(path.join(fixture.project, '.vld', 'workspaces.json'), 'utf8'));
  assert.equal(state.allocations.filter((entry) => entry.packageId === 'export-api').length, 1);
  assert.equal(workspaceEntries(fixture.project).length, 2, 'concurrent requests produce at most one allocated worktree');
});

test('workspace acquisition retries once when an EEXIST lock disappears before reinspection', (t) => {
  const fixture = createFixture(t);
  const lock = inspectWorkspaceLock(fixture.project);
  let collisions = 0;
  setWorkspaceLockTestHook(({ phase, directory, attempt }) => {
    if (phase === 'before-exclusive-create' && attempt === 1) {
      writeFileSync(directory, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'vanishing-owner' }));
    }
    if (phase === 'after-eexist') {
      collisions += 1;
      rmSync(directory, { force: true });
    }
  });
  t.after(() => setWorkspaceLockTestHook());

  const created = createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project });
  assert.equal(collisions, 1, 'the hook removes the lock after exclusive creation reports EEXIST');
  assert.equal(created.changed, true, 'the bounded fresh attempt acquires the now-free lock');
  assert.equal(workspaceEntries(fixture.project).length, 2);
});

test('workspace acquisition stops after its bounded vanished-collision retry', (t) => {
  const fixture = createFixture(t);
  let collisions = 0;
  setWorkspaceLockTestHook(({ phase, directory }) => {
    if (phase === 'before-exclusive-create') {
      writeFileSync(directory, JSON.stringify({ schemaVersion: 1, pid: process.pid, token: `vanishing-${collisions}` }));
    }
    if (phase === 'after-eexist') {
      collisions += 1;
      rmSync(directory, { force: true });
    }
  });
  t.after(() => setWorkspaceLockTestHook());

  assert.throws(
    () => createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_LOCK_RACE'
  );
  assert.equal(collisions, 2, 'only the initial collision and one bounded retry are inspected');
  assert.equal(workspaceEntries(fixture.project).length, 1, 'a failed acquisition creates no worktree');
});

test('workspace recovery fails closed for a partial owner and blocks mutation behind a recovery guard', (t) => {
  const fixture = createFixture(t);
  const lock = inspectWorkspaceLock(fixture.project);
  writeFileSync(lock.directory, '{"schemaVersion":1');
  assert.throws(
    () => recoverWorkspaces({ missionFile: fixture.missionFile, projectDir: fixture.project }),
    (error) => error.code === 'INVALID_WORKSPACE_LOCK'
  );
  rmSync(lock.directory, { force: true });
  const ownerField = ['to', 'ken'].join('');
  writeFileSync(`${lock.directory}.recovery`, JSON.stringify({ schemaVersion: 1, pid: process.pid, [ownerField]: 'test-recovery-guard' }));
  assert.throws(
    () => createWorkspace({ missionFile: fixture.missionFile, packageId: 'export-api', projectDir: fixture.project }),
    (error) => error.code === 'WORKSPACE_RECOVERY_IN_PROGRESS'
  );
});
