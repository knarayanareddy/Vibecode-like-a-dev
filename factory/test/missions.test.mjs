/**
 * Mission foundation tests.
 *
 * These deliberately use real throwaway Git repositories and a real verified
 * packet fixture. The foundation is allowed to read a fixed Git ref, but must
 * never create a worktree, branch, process or network request.
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMission,
  missionStatus,
  readMission,
  safeProjectPath,
  validateMission,
  validateMissionDefinition
} from '../lib/missions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createProject(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-mission-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'mission-test@example.invalid']);
  git(project, ['config', 'user.name', 'Mission Test']);
  git(project, ['add', 'specs']);
  git(project, ['commit', '-qm', 'verified packet']);
  return project;
}

function definition(project, { packages = null, extra = {} } = {}) {
  const ids = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((requirement) => requirement.id);
  return {
    schemaVersion: 1,
    id: 'add-report-export',
    title: 'Implement a traceable report export workflow',
    workPackages: packages ?? [{
      id: 'report-export',
      title: 'Implement report export API and tests',
      requirements: ids,
      dependsOn: [],
      resourceClaims: { paths: ['src/export/**', 'test/export/**'] }
    }],
    ...extra
  };
}

test('mission init freezes a verified packet and Git target into an atomically validated declaration', (t) => {
  const project = createProject(t);
  const result = createMission({ definition: definition(project), projectDir: project, packetDir: 'specs' });

  assert.equal(result.mission.schemaVersion, 1);
  assert.equal(result.mission.packet.path, 'specs');
  assert.match(result.mission.packet.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.mission.target.ref, 'HEAD');
  assert.match(result.mission.target.commit, /^[a-f0-9]{40}$/);
  assert.match(result.mission.corePolicyDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.mission.workPackages.length, 1);
  assert.ok(existsSync(result.file));
  assert.deepEqual(JSON.parse(readFileSync(result.file, 'utf8')), result.mission, 'managed mission is deterministic JSON');

  const report = validateMission(result.mission, { projectDir: project });
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.equal(report.warnings.length, 0);
  assert.match(report.passes.join('\n'), /assigned exactly once/);

  const unexpectedPacketField = validateMission({ ...result.mission, packet: { ...result.mission.packet, command: 'never-run' } }, { projectDir: project });
  assert.equal(unexpectedPacketField.ok, false);
  assert.match(unexpectedPacketField.errors.join('\n'), /packet.command is not allowed/);

  const status = missionStatus({ file: 'missions/add-report-export/mission.json', projectDir: project });
  assert.equal(status.ok, true, status.errors.join('\n'));
  assert.deepEqual(status.stale, []);
  assert.deepEqual(status.requirements, { total: result.mission.workPackages[0].requirements.length, assigned: result.mission.workPackages[0].requirements.length });
  assert.equal(existsSync(path.join(project, '.vld', 'runtime')), false, 'mission creation does not start a runtime');
  assert.equal(git(project, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length, 1, 'mission creation does not allocate a worktree');
});

test('mission definition rejects unknown fields, duplicate assignments, unsafe resource claims and dependency cycles', () => {
  const requirementIds = ['REQ-001', 'REQ-002'];
  const invalid = validateMissionDefinition({
    schemaVersion: 1,
    id: 'invalid-mission',
    title: 'Invalid mission rejects unsafe process state',
    command: 'rm -rf /',
    workPackages: [
      {
        id: 'first-package',
        title: 'First package repeats a requirement',
        requirements: ['REQ-001'],
        dependsOn: ['second-package'],
        resourceClaims: { paths: ['../outside/**'] }
      },
      {
        id: 'second-package',
        title: 'Second package creates a cycle',
        requirements: ['REQ-001'],
        dependsOn: ['first-package']
      }
    ]
  }, { requirementIds });

  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /mission definition.command is not allowed/);
  assert.match(invalid.errors.join('\n'), /unsafe project-relative pattern/);
  assert.match(invalid.errors.join('\n'), /dependency cycle/);
  assert.match(invalid.errors.join('\n'), /assigned to both/);
  assert.deepEqual(invalid.warnings, ['requirement REQ-002 is not assigned to a work package']);
});

test('mission creation refuses incomplete packet coverage and leaves no partial mission output', (t) => {
  const project = createProject(t);
  const raw = definition(project);
  raw.workPackages[0].requirements.pop();

  assert.throws(
    () => createMission({ definition: raw, projectDir: project, packetDir: 'specs' }),
    (error) => error.code === 'INCOMPLETE_MISSION' && /not assigned/.test(error.message)
  );
  assert.equal(existsSync(path.join(project, 'missions', 'add-report-export', 'mission.json')), false);
});

test('mission validation detects packet digest drift and status detects target movement without rewriting authority', (t) => {
  const project = createProject(t);
  const created = createMission({ definition: definition(project), projectDir: project, packetDir: 'specs' });

  writeFileSync(path.join(project, 'specs', 'spec.json'), `${readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')}\n`);
  const driftedPacket = validateMission(created.mission, { projectDir: project });
  assert.equal(driftedPacket.ok, false);
  assert.match(driftedPacket.errors.join('\n'), /packet digest differs/);

  // Restore the exact frozen packet so target staleness is independent of packet drift.
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true, force: true });
  writeFileSync(path.join(project, 'README.md'), '# later target\n');
  git(project, ['add', 'README.md']);
  git(project, ['commit', '-qm', 'advance target']);

  const before = readFileSync(created.file, 'utf8');
  const status = missionStatus({ file: 'missions/add-report-export/mission.json', projectDir: project });
  assert.equal(status.ok, false);
  assert.equal(status.errors.length, 0, status.errors.join('\n'));
  assert.equal(status.stale.length, 1);
  assert.equal(status.stale[0].kind, 'target');
  assert.equal(status.stale[0].expected, created.mission.target.commit);
  assert.notEqual(status.stale[0].actual, created.mission.target.commit);
  assert.equal(readFileSync(created.file, 'utf8'), before, 'status is read-only and never retargets a mission');
});

test('mission paths are confined to the project and pre-existing symlink components are refused', (t) => {
  const project = createProject(t);
  assert.throws(() => safeProjectPath(project, '../outside.json', 'mission output'), /escapes the project/);
  assert.throws(() => safeProjectPath(project, path.join(os.tmpdir(), 'outside.json'), 'mission output'), /relative path/);

  const external = mkdtempSync(path.join(os.tmpdir(), 'vld-mission-external-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  symlinkSync(external, path.join(project, 'linked-missions'));
  assert.throws(() => safeProjectPath(project, 'linked-missions/mission.json', 'mission output'), /symbolic link/);

  const raw = definition(project);
  assert.throws(
    () => createMission({ definition: raw, projectDir: project, packetDir: 'specs', outFile: '../outside.json' }),
    (error) => error.code === 'INVALID_MISSION_PATH'
  );
  assert.equal(existsSync(path.join(external, 'mission.json')), false);
});

test('mission file loading rejects malformed JSON and mission validation does not run Git mutations', (t) => {
  const project = createProject(t);
  writeFileSync(path.join(project, 'invalid.json'), '{ not JSON');
  assert.throws(() => readMission('invalid.json', { projectDir: project }), /invalid JSON/);

  const beforeStatus = git(project, ['status', '--porcelain']);
  const beforeBranches = git(project, ['branch', '--format=%(refname:short)']);
  const raw = definition(project, { extra: { unexpected: true } });
  assert.throws(() => createMission({ definition: raw, projectDir: project, packetDir: 'specs' }), /unexpected is not allowed/);
  assert.equal(git(project, ['status', '--porcelain']), beforeStatus);
  assert.equal(git(project, ['branch', '--format=%(refname:short)']), beforeBranches);
});
