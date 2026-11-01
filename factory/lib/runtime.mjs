/**
 * Optional Phase 3 local Runtime host.
 *
 * This host owns only durable fake-run state, leases and receipts. It does not
 * launch a process/agent/model, execute a project command, access a credential,
 * contact a network service, push, merge or change Git refs/worktrees. Those
 * capabilities require later phases and separate adapters.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  digest,
  ensureProjectDir,
  extensionError,
  ID_PATTERN,
  readJson,
  stableJson
} from './extension-utils.mjs';
import { missionStatus, readMission } from './missions.mjs';
import { assertGitHubPullRequestPlan } from './forge-plan.mjs';
import {
  assertCanAllocate,
  assertCanHeartbeat,
  assertLeaseDuration,
  assertRuntimeActor,
  assertRuntimeTransition,
  defaultRuntimePolicy,
  isTerminalRuntimeState,
  runtimePolicyDigest,
  validateRuntimePolicy
} from './runtime-policy.mjs';

const RUNTIME_STATE_VERSION = 1;
const EVENT_VERSION = 1;
const LOCK_VERSION = 1;
const MAX_RECEIPTS = 200;
const COMMIT = /^[a-f0-9]{40}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{7,120}$/;
const LEASE_TOKEN = /^lease-[a-f0-9-]{36}$/;
const EVENT_TYPES = new Set(['initialized', 'allocated', 'heartbeat', 'transition', 'ready', 'lease-expired', 'agent-run', 'candidate', 'verification', 'approval', 'queue', 'forge-plan']);

function errorDetail(error) {
  return String(error?.stderr || error?.message || error || '').trim();
}

function git(project, args, code = 'RUNTIME_GIT_FAILED') {
  try {
    return execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    throw extensionError(`git ${args[0]} failed${errorDetail(error) ? `: ${errorDetail(error)}` : ''}`, code);
  }
}

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

function safeDirectory(directory, label) {
  if (!existsSync(directory)) return;
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw extensionError(`${label} is not a real directory`, 'INVALID_RUNTIME_PATH');
}

/** Create a directory tree without following an existing symlink component. */
function mkdirWithoutSymlinks(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor)) safeDirectory(cursor, label);
    else mkdirSync(cursor);
  }
}

function safeRegularFile(file, label) {
  if (!existsSync(file)) return false;
  const stats = lstatSync(file);
  if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError(`${label} is not a regular file`, 'INVALID_RUNTIME_PATH');
  return true;
}

function writeTextAtomic(file, text) {
  mkdirWithoutSymlinks(path.dirname(file), 'runtime directory');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
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
    if (error.code === 'NOT_A_GIT_REPOSITORY') throw extensionError('runtime commands require a Git working repository', 'NOT_A_GIT_REPOSITORY');
    throw error;
  }
  const commonCandidate = path.resolve(project, commonRaw);
  if (!existsSync(commonCandidate) || !lstatSync(commonCandidate).isDirectory()) throw extensionError('Git common directory is unavailable', 'NOT_A_GIT_REPOSITORY');
  const commonDir = realpathSync(commonCandidate);
  const gitDirCandidate = path.resolve(project, gitDirRaw);
  if (!existsSync(gitDirCandidate) || !lstatSync(gitDirCandidate).isDirectory()) throw extensionError('Git directory is unavailable', 'NOT_A_GIT_REPOSITORY');
  const gitDir = realpathSync(gitDirCandidate);
  const rootPath = realpathSync(path.resolve(root));
  // In a linked worktree, --git-dir is .git/worktrees/<id>, not the common
  // directory. This identity check avoids textual /tmp, drive-letter and case
  // differences while retaining the primary-checkout-only rule.
  const rootMatchesProject = samePath(project, rootPath);
  const gitDirMatchesCommon = samePath(gitDir, commonDir);
  if (!rootMatchesProject || !gitDirMatchesCommon) {
    const detail = `root identity ${rootMatchesProject ? 'matches' : 'differs'}; Git-directory identity ${gitDirMatchesCommon ? 'matches' : 'differs'}`;
    throw extensionError(`runtime commands must run from the primary Git checkout root, not a subdirectory or linked worktree (${detail})`, 'RUNTIME_PRIMARY_CHECKOUT_REQUIRED');
  }
  return { project, root: rootPath, commonDir };
}

function runtimeBase(repo) {
  const vld = path.join(repo.root, '.vld');
  if (existsSync(vld)) safeDirectory(vld, 'runtime state directory');
  const base = path.join(vld, 'runtime');
  if (existsSync(base)) safeDirectory(base, 'runtime state directory');
  return base;
}

function runtimeDirectory(repo, mission) {
  if (!ID_PATTERN.test(String(mission?.id ?? ''))) throw extensionError('runtime mission id is invalid', 'INVALID_RUNTIME_MISSION');
  const directory = path.join(runtimeBase(repo), mission.id);
  if (!isWithin(runtimeBase(repo), directory) || directory === runtimeBase(repo)) throw extensionError('runtime state path escapes its managed root', 'INVALID_RUNTIME_PATH');
  return directory;
}

function runtimePaths(repo, mission) {
  const directory = runtimeDirectory(repo, mission);
  return {
    directory,
    events: path.join(directory, 'events.jsonl'),
    snapshot: path.join(directory, 'state.json'),
    pending: path.join(directory, 'pending.json'),
    lock: path.join(directory, 'runtime.lock'),
    recovery: path.join(directory, 'runtime.lock.recovery')
  };
}

/** Exposed for deterministic fixtures only; never print these host paths in Runtime API output. */
export function runtimeDebugPaths({ missionFile, projectDir = '.' } = {}) {
  const repo = repository(projectDir);
  const loaded = readMission(missionFile, { projectDir: repo.root });
  return runtimePaths(repo, loaded.mission);
}

function nowIso(now = undefined) {
  const date = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(date.getTime())) throw extensionError('runtime clock value is invalid', 'INVALID_RUNTIME_TIME');
  return date.toISOString();
}

function plusMilliseconds(iso, milliseconds) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw extensionError('runtime event time is invalid', 'INVALID_RUNTIME_LEDGER');
  return new Date(date.getTime() + milliseconds).toISOString();
}

function runtimeContext({ missionFile, projectDir = '.', requireCurrent = true } = {}) {
  const repo = repository(projectDir);
  const loaded = readMission(missionFile, { projectDir: repo.root });
  const report = missionStatus({ file: missionFile, projectDir: repo.root });
  if (requireCurrent && !report.ok) {
    const problems = [...report.errors, ...report.stale.map((entry) => entry.kind === 'target' ? 'mission target has moved' : `mission is stale: ${entry.kind}`)];
    throw extensionError(`mission is not current:\n${problems.map((entry) => `- ${entry}`).join('\n')}`, 'STALE_MISSION');
  }
  return { repo, mission: loaded.mission, missionFile: path.relative(repo.root, loaded.file).split(path.sep).join('/'), missionReport: report, paths: runtimePaths(repo, loaded.mission) };
}

function validLockOwner(owner) {
  return Boolean(owner) && typeof owner === 'object' && !Array.isArray(owner)
    && owner.schemaVersion === LOCK_VERSION && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.token === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(owner.token);
}

function lockOwner(paths) {
  if (!safeRegularFile(paths.lock, 'runtime lock')) throw extensionError('runtime lock has an unsafe filesystem type', 'INVALID_RUNTIME_LOCK');
  let owner;
  try { owner = readJson(paths.lock); } catch { throw extensionError('runtime lock owner is incomplete or invalid; inspect it before manual removal', 'INVALID_RUNTIME_LOCK'); }
  if (!validLockOwner(owner)) throw extensionError('runtime lock owner is incomplete or invalid; inspect it before manual removal', 'INVALID_RUNTIME_LOCK');
  return owner;
}

function activePid(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function recoveryGuard(paths) {
  let stats;
  try { stats = lstatSync(paths.recovery); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError('runtime recovery guard has an unsafe filesystem type', 'INVALID_RUNTIME_LOCK');
  // The guard is deliberately fail-closed. A crash leaves an operator-visible
  // file to inspect rather than allowing a second recovery to race cleanup.
  return paths.recovery;
}

function assertNoRecovery(paths) {
  if (recoveryGuard(paths)) throw extensionError('runtime recovery is in progress or requires manual inspection', 'RUNTIME_RECOVERY_IN_PROGRESS');
}

function acquireRecoveryGuard(paths) {
  mkdirWithoutSymlinks(paths.directory, 'runtime directory');
  const owner = { schemaVersion: LOCK_VERSION, pid: process.pid, token: randomUUID() };
  try {
    writeFileSync(paths.recovery, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw extensionError('runtime recovery is already in progress or requires manual inspection', 'RUNTIME_RECOVERY_IN_PROGRESS');
    throw error;
  }
  return owner;
}

function releaseRecoveryGuard(paths, owner) {
  try {
    const stats = lstatSync(paths.recovery);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const actual = readJson(paths.recovery);
    if (actual?.token === owner.token) rmSync(paths.recovery, { force: true });
  } catch {}
}

function withRecoveryGuard(paths, callback) {
  const owner = acquireRecoveryGuard(paths);
  try { return callback(); } finally { releaseRecoveryGuard(paths, owner); }
}

function acquireRuntimeLock(paths, { allowRecovery = false } = {}) {
  mkdirWithoutSymlinks(paths.directory, 'runtime directory');
  if (!allowRecovery) assertNoRecovery(paths);
  const owner = { schemaVersion: LOCK_VERSION, pid: process.pid, token: randomUUID() };
  try {
    writeFileSync(paths.lock, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const stats = lstatSync(paths.lock);
      if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError('runtime lock has an unsafe filesystem type', 'INVALID_RUNTIME_LOCK');
      const existing = lockOwner(paths);
      if (activePid(existing.pid)) throw extensionError(`runtime is locked by active pid ${existing.pid}`, 'RUNTIME_LOCKED');
      throw extensionError('runtime has a stale lock; run vld runtime recover', 'STALE_RUNTIME_LOCK');
    }
    throw error;
  }
  if (!allowRecovery) {
    try {
      assertNoRecovery(paths);
    } catch (error) {
      releaseRuntimeLock(paths, owner);
      throw error;
    }
  }
  return owner;
}

function releaseRuntimeLock(paths, owner) {
  try {
    const stats = lstatSync(paths.lock);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    const actual = readJson(paths.lock);
    if (actual?.token === owner.token) rmSync(paths.lock, { force: true });
  } catch {}
}

function withRuntimeLock(paths, callback, options = {}) {
  const owner = acquireRuntimeLock(paths, options);
  try {
    return callback();
  } finally {
    releaseRuntimeLock(paths, owner);
  }
}

function clearStaleRuntimeLock(paths) {
  let stats;
  try { stats = lstatSync(paths.lock); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError('runtime lock has an unsafe filesystem type', 'INVALID_RUNTIME_LOCK');
  const owner = lockOwner(paths);
  if (activePid(owner.pid)) throw extensionError(`runtime is locked by active pid ${owner.pid}`, 'RUNTIME_LOCKED');
  rmSync(paths.lock, { force: true });
  return { pid: owner.pid };
}

function assertEventActor(actor) {
  return assertRuntimeActor(actor);
}

function validDigest(value) {
  return /^[a-f0-9]{64}$/.test(String(value ?? ''));
}

/** Agent receipts are deliberately metadata-only: no argv, host path, env or raw output. */
function validateAgentRunReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw extensionError('runtime agent receipt must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'adapter', 'policyDigest', 'contextDigest', 'workspaceDigest', 'outcome', 'attempts', 'startedAt', 'finishedAt', 'durationMs', 'output']);
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) throw extensionError(`runtime agent receipt.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(receipt.id ?? ''))) throw extensionError('runtime agent receipt has an invalid id', 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(receipt.adapter ?? ''))) throw extensionError('runtime agent receipt has an invalid adapter', 'INVALID_RUNTIME_LEDGER');
  for (const field of ['policyDigest', 'contextDigest', 'workspaceDigest']) if (!validDigest(receipt[field])) throw extensionError(`runtime agent receipt has an invalid ${field}`, 'INVALID_RUNTIME_LEDGER');
  if (!['completed', 'failed', 'cancelled', 'timed-out'].includes(receipt.outcome)) throw extensionError('runtime agent receipt has an invalid outcome', 'INVALID_RUNTIME_LEDGER');
  if (!Number.isSafeInteger(receipt.attempts) || receipt.attempts < 1 || receipt.attempts > 4) throw extensionError('runtime agent receipt has an invalid attempt count', 'INVALID_RUNTIME_LEDGER');
  if (typeof receipt.startedAt !== 'string' || Number.isNaN(new Date(receipt.startedAt).getTime()) || typeof receipt.finishedAt !== 'string' || Number.isNaN(new Date(receipt.finishedAt).getTime())) throw extensionError('runtime agent receipt has invalid timestamps', 'INVALID_RUNTIME_LEDGER');
  if (!Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0 || receipt.durationMs > 24 * 60 * 60 * 1_000) throw extensionError('runtime agent receipt has an invalid duration', 'INVALID_RUNTIME_LEDGER');
  if (!receipt.output || typeof receipt.output !== 'object' || Array.isArray(receipt.output) || Object.keys(receipt.output).some((key) => !new Set(['digest', 'bytes', 'summary']).has(key))) throw extensionError('runtime agent receipt output is invalid', 'INVALID_RUNTIME_LEDGER');
  if (!validDigest(receipt.output.digest) || !Number.isSafeInteger(receipt.output.bytes) || receipt.output.bytes < 0 || typeof receipt.output.summary !== 'string' || receipt.output.summary.length > 4_000 || /[\r\n\0]/.test(receipt.output.summary)) throw extensionError('runtime agent receipt output is invalid', 'INVALID_RUNTIME_LEDGER');
  return receipt;
}

function publicAgentRun(receipt) {
  return {
    id: receipt.id,
    adapter: receipt.adapter,
    policyDigest: receipt.policyDigest,
    contextDigest: receipt.contextDigest,
    workspaceDigest: receipt.workspaceDigest,
    outcome: receipt.outcome,
    attempts: receipt.attempts,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    durationMs: receipt.durationMs,
    output: { ...receipt.output }
  };
}

function validCommit(value) {
  return COMMIT.test(String(value ?? ''));
}

function validTime(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function safeSummary(value) {
  return typeof value === 'string' && value.length <= 4_000 && !/[\r\n\0]/.test(value);
}

/** M5 receipts bind only immutable SHA/digest metadata and redacted summaries. */
function validateCandidateReceipt(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw extensionError('runtime candidate must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'missionId', 'packageId', 'candidateSha', 'baseSha', 'targetRef', 'targetSha', 'packetDigest', 'policyDigest', 'adapterRunId', 'generatedAt']);
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) throw extensionError(`runtime candidate.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(candidate.id ?? '')) || !ID_PATTERN.test(String(candidate.missionId ?? '')) || !ID_PATTERN.test(String(candidate.packageId ?? '')) || !validCommit(candidate.candidateSha) || !validCommit(candidate.baseSha) || !validCommit(candidate.targetSha)) throw extensionError('runtime candidate has invalid id or commit identity', 'INVALID_RUNTIME_LEDGER');
  if (typeof candidate.targetRef !== 'string' || !candidate.targetRef || candidate.targetRef.length > 200 || /[\r\n\0]/.test(candidate.targetRef) || candidate.targetRef.startsWith('-') || candidate.targetRef.includes('..')) throw extensionError('runtime candidate has invalid target ref', 'INVALID_RUNTIME_LEDGER');
  if (!validDigest(candidate.packetDigest) || !validDigest(candidate.policyDigest) || !validTime(candidate.generatedAt)) throw extensionError('runtime candidate has invalid authority metadata', 'INVALID_RUNTIME_LEDGER');
  if (candidate.adapterRunId !== null && !ID_PATTERN.test(String(candidate.adapterRunId ?? ''))) throw extensionError('runtime candidate has invalid adapter run id', 'INVALID_RUNTIME_LEDGER');
  return candidate;
}

function validateCheckReceipt(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) throw extensionError('runtime verification check must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'kind', 'passed', 'output']);
  for (const key of Object.keys(check)) if (!allowed.has(key)) throw extensionError(`runtime verification check.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(check.id ?? '')) || check.kind !== 'vld-packet' || typeof check.passed !== 'boolean') throw extensionError('runtime verification check is invalid', 'INVALID_RUNTIME_LEDGER');
  if (!check.output || typeof check.output !== 'object' || Array.isArray(check.output) || Object.keys(check.output).some((key) => !new Set(['digest', 'bytes', 'summary']).has(key))) throw extensionError('runtime verification output is invalid', 'INVALID_RUNTIME_LEDGER');
  if (!validDigest(check.output.digest) || !Number.isSafeInteger(check.output.bytes) || check.output.bytes < 0 || !safeSummary(check.output.summary)) throw extensionError('runtime verification output is invalid', 'INVALID_RUNTIME_LEDGER');
  return check;
}

function validateVerificationReceipt(verification) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) throw extensionError('runtime verification must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'candidateId', 'candidateSha', 'targetSha', 'policyDigest', 'integrationTree', 'outcome', 'generatedAt', 'checks']);
  for (const key of Object.keys(verification)) if (!allowed.has(key)) throw extensionError(`runtime verification.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(verification.id ?? '')) || !ID_PATTERN.test(String(verification.candidateId ?? '')) || !validCommit(verification.candidateSha) || !validCommit(verification.targetSha) || !validCommit(verification.integrationTree) || !validDigest(verification.policyDigest) || !validTime(verification.generatedAt)) throw extensionError('runtime verification has invalid identity metadata', 'INVALID_RUNTIME_LEDGER');
  if (!['passed', 'failed', 'conflict', 'invalidated'].includes(verification.outcome)) throw extensionError('runtime verification has an invalid outcome', 'INVALID_RUNTIME_LEDGER');
  if (!Array.isArray(verification.checks) || verification.checks.length !== 1) throw extensionError('runtime verification requires exactly one builtin check receipt', 'INVALID_RUNTIME_LEDGER');
  for (const check of verification.checks) validateCheckReceipt(check);
  return verification;
}

function validateApprovalReceipt(approval) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw extensionError('runtime approval must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'candidateId', 'candidateSha', 'targetSha', 'policyDigest', 'reviewerId', 'approvedAt', 'reason']);
  for (const key of Object.keys(approval)) if (!allowed.has(key)) throw extensionError(`runtime approval.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(approval.id ?? '')) || !ID_PATTERN.test(String(approval.candidateId ?? '')) || !validCommit(approval.candidateSha) || !validCommit(approval.targetSha) || !validDigest(approval.policyDigest) || !ID_PATTERN.test(String(approval.reviewerId ?? '')) || !validTime(approval.approvedAt) || !safeSummary(approval.reason) || !approval.reason.trim()) throw extensionError('runtime approval is invalid', 'INVALID_RUNTIME_LEDGER');
  return approval;
}

function validateQueueReceipt(queue) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) throw extensionError('runtime queue receipt must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'candidateId', 'candidateSha', 'targetSha', 'policyDigest', 'queuedAt']);
  for (const key of Object.keys(queue)) if (!allowed.has(key)) throw extensionError(`runtime queue.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(queue.id ?? '')) || !ID_PATTERN.test(String(queue.candidateId ?? '')) || !validCommit(queue.candidateSha) || !validCommit(queue.targetSha) || !validDigest(queue.policyDigest) || !validTime(queue.queuedAt)) throw extensionError('runtime queue receipt is invalid', 'INVALID_RUNTIME_LEDGER');
  return queue;
}

// Forge receipts never store a credential, local path, client config or provider response.
const FORGE_SENSITIVE_TEXT = /(?:github_pat_|gh[pousr]_[A-Za-z0-9_]{8,}|(?:token|secret|password|authorization|api[_-]?key)\s*(?:=|:)\s*[^\s,;]+)/i;
const FORGE_HOST_PATH = /(?:^|[\s'"])(?:\/(?:home|users|var|tmp|etc)\/|[A-Za-z]:\\)/i;

/** A durable, data-only export fact that binds every independently-issued delivery receipt. */
function validateForgePlanReceipt(forge) {
  if (!forge || typeof forge !== 'object' || Array.isArray(forge)) throw extensionError('runtime forge receipt must be an object', 'INVALID_RUNTIME_LEDGER');
  const allowed = new Set(['id', 'candidateId', 'candidateDigest', 'candidateSha', 'targetSha', 'packetDigest', 'policyDigest', 'verificationId', 'verificationDigest', 'approvalId', 'approvalDigest', 'queueId', 'queueDigest', 'exportedAt', 'plan']);
  for (const key of Object.keys(forge)) if (!allowed.has(key)) throw extensionError(`runtime forge receipt.${key} is not allowed`, 'INVALID_RUNTIME_LEDGER');
  if (!ID_PATTERN.test(String(forge.id ?? '')) || !ID_PATTERN.test(String(forge.candidateId ?? '')) || !validDigest(forge.candidateDigest) || !validCommit(forge.candidateSha) || !validCommit(forge.targetSha) || !validDigest(forge.packetDigest) || !validDigest(forge.policyDigest) || !ID_PATTERN.test(String(forge.verificationId ?? '')) || !validDigest(forge.verificationDigest) || !ID_PATTERN.test(String(forge.approvalId ?? '')) || !validDigest(forge.approvalDigest) || !ID_PATTERN.test(String(forge.queueId ?? '')) || !validDigest(forge.queueDigest) || !validTime(forge.exportedAt)) throw extensionError('runtime forge receipt has invalid authority metadata', 'INVALID_RUNTIME_LEDGER');
  try { assertGitHubPullRequestPlan(forge.plan); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_LEDGER'); }
  if (forge.plan.allowMergeRequest !== false || forge.plan.candidateId !== forge.candidateId || forge.plan.headSha !== forge.candidateSha || forge.plan.candidateSha !== forge.candidateSha || forge.plan.targetSha !== forge.targetSha || forge.plan.packetDigest !== forge.packetDigest || forge.plan.policyDigest !== forge.policyDigest) throw extensionError('runtime forge receipt plan does not bind its safe queued tuple', 'INVALID_RUNTIME_LEDGER');
  if (FORGE_SENSITIVE_TEXT.test(`${forge.plan.title}\n${forge.plan.body}`) || FORGE_HOST_PATH.test(`${forge.plan.title}\n${forge.plan.body}`)) throw extensionError('runtime forge receipt must not contain credential-like text or host paths', 'INVALID_RUNTIME_LEDGER');
  return forge;
}

function publicDeliveryReceipt(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw extensionError('runtime ledger event must be an object', 'INVALID_RUNTIME_LEDGER');
  if (event.schemaVersion !== EVENT_VERSION) throw extensionError(`runtime ledger event schemaVersion must be ${EVENT_VERSION}`, 'INVALID_RUNTIME_LEDGER');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw extensionError('runtime ledger event has invalid sequence', 'INVALID_RUNTIME_LEDGER');
  if (typeof event.at !== 'string' || Number.isNaN(new Date(event.at).getTime())) throw extensionError('runtime ledger event has invalid timestamp', 'INVALID_RUNTIME_LEDGER');
  if (!EVENT_TYPES.has(event.type)) throw extensionError('runtime ledger event has unknown type', 'INVALID_RUNTIME_LEDGER');
  assertEventActor(event.actor);
  if (event.type === 'initialized') {
    if (!event.mission || !event.policy || !Array.isArray(event.packages)) throw extensionError('runtime initialized event is incomplete', 'INVALID_RUNTIME_LEDGER');
    if (!ID_PATTERN.test(String(event.mission.id ?? '')) || !/^[a-f0-9]{64}$/.test(String(event.mission.digest ?? '')) || !COMMIT.test(String(event.mission.targetCommit ?? ''))) throw extensionError('runtime initialized event has invalid mission authority', 'INVALID_RUNTIME_LEDGER');
    if (!ID_PATTERN.test(String(event.policy.id ?? '')) || !/^[a-f0-9]{64}$/.test(String(event.policy.digest ?? ''))) throw extensionError('runtime initialized event has invalid policy authority', 'INVALID_RUNTIME_LEDGER');
    return;
  }
  if (!ID_PATTERN.test(String(event.packageId ?? ''))) throw extensionError('runtime event has invalid package id', 'INVALID_RUNTIME_LEDGER');
  if (event.type === 'agent-run') {
    if (event.actor.role !== 'runtime' || !ID_PATTERN.test(String(event.runId ?? ''))) throw extensionError('runtime agent event has an invalid actor or run id', 'INVALID_RUNTIME_LEDGER');
    validateAgentRunReceipt(event.agentRun);
    return;
  }
  if (event.type === 'candidate') {
    if (!ID_PATTERN.test(String(event.runId ?? ''))) throw extensionError('runtime candidate event has an invalid run id', 'INVALID_RUNTIME_LEDGER');
    validateCandidateReceipt(event.candidate);
    return;
  }
  if (event.type === 'verification') {
    if (event.actor.role !== 'runtime') throw extensionError('runtime verification event requires host actor', 'INVALID_RUNTIME_LEDGER');
    validateVerificationReceipt(event.verification);
    return;
  }
  if (event.type === 'approval') {
    validateApprovalReceipt(event.approval);
    return;
  }
  if (event.type === 'queue') {
    validateQueueReceipt(event.queue);
    return;
  }
  if (event.type === 'forge-plan') {
    if (event.actor.role !== 'release-approver') throw extensionError('runtime forge receipt requires a release approver', 'INVALID_RUNTIME_LEDGER');
    validateForgePlanReceipt(event.forge);
    return;
  }
  if (event.type === 'allocated') {
    if (!event.run || !ID_PATTERN.test(String(event.run.holderId ?? '')) || typeof event.run.id !== 'string' || !event.lease || typeof event.lease.tokenDigest !== 'string') throw extensionError('runtime allocation event is incomplete', 'INVALID_RUNTIME_LEDGER');
  }
  if (event.type === 'heartbeat' && (typeof event.runId !== 'string' || typeof event.expiresAt !== 'string')) throw extensionError('runtime heartbeat event is incomplete', 'INVALID_RUNTIME_LEDGER');
  if (['transition', 'ready', 'lease-expired'].includes(event.type) && (typeof event.from !== 'string' || typeof event.to !== 'string')) throw extensionError('runtime transition event is incomplete', 'INVALID_RUNTIME_LEDGER');
  if (event.idempotencyKey !== undefined && (!IDEMPOTENCY_KEY.test(event.idempotencyKey) || !/^[a-f0-9]{64}$/.test(String(event.requestDigest ?? '')))) throw extensionError('runtime event has invalid idempotency metadata', 'INVALID_RUNTIME_LEDGER');
}

function initialPackages(packages) {
  const known = new Set(packages.map((entry) => entry.id));
  return packages.map((entry) => ({
    id: entry.id,
    dependsOn: [...(entry.dependsOn ?? [])],
    state: (entry.dependsOn ?? []).length === 0 ? 'ready' : 'planned',
    version: 0,
    run: null,
    lease: null,
    blocked: null,
    requirements: [...(entry.requirements ?? [])],
    resourceClaims: [...(entry.resourceClaims?.paths ?? [])]
  })).map((entry) => {
    if (!ID_PATTERN.test(entry.id) || entry.dependsOn.some((dependency) => !known.has(dependency))) throw extensionError('runtime initialized event has invalid package graph', 'INVALID_RUNTIME_LEDGER');
    return entry;
  });
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function applyEvent(state, event) {
  if (event.type === 'initialized') {
    if (state !== null) throw extensionError('runtime ledger contains more than one initialized event', 'INVALID_RUNTIME_LEDGER');
    return {
      schemaVersion: RUNTIME_STATE_VERSION,
      mission: event.mission,
      policy: event.policy,
      packages: initialPackages(event.packages),
      receipts: [],
      sequence: event.sequence,
      eventDigest: null
    };
  }
  if (!state) throw extensionError('runtime ledger is missing its initialized event', 'INVALID_RUNTIME_LEDGER');
  const next = cloneState(state);
  const workPackage = next.packages.find((entry) => entry.id === event.packageId);
  if (!workPackage) throw extensionError(`runtime event references unknown package ${event.packageId}`, 'INVALID_RUNTIME_LEDGER');
  if (event.type === 'agent-run') {
    if (event.actor.role !== 'runtime' || workPackage.state !== 'running' || workPackage.run?.id !== event.runId) {
      throw extensionError('runtime agent receipt does not match a running package', 'INVALID_RUNTIME_LEDGER');
    }
    if (next.receipts.some((receipt) => receipt.agentRun?.id === event.agentRun.id)) throw extensionError('runtime agent receipt repeats', 'INVALID_RUNTIME_LEDGER');
  } else if (event.type === 'candidate') {
    if (workPackage.state !== 'changes_ready' || workPackage.run?.id !== event.runId || event.actor.role !== 'implementer' || event.actor.id !== workPackage.run.holderId || event.candidate.missionId !== next.mission.id || event.candidate.packageId !== event.packageId) {
      throw extensionError('runtime candidate does not match an implementer changes-ready package', 'INVALID_RUNTIME_LEDGER');
    }
    if (next.receipts.some((receipt) => receipt.candidate?.id === event.candidate.id)) throw extensionError('runtime candidate receipt repeats', 'INVALID_RUNTIME_LEDGER');
  } else if (event.type === 'verification') {
    const candidate = next.receipts.find((receipt) => receipt.candidate?.id === event.verification.candidateId)?.candidate;
    if (workPackage.state !== 'verifying' || !candidate || candidate.candidateSha !== event.verification.candidateSha || candidate.targetSha !== event.verification.targetSha || candidate.policyDigest !== event.verification.policyDigest) {
      throw extensionError('runtime verification does not match its frozen candidate', 'INVALID_RUNTIME_LEDGER');
    }
    if (next.receipts.some((receipt) => receipt.verification?.id === event.verification.id)) throw extensionError('runtime verification receipt repeats', 'INVALID_RUNTIME_LEDGER');
  } else if (event.type === 'approval') {
    const candidate = next.receipts.find((receipt) => receipt.candidate?.id === event.approval.candidateId)?.candidate;
    const verification = next.receipts.find((receipt) => receipt.verification?.candidateId === event.approval.candidateId)?.verification;
    if (workPackage.state !== 'in_review' || event.actor.role !== 'reviewer' || event.actor.id !== event.approval.reviewerId || event.actor.id === workPackage.run?.holderId || !candidate || !verification || verification.outcome !== 'passed' || candidate.candidateSha !== event.approval.candidateSha || candidate.targetSha !== event.approval.targetSha || candidate.policyDigest !== event.approval.policyDigest) {
      throw extensionError('runtime approval does not satisfy independent verified review', 'INVALID_RUNTIME_LEDGER');
    }
    if (next.receipts.some((receipt) => receipt.approval?.id === event.approval.id)) throw extensionError('runtime approval receipt repeats', 'INVALID_RUNTIME_LEDGER');
  } else if (event.type === 'queue') {
    const candidate = next.receipts.find((receipt) => receipt.candidate?.id === event.queue.candidateId)?.candidate;
    const approval = next.receipts.find((receipt) => receipt.approval?.candidateId === event.queue.candidateId)?.approval;
    if (workPackage.state !== 'approved' || event.actor.role !== 'release-approver' || !candidate || !approval || candidate.candidateSha !== event.queue.candidateSha || candidate.targetSha !== event.queue.targetSha || candidate.policyDigest !== event.queue.policyDigest) {
      throw extensionError('runtime queue receipt does not match an approved candidate', 'INVALID_RUNTIME_LEDGER');
    }
    if (next.receipts.some((receipt) => receipt.queue?.id === event.queue.id)) throw extensionError('runtime queue receipt repeats', 'INVALID_RUNTIME_LEDGER');
  } else if (event.type === 'forge-plan') {
    const candidate = next.receipts.find((receipt) => receipt.candidate?.id === event.forge.candidateId)?.candidate;
    const verification = next.receipts.find((receipt) => receipt.verification?.candidateId === event.forge.candidateId)?.verification;
    const approval = next.receipts.find((receipt) => receipt.approval?.candidateId === event.forge.candidateId)?.approval;
    const queue = next.receipts.find((receipt) => receipt.queue?.candidateId === event.forge.candidateId)?.queue;
    const exactTuple = candidate && verification && approval && queue
      && verification.outcome === 'passed'
      && digest(candidate) === event.forge.candidateDigest && candidate.candidateSha === event.forge.candidateSha && candidate.targetSha === event.forge.targetSha && candidate.packetDigest === event.forge.packetDigest && candidate.policyDigest === event.forge.policyDigest
      && approval.id === event.forge.approvalId && approval.candidateSha === event.forge.candidateSha && approval.targetSha === event.forge.targetSha && approval.policyDigest === event.forge.policyDigest
      && queue.id === event.forge.queueId && queue.candidateSha === event.forge.candidateSha && queue.targetSha === event.forge.targetSha && queue.policyDigest === event.forge.policyDigest
      && verification.id === event.forge.verificationId && digest(verification) === event.forge.verificationDigest && digest(approval) === event.forge.approvalDigest && digest(queue) === event.forge.queueDigest;
    if (workPackage.state !== 'queued' || !exactTuple) throw extensionError('runtime forge receipt does not match a passed, independently approved queued tuple', 'INVALID_RUNTIME_LEDGER');
    if (next.receipts.some((receipt) => receipt.forge?.id === event.forge.id)) throw extensionError('runtime forge receipt repeats', 'INVALID_RUNTIME_LEDGER');
  } else if (event.type === 'allocated') {
    assertCanAllocate(event.actor);
    if (workPackage.state !== 'ready' || workPackage.run || workPackage.lease) throw extensionError('runtime allocation event is not valid for package state', 'INVALID_RUNTIME_LEDGER');
    workPackage.state = 'allocated';
    workPackage.version += 1;
    workPackage.run = { id: event.run.id, holderId: event.run.holderId };
    workPackage.lease = { id: event.lease.id, tokenDigest: event.lease.tokenDigest, expiresAt: event.lease.expiresAt };
  } else if (event.type === 'heartbeat') {
    if (!workPackage.lease || workPackage.run?.id !== event.runId) throw extensionError('runtime heartbeat has no matching active lease', 'INVALID_RUNTIME_LEDGER');
    assertCanHeartbeat(event.actor, workPackage.run.holderId);
    if (Number.isNaN(new Date(event.expiresAt).getTime())) throw extensionError('runtime heartbeat has invalid expiry', 'INVALID_RUNTIME_LEDGER');
    workPackage.lease.expiresAt = event.expiresAt;
    workPackage.version += 1;
  } else {
    if (workPackage.state !== event.from) throw extensionError(`runtime transition expected ${event.from} but package is ${workPackage.state}`, 'INVALID_RUNTIME_LEDGER');
    if (event.type === 'transition' && event.expectedVersion !== workPackage.version) throw extensionError('runtime transition event has an unexpected package version', 'INVALID_RUNTIME_LEDGER');
    assertRuntimeTransition({ from: event.from, to: event.to, actor: event.actor, holderId: workPackage.run?.holderId ?? null });
    workPackage.state = event.to;
    workPackage.version += 1;
    if (event.to === 'blocked') {
      workPackage.blocked = event.reason ?? (event.type === 'lease-expired' ? 'lease expired' : 'blocked');
      workPackage.lease = null;
    } else if (event.from === 'blocked') {
      workPackage.blocked = null;
    }
    if (event.to === 'merged') workPackage.lease = null;
  }
  next.receipts = [...next.receipts, {
    sequence: event.sequence,
    type: event.type,
    packageId: event.packageId,
    actor: event.actor,
    at: event.at,
    ...(event.from ? { from: event.from, to: event.to } : {}),
    ...(event.type === 'agent-run' ? { runId: event.runId, agentRun: publicAgentRun(event.agentRun) } : {}),
    ...(event.type === 'candidate' ? { runId: event.runId, candidate: publicDeliveryReceipt(event.candidate) } : {}),
    ...(event.type === 'verification' ? { verification: publicDeliveryReceipt(event.verification) } : {}),
    ...(event.type === 'approval' ? { approval: publicDeliveryReceipt(event.approval) } : {}),
    ...(event.type === 'queue' ? { queue: publicDeliveryReceipt(event.queue) } : {}),
    ...(event.type === 'forge-plan' ? { forge: publicDeliveryReceipt(event.forge) } : {})
  }].slice(-MAX_RECEIPTS);
  next.sequence = event.sequence;
  return next;
}

function deriveState(events) {
  let state = null;
  let expectedSequence = 1;
  for (const event of events) {
    validateEvent(event);
    if (event.sequence !== expectedSequence) throw extensionError(`runtime ledger sequence ${event.sequence} is not contiguous`, 'INVALID_RUNTIME_LEDGER');
    state = applyEvent(state, event);
    expectedSequence += 1;
  }
  if (!state) throw extensionError('runtime ledger has no initialized event', 'INVALID_RUNTIME_LEDGER');
  state.eventDigest = digest(events);
  return state;
}

function readEvents(paths) {
  if (!safeRegularFile(paths.events, 'runtime event ledger')) throw extensionError('runtime has not been initialized', 'RUNTIME_NOT_FOUND');
  const source = readFileSync(paths.events, 'utf8');
  if (!source.endsWith('\n')) throw extensionError('runtime event ledger is truncated', 'INVALID_RUNTIME_LEDGER');
  const lines = source.split('\n').filter(Boolean);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    throw extensionError(`runtime event ledger has invalid JSON: ${error.message}`, 'INVALID_RUNTIME_LEDGER');
  }
}

function writeEvents(paths, events) {
  writeTextAtomic(paths.events, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

function readLedger(paths, { requireSnapshot = true } = {}) {
  const events = readEvents(paths);
  const state = deriveState(events);
  if (requireSnapshot) {
    if (!safeRegularFile(paths.snapshot, 'runtime state snapshot')) throw extensionError('runtime state snapshot is missing', 'INVALID_RUNTIME_LEDGER');
    let snapshot;
    try { snapshot = readJson(paths.snapshot); } catch (error) { throw extensionError(`runtime state snapshot is invalid JSON: ${error.message}`, 'INVALID_RUNTIME_LEDGER'); }
    if (stableJson(snapshot) !== stableJson(state)) throw extensionError('runtime state snapshot does not match its event ledger; run vld runtime recover', 'RUNTIME_LEDGER_DIVERGED');
  }
  return { events, state };
}

function writeSnapshot(paths, state) {
  writeJsonAtomic(paths.snapshot, state);
}

function writePending(paths, pending) {
  writeJsonAtomic(paths.pending, pending);
}

function assertNoPendingTransaction(paths) {
  let stats;
  try {
    stats = lstatSync(paths.pending);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw extensionError('runtime pending transaction has an unsafe filesystem type', 'INVALID_RUNTIME_LEDGER');
  throw extensionError('runtime has a pending transaction; run vld runtime recover before another mutation', 'RUNTIME_RECOVERY_REQUIRED');
}

function appendEvents(paths, before, additions) {
  // Do not overwrite an interrupted transaction: only recovery may classify its
  // digest as known-unapplied or known-complete.
  assertNoPendingTransaction(paths);
  const after = [...before, ...additions];
  const pending = {
    schemaVersion: RUNTIME_STATE_VERSION,
    beforeEventDigest: digest(before),
    nextEventDigest: digest(after)
  };
  writePending(paths, pending);
  writeEvents(paths, after);
  const state = deriveState(after);
  writeSnapshot(paths, state);
  rmSync(paths.pending, { force: true });
  return { events: after, state };
}

function reconcilePending(paths) {
  if (!safeRegularFile(paths.pending, 'runtime pending transaction')) return { changed: false };
  let pending;
  try { pending = readJson(paths.pending); } catch (error) { throw extensionError(`runtime pending transaction is invalid JSON: ${error.message}`, 'INVALID_RUNTIME_LEDGER'); }
  if (!pending || pending.schemaVersion !== RUNTIME_STATE_VERSION || !/^[a-f0-9]{64}$/.test(String(pending.beforeEventDigest ?? '')) || !/^[a-f0-9]{64}$/.test(String(pending.nextEventDigest ?? ''))) {
    throw extensionError('runtime pending transaction is invalid', 'INVALID_RUNTIME_LEDGER');
  }
  const events = readEvents(paths);
  const actual = digest(events);
  if (actual === pending.beforeEventDigest) {
    rmSync(paths.pending, { force: true });
    return { changed: true, action: 'discarded-unapplied-pending-transaction' };
  }
  if (actual === pending.nextEventDigest) {
    writeSnapshot(paths, deriveState(events));
    rmSync(paths.pending, { force: true });
    return { changed: true, action: 'completed-pending-transaction' };
  }
  throw extensionError('runtime pending transaction does not match the event ledger', 'RUNTIME_LEDGER_DIVERGED');
}

function currentMissionMatches(state, context) {
  return state.mission.digest === digest(context.mission)
    && state.mission.targetCommit === context.mission.target.commit
    && state.mission.packetDigest === context.mission.packet.digest
    && state.mission.policyDigest === context.mission.corePolicyDigest;
}

function publicPackage(workPackage) {
  return {
    id: workPackage.id,
    state: workPackage.state,
    version: workPackage.version,
    dependsOn: [...workPackage.dependsOn],
    requirements: [...workPackage.requirements],
    resourceClaims: [...workPackage.resourceClaims],
    run: workPackage.run ? { ...workPackage.run } : null,
    lease: workPackage.lease ? { id: workPackage.lease.id, expiresAt: workPackage.lease.expiresAt } : null,
    blocked: workPackage.blocked
  };
}

function reportRuntime(context, state, { warnings = [], recovered = null } = {}) {
  const expired = state.packages.filter((entry) => entry.lease && new Date(entry.lease.expiresAt).getTime() <= Date.now()).map((entry) => entry.id);
  if (!currentMissionMatches(state, context)) warnings.push('runtime state belongs to a different revision of this mission; allocation and transitions are blocked');
  if (!context.missionReport.ok) warnings.push('mission is not current; allocation and transitions are blocked');
  if (expired.length) warnings.push(`${expired.length} lease(s) are expired; run vld runtime recover`);
  return {
    ok: warnings.length === 0,
    runtime: {
      missionId: state.mission.id,
      missionDigest: state.mission.digest,
      packetDigest: state.mission.packetDigest,
      corePolicyDigest: state.mission.policyDigest,
      policy: { id: state.policy.id, digest: state.policy.digest },
      sequence: state.sequence
    },
    mission: { id: context.mission.id, current: context.missionReport.ok, stale: context.missionReport.stale },
    packages: state.packages.map(publicPackage),
    agentRuns: state.receipts.filter((receipt) => receipt.type === 'agent-run' && receipt.agentRun).map((receipt) => ({
      sequence: receipt.sequence,
      packageId: receipt.packageId,
      runId: receipt.runId,
      ...publicAgentRun(receipt.agentRun)
    })),
    delivery: state.receipts.filter((receipt) => ['candidate', 'verification', 'approval', 'queue', 'forge-plan'].includes(receipt.type)).map((receipt) => ({
      sequence: receipt.sequence,
      packageId: receipt.packageId,
      ...(receipt.runId ? { runId: receipt.runId } : {}),
      ...(receipt.candidate ? { candidate: publicDeliveryReceipt(receipt.candidate) } : {}),
      ...(receipt.verification ? { verification: publicDeliveryReceipt(receipt.verification) } : {}),
      ...(receipt.approval ? { approval: publicDeliveryReceipt(receipt.approval) } : {}),
      ...(receipt.queue ? { queue: publicDeliveryReceipt(receipt.queue) } : {}),
      ...(receipt.forge ? { forge: publicDeliveryReceipt(receipt.forge) } : {})
    })),
    warnings,
    ...(recovered ? { recovered } : {})
  };
}

function assertCurrentRuntime(context, state, policy) {
  if (!context.missionReport.ok || !currentMissionMatches(state, context)) throw extensionError('runtime mission authority is stale or changed; create a new reviewed mission/runtime instead', 'STALE_RUNTIME_MISSION');
  const checked = validateRuntimePolicy(policy);
  if (!checked.ok || runtimePolicyDigest(policy) !== state.policy.digest) throw extensionError('runtime policy differs from its frozen policy digest', 'STALE_RUNTIME_POLICY');
}

function normalizeIdempotency(key, request) {
  if (key === undefined || key === null) return null;
  if (!IDEMPOTENCY_KEY.test(String(key))) throw extensionError('idempotency key must be a bounded identifier', 'INVALID_RUNTIME_IDEMPOTENCY');
  return { key: String(key), requestDigest: digest(request) };
}

function suppliedLeaseToken(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !LEASE_TOKEN.test(value)) throw extensionError('lease token must be a lease-prefixed UUID capability', 'INVALID_RUNTIME_LEASE');
  return value;
}

function idempotentResult(events, metadata, state, context, { leaseToken = null } = {}) {
  if (!metadata) return null;
  const existing = events.find((event) => event.idempotencyKey === metadata.key);
  if (!existing) return null;
  if (existing.requestDigest !== metadata.requestDigest) throw extensionError('idempotency key was reused for a different request', 'RUNTIME_IDEMPOTENCY_CONFLICT');
  return { changed: false, replayedSequence: existing.sequence, status: reportRuntime(context, state), ...(leaseToken ? { leaseToken } : {}) };
}

function assertGenericRuntimeTransition(from, to) {
  // Candidate, verification, approval, queue and forge progression are evidence
  // transitions. They are deliberately available only through their typed
  // receipt APIs below, never through the generic state endpoint.
  if (to === 'blocked') return;
  if (!new Set(['allocated->running', 'running->changes_ready', 'blocked->ready']).has(`${from}->${to}`)) {
    throw extensionError(`transition ${from}->${to} requires its typed Runtime receipt API`, 'RUNTIME_RECEIPT_REQUIRED');
  }
}

function activeLease(workPackage, token, at) {
  if (!workPackage.lease || !workPackage.run) throw extensionError('package has no active lease', 'RUNTIME_LEASE_NOT_FOUND');
  if (new Date(workPackage.lease.expiresAt).getTime() <= new Date(at).getTime()) throw extensionError('package lease has expired; run runtime recover', 'RUNTIME_LEASE_EXPIRED');
  if (typeof token !== 'string' || digest(token) !== workPackage.lease.tokenDigest) throw extensionError('lease token is invalid', 'RUNTIME_LEASE_FORBIDDEN');
}

function transitionReadiness(state, sequence, at) {
  const events = [];
  let working = cloneState(state);
  for (const workPackage of working.packages) {
    if (workPackage.state !== 'planned') continue;
    const ready = workPackage.dependsOn.every((dependency) => working.packages.find((entry) => entry.id === dependency)?.state === 'merged');
    if (!ready) continue;
    const event = { schemaVersion: EVENT_VERSION, sequence: sequence + events.length, at, type: 'ready', actor: { role: 'runtime', id: 'runtime-host' }, packageId: workPackage.id, from: 'planned', to: 'ready' };
    working = applyEvent(working, event);
    events.push(event);
  }
  return events;
}

/** Initialize a Runtime ledger from one current, verified mission. */
export function initializeRuntime({ missionFile, projectDir = '.', policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const checked = validateRuntimePolicy(policy);
  if (!checked.ok) throw extensionError(`runtime policy is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_RUNTIME_POLICY');
  mkdirWithoutSymlinks(context.paths.directory, 'runtime directory');
  return withRuntimeLock(context.paths, () => {
    if (existsSync(context.paths.events)) {
      const { state } = readLedger(context.paths);
      if (!currentMissionMatches(state, context)) throw extensionError('a different mission revision already owns this runtime directory', 'RUNTIME_MISSION_MISMATCH');
      if (state.policy.digest !== runtimePolicyDigest(policy)) throw extensionError('runtime policy differs from existing runtime state', 'RUNTIME_POLICY_MISMATCH');
      return { changed: false, status: reportRuntime(context, state) };
    }
    const at = nowIso(now);
    const event = {
      schemaVersion: EVENT_VERSION,
      sequence: 1,
      at,
      type: 'initialized',
      actor: { role: 'runtime', id: 'runtime-host' },
      mission: {
        id: context.mission.id,
        digest: digest(context.mission),
        file: context.missionFile,
        targetCommit: context.mission.target.commit,
        packetDigest: context.mission.packet.digest,
        policyDigest: context.mission.corePolicyDigest
      },
      policy: { id: policy.id, digest: runtimePolicyDigest(policy) },
      packages: context.mission.workPackages
    };
    const events = [event];
    const state = deriveState(events);
    writeEvents(context.paths, events);
    writeSnapshot(context.paths, state);
    return { changed: true, status: reportRuntime(context, state) };
  });
}

/** Inspect the ledger without changing Runtime state. */
export function runtimeStatus({ missionFile, projectDir = '.', now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: false });
  const { state } = readLedger(context.paths);
  const warnings = [];
  const timestamp = nowIso(now);
  const expired = state.packages.filter((entry) => entry.lease && new Date(entry.lease.expiresAt).getTime() <= new Date(timestamp).getTime()).map((entry) => entry.id);
  if (expired.length) warnings.push(`${expired.length} lease(s) are expired; run vld runtime recover`);
  return reportRuntime(context, state, { warnings });
}

/**
 * Read the exact durable tuple that may be bound into a data-only forge plan.
 * The caller receives no Runtime paths, credential material or provider facts.
 */
export function runtimeForgeEvidence({ missionFile, packageId, candidateId, projectDir = '.', policy = defaultRuntimePolicy() } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  if (!ID_PATTERN.test(String(packageId ?? '')) || !ID_PATTERN.test(String(candidateId ?? ''))) throw extensionError('forge evidence package/candidate id is invalid', 'INVALID_RUNTIME_FORGE_RECEIPT');
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    if (workPackage.state !== 'queued') throw extensionError('forge plan export requires a queued package', 'RUNTIME_FORGE_STATE');
    const candidateEvent = events.find((event) => event.type === 'candidate' && event.packageId === packageId && event.candidate?.id === candidateId);
    const candidate = candidateEvent?.candidate;
    const verification = events.find((event) => event.type === 'verification' && event.packageId === packageId && event.verification?.candidateId === candidateId)?.verification;
    const approval = events.find((event) => event.type === 'approval' && event.packageId === packageId && event.approval?.candidateId === candidateId)?.approval;
    const queue = events.find((event) => event.type === 'queue' && event.packageId === packageId && event.queue?.candidateId === candidateId)?.queue;
    if (!candidate || !verification || verification.outcome !== 'passed' || !approval || !queue) throw extensionError('forge plan requires one passed verification, independent approval and queue receipt', 'RUNTIME_FORGE_TUPLE_INVALID');
    if (candidate.candidateSha !== verification.candidateSha || candidate.targetSha !== verification.targetSha || candidate.policyDigest !== verification.policyDigest || candidate.candidateSha !== approval.candidateSha || candidate.targetSha !== approval.targetSha || candidate.policyDigest !== approval.policyDigest || candidate.candidateSha !== queue.candidateSha || candidate.targetSha !== queue.targetSha || candidate.policyDigest !== queue.policyDigest) throw extensionError('forge plan tuple authority does not match', 'RUNTIME_FORGE_TUPLE_INVALID');
    return {
      mission: { id: context.mission.id, targetRef: context.mission.target.ref, targetSha: context.mission.target.commit, packetDigest: context.mission.packet.digest },
      package: publicPackage(workPackage),
      candidate: publicDeliveryReceipt(candidate),
      verification: publicDeliveryReceipt(verification),
      approval: publicDeliveryReceipt(approval),
      queue: publicDeliveryReceipt(queue)
    };
  });
}

/** Allocate one ready package and return its one-time lease token. */
export function allocateRuntimePackage({ missionFile, packageId, projectDir = '.', actor = { role: 'operator', id: 'local-operator' }, assignee, leaseMs = 5 * 60 * 1_000, leaseToken = null, idempotencyKey = null, now, policy = defaultRuntimePolicy() } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const requestedActor = assertCanAllocate(actor);
  const holder = assertRuntimeActor(assignee);
  if (holder.role !== 'implementer') throw extensionError('runtime assignee must have implementer role', 'INVALID_RUNTIME_ASSIGNEE');
  const duration = assertLeaseDuration(leaseMs, policy);
  const suppliedToken = suppliedLeaseToken(leaseToken);
  if (idempotencyKey && !suppliedToken) throw extensionError('idempotent allocation requires a caller-held lease token', 'RUNTIME_LEASE_TOKEN_REQUIRED');
  const token = suppliedToken ?? `lease-${randomUUID()}`;
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const request = { operation: 'allocate', packageId, actor: requestedActor, assignee: holder, leaseMs: duration, leaseTokenDigest: digest(token) };
    const idempotency = normalizeIdempotency(idempotencyKey, request);
    const replay = idempotentResult(events, idempotency, state, context, { leaseToken: suppliedToken });
    if (replay) return replay;
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    if (workPackage.state !== 'ready') throw extensionError(`work package "${packageId}" is ${workPackage.state}, not ready`, 'RUNTIME_PACKAGE_NOT_READY');
    const event = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'allocated',
      actor: requestedActor,
      packageId,
      run: { id: `run-${randomUUID()}`, holderId: holder.id },
      lease: { id: `lease-${randomUUID()}`, tokenDigest: digest(token), expiresAt: plusMilliseconds(at, duration) },
      ...(idempotency ? { idempotencyKey: idempotency.key, requestDigest: idempotency.requestDigest } : {})
    };
    const committed = appendEvents(context.paths, events, [event]);
    const allocated = committed.state.packages.find((entry) => entry.id === packageId);
    return { changed: true, leaseToken: token, status: reportRuntime(context, committed.state), allocation: publicPackage(allocated) };
  });
}

/** Extend an assigned implementer's lease without exposing its token in the ledger. */
export function heartbeatRuntimeLease({ missionFile, packageId, runId, leaseToken, projectDir = '.', actor, leaseMs = 5 * 60 * 1_000, idempotencyKey = null, now, policy = defaultRuntimePolicy() } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const at = nowIso(now);
  const duration = assertLeaseDuration(leaseMs, policy);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    const requestedActor = assertCanHeartbeat(actor, workPackage.run?.holderId);
    const request = { operation: 'heartbeat', packageId, runId, actor: requestedActor, leaseTokenDigest: digest(String(leaseToken ?? '')), leaseMs: duration };
    const idempotency = normalizeIdempotency(idempotencyKey, request);
    const replay = idempotentResult(events, idempotency, state, context);
    if (replay) return replay;
    activeLease(workPackage, leaseToken, at);
    if (workPackage.run.id !== runId) throw extensionError('run id does not own this package lease', 'RUNTIME_LEASE_FORBIDDEN');
    const event = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'heartbeat',
      actor: requestedActor,
      packageId,
      runId,
      expiresAt: plusMilliseconds(at, duration),
      ...(idempotency ? { idempotencyKey: idempotency.key, requestDigest: idempotency.requestDigest } : {})
    };
    const committed = appendEvents(context.paths, events, [event]);
    return { changed: true, status: reportRuntime(context, committed.state), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/** Apply one host-validated package state transition. */
export function transitionRuntimePackage({ missionFile, packageId, to, actor, expectedVersion, leaseToken = null, reason = null, projectDir = '.', idempotencyKey = null, now, policy = defaultRuntimePolicy() } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    // Check replay before current-state validation: a timed-out request naturally
    // sees the already-advanced state but must still return its first receipt.
    const declaredActor = assertRuntimeActor(actor);
    const request = { operation: 'transition', packageId, to, actor: declaredActor, expectedVersion, leaseTokenDigest: leaseToken ? digest(leaseToken) : null, reason };
    const idempotency = normalizeIdempotency(idempotencyKey, request);
    const replay = idempotentResult(events, idempotency, state, context);
    if (replay) return replay;
    if (isTerminalRuntimeState(workPackage.state)) throw extensionError('terminal package state cannot transition again', 'RUNTIME_TERMINAL_STATE');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== workPackage.version) throw extensionError(`expected package version ${workPackage.version}`, 'RUNTIME_VERSION_CONFLICT');
    assertGenericRuntimeTransition(workPackage.state, to);
    const requestedActor = assertRuntimeTransition({ from: workPackage.state, to, actor: declaredActor, holderId: workPackage.run?.holderId ?? null });
    if (['allocated', 'running'].includes(workPackage.state) && ['running', 'changes_ready'].includes(to)) activeLease(workPackage, leaseToken, at);
    if (reason !== null && (typeof reason !== 'string' || !reason.trim() || /[\r\n\0]/.test(reason) || reason.length > 500)) throw extensionError('transition reason must be a bounded one-line string', 'INVALID_RUNTIME_TRANSITION');
    const event = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'transition',
      actor: requestedActor,
      packageId,
      from: workPackage.state,
      to,
      expectedVersion,
      ...(reason ? { reason } : {}),
      ...(idempotency ? { idempotencyKey: idempotency.key, requestDigest: idempotency.requestDigest } : {})
    };
    const transitioned = applyEvent(state, event);
    const readiness = to === 'merged' ? transitionReadiness(transitioned, event.sequence + 1, at) : [];
    const committed = appendEvents(context.paths, events, [event, ...readiness]);
    return { changed: true, status: reportRuntime(context, committed.state), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/** Submit a frozen M5 candidate and atomically enter host-owned verification. */
export function submitRuntimeCandidate({ missionFile, packageId, runId, candidate, leaseToken, actor, projectDir = '.', policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const requestedActor = assertRuntimeActor(actor);
  try { validateCandidateReceipt(candidate); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_CANDIDATE'); }
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    const prior = events.find((event) => event.type === 'candidate' && event.candidate?.id === candidate.id);
    if (prior) {
      if (prior.packageId !== packageId || prior.runId !== runId || digest(prior.candidate) !== digest(candidate)) throw extensionError('candidate receipt id was reused for different data', 'RUNTIME_IDEMPOTENCY_CONFLICT');
      return { changed: false, replayedSequence: prior.sequence, status: reportRuntime(context, state), candidate: publicDeliveryReceipt(prior.candidate) };
    }
    if (workPackage.state !== 'changes_ready' || workPackage.run?.id !== runId) throw extensionError('candidate submission requires the active changes-ready package run', 'RUNTIME_CANDIDATE_STATE');
    assertCanHeartbeat(requestedActor, workPackage.run.holderId);
    activeLease(workPackage, leaseToken, at);
    const candidateEvent = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'candidate',
      actor: requestedActor,
      packageId,
      runId,
      candidate: publicDeliveryReceipt(candidate)
    };
    const candidateState = applyEvent(state, candidateEvent);
    const transition = {
      schemaVersion: EVENT_VERSION,
      sequence: candidateEvent.sequence + 1,
      at,
      type: 'transition',
      actor: { role: 'runtime', id: 'runtime-host' },
      packageId,
      from: 'changes_ready',
      to: 'verifying',
      expectedVersion: workPackage.version
    };
    applyEvent(candidateState, transition);
    const committed = appendEvents(context.paths, events, [candidateEvent, transition]);
    return { changed: true, status: reportRuntime(context, committed.state), candidate: publicDeliveryReceipt(candidate), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/** Persist host verification and atomically enter review or block the candidate. */
export function recordRuntimeVerification({ missionFile, packageId, verification, projectDir = '.', policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  try { validateVerificationReceipt(verification); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_VERIFICATION'); }
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    const prior = events.find((event) => event.type === 'verification' && event.verification?.id === verification.id);
    if (prior) {
      if (prior.packageId !== packageId || digest(prior.verification) !== digest(verification)) throw extensionError('verification receipt id was reused for different data', 'RUNTIME_IDEMPOTENCY_CONFLICT');
      return { changed: false, replayedSequence: prior.sequence, status: reportRuntime(context, state), verification: publicDeliveryReceipt(prior.verification) };
    }
    if (workPackage.state !== 'verifying') throw extensionError('verification requires a verifying package', 'RUNTIME_VERIFICATION_STATE');
    const verificationEvent = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'verification',
      actor: { role: 'runtime', id: 'runtime-host' },
      packageId,
      verification: publicDeliveryReceipt(verification)
    };
    const verificationState = applyEvent(state, verificationEvent);
    const passed = verification.outcome === 'passed';
    const transition = {
      schemaVersion: EVENT_VERSION,
      sequence: verificationEvent.sequence + 1,
      at,
      type: 'transition',
      actor: { role: 'runtime', id: 'runtime-host' },
      packageId,
      from: 'verifying',
      to: passed ? 'in_review' : 'blocked',
      expectedVersion: workPackage.version,
      ...(!passed ? { reason: `delivery verification ${verification.outcome}` } : {})
    };
    applyEvent(verificationState, transition);
    const committed = appendEvents(context.paths, events, [verificationEvent, transition]);
    return { changed: true, status: reportRuntime(context, committed.state), verification: publicDeliveryReceipt(verification), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/** Bind an independent reviewer approval to one exact verified candidate tuple. */
export function approveRuntimeCandidate({ missionFile, packageId, approval, actor, projectDir = '.', policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const requestedActor = assertRuntimeActor(actor);
  try { validateApprovalReceipt(approval); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_APPROVAL'); }
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    const prior = events.find((event) => event.type === 'approval' && event.approval?.id === approval.id);
    if (prior) {
      if (prior.packageId !== packageId || digest(prior.approval) !== digest(approval)) throw extensionError('approval receipt id was reused for different data', 'RUNTIME_IDEMPOTENCY_CONFLICT');
      return { changed: false, replayedSequence: prior.sequence, status: reportRuntime(context, state), approval: publicDeliveryReceipt(prior.approval) };
    }
    if (workPackage.state !== 'in_review') throw extensionError('approval requires a package in review', 'RUNTIME_APPROVAL_STATE');
    const approvalEvent = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'approval',
      actor: requestedActor,
      packageId,
      approval: publicDeliveryReceipt(approval)
    };
    const approvalState = applyEvent(state, approvalEvent);
    const transition = {
      schemaVersion: EVENT_VERSION,
      sequence: approvalEvent.sequence + 1,
      at,
      type: 'transition',
      actor: requestedActor,
      packageId,
      from: 'in_review',
      to: 'approved',
      expectedVersion: workPackage.version
    };
    applyEvent(approvalState, transition);
    const committed = appendEvents(context.paths, events, [approvalEvent, transition]);
    return { changed: true, status: reportRuntime(context, committed.state), approval: publicDeliveryReceipt(approval), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/** Queue an approved exact tuple; M5 deliberately has no local/forge merge action. */
export function queueRuntimeCandidate({ missionFile, packageId, queue, actor, projectDir = '.', policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const requestedActor = assertRuntimeActor(actor);
  try { validateQueueReceipt(queue); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_QUEUE'); }
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    const prior = events.find((event) => event.type === 'queue' && event.queue?.id === queue.id);
    if (prior) {
      if (prior.packageId !== packageId || digest(prior.queue) !== digest(queue)) throw extensionError('queue receipt id was reused for different data', 'RUNTIME_IDEMPOTENCY_CONFLICT');
      return { changed: false, replayedSequence: prior.sequence, status: reportRuntime(context, state), queue: publicDeliveryReceipt(prior.queue) };
    }
    if (workPackage.state !== 'approved') throw extensionError('queue requires an approved package', 'RUNTIME_QUEUE_STATE');
    const queueEvent = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'queue',
      actor: requestedActor,
      packageId,
      queue: publicDeliveryReceipt(queue)
    };
    const queueState = applyEvent(state, queueEvent);
    const transition = {
      schemaVersion: EVENT_VERSION,
      sequence: queueEvent.sequence + 1,
      at,
      type: 'transition',
      actor: requestedActor,
      packageId,
      from: 'approved',
      to: 'queued',
      expectedVersion: workPackage.version
    };
    applyEvent(queueState, transition);
    const committed = appendEvents(context.paths, events, [queueEvent, transition]);
    return { changed: true, status: reportRuntime(context, committed.state), queue: publicDeliveryReceipt(queue), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/**
 * Persist a safe, immutable GitHub plan after replaying its exact queued tuple.
 * This is a local ledger fact only: no credential, network request, Git action,
 * PR operation or merge request is made here.
 */
export function recordRuntimeForgePlan({ missionFile, packageId, forge, actor, projectDir = '.', policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const requestedActor = assertRuntimeActor(actor);
  if (requestedActor.role !== 'release-approver') throw extensionError('forge plan export requires a release approver', 'RUNTIME_ACTOR_FORBIDDEN');
  try { validateForgePlanReceipt(forge); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_FORGE_RECEIPT'); }
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    const prior = events.find((event) => event.type === 'forge-plan' && event.forge?.id === forge.id);
    if (prior) {
      const { exportedAt: _priorExportedAt, ...priorAuthority } = prior.forge;
      const { exportedAt: _requestedExportedAt, ...requestedAuthority } = forge;
      if (prior.packageId !== packageId || digest(priorAuthority) !== digest(requestedAuthority)) throw extensionError('forge receipt id was reused for different data', 'RUNTIME_IDEMPOTENCY_CONFLICT');
      // A deterministic plan re-export gets the original durable receipt/time.
      // The fresh local timestamp is intentionally not an authority change.
      return { changed: false, replayedSequence: prior.sequence, status: reportRuntime(context, state), forge: publicDeliveryReceipt(prior.forge) };
    }
    if (workPackage.state !== 'queued') throw extensionError('forge plan export requires a queued package', 'RUNTIME_FORGE_STATE');
    const event = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'forge-plan',
      actor: requestedActor,
      packageId,
      forge: publicDeliveryReceipt(forge)
    };
    applyEvent(state, event);
    const committed = appendEvents(context.paths, events, [event]);
    return { changed: true, status: reportRuntime(context, committed.state), forge: publicDeliveryReceipt(forge), package: publicPackage(committed.state.packages.find((entry) => entry.id === packageId)) };
  });
}

/**
 * Persist an M4 adapter receipt after a host-controlled adapter attempt. This
 * does not advance lifecycle state; the host performs the separate transition
 * only after the receipt is durable. Raw process output/path/env never enter it.
 */
export function recordRuntimeAgentReceipt({ missionFile, packageId, runId, agentRun, projectDir = '.', actor = { role: 'runtime', id: 'runtime-host' }, policy = defaultRuntimePolicy(), now } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: true });
  const requestedActor = assertRuntimeActor(actor);
  if (requestedActor.role !== 'runtime') throw extensionError('only the Runtime host may record an agent receipt', 'RUNTIME_ACTOR_FORBIDDEN');
  if (!ID_PATTERN.test(String(packageId ?? '')) || !ID_PATTERN.test(String(runId ?? ''))) throw extensionError('runtime agent receipt package/run id is invalid', 'INVALID_RUNTIME_AGENT_RECEIPT');
  try { validateAgentRunReceipt(agentRun); } catch (error) {
    throw extensionError(error.message, 'INVALID_RUNTIME_AGENT_RECEIPT');
  }
  const at = nowIso(now);
  return withRuntimeLock(context.paths, () => {
    const { events, state } = readLedger(context.paths);
    assertCurrentRuntime(context, state, policy);
    const workPackage = state.packages.find((entry) => entry.id === packageId);
    if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
    if (workPackage.state !== 'running' || workPackage.run?.id !== runId) throw extensionError('runtime agent receipt must match the active running package', 'RUNTIME_AGENT_RUN_MISMATCH');
    const prior = events.find((event) => event.type === 'agent-run' && event.agentRun?.id === agentRun.id);
    if (prior) {
      if (digest(prior.agentRun) !== digest(agentRun) || prior.packageId !== packageId || prior.runId !== runId) throw extensionError('runtime agent receipt id was reused for different data', 'RUNTIME_IDEMPOTENCY_CONFLICT');
      return { changed: false, replayedSequence: prior.sequence, status: reportRuntime(context, state), agentRun: publicAgentRun(prior.agentRun) };
    }
    const event = {
      schemaVersion: EVENT_VERSION,
      sequence: state.sequence + 1,
      at,
      type: 'agent-run',
      actor: requestedActor,
      packageId,
      runId,
      agentRun: publicAgentRun(agentRun)
    };
    const committed = appendEvents(context.paths, events, [event]);
    return { changed: true, status: reportRuntime(context, committed.state), agentRun: publicAgentRun(agentRun) };
  });
}

/** Reconcile an interrupted transaction/stale lock and block expired leases. */
export function recoverRuntime({ missionFile, projectDir = '.', now, policy = defaultRuntimePolicy() } = {}) {
  const context = runtimeContext({ missionFile, projectDir, requireCurrent: false });
  const at = nowIso(now);
  return withRecoveryGuard(context.paths, () => {
    const recoveredLock = clearStaleRuntimeLock(context.paths);
    return withRuntimeLock(context.paths, () => {
      const pending = reconcilePending(context.paths);
    const { events, state } = readLedger(context.paths);
    const expired = state.packages.filter((entry) => entry.lease && new Date(entry.lease.expiresAt).getTime() <= new Date(at).getTime() && !isTerminalRuntimeState(entry.state));
    let committed = { events, state };
    if (expired.length) {
      const additions = expired.map((entry, index) => ({
        schemaVersion: EVENT_VERSION,
        sequence: state.sequence + index + 1,
        at,
        type: 'lease-expired',
        actor: { role: 'runtime', id: 'runtime-host' },
        packageId: entry.id,
        from: entry.state,
        to: 'blocked',
        reason: 'lease expired without a valid heartbeat'
      }));
      committed = appendEvents(context.paths, events, additions);
    }
    const checked = validateRuntimePolicy(policy);
    const warnings = checked.ok && committed.state.policy.digest !== runtimePolicyDigest(policy) ? ['runtime policy digest differs from requested local policy'] : [];
      return reportRuntime(context, committed.state, { warnings, recovered: { lock: recoveredLock, pending, expiredLeases: expired.map((entry) => entry.id) } });
    }, { allowRecovery: true });
  });
}
