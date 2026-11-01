/**
 * Safe manual allocation of Git worktrees for VLD mission work packages.
 *
 * This is a deliberately narrow Phase 2 foundation. It only invokes fixed-argv
 * Git commands after Core has validated a frozen mission. It never starts an
 * agent, runs a project command, creates a PR, pushes, merges or evaluates an
 * arbitrary workflow command.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  digest,
  ensureProjectDir,
  extensionError,
  ID_PATTERN,
  readJson,
  vldDir,
  writeJsonAtomic
} from './extension-utils.mjs';
import { missionStatus, readMission } from './missions.mjs';

const STATE_VERSION = 1;
const COMMIT = /^[a-f0-9]{40}$/;
const BRANCH = /^vld\/[a-z0-9][a-z0-9-]{1,60}\/[a-z0-9][a-z0-9-]{1,60}$/;
const ALLOCATION_STATUS = new Set(['allocated', 'removing']);
const MAX_RECEIPTS = 100;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function displayRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function errorDetail(error) {
  return String(error?.stderr || error?.message || error || '').trim();
}

function git(project, args, code = 'GIT_WORKSPACE_FAILED') {
  try {
    return execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    throw extensionError(`git ${args[0]} failed${errorDetail(error) ? `: ${errorDetail(error)}` : ''}`, code);
  }
}

function gitSucceeds(project, args) {
  try {
    execFileSync('git', ['-C', project, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function repository(projectDir) {
  // macOS may spell a real temporary directory under /private while callers use
  // its /tmp alias. Compare canonical existing paths so Git's primary worktree
  // identity remains portable without treating CWD as an authority boundary.
  const project = realpathSync(ensureProjectDir(projectDir));
  let root;
  let commonRaw;
  let gitDirRaw;
  try {
    root = git(project, ['rev-parse', '--show-toplevel'], 'NOT_A_GIT_REPOSITORY');
    commonRaw = git(project, ['rev-parse', '--git-common-dir'], 'NOT_A_GIT_REPOSITORY');
    gitDirRaw = git(project, ['rev-parse', '--git-dir'], 'NOT_A_GIT_REPOSITORY');
  } catch (error) {
    if (error.code === 'NOT_A_GIT_REPOSITORY') throw extensionError('workspace commands require a Git working repository', 'NOT_A_GIT_REPOSITORY');
    throw error;
  }
  const commonCandidate = path.resolve(project, commonRaw);
  if (!existsSync(commonCandidate) || !lstatSync(commonCandidate).isDirectory()) throw extensionError('Git common directory is unavailable', 'NOT_A_GIT_REPOSITORY');
  const commonDir = realpathSync(commonCandidate);
  const gitDirCandidate = path.resolve(project, gitDirRaw);
  if (!existsSync(gitDirCandidate) || !lstatSync(gitDirCandidate).isDirectory()) throw extensionError('Git directory is unavailable', 'NOT_A_GIT_REPOSITORY');
  const gitDir = realpathSync(gitDirCandidate);
  return { project, root: realpathSync(path.resolve(root)), commonDir, gitDir };
}

function workspaceRoot(repo) {
  const label = `${path.basename(repo.root)}-${digest(repo.commonDir).slice(0, 12)}`;
  const root = path.join(path.dirname(repo.root), '.vld-worktrees', label);
  if (isWithin(repo.root, root)) throw extensionError('managed workspace root must be outside the project checkout', 'INVALID_WORKSPACE_ROOT');
  return root;
}

function statePath(repo) {
  // Workspace allocations must have one ledger per checkout, rather than one
  // ledger per caller subdirectory. Mutating entry points require this root.
  const directory = vldDir(repo.root);
  if (existsSync(directory)) safeExistingDirectory(directory, 'workspace state directory');
  const file = path.join(directory, 'workspaces.json');
  if (existsSync(file)) {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError('workspace state file is not a regular file', 'INVALID_WORKSPACE_STATE');
  }
  return file;
}

function lockPath(repo) {
  return path.join(repo.commonDir, 'vld-workspaces.lock');
}

function safeExistingDirectory(target, label) {
  if (!existsSync(target)) return;
  const stats = lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw extensionError(`${label} is not a real directory`, 'INVALID_WORKSPACE_ROOT');
}

/** Create a parent directory only when no existing path component is a symlink. */
function mkdirWithoutSymlinks(target, label) {
  const parsed = path.parse(path.resolve(target));
  let cursor = parsed.root;
  for (const part of path.resolve(target).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor)) {
      safeExistingDirectory(cursor, label);
    } else {
      mkdirSync(cursor);
    }
  }
}

function parseWorktreeList(output) {
  const entries = [];
  let current = null;
  for (const line of `${output}\n`.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: path.resolve(line.slice('worktree '.length)), head: null, branch: null, bare: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === '') {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function listWorktrees(repo) {
  return parseWorktreeList(git(repo.project, ['worktree', 'list', '--porcelain']));
}

/**
 * A worktree allocation ledger belongs to the primary checkout, not a nested
 * directory or one of the allocated worktrees. This prevents two paths into the
 * same Git common directory from creating divergent `.vld/workspaces.json`
 * ledgers. Operators run workspace commands from the primary project root.
 */
function primaryWorkspaceRepository(projectDir) {
  const repo = repository(projectDir);
  const primary = listWorktrees(repo)[0];
  if (!primary || primary.bare || !primary.path) throw extensionError('workspace commands require a primary Git working checkout', 'NOT_A_GIT_REPOSITORY');
  if (!samePath(repo.project, repo.root) || !samePath(repo.gitDir, repo.commonDir) || !samePath(repo.root, primary.path)) {
    throw extensionError('workspace commands must run from the primary Git checkout root, not a subdirectory or linked worktree', 'WORKSPACE_PRIMARY_CHECKOUT_REQUIRED');
  }
  return repo;
}

function activePid(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a different live user owns the process; it must remain a lock.
    return error?.code === 'EPERM';
  }
}

function workspaceRecoveryPath(repo) {
  return `${lockPath(repo)}.recovery`;
}

function validLockOwner(owner) {
  return Boolean(owner) && typeof owner === 'object' && !Array.isArray(owner)
    && owner.schemaVersion === 1 && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.token === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(owner.token);
}

function readWorkspaceLockOwner(file) {
  let owner;
  try { owner = readJson(file); } catch { throw extensionError('workspace lock owner is incomplete or invalid; inspect it before manual removal', 'INVALID_WORKSPACE_LOCK'); }
  if (!validLockOwner(owner)) throw extensionError('workspace lock owner is incomplete or invalid; inspect it before manual removal', 'INVALID_WORKSPACE_LOCK');
  return owner;
}

export function inspectWorkspaceLock(projectDir = '.') {
  const repo = repository(projectDir);
  const directory = lockPath(repo);
  let stats;
  try { stats = lstatSync(directory); } catch { return { repo, directory, exists: false, active: false, owner: null, kind: null }; }
  if (stats.isSymbolicLink()) return { repo, directory, exists: true, active: false, owner: null, kind: 'symlink' };
  if (!stats.isFile()) return { repo, directory, exists: true, active: false, owner: null, kind: stats.isDirectory() ? 'legacy-directory' : 'other' };
  try {
    const owner = readWorkspaceLockOwner(directory);
    return { repo, directory, exists: true, active: activePid(owner.pid), owner, kind: 'file' };
  } catch {
    return { repo, directory, exists: true, active: false, owner: null, kind: 'invalid' };
  }
}

function recoveryGuard(repo) {
  const file = workspaceRecoveryPath(repo);
  let stats;
  try { stats = lstatSync(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError('workspace recovery guard has an unsafe filesystem type', 'INVALID_WORKSPACE_LOCK');
  return file;
}

function assertNoWorkspaceRecovery(repo) {
  if (recoveryGuard(repo)) throw extensionError('workspace recovery is in progress or requires manual inspection', 'WORKSPACE_RECOVERY_IN_PROGRESS');
}

function acquireWorkspaceRecovery(repo) {
  const file = workspaceRecoveryPath(repo);
  const owner = { schemaVersion: 1, pid: process.pid, token: randomUUID() };
  try {
    writeFileSync(file, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw extensionError('workspace recovery is already in progress or requires manual inspection', 'WORKSPACE_RECOVERY_IN_PROGRESS');
    throw error;
  }
  return owner;
}

function releaseWorkspaceRecovery(repo, owner) {
  const file = workspaceRecoveryPath(repo);
  try {
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const actual = readJson(file);
    if (actual?.token === owner.token) rmSync(file, { force: true });
  } catch {}
}

function withWorkspaceRecovery(repo, callback) {
  const owner = acquireWorkspaceRecovery(repo);
  try { return callback(); } finally { releaseWorkspaceRecovery(repo, owner); }
}

function clearStaleLock(repo) {
  const inspected = inspectWorkspaceLock(repo.project);
  if (!inspected.exists) return null;
  if (inspected.kind !== 'file') throw extensionError(`workspace lock has an unsafe filesystem type: ${inspected.kind}`, 'INVALID_WORKSPACE_LOCK');
  if (inspected.active) throw extensionError(`workspace repository is locked by pid ${inspected.owner.pid}`, 'WORKSPACE_LOCKED');
  const owner = readWorkspaceLockOwner(inspected.directory);
  if (activePid(owner.pid)) throw extensionError(`workspace repository is locked by pid ${owner.pid}`, 'WORKSPACE_LOCKED');
  rmSync(inspected.directory, { force: true });
  return { owner, directory: inspected.directory };
}

function acquireWorkspaceLock(repo, { allowRecovery = false } = {}) {
  const directory = lockPath(repo);
  if (!allowRecovery) assertNoWorkspaceRecovery(repo);
  const owner = { schemaVersion: 1, pid: process.pid, token: randomUUID() };
  try {
    writeFileSync(directory, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const inspected = inspectWorkspaceLock(repo.project);
      if (inspected.kind !== 'file') throw extensionError(`workspace lock has an unsafe filesystem type: ${inspected.kind}`, 'INVALID_WORKSPACE_LOCK');
      const reason = inspected.active ? `pid ${inspected.owner.pid} is active` : 'a stale lock requires `vld workspace recover`';
      throw extensionError(`workspace repository is locked: ${reason}`, inspected.active ? 'WORKSPACE_LOCKED' : 'STALE_WORKSPACE_LOCK');
    }
    throw error;
  }
  if (!allowRecovery) {
    try { assertNoWorkspaceRecovery(repo); } catch (error) { releaseWorkspaceLock(repo, owner); throw error; }
  }
  return owner;
}

function releaseWorkspaceLock(repo, owner) {
  const file = lockPath(repo);
  try {
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const actual = readJson(file);
    if (actual?.token === owner.token) rmSync(file, { force: true });
  } catch {}
}

function withWorkspaceLock(repo, callback, options = {}) {
  const owner = acquireWorkspaceLock(repo, options);
  try { return callback(); } finally { releaseWorkspaceLock(repo, owner); }
}

function emptyState(repo) {
  return {
    schemaVersion: STATE_VERSION,
    repository: { commonDirDigest: digest(repo.commonDir) },
    allocations: [],
    receipts: []
  };
}

function validateAllocation(allocation, root, errors) {
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
    errors.push('workspace allocation must be an object');
    return;
  }
  const allowed = new Set(['id', 'missionId', 'missionDigest', 'missionFile', 'packageId', 'worktree', 'branch', 'baseCommit', 'targetCommit', 'resourceClaims', 'status', 'removal']);
  for (const key of Object.keys(allocation)) if (!allowed.has(key)) errors.push(`workspace allocation.${key} is not allowed`);
  if (!ID_PATTERN.test(String(allocation.id ?? ''))) errors.push('workspace allocation has an invalid id');
  if (!ID_PATTERN.test(String(allocation.missionId ?? ''))) errors.push('workspace allocation has an invalid mission id');
  if (!ID_PATTERN.test(String(allocation.packageId ?? ''))) errors.push('workspace allocation has an invalid package id');
  if (!/^[a-f0-9]{64}$/.test(String(allocation.missionDigest ?? ''))) errors.push('workspace allocation has an invalid mission digest');
  if (typeof allocation.missionFile !== 'string' || allocation.missionFile.startsWith('..') || path.isAbsolute(allocation.missionFile)) errors.push('workspace allocation has an invalid mission file');
  const resolvedWorktree = typeof allocation.worktree === 'string' ? path.resolve(allocation.worktree) : null;
  if (!resolvedWorktree || !isWithin(root, resolvedWorktree) || resolvedWorktree === root) {
    errors.push('workspace allocation escapes the managed workspace root');
  } else if (ID_PATTERN.test(String(allocation.missionId ?? '')) && ID_PATTERN.test(String(allocation.packageId ?? '')) && resolvedWorktree !== path.resolve(root, allocation.missionId, allocation.packageId)) {
    errors.push('workspace allocation does not use its deterministic managed path');
  }
  if (!BRANCH.test(String(allocation.branch ?? ''))) errors.push('workspace allocation has an invalid branch');
  else if (ID_PATTERN.test(String(allocation.missionId ?? '')) && ID_PATTERN.test(String(allocation.packageId ?? '')) && allocation.branch !== `vld/${allocation.missionId}/${allocation.packageId}`) errors.push('workspace allocation does not use its deterministic branch');
  if (!COMMIT.test(String(allocation.baseCommit ?? '')) || !COMMIT.test(String(allocation.targetCommit ?? ''))) errors.push('workspace allocation has an invalid commit');
  else if (allocation.baseCommit !== allocation.targetCommit) errors.push('workspace allocation base and frozen target commits must match');
  if (!ALLOCATION_STATUS.has(allocation.status)) errors.push('workspace allocation has an invalid status');
  if (!Array.isArray(allocation.resourceClaims) || allocation.resourceClaims.some((claim) => typeof claim !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/*?{}-]{0,240}$/.test(claim)) || new Set(allocation.resourceClaims).size !== (allocation.resourceClaims?.length ?? 0)) {
    errors.push('workspace allocation resource claims must be a unique list of safe project-relative patterns');
  }
  if (allocation.status === 'removing') {
    if (!allocation.removal || typeof allocation.removal !== 'object' || Array.isArray(allocation.removal) || Object.keys(allocation.removal).some((key) => key !== 'discarded') || typeof allocation.removal.discarded !== 'boolean') errors.push('removing workspace allocation has invalid removal state');
  } else if (allocation.removal !== undefined) {
    errors.push('allocated workspace may not have removal state');
  }
}

function validateReceipt(receipt, root, errors) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    errors.push('workspace receipt must be an object');
    return;
  }
  const allowed = new Set(['id', 'action', 'discarded', 'branch', 'worktree', 'baseCommit', 'targetCommit', 'branchRetained']);
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) errors.push(`workspace receipt.${key} is not allowed`);
  if (!ID_PATTERN.test(String(receipt.id ?? ''))) errors.push('workspace receipt has an invalid id');
  if (receipt.action !== 'removed') errors.push('workspace receipt has an invalid action');
  if (typeof receipt.discarded !== 'boolean' || typeof receipt.branchRetained !== 'boolean') errors.push('workspace receipt has invalid discard/retention state');
  if (!BRANCH.test(String(receipt.branch ?? ''))) errors.push('workspace receipt has an invalid branch');
  if (typeof receipt.worktree !== 'string' || !isWithin(root, path.resolve(receipt.worktree)) || path.resolve(receipt.worktree) === root) errors.push('workspace receipt escapes the managed workspace root');
  if (!COMMIT.test(String(receipt.baseCommit ?? '')) || !COMMIT.test(String(receipt.targetCommit ?? ''))) errors.push('workspace receipt has an invalid commit');
}

function validateState(state, repo) {
  const errors = [];
  const root = workspaceRoot(repo);
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { errors: ['workspace state is not an object'], root };
  const allowed = new Set(['schemaVersion', 'repository', 'allocations', 'receipts']);
  for (const key of Object.keys(state)) if (!allowed.has(key)) errors.push(`workspace state.${key} is not allowed`);
  if (state.schemaVersion !== STATE_VERSION) errors.push(`workspace state schemaVersion must be ${STATE_VERSION}`);
  if (!state.repository || typeof state.repository !== 'object' || Array.isArray(state.repository) || Object.keys(state.repository).some((key) => key !== 'commonDirDigest') || state.repository.commonDirDigest !== digest(repo.commonDir)) errors.push('workspace state belongs to a different Git repository');
  if (!Array.isArray(state.allocations)) errors.push('workspace state allocations must be a list');
  if (!Array.isArray(state.receipts)) errors.push('workspace state receipts must be a list');
  if (Array.isArray(state.receipts) && state.receipts.length > MAX_RECEIPTS) errors.push(`workspace state retains more than ${MAX_RECEIPTS} receipts`);
  const ids = new Set();
  const assignments = new Set();
  for (const allocation of Array.isArray(state.allocations) ? state.allocations : []) {
    validateAllocation(allocation, root, errors);
    if (ids.has(allocation?.id)) errors.push(`workspace allocation "${allocation?.id ?? '?'}" repeats`);
    else ids.add(allocation?.id);
    const assignment = `${allocation?.missionDigest}:${allocation?.packageId}`;
    if (assignments.has(assignment)) errors.push(`workspace allocation repeats package "${allocation?.packageId ?? '?'}"`);
    else assignments.add(assignment);
  }
  for (const receipt of Array.isArray(state.receipts) ? state.receipts : []) validateReceipt(receipt, root, errors);
  return { errors, root };
}

function readWorkspaceState(repo) {
  const file = statePath(repo);
  if (!existsSync(file)) return { file, state: emptyState(repo), exists: false, errors: [] };
  let state;
  try { state = readJson(file); } catch (error) { return { file, state: null, exists: true, errors: [`workspace state is invalid JSON: ${error.message}`] }; }
  const { errors } = validateState(state, repo);
  return { file, state, exists: true, errors };
}

function writeWorkspaceState(repo, state) {
  const checked = validateState(state, repo);
  if (checked.errors.length) throw extensionError(`workspace state is invalid:\n${checked.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_WORKSPACE_STATE');
  writeJsonAtomic(statePath(repo), state);
}

function branchExists(repo, branch) {
  return gitSucceeds(repo.project, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

function branchCommit(repo, branch) {
  return git(repo.project, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
}

function isRealDirectoryTree(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isWithin(resolvedRoot, resolvedCandidate) || resolvedRoot === resolvedCandidate) return false;
  let cursor = resolvedRoot;
  try {
    let stats = lstatSync(cursor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    for (const part of path.relative(resolvedRoot, resolvedCandidate).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function healthForAllocation(allocation, worktrees, root) {
  if (!allocation || typeof allocation.worktree !== 'string') return { state: 'drifted', detail: 'registered allocation has an invalid worktree path' };
  const allocationPath = path.resolve(allocation.worktree);
  const worktree = worktrees.find((entry) => entry.path === allocationPath);
  if (!worktree || !existsSync(allocationPath)) return { state: 'missing', detail: 'registered worktree is absent' };
  if (!isRealDirectoryTree(root, allocationPath)) return { state: 'drifted', detail: 'registered worktree contains a symbolic link or is not a real directory' };
  if (worktree.branch !== `refs/heads/${allocation.branch}`) return { state: 'drifted', detail: `expected branch refs/heads/${allocation.branch}, found ${worktree.branch ?? 'detached HEAD'}` };
  if (worktree.head && !COMMIT.test(worktree.head)) return { state: 'drifted', detail: 'worktree has an invalid HEAD' };
  return { state: 'healthy', detail: null };
}

function claimedPathOverlap(left, right) {
  for (const first of left ?? []) {
    for (const second of right ?? []) {
      if (first === second) return first;
      const firstPrefix = first.endsWith('/**') ? first.slice(0, -3) : null;
      const secondPrefix = second.endsWith('/**') ? second.slice(0, -3) : null;
      if (firstPrefix && second.startsWith(firstPrefix)) return first;
      if (secondPrefix && first.startsWith(secondPrefix)) return second;
    }
  }
  return null;
}

function missionWorkspace(repo, mission, workPackage) {
  const root = workspaceRoot(repo);
  const directory = path.resolve(root, mission.id, workPackage.id);
  if (!isWithin(root, directory)) throw extensionError('workspace path escapes managed root', 'INVALID_WORKSPACE_ROOT');
  const branch = `vld/${mission.id}/${workPackage.id}`;
  if (!BRANCH.test(branch)) throw extensionError('generated workspace branch is invalid', 'INVALID_WORKSPACE_BRANCH');
  return { root, directory, branch };
}

function missionCurrentOrThrow(file, project) {
  const status = missionStatus({ file, projectDir: project });
  if (!status.ok) {
    const problems = [...status.errors, ...status.stale.map((entry) => entry.kind === 'target' ? 'mission target has moved' : `mission is stale: ${entry.kind}`)];
    throw extensionError(`mission is not current:\n${problems.map((problem) => `- ${problem}`).join('\n')}`, 'STALE_MISSION');
  }
  return status;
}

function receiptFor(allocation, { discarded, branchRetained = false } = {}) {
  return {
    id: allocation.id,
    action: 'removed',
    discarded: Boolean(discarded),
    branch: allocation.branch,
    worktree: allocation.worktree,
    baseCommit: allocation.baseCommit,
    targetCommit: allocation.targetCommit,
    branchRetained: Boolean(branchRetained)
  };
}

function appendReceipt(state, receipt) {
  return { ...state, receipts: [...state.receipts, receipt].slice(-MAX_RECEIPTS) };
}

/** Allocate an isolated worktree for one current mission work package. */
export function createWorkspace({ missionFile, packageId, projectDir = '.' } = {}) {
  const repo = primaryWorkspaceRepository(projectDir);
  const project = repo.root;
  const current = missionCurrentOrThrow(missionFile, project);
  const mission = current.mission;
  const workPackage = mission.workPackages.find((entry) => entry.id === packageId);
  if (!workPackage) throw extensionError(`mission "${mission.id}" has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');

  return withWorkspaceLock(repo, () => {
    const loaded = readWorkspaceState(repo);
    if (loaded.errors.length) throw extensionError(`workspace state is invalid:\n${loaded.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_WORKSPACE_STATE');
    const state = loaded.state;
    const worktrees = listWorktrees(repo);
    const missionDigest = digest(mission);
    const existing = state.allocations.find((entry) => entry.missionDigest === missionDigest && entry.packageId === packageId);
    if (existing) {
      const health = healthForAllocation(existing, worktrees, workspaceRoot(repo));
      if (existing.status === 'allocated' && health.state === 'healthy') return { changed: false, allocation: existing, warnings: [] };
      throw extensionError(`work package "${packageId}" has ${existing.status === 'removing' ? 'a pending removal' : `an unhealthy workspace (${health.detail})`}; run vld workspace recover before allocating it again`, 'WORKSPACE_RECOVERY_REQUIRED');
    }

    const workspace = missionWorkspace(repo, mission, workPackage);
    const warnings = [];
    for (const allocation of state.allocations.filter((entry) => entry.status === 'allocated')) {
      const overlap = claimedPathOverlap(workPackage.resourceClaims?.paths, allocation.resourceClaims);
      if (overlap) warnings.push(`resource claim "${overlap}" overlaps allocated package "${allocation.packageId}"; worktree isolation does not prevent a later merge conflict`);
    }
    if (branchExists(repo, workspace.branch)) throw extensionError(`workspace branch "${workspace.branch}" already exists; run recover or choose a new mission/package id`, 'WORKSPACE_BRANCH_EXISTS');
    if (existsSync(workspace.directory) || worktrees.some((entry) => entry.path === workspace.directory)) {
      throw extensionError(`workspace path already exists: ${workspace.directory}`, 'WORKSPACE_PATH_EXISTS');
    }

    mkdirWithoutSymlinks(path.dirname(workspace.directory), 'managed workspace root');
    let created = false;
    try {
      git(repo.project, ['worktree', 'add', '-b', workspace.branch, workspace.directory, mission.target.commit]);
      created = true;
      const allocation = {
        // Deliberately unique per allocation lifetime: a stale discard acknowledgement
        // from an earlier removed workspace must not authorize a later re-allocation.
        id: `workspace-${randomUUID()}`,
        missionId: mission.id,
        missionDigest,
        missionFile: displayRelative(project, readMission(missionFile, { projectDir: project }).file),
        packageId,
        worktree: workspace.directory,
        branch: workspace.branch,
        baseCommit: mission.target.commit,
        targetCommit: mission.target.commit,
        resourceClaims: [...(workPackage.resourceClaims?.paths ?? [])],
        status: 'allocated'
      };
      const healthy = healthForAllocation(allocation, listWorktrees(repo), workspaceRoot(repo));
      if (healthy.state !== 'healthy') throw extensionError(`new workspace did not verify: ${healthy.detail}`, 'WORKSPACE_CREATE_FAILED');
      writeWorkspaceState(repo, { ...state, allocations: [...state.allocations, allocation] });
      return { changed: true, allocation, warnings };
    } catch (error) {
      if (created) {
        try { git(repo.project, ['worktree', 'remove', '--force', workspace.directory]); } catch {}
        try { git(repo.project, ['branch', '-D', '--', workspace.branch]); } catch {}
      }
      throw error;
    }
  });
}

/** Inspect allocations and Git registrations without changing project or Git state. */
export function workspaceStatus({ missionFile, projectDir = '.' } = {}) {
  const repo = primaryWorkspaceRepository(projectDir);
  const project = repo.root;
  const loadedMission = readMission(missionFile, { projectDir: project });
  const missionReport = missionStatus({ file: missionFile, projectDir: project });
  const loadedState = readWorkspaceState(repo);
  const errors = [...loadedState.errors, ...missionReport.errors];
  const warnings = [...missionReport.warnings];
  let worktrees = [];
  try { worktrees = listWorktrees(repo); } catch (error) { errors.push(error.message); }
  const missionDigest = digest(loadedMission.mission);
  const allocations = (loadedState.state?.allocations ?? []).filter((entry) => entry?.missionDigest === missionDigest);
  const missionRelativeFile = displayRelative(project, loadedMission.file);
  const otherMissionRevisions = (loadedState.state?.allocations ?? []).filter((entry) => entry?.missionId === loadedMission.mission?.id && entry?.missionFile === missionRelativeFile && entry?.missionDigest !== missionDigest);
  if (otherMissionRevisions.length) warnings.push(`${otherMissionRevisions.length} allocation(s) belong to a different revision of this mission; restore the frozen mission or recover/inspect the recorded workspace before allocating again`);
  const workPackages = Array.isArray(loadedMission.mission?.workPackages) ? loadedMission.mission.workPackages : [];
  const packageStatus = workPackages.map((workPackage) => {
    const allocation = allocations.find((entry) => entry?.packageId === workPackage?.id) ?? null;
    return { id: workPackage?.id ?? '(invalid package)', allocation, status: allocation ? healthForAllocation(allocation, worktrees, workspaceRoot(repo)) : { state: 'unallocated', detail: null } };
  });
  for (const entry of packageStatus) if (entry.status.state !== 'healthy' && entry.status.state !== 'unallocated') warnings.push(`work package "${entry.id}" is ${entry.status.state}: ${entry.status.detail}`);
  const root = workspaceRoot(repo);
  const known = new Set((loadedState.state?.allocations ?? []).filter((entry) => typeof entry?.worktree === 'string').map((entry) => path.resolve(entry.worktree)));
  const unmanaged = worktrees.filter((entry) => isWithin(root, entry.path) && !known.has(entry.path)).map((entry) => entry.path);
  if (unmanaged.length) warnings.push(`${unmanaged.length} managed-root worktree(s) are not recorded in workspace state`);
  const missionCurrent = missionReport.ok;
  return {
    ok: errors.length === 0 && missionCurrent && otherMissionRevisions.length === 0 && packageStatus.every((entry) => ['healthy', 'unallocated'].includes(entry.status.state)),
    project,
    root,
    mission: { id: loadedMission.mission?.id ?? null, file: loadedMission.file, current: missionCurrent, stale: missionReport.stale },
    packageStatus,
    unmanaged,
    errors,
    warnings
  };
}

/**
 * Return one healthy, frozen workspace for the optional Runtime adapter host.
 * This is read-only: M4 must not bypass the manual allocator or invent a path.
 */
export function runtimeWorkspaceAllocation({ missionFile, packageId, projectDir = '.' } = {}) {
  const repo = primaryWorkspaceRepository(projectDir);
  const project = repo.root;
  const current = missionCurrentOrThrow(missionFile, project);
  const workPackage = current.mission.workPackages.find((entry) => entry.id === packageId);
  if (!workPackage) throw extensionError(`mission "${current.mission.id}" has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
  const loaded = readWorkspaceState(repo);
  if (loaded.errors.length) throw extensionError(`workspace state is invalid:\n${loaded.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_WORKSPACE_STATE');
  const allocation = loaded.state.allocations.find((entry) => entry.missionDigest === digest(current.mission) && entry.packageId === packageId);
  if (!allocation || allocation.status !== 'allocated') throw extensionError(`work package "${packageId}" has no allocated workspace`, 'WORKSPACE_NOT_FOUND');
  const health = healthForAllocation(allocation, listWorktrees(repo), workspaceRoot(repo));
  if (health.state !== 'healthy') throw extensionError(`workspace is ${health.state}: ${health.detail}; run vld workspace recover`, 'WORKSPACE_RECOVERY_REQUIRED');
  return {
    id: allocation.id,
    missionId: allocation.missionId,
    missionDigest: allocation.missionDigest,
    packageId: allocation.packageId,
    worktree: allocation.worktree,
    branch: allocation.branch,
    baseCommit: allocation.baseCommit,
    targetCommit: allocation.targetCommit,
    resourceClaims: [...allocation.resourceClaims]
  };
}

/**
 * Create a short-lived detached integration worktree under the same repository
 * lock as manual allocations. M5 calls this with a candidate SHA after validating
 * that it belongs to the package branch. It never updates a branch/ref and always
 * removes the integration worktree before returning.
 */
export function withRuntimeIntegrationWorkspace({ missionFile, packageId, candidateSha, projectDir = '.', callback } = {}) {
  const repo = primaryWorkspaceRepository(projectDir);
  const project = repo.root;
  const current = missionCurrentOrThrow(missionFile, project);
  if (!COMMIT.test(String(candidateSha ?? ''))) throw extensionError('integration candidate SHA must be a full commit', 'INVALID_CANDIDATE_SHA');
  if (typeof callback !== 'function') throw extensionError('integration callback is required', 'INVALID_INTEGRATION_REQUEST');
  const workPackage = current.mission.workPackages.find((entry) => entry.id === packageId);
  if (!workPackage) throw extensionError(`mission "${current.mission.id}" has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
  const root = path.join(path.dirname(repo.root), '.vld-integrations', `${path.basename(repo.root)}-${digest(repo.commonDir).slice(0, 12)}`);
  if (isWithin(repo.root, root)) throw extensionError('integration root must be outside the project checkout', 'INVALID_WORKSPACE_ROOT');

  return withWorkspaceLock(repo, () => {
    mkdirWithoutSymlinks(root, 'integration root');
    const directory = path.join(root, current.mission.id, packageId, `${candidateSha.slice(0, 12)}-${randomUUID()}`);
    if (!isWithin(root, directory)) throw extensionError('integration worktree path escapes its managed root', 'INVALID_WORKSPACE_ROOT');
    let created = false;
    try {
      git(repo.project, ['worktree', 'add', '--detach', directory, current.mission.target.commit], 'INTEGRATION_WORKTREE_FAILED');
      created = true;
      // --no-commit and --no-ff prepare the exact merge result for checks but
      // cannot update any branch. A conflict is a typed result, not an agent job.
      if (!gitSucceeds(directory, ['merge', '--no-commit', '--no-ff', candidateSha])) {
        try { git(directory, ['merge', '--abort'], 'INTEGRATION_MERGE_ABORT_FAILED'); } catch {}
        return { integrated: false, outcome: 'conflict' };
      }
      const integrationTree = git(directory, ['write-tree'], 'INTEGRATION_TREE_FAILED');
      if (!COMMIT.test(integrationTree)) throw extensionError('integration did not produce a tree digest', 'INTEGRATION_TREE_FAILED');
      return {
        integrated: true,
        targetSha: current.mission.target.commit,
        candidateSha,
        integrationTree,
        result: callback({ worktree: directory, targetSha: current.mission.target.commit, candidateSha, integrationTree, mission: current.mission })
      };
    } finally {
      if (created) {
        try { git(directory, ['merge', '--abort'], 'INTEGRATION_MERGE_ABORT_FAILED'); } catch {}
        // Leaving an untracked integration worktree would defeat serialized
        // recovery, so removal failure is deliberately surfaced to the caller.
        git(repo.project, ['worktree', 'remove', '--force', directory], 'INTEGRATION_WORKTREE_CLEANUP_FAILED');
      }
    }
  });
}

/**
 * Reconcile a stale lock and interrupted removal. It intentionally never deletes
 * an unowned worktree or a remaining branch; recovery favours preserving work.
 */
export function recoverWorkspaces({ missionFile, projectDir = '.' } = {}) {
  const repo = primaryWorkspaceRepository(projectDir);
  const project = repo.root;
  const loadedMission = readMission(missionFile, { projectDir: project });

  return withWorkspaceRecovery(repo, () => {
    const recoveredLock = clearStaleLock(repo);
    return withWorkspaceLock(repo, () => {
      const loaded = readWorkspaceState(repo);
    if (loaded.errors.length) throw extensionError(`workspace state is invalid:\n${loaded.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_WORKSPACE_STATE');
    let state = loaded.state;
    const worktrees = listWorktrees(repo);
    // Recovery must still be able to preserve/finalize an interrupted removal
    // when the authored mission was later edited. Match its stable source path
    // and ID rather than requiring the old mission content digest; this path
    // never deletes a remaining branch.
    const missionFile = displayRelative(project, loadedMission.file);
    const missionId = loadedMission.mission?.id;
    const finalized = [];
    const reset = [];
    const remaining = [];
    for (const allocation of state.allocations) {
      if (allocation.missionId !== missionId || allocation.missionFile !== missionFile || allocation.status !== 'removing') {
        remaining.push(allocation);
        continue;
      }
      const health = healthForAllocation(allocation, worktrees, workspaceRoot(repo));
      if (health.state === 'healthy') {
        const restored = { ...allocation, status: 'allocated' };
        delete restored.removal;
        remaining.push(restored);
        reset.push(allocation.id);
      } else if (health.state === 'missing') {
        const branchRetained = branchExists(repo, allocation.branch);
        state = appendReceipt(state, receiptFor(allocation, { discarded: allocation.removal.discarded, branchRetained }));
        finalized.push({ id: allocation.id, branchRetained });
      } else {
        remaining.push(allocation);
      }
    }
    if (finalized.length || reset.length) {
      state = { ...state, allocations: remaining };
      writeWorkspaceState(repo, state);
    }
    const status = workspaceStatus({ missionFile, projectDir: project });
      return { ...status, recoveredLock, finalized, reset };
    }, { allowRecovery: true });
  });
}

/** Remove a clean no-commit workspace, or explicitly discard it with an exact allocation acknowledgement. */
export function removeWorkspace({ missionFile, packageId, projectDir = '.', discard = false, acknowledge = null } = {}) {
  const repo = primaryWorkspaceRepository(projectDir);
  const project = repo.root;
  const loadedMission = readMission(missionFile, { projectDir: project });
  const mission = loadedMission.mission;
  if (!mission || typeof mission !== 'object' || !Array.isArray(mission.workPackages)) throw extensionError('mission is invalid; run vld mission validate before workspace removal', 'INVALID_MISSION');
  if (!mission.workPackages.some((entry) => entry?.id === packageId)) throw extensionError(`mission "${mission.id}" has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');

  return withWorkspaceLock(repo, () => {
    const loaded = readWorkspaceState(repo);
    if (loaded.errors.length) throw extensionError(`workspace state is invalid:\n${loaded.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_WORKSPACE_STATE');
    let state = loaded.state;
    const missionDigest = digest(mission);
    const allocation = state.allocations.find((entry) => entry.missionDigest === missionDigest && entry.packageId === packageId);
    if (!allocation) throw extensionError(`work package "${packageId}" has no allocated workspace`, 'WORKSPACE_NOT_FOUND');
    if (allocation.status !== 'allocated') throw extensionError(`work package "${packageId}" has a pending removal; run vld workspace recover`, 'WORKSPACE_RECOVERY_REQUIRED');
    const health = healthForAllocation(allocation, listWorktrees(repo), workspaceRoot(repo));
    if (health.state !== 'healthy') throw extensionError(`workspace is ${health.state}: ${health.detail}; run vld workspace recover`, 'WORKSPACE_RECOVERY_REQUIRED');
    const dirty = git(allocation.worktree, ['status', '--porcelain']);
    const tip = branchCommit(repo, allocation.branch);
    if (discard) {
      if (acknowledge !== allocation.id) throw extensionError(`discard requires --acknowledge ${allocation.id}`, 'WORKSPACE_ACKNOWLEDGEMENT_REQUIRED');
    } else {
      if (dirty) throw extensionError('workspace has staged, unstaged or untracked changes; use --discard with the exact workspace acknowledgement only if that work may be lost', 'WORKSPACE_DIRTY');
      if (tip !== allocation.baseCommit) throw extensionError('workspace branch has commits beyond its frozen base; use --discard with the exact workspace acknowledgement only if that branch may be deleted', 'WORKSPACE_HAS_COMMITS');
    }

    const pending = {
      ...allocation,
      status: 'removing',
      removal: { discarded: Boolean(discard) }
    };
    state = { ...state, allocations: state.allocations.map((entry) => entry.id === allocation.id ? pending : entry) };
    writeWorkspaceState(repo, state);
    try {
      git(repo.project, ['worktree', 'remove', ...(discard ? ['--force'] : []), allocation.worktree]);
      git(repo.project, ['branch', '-D', '--', allocation.branch]);
      state = appendReceipt({ ...state, allocations: state.allocations.filter((entry) => entry.id !== allocation.id) }, receiptFor(allocation, { discarded: discard }));
      writeWorkspaceState(repo, state);
      return { changed: true, allocation, discarded: Boolean(discard) };
    } catch (error) {
      // The persisted `removing` marker makes the interruption observable and lets
      // `recover` preserve any remaining branch rather than silently deleting it.
      throw error;
    }
  });
}
