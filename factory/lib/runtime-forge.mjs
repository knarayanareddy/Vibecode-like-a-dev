/**
 * Offline Runtime-to-forge plan handoff.
 *
 * This module builds a bounded GitHub v1 plan from durable Runtime evidence and
 * records an immutable forge receipt. It deliberately has no token discovery,
 * environment reads, `gh` invocation, fetch, provider client, push, PR or merge
 * capability. Writing an explicitly requested local plan file is its only I/O
 * outside the Runtime ledger.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertGitHubPullRequestPlan, createGitHubPullRequestPlan } from './forge-plan.mjs';
import { digest, ensureProjectDir, extensionError } from './extension-utils.mjs';
import { verifyEvidenceChain } from './evidence.mjs';
import { readMission } from './missions.mjs';
import { recordRuntimeForgePlan, runtimeForgeEvidence } from './runtime.mjs';
import { requiresHumanReview } from './review.mjs';

function atIso(now = undefined) {
  const value = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(value.getTime())) throw extensionError('forge export time is invalid', 'INVALID_RUNTIME_FORGE_RECEIPT');
  return value.toISOString();
}

function baseFromTarget(targetRef) {
  if (typeof targetRef !== 'string') throw extensionError('queued candidate target ref is invalid', 'RUNTIME_FORGE_TUPLE_INVALID');
  if (targetRef.startsWith('refs/heads/')) return targetRef.slice('refs/heads/'.length);
  if (targetRef.startsWith('refs/')) throw extensionError('queued candidate target is not a branch; supply --base-ref explicitly', 'RUNTIME_FORGE_TUPLE_INVALID');
  return targetRef;
}

function requiredChecks(value) {
  const checks = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return checks.map((item) => String(item).trim()).filter(Boolean);
}

function safeTitle(value, evidence) {
  if (value !== undefined && value !== null) return value;
  return `VLD ${evidence.mission.id}/${evidence.package.id}: ${evidence.candidate.id}`;
}

function sandboxReceiptLines(projectDir, evidence) {
  // Sandbox execution receipts come from the build report the candidate was
  // verified against; absent receipts are stated, never implied (roadmap 4.2).
  const reportFile = path.join(projectDir, '.vld', 'build', evidence.mission.id, 'build-report.json');
  try {
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    return (report.packages ?? []).map((entry) => `  ${entry.packageId}: ${entry.sandboxReceiptDigest ?? 'not recorded'}`);
  } catch {
    return ['  not recorded (no build report)'];
  }
}

/**
 * PR body sections (roadmap 4.2): the runtime receipts plus the evidence
 * export and per-package sandbox receipts, so a reviewer sees the audit
 * surface without leaving the pull request.
 */
function deterministicBody(evidence, extras = {}) {
  const { candidate, verification, approval, queue } = evidence;
  const exportLines = extras.evidenceExport ?? ['  not recorded (offline export)'];
  const sandboxLines = extras.sandboxReceipts ?? ['  not recorded'];
  return [
    'VLD Runtime safe forge plan export.',
    'Authority scope: local Runtime ledger only; this is not provider, PR, CI, ref, or branch-protection attestation.',
    '',
    `Candidate: ${candidate.id}`,
    `Candidate SHA: ${candidate.candidateSha}`,
    `Frozen target SHA: ${candidate.targetSha}`,
    `Packet digest: ${candidate.packetDigest}`,
    `Policy digest: ${candidate.policyDigest}`,
    `Passed verification: ${verification.id}`,
    `Independent approval: ${approval.id}`,
    `Queue receipt: ${queue.id}`,
    '',
    'Sandbox receipts:',
    ...sandboxLines,
    'Evidence export:',
    ...exportLines,
    '',
    'This is an offline, data-only plan. It contains no credential and does not authorize a push, pull-request change, or merge request.'
  ].join('\n');
}

function bodyExtras(projectDir, evidence, chain) {
  return {
    sandboxReceipts: sandboxReceiptLines(projectDir, evidence),
    evidenceExport: chain
      ? [`  chain head: ${chain.headHash} (${chain.entries} entries, ${chain.ok ? 'verified' : 'degraded'})`]
      : ['  not recorded (offline export)']
  };
}

/** Build one immutable safe plan and a receipt that binds all delivery facts. */
export function prepareRuntimeForgePlan({ missionFile, packageId, candidateId, repository, headRef, baseRef = null, title = undefined, requiredChecks: checks = [], projectDir = '.', now } = {}) {
  const evidence = runtimeForgeEvidence({ missionFile, packageId, candidateId, projectDir });
  const plan = createGitHubPullRequestPlan({
    repository,
    headRef,
    baseRef: baseRef ?? baseFromTarget(evidence.candidate.targetRef),
    candidate: evidence.candidate,
    approval: evidence.approval,
    queue: evidence.queue,
    title: safeTitle(title, evidence),
    body: deterministicBody(evidence, bodyExtras(projectDir, evidence, verifyEvidenceChain({ projectDir }))),
    requiredChecks: requiredChecks(checks),
    requireGitHubApproval: true,
    // The export can never produce a plan accepted by requestGitHubMerge.
    allowMergeRequest: false
  });
  const authority = {
    candidateId: evidence.candidate.id,
    candidateDigest: digest(evidence.candidate),
    verificationDigest: digest(evidence.verification),
    approvalDigest: digest(evidence.approval),
    queueDigest: digest(evidence.queue),
    planDigest: plan.digest
  };
  const forge = {
    id: `forge-${digest(authority).slice(0, 48)}`,
    candidateId: evidence.candidate.id,
    candidateDigest: authority.candidateDigest,
    candidateSha: evidence.candidate.candidateSha,
    targetSha: evidence.candidate.targetSha,
    packetDigest: evidence.candidate.packetDigest,
    policyDigest: evidence.candidate.policyDigest,
    verificationId: evidence.verification.id,
    verificationDigest: authority.verificationDigest,
    approvalId: evidence.approval.id,
    approvalDigest: authority.approvalDigest,
    queueId: evidence.queue.id,
    queueDigest: authority.queueDigest,
    exportedAt: atIso(now),
    plan
  };
  return { evidence, forge, plan };
}

/** Append the prepared receipt only after Runtime replays its authority chain. */
export function exportRuntimeForgePlan({ actor, ...options } = {}) {
  const prepared = prepareRuntimeForgePlan(options);
  const result = recordRuntimeForgePlan({
    missionFile: options.missionFile,
    packageId: options.packageId,
    projectDir: options.projectDir,
    actor,
    forge: prepared.forge
  });
  return { ...result, plan: prepared.plan };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeDirectoryChain(root, directory) {
  const relative = path.relative(root, directory);
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor)) {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw extensionError('forge plan output directory is unsafe', 'INVALID_RUNTIME_FORGE_PATH');
    } else {
      mkdirSync(cursor);
    }
  }
}

/**
 * Create a reviewed JSON plan without overwriting a file or traversing links.
 * The plan deliberately carries no output path; Runtime receipts stay portable.
 */
export function writeRuntimeForgePlan({ projectDir = '.', outFile, plan } = {}) {
  const root = ensureProjectDir(projectDir);
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw extensionError('forge plan project directory is unsafe', 'INVALID_RUNTIME_FORGE_PATH');
  try { assertGitHubPullRequestPlan(plan); } catch (error) { throw extensionError(error.message, 'INVALID_RUNTIME_FORGE_PLAN'); }
  if (plan.allowMergeRequest !== false) throw extensionError('forge plan output must be merge-disabled', 'INVALID_RUNTIME_FORGE_PLAN');
  if (typeof outFile !== 'string' || !outFile.trim() || path.isAbsolute(outFile)) throw extensionError('forge plan --out must be a relative path inside the project', 'INVALID_RUNTIME_FORGE_PATH');
  const normalized = path.normalize(outFile);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.split(path.sep)[0] === '.vld') throw extensionError('forge plan output must not escape or modify .vld runtime state', 'INVALID_RUNTIME_FORGE_PATH');
  const target = path.resolve(root, normalized);
  if (!isWithin(root, target) || target === root) throw extensionError('forge plan output escapes the project', 'INVALID_RUNTIME_FORGE_PATH');
  safeDirectoryChain(root, path.dirname(target));
  if (existsSync(target)) throw extensionError('forge plan output already exists; choose a new review file', 'RUNTIME_FORGE_OUTPUT_EXISTS');
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    // link(2) refuses an existing destination, unlike rename which could race to overwrite it.
    linkSync(temporary, target);
  } catch (error) {
    if (error?.code === 'EEXIST') throw extensionError('forge plan output already exists; choose a new review file', 'RUNTIME_FORGE_OUTPUT_EXISTS');
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  return { file: path.relative(root, target).split(path.sep).join('/'), digest: plan.digest };
}

/**
 * Opt-in governed GitHub v1 execute mode (ADR 0012, roadmap 3.2).
 * Offline `prepareRuntimeForgePlan`/`exportRuntimeForgePlan` stay untouched;
 * this entrypoint runs ONLY on explicit caller request with an explicit
 * in-memory token, binds the immutable Runtime delivery tuple, never writes
 * the token or raw provider payload to disk, and appends a redacted receipt
 * to the hash-chained evidence ledger.
 */
export async function executeRuntimeForgePlan({
  missionFile,
  packageId,
  candidateId,
  repository,
  headRef,
  baseRef = null,
  title = undefined,
  requiredChecks: checks = ['spec'],
  draft = true,
  allowMergeRequest = false,
  requireGitHubApproval = true,
  existingPullNumber = null,
  action = 'publish',
  pullNumber = null,
  postEvidence = true,
  token,
  fetchImpl = globalThis.fetch,
  apiUrl = null,
  projectDir = '.'
} = {}) {
  const root = ensureProjectDir(projectDir);
  const evidence = runtimeForgeEvidence({ missionFile, packageId, candidateId, projectDir: root });

  const { appendEvidence } = await import('./evidence.mjs');
  const chainBefore = verifyEvidenceChain({ projectDir: root });

  // Roadmap 4.2, gate 1: never publish from a broken evidence chain.
  if (!chainBefore.ok) {
    throw extensionError(
      `refusing to publish: the evidence chain failed verification (${chainBefore.errors?.slice(0, 3).join('; ') || `broken at seq ${chainBefore.firstBrokenSeq}`})`,
      'FORGE_EVIDENCE_CHAIN_INVALID'
    );
  }

  // Roadmap 4.2, gate 2: escalation packets (rigor tier >= 2, money, regulated
  // or destructiveWrites) publish only with a human sign-off recorded on the
  // independent review. Stricter than the queue gate on purpose: publishing to
  // a repository is the highest-stakes step of the journey.
  const loadedMission = readMission(missionFile, { projectDir: root });
  const specFile = path.resolve(root, loadedMission.mission.packet.path, 'spec.json');
  let spec = null;
  try {
    spec = JSON.parse(readFileSync(specFile, 'utf8'));
  } catch {
    throw extensionError('cannot read the frozen packet spec.json for the publish gates', 'FORGE_PACKET_UNREADABLE');
  }
  const escalation = requiresHumanReview(spec);
  const signoffRequired = evidence.review ? Boolean(evidence.review.requiresHumanSignoff) : escalation.required;
  if (signoffRequired && !evidence.review?.humanSignoff) {
    throw extensionError(
      `refusing to publish: this packet requires a human sign-off recorded on the independent review (${escalation.reasons.join(', ') || 'escalation packet'})`,
      'FORGE_HUMAN_SIGNOFF_REQUIRED'
    );
  }

  const plan = createGitHubPullRequestPlan({
    repository,
    headRef,
    baseRef: baseRef ?? baseFromTarget(evidence.candidate.targetRef),
    candidate: evidence.candidate,
    approval: evidence.approval,
    queue: evidence.queue,
    title: safeTitle(title, evidence),
    body: deterministicBody(evidence, bodyExtras(root, evidence, chainBefore)),
    requiredChecks: requiredChecks(checks),
    requireGitHubApproval: Boolean(requireGitHubApproval),
    allowMergeRequest: action === 'merge' ? Boolean(allowMergeRequest) : false,
    draft: Boolean(draft),
    ...(existingPullNumber ? { existingPullNumber } : {})
  });

  const { createGitHubV1Client, executeGitHubDelivery } = await import('../integrations/github-v1/index.mjs');
  const client = createGitHubV1Client({ token, fetchImpl, ...(apiUrl ? { apiUrl } : {}) });

  const evidenceLines = [
    `**Mission / package:** \`${evidence.mission.id}\` / \`${evidence.package.id}\``,
    `**Verification receipt:** \`${evidence.verification.id}\` (${evidence.verification.outcome})`,
    `**Independent approval:** \`${evidence.approval.id}\``,
    `**Queue receipt:** \`${evidence.queue.id}\``,
    `**Packet digest:** \`${evidence.candidate.packetDigest}\``,
    `**Evidence chain head:** \`${chainBefore.headHash}\` (${chainBefore.entries} entries, ${chainBefore.ok ? 'verified' : 'degraded'})`
  ];

  const remote = await executeGitHubDelivery({
    client,
    plan,
    action,
    pullNumber,
    postEvidence: action === 'publish' ? Boolean(postEvidence) : false,
    evidenceLines
  });

  const receiptBody = {
    schemaVersion: 1,
    provider: 'github-v1',
    mode: 'execute',
    action: remote.action,
    executedAt: remote.executedAt,
    missionId: evidence.mission.id,
    packageId: evidence.package.id,
    candidateId: evidence.candidate.id,
    candidateSha: evidence.candidate.candidateSha,
    targetSha: evidence.candidate.targetSha,
    planDigest: plan.digest,
    draft: plan.draft,
    repository: plan.repository,
    pullNumber: remote.pullRequest?.number ?? remote.pullNumber ?? null,
    pullUrl: remote.pullRequest?.url ?? null,
    requiredChecksPassed: remote.requiredChecksPassed ?? null,
    githubApproval: remote.githubApproval ?? null,
    mergedSha: remote.mergedSha ?? null,
    evidenceCommentId: remote.evidenceComment?.commentId ?? null
  };
  const executionReceipt = { ...receiptBody, receiptDigest: digest(receiptBody) };

  const ledger = appendEvidence({
    projectDir: root,
    kind: 'forge',
    actor: 'forge:github-v1',
    subject: `${plan.repository}#${executionReceipt.pullNumber ?? 'pending'}`,
    payload: executionReceipt
  });

  return {
    ok: true,
    receipt: executionReceipt,
    evidenceHash: ledger.headHash
  };
}
