/**
 * M4 host orchestration for one scoped agent adapter run.
 *
 * The adapter never mutates Runtime lifecycle state. This host verifies a live
 * allocated lease and healthy M2 workspace, moves it through M3 transitions,
 * persists a metadata-only receipt, and blocks failure/timeout/cancellation. It does
 * not submit candidates, run project verification, push, merge or open a PR.
 */

import { randomUUID } from 'node:crypto';
import {
  agentPolicyDigest,
  assertAgentPolicy,
  loadAgentPolicy
} from './agent-policy.mjs';
import { executeAgentAdapter } from './agent-adapters.mjs';
import { digest, extensionError } from './extension-utils.mjs';
import {
  recordRuntimeAgentReceipt,
  runtimeStatus,
  transitionRuntimePackage
} from './runtime.mjs';
import { runtimeWorkspaceAllocation } from './workspaces.mjs';

function now() {
  return new Date().toISOString();
}

function durationMilliseconds(startedAt, finishedAt) {
  const value = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function activePackage(status, packageId) {
  const workPackage = status.packages.find((entry) => entry.id === packageId);
  if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
  if (workPackage.state !== 'allocated' || !workPackage.run || !workPackage.lease) throw extensionError(`work package "${packageId}" must be allocated with a live lease before an adapter can start`, 'RUNTIME_AGENT_NOT_ALLOCATED');
  return workPackage;
}

function contextFor(status, workPackage) {
  return {
    schemaVersion: 1,
    missionId: status.runtime.missionId,
    missionDigest: status.runtime.missionDigest,
    packetDigest: status.runtime.packetDigest,
    corePolicyDigest: status.runtime.corePolicyDigest,
    runtimePolicyDigest: status.runtime.policy.digest,
    packageId: workPackage.id,
    requirements: [...workPackage.requirements].sort(),
    dependencies: [...workPackage.dependsOn].sort()
  };
}

function safeFailureResult(error, startedAt) {
  const finishedAt = now();
  return {
    outcome: error?.code === 'AGENT_CANCELLED' ? 'cancelled' : 'failed',
    exitCode: null,
    signal: null,
    outputDigest: digest(''),
    outputBytes: 0,
    outputSummary: 'adapter host failed before a process result was available',
    startedAt,
    finishedAt
  };
}

function receiptOutputSummary(outcome) {
  return ({
    completed: 'agent completed successfully',
    failed: 'agent failed',
    cancelled: 'agent cancelled',
    'timed-out': 'agent timed out'
  })[outcome] ?? 'agent ended with an unknown outcome';
}

function attemptReceipt({ id, policyDigest, contextDigest, workspaceDigest, execution, attempts }) {
  return {
    id,
    adapter: execution.adapter,
    policyDigest,
    contextDigest,
    workspaceDigest,
    outcome: execution.outcome,
    attempts,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    durationMs: durationMilliseconds(execution.startedAt, execution.finishedAt),
    output: {
      digest: execution.outputDigest,
      bytes: execution.outputBytes,
      // Arbitrary peer/process output is not a credential-safe persistence
      // format. Retain its digest/size as evidence and only an allowlisted
      // outcome label in the Runtime ledger.
      summary: receiptOutputSummary(execution.outcome)
    }
  };
}

function retryable(outcome) {
  return outcome === 'failed' || outcome === 'timed-out';
}

function packageFromStatus(status, packageId) {
  return status.packages.find((entry) => entry.id === packageId) ?? null;
}

/**
 * Heartbeats legitimately advance the Runtime package version while an adapter
 * runs. Settle against a fresh version and retry a small bounded number of
 * compare-and-swap conflicts; never reuse the version captured at start.
 */
function settleRunningAgent({ missionFile, projectDir, packageId, runId, leaseToken, actor, completed, reason }) {
  let lastStatus = runtimeStatus({ missionFile, projectDir });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = packageFromStatus(lastStatus, packageId);
    if (!current || current.state !== 'running' || current.run?.id !== runId) return { status: lastStatus, package: current, changed: false };
    try {
      return transitionRuntimePackage({
        missionFile,
        projectDir,
        packageId,
        to: completed ? 'changes_ready' : 'blocked',
        actor: completed ? actor : { role: 'runtime', id: 'runtime-host' },
        expectedVersion: current.version,
        ...(completed ? { leaseToken } : { reason })
      });
    } catch (error) {
      if (error.code === 'RUNTIME_VERSION_CONFLICT') {
        lastStatus = runtimeStatus({ missionFile, projectDir });
        continue;
      }
      return { error, status: runtimeStatus({ missionFile, projectDir }), package: null, changed: false };
    }
  }
  return { error: extensionError('agent settlement conflicted with repeated lease updates', 'RUNTIME_VERSION_CONFLICT'), status: runtimeStatus({ missionFile, projectDir }), package: null, changed: false };
}

/**
 * Start and await one explicitly policy-authorized local adapter run. The caller
 * supplies the one-time M3 lease token; it is used for transition validation but
 * never appears in the run spec, events, receipts or return value.
 */
export async function runRuntimeAgent({ missionFile, packageId, policyFile, leaseToken, projectDir = '.', signal = null, onEvent = null } = {}) {
  if (typeof leaseToken !== 'string' || leaseToken.length < 16 || /[\r\n\0]/.test(leaseToken)) throw extensionError('runtime agent run requires a valid lease token', 'RUNTIME_LEASE_FORBIDDEN');
  const policyLoaded = loadAgentPolicy(policyFile, { projectDir });
  const policy = assertAgentPolicy(policyLoaded.policy);
  const before = runtimeStatus({ missionFile, projectDir });
  const workPackage = activePackage(before, packageId);
  const workspace = runtimeWorkspaceAllocation({ missionFile, packageId, projectDir });
  const actor = { role: 'implementer', id: workPackage.run.holderId };
  const context = contextFor(before, workPackage);
  // The packet digest is deliberately sourced from frozen Runtime authority,
  // never from a caller-selected path. The adapter receives only this digest
  // reference and reads the checked-out packet files from its worktree itself.
  const contextDigest = digest(context);
  const workspaceDigest = digest({ id: workspace.id, missionDigest: workspace.missionDigest, packageId: workspace.packageId, branch: workspace.branch, baseCommit: workspace.baseCommit });
  const agentRunId = `agent-run-${randomUUID()}`;
  const spec = {
    id: agentRunId,
    missionId: before.runtime.missionId,
    packageId,
    packetDigest: context.packetDigest,
    contextDigest,
    requirementIds: [...workPackage.requirements].sort(),
    workspace: workspace.worktree
  };

  transitionRuntimePackage({
    missionFile,
    projectDir,
    packageId,
    to: 'running',
    actor,
    expectedVersion: workPackage.version,
    leaseToken
  });
  let execution = null;
  let attempts = 0;
  const events = [];
  const startedAt = now();
  try {
    do {
      attempts += 1;
      const result = await executeAgentAdapter({
        spec,
        policy,
        signal,
        onEvent: (event) => {
          // Events returned to the local caller are already schema-validated and
          // redacted by the adapter layer. Keep only bounded metadata in memory.
          if (events.length < 64) events.push(event);
          if (typeof onEvent === 'function') onEvent(event);
        }
      });
      execution = { ...result, adapter: policy.adapter };
    } while (retryable(execution.outcome) && attempts <= policy.limits.retryBudget && !signal?.aborted);
  } catch (error) {
    execution = { ...safeFailureResult(error, startedAt), adapter: policy.adapter };
  }

  const receipt = attemptReceipt({
    id: agentRunId,
    policyDigest: agentPolicyDigest(policy),
    contextDigest,
    workspaceDigest,
    execution,
    attempts
  });
  const recorded = recordRuntimeAgentReceipt({ missionFile, projectDir, packageId, runId: workPackage.run.id, agentRun: receipt });

  let settled;
  if (execution.outcome === 'completed') {
    settled = settleRunningAgent({ missionFile, projectDir, packageId, runId: workPackage.run.id, leaseToken, actor, completed: true, reason: null });
    if (settled.error || settled.package?.state !== 'changes_ready') {
      // A completed adapter that lost a lease or another Runtime race never
      // receives success. Block from a freshly-read version when it is still
      // our active run; if recovery already settled it, report that state.
      settled = settleRunningAgent({
        missionFile,
        projectDir,
        packageId,
        runId: workPackage.run.id,
        leaseToken,
        actor,
        completed: false,
        reason: `adapter completed but could not advance safely: ${settled.error?.code ?? 'runtime-state-error'}`
      });
    }
  } else {
    settled = settleRunningAgent({
      missionFile,
      projectDir,
      packageId,
      runId: workPackage.run.id,
      leaseToken,
      actor,
      completed: false,
      reason: `adapter ${execution.outcome}`
    });
  }

  const finalPackage = packageFromStatus(settled.status, packageId);
  return {
    ok: execution.outcome === 'completed' && finalPackage?.state === 'changes_ready',
    changed: true,
    agentRun: recorded.agentRun,
    status: settled.status,
    events
  };
}

/** Read only the Runtime's metadata-only, durable agent receipts. */
export function runtimeAgentStatus({ missionFile, projectDir = '.' } = {}) {
  const status = runtimeStatus({ missionFile, projectDir });
  return {
    ok: status.ok,
    runtime: status.runtime,
    mission: status.mission,
    agentRuns: status.agentRuns ?? [],
    warnings: status.warnings
  };
}
