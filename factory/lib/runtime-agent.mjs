/**
 * M4 host orchestration for one scoped agent adapter run.
 *
 * The adapter never mutates Runtime lifecycle state. This host verifies a live
 * allocated lease and healthy M2 workspace, moves it through M3 transitions,
 * persists a redacted receipt, and blocks failure/timeout/cancellation. It does
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
      summary: execution.outputSummary
    }
  };
}

function retryable(outcome) {
  return outcome === 'failed' || outcome === 'timed-out';
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

  const started = transitionRuntimePackage({
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
    try {
      settled = transitionRuntimePackage({
        missionFile,
        projectDir,
        packageId,
        to: 'changes_ready',
        actor,
        expectedVersion: started.package.version,
        leaseToken
      });
    } catch (error) {
      // A completed adapter that lost its lease never receives a success state.
      // Runtime blocks it with a durable receipt rather than guessing/retrying.
      settled = transitionRuntimePackage({
        missionFile,
        projectDir,
        packageId,
        to: 'blocked',
        actor: { role: 'runtime', id: 'runtime-host' },
        expectedVersion: started.package.version,
        reason: `adapter completed but could not advance safely: ${error.code ?? 'runtime-state-error'}`
      });
    }
  } else {
    settled = transitionRuntimePackage({
      missionFile,
      projectDir,
      packageId,
      to: 'blocked',
      actor: { role: 'runtime', id: 'runtime-host' },
      expectedVersion: started.package.version,
      reason: `adapter ${execution.outcome}`
    });
  }

  return {
    ok: execution.outcome === 'completed' && settled.package.state === 'changes_ready',
    changed: true,
    agentRun: recorded.agentRun,
    status: settled.status,
    events
  };
}

/** Read only the Runtime's redacted, durable agent receipts. */
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
