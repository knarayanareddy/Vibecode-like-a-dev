/**
 * M5 candidate, deterministic integration verification, independent approval and
 * queue host. It has no project-command runner, push, local merge, forge or PR
 * adapter. All lifecycle records are appended by runtime.mjs, never by a caller.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadDeliveryPolicy } from './delivery-policy.mjs';
import { digest, extensionError, ID_PATTERN } from './extension-utils.mjs';
import { readMission } from './missions.mjs';
import {
  approveRuntimeCandidate,
  queueRuntimeCandidate,
  recordRuntimeVerification,
  runtimeStatus,
  submitRuntimeCandidate
} from './runtime.mjs';
import { runtimeWorkspaceAllocation, withRuntimeIntegrationWorkspace } from './workspaces.mjs';
import { verifyPacket } from './verify.mjs';

const COMMIT = /^[a-f0-9]{40}$/;

function git(directory, args, code) {
  try {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw extensionError(`candidate Git identity could not be verified`, code);
  }
}

function gitSucceeds(directory, args) {
  try {
    execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function now() {
  return new Date().toISOString();
}

function packageFor(status, packageId, expected) {
  const workPackage = status.packages.find((entry) => entry.id === packageId);
  if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
  if (expected && workPackage.state !== expected) throw extensionError(`work package "${packageId}" must be ${expected}, not ${workPackage.state}`, 'RUNTIME_DELIVERY_STATE');
  return workPackage;
}

function candidateFor(status, packageId, candidateId = null) {
  const candidates = (status.delivery ?? []).filter((entry) => entry.packageId === packageId && entry.candidate).map((entry) => entry.candidate);
  const candidate = candidateId ? candidates.find((entry) => entry.id === candidateId) : candidates.at(-1);
  if (!candidate) throw extensionError('runtime package has no frozen candidate receipt', 'RUNTIME_CANDIDATE_NOT_FOUND');
  return candidate;
}

function verificationFor(status, packageId, candidateId) {
  return (status.delivery ?? []).filter((entry) => entry.packageId === packageId && entry.verification?.candidateId === candidateId).map((entry) => entry.verification).at(-1) ?? null;
}

function approvalFor(status, packageId, candidateId) {
  return (status.delivery ?? []).filter((entry) => entry.packageId === packageId && entry.approval?.candidateId === candidateId).map((entry) => entry.approval).at(-1) ?? null;
}

function outputReceipt({ summary }) {
  const redacted = String(summary).replace(/[\r\n\0]/g, ' ').slice(0, 500);
  return { digest: digest(redacted), bytes: Buffer.byteLength(redacted), summary: redacted };
}

function packetCheck(worktree, mission, candidate) {
  const packet = path.join(worktree, mission.packet.path);
  let report;
  let actualDigest = null;
  try {
    report = verifyPacket(packet, { strict: false });
    actualDigest = digest(readFileSync(path.join(packet, 'spec.json'), 'utf8'));
  } catch {
    report = { ok: false, errors: ['packet verifier could not read the integration packet'] };
  }
  const passed = Boolean(report.ok) && actualDigest === candidate.packetDigest;
  const summary = passed
    ? 'frozen packet verifies in the integration worktree'
    : actualDigest !== candidate.packetDigest
      ? 'integration packet digest differs from the frozen candidate tuple'
      : `packet verification failed with ${Math.min(report.errors?.length ?? 1, 9)} finding(s)`;
  const output = outputReceipt({ passed, summary });
  return { id: 'vld-packet', kind: 'vld-packet', passed, output };
}

function requirePolicyTuple(policy, candidate) {
  if (policy.digest !== candidate.policyDigest) throw extensionError('delivery policy digest differs from the frozen candidate policy', 'STALE_DELIVERY_POLICY');
}

/** Freeze the exact branch-head candidate from an active changes-ready package. */
export function submitRuntimeDeliveryCandidate({ missionFile, packageId, candidateSha, policyFile, leaseToken, adapterRunId = null, projectDir = '.' } = {}) {
  const policy = loadDeliveryPolicy(policyFile, { projectDir });
  const status = runtimeStatus({ missionFile, projectDir });
  const workPackage = packageFor(status, packageId, 'changes_ready');
  if (!workPackage.run || !workPackage.lease) throw extensionError('candidate submission requires a live package lease', 'RUNTIME_CANDIDATE_STATE');
  if (!COMMIT.test(String(candidateSha ?? ''))) throw extensionError('candidate SHA must be a full lowercase Git commit', 'INVALID_CANDIDATE_SHA');
  if (adapterRunId !== null) {
    if (!ID_PATTERN.test(String(adapterRunId))) throw extensionError('adapter run id is invalid', 'INVALID_CANDIDATE');
    const run = (status.agentRuns ?? []).find((entry) => entry.id === adapterRunId && entry.packageId === packageId);
    if (!run || run.outcome !== 'completed') throw extensionError('candidate adapter run is not a completed receipt for this package', 'INVALID_CANDIDATE');
  }
  const workspace = runtimeWorkspaceAllocation({ missionFile, packageId, projectDir });
  const tip = git(workspace.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], 'INVALID_CANDIDATE_SHA');
  if (tip !== candidateSha) throw extensionError('candidate SHA must equal the current allocated workspace branch HEAD', 'CANDIDATE_NOT_BRANCH_HEAD');
  if (git(workspace.worktree, ['status', '--porcelain'], 'CANDIDATE_WORKSPACE_DIRTY')) throw extensionError('candidate workspace must be clean before submission', 'CANDIDATE_WORKSPACE_DIRTY');
  if (!gitSucceeds(workspace.worktree, ['merge-base', '--is-ancestor', workspace.baseCommit, candidateSha])) throw extensionError('candidate SHA is not descended from its frozen workspace base', 'CANDIDATE_BASE_MISMATCH');
  if (!gitSucceeds(workspace.worktree, ['merge-base', '--is-ancestor', candidateSha, workspace.branch])) throw extensionError('candidate SHA is not reachable from the allocated package branch', 'CANDIDATE_BRANCH_MISMATCH');
  const loaded = readMission(missionFile, { projectDir });
  const candidate = {
    id: `candidate-${randomUUID()}`,
    missionId: loaded.mission.id,
    packageId,
    candidateSha,
    baseSha: workspace.baseCommit,
    targetRef: loaded.mission.target.ref,
    targetSha: loaded.mission.target.commit,
    packetDigest: loaded.mission.packet.digest,
    policyDigest: policy.digest,
    adapterRunId,
    generatedAt: now()
  };
  return submitRuntimeCandidate({
    missionFile,
    projectDir,
    packageId,
    runId: workPackage.run.id,
    leaseToken,
    actor: { role: 'implementer', id: workPackage.run.holderId },
    candidate
  });
}

/** Verify an exact candidate via a disposable detached local integration worktree. */
export function verifyRuntimeDeliveryCandidate({ missionFile, packageId, policyFile, projectDir = '.' } = {}) {
  const policy = loadDeliveryPolicy(policyFile, { projectDir });
  const status = runtimeStatus({ missionFile, projectDir });
  packageFor(status, packageId, 'verifying');
  const candidate = candidateFor(status, packageId);
  requirePolicyTuple(policy, candidate);
  const loaded = readMission(missionFile, { projectDir });
  let verification;
  if (loaded.mission.target.commit !== candidate.targetSha || loaded.mission.packet.digest !== candidate.packetDigest) {
    verification = {
      id: `verification-${randomUUID()}`,
      candidateId: candidate.id,
      candidateSha: candidate.candidateSha,
      targetSha: candidate.targetSha,
      policyDigest: candidate.policyDigest,
      integrationTree: candidate.targetSha,
      outcome: 'invalidated',
      generatedAt: now(),
      checks: [{ id: 'vld-packet', kind: 'vld-packet', passed: false, output: outputReceipt({ passed: false, summary: 'frozen mission target or packet authority changed before integration' }) }]
    };
  } else {
    const integration = withRuntimeIntegrationWorkspace({
      missionFile,
      projectDir,
      packageId,
      candidateSha: candidate.candidateSha,
      callback: ({ worktree, mission }) => packetCheck(worktree, mission, candidate)
    });
    if (!integration.integrated) {
      verification = {
        id: `verification-${randomUUID()}`,
        candidateId: candidate.id,
        candidateSha: candidate.candidateSha,
        targetSha: candidate.targetSha,
        policyDigest: candidate.policyDigest,
        integrationTree: candidate.targetSha,
        outcome: 'conflict',
        generatedAt: now(),
        checks: [{ id: 'vld-packet', kind: 'vld-packet', passed: false, output: outputReceipt({ passed: false, summary: 'candidate could not be integrated cleanly at the frozen target' }) }]
      };
    } else {
      const check = integration.result;
      verification = {
        id: `verification-${randomUUID()}`,
        candidateId: candidate.id,
        candidateSha: candidate.candidateSha,
        targetSha: candidate.targetSha,
        policyDigest: candidate.policyDigest,
        integrationTree: integration.integrationTree,
        outcome: check.passed ? 'passed' : 'failed',
        generatedAt: now(),
        checks: [check]
      };
    }
  }
  return recordRuntimeVerification({ missionFile, projectDir, packageId, verification });
}

/** Record an independent human/local reviewer approval for an exact tuple. */
export function approveRuntimeDeliveryCandidate({ missionFile, packageId, candidateId, policyFile, actor, reason, projectDir = '.' } = {}) {
  const policy = loadDeliveryPolicy(policyFile, { projectDir });
  const status = runtimeStatus({ missionFile, projectDir });
  packageFor(status, packageId, 'in_review');
  const candidate = candidateFor(status, packageId, candidateId);
  requirePolicyTuple(policy, candidate);
  const verification = verificationFor(status, packageId, candidate.id);
  if (!verification || verification.outcome !== 'passed') throw extensionError('approval requires a passed frozen candidate verification', 'RUNTIME_APPROVAL_STATE');
  const loaded = readMission(missionFile, { projectDir });
  if (loaded.mission.target.commit !== candidate.targetSha || loaded.mission.packet.digest !== candidate.packetDigest) throw extensionError('candidate approval is invalid because target or packet authority changed', 'STALE_CANDIDATE');
  const approval = {
    id: `approval-${randomUUID()}`,
    candidateId: candidate.id,
    candidateSha: candidate.candidateSha,
    targetSha: candidate.targetSha,
    policyDigest: candidate.policyDigest,
    reviewerId: actor?.id,
    approvedAt: now(),
    reason
  };
  return approveRuntimeCandidate({ missionFile, projectDir, packageId, approval, actor });
}

/** Queue an approved tuple after re-reading its target/packet authority. */
export function queueRuntimeDeliveryCandidate({ missionFile, packageId, candidateId, policyFile, actor, projectDir = '.' } = {}) {
  const policy = loadDeliveryPolicy(policyFile, { projectDir });
  const status = runtimeStatus({ missionFile, projectDir });
  packageFor(status, packageId, 'approved');
  const candidate = candidateFor(status, packageId, candidateId);
  requirePolicyTuple(policy, candidate);
  if (!approvalFor(status, packageId, candidate.id)) throw extensionError('queue requires an independent approval receipt', 'RUNTIME_QUEUE_STATE');
  const loaded = readMission(missionFile, { projectDir });
  if (loaded.mission.target.commit !== candidate.targetSha || loaded.mission.packet.digest !== candidate.packetDigest) throw extensionError('candidate queue is invalid because target or packet authority changed', 'STALE_CANDIDATE');
  const queue = {
    id: `queue-${randomUUID()}`,
    candidateId: candidate.id,
    candidateSha: candidate.candidateSha,
    targetSha: candidate.targetSha,
    policyDigest: candidate.policyDigest,
    queuedAt: now()
  };
  return queueRuntimeCandidate({ missionFile, projectDir, packageId, queue, actor });
}

/** Return only Runtime-derived candidate/verification/review/queue receipts. */
export function runtimeDeliveryStatus({ missionFile, projectDir = '.' } = {}) {
  const status = runtimeStatus({ missionFile, projectDir });
  return { ok: status.ok, runtime: status.runtime, mission: status.mission, packages: status.packages, delivery: status.delivery ?? [], warnings: status.warnings };
}
