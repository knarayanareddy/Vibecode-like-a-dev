/**
 * Data-only forge-plan schema shared by Runtime and optional provider packages.
 *
 * This module has no network, credential, process, Git or provider SDK access.
 * A plan binds a reviewed candidate/approval/queue tuple to a future provider
 * request, but cannot itself publish a pull request or request a merge.
 */

import { digest, extensionError, ID_PATTERN } from './extension-utils.mjs';

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeLine(value, maximum = 240) { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value); }
function safeBody(value) { return typeof value === 'string' && value.length <= 10_000 && !/\0/.test(value); }
function safeRepository(value) { if (!REPOSITORY.test(String(value ?? ''))) throw extensionError('GitHub repository must be owner/name', 'INVALID_GITHUB_REPOSITORY'); return value; }
function safeRef(value, label) { if (!REF.test(String(value ?? ''))) throw extensionError(`GitHub ${label} ref is invalid`, 'INVALID_GITHUB_REF'); return value; }
function safeSha(value, label) { if (!SHA.test(String(value ?? ''))) throw extensionError(`GitHub ${label} SHA must be a full commit SHA`, 'INVALID_GITHUB_SHA'); return value; }
function safeNumber(value) { if (!Number.isSafeInteger(value) || value < 1) throw extensionError('GitHub pull request number is invalid', 'INVALID_GITHUB_PULL_REQUEST'); return value; }

/** Validate an immutable, provider-safe GitHub pull-request plan. */
export function assertGitHubPullRequestPlan(plan) {
  const allowed = new Set(['schemaVersion', 'provider', 'repository', 'headRef', 'headSha', 'baseRef', 'candidateId', 'candidateSha', 'targetSha', 'packetDigest', 'policyDigest', 'title', 'body', 'existingPullNumber', 'requiredChecks', 'requireGitHubApproval', 'allowMergeRequest', 'digest']);
  if (!object(plan) || plan.provider !== 'github-v1' || Object.keys(plan).some((key) => !allowed.has(key))) throw extensionError('GitHub plan is invalid', 'INVALID_GITHUB_PLAN');
  const { digest: planDigest, ...unsigned } = plan;
  if (!/^[a-f0-9]{64}$/.test(String(planDigest ?? '')) || digest(unsigned) !== planDigest) throw extensionError('GitHub plan digest does not match its reviewed contents', 'GITHUB_PLAN_DIGEST_MISMATCH');
  if (plan.schemaVersion !== 1) throw extensionError('GitHub plan schemaVersion is invalid', 'INVALID_GITHUB_PLAN');
  safeRepository(plan.repository); safeRef(plan.headRef, 'head'); safeRef(plan.baseRef, 'base'); safeSha(plan.headSha, 'head'); safeSha(plan.candidateSha, 'candidate'); safeSha(plan.targetSha, 'target');
  for (const field of ['packetDigest', 'policyDigest']) if (!/^[a-f0-9]{64}$/.test(String(plan[field] ?? ''))) throw extensionError(`GitHub plan ${field} is invalid`, 'INVALID_GITHUB_PLAN');
  if (!ID_PATTERN.test(String(plan.candidateId ?? '')) || !safeLine(plan.title, 240) || !safeBody(plan.body)) throw extensionError('GitHub plan fields are invalid', 'INVALID_GITHUB_PLAN');
  if (plan.existingPullNumber !== undefined) safeNumber(plan.existingPullNumber);
  if (!Array.isArray(plan.requiredChecks) || plan.requiredChecks.length > 30 || plan.requiredChecks.some((check) => !safeLine(check, 120)) || new Set(plan.requiredChecks).size !== plan.requiredChecks.length) throw extensionError('GitHub plan requiredChecks are invalid', 'INVALID_GITHUB_PLAN');
  if (typeof plan.requireGitHubApproval !== 'boolean' || typeof plan.allowMergeRequest !== 'boolean') throw extensionError('GitHub plan flags are invalid', 'INVALID_GITHUB_PLAN');
  return plan;
}

/** Bind exact M5 receipts into a non-secret, reviewable provider plan. */
export function createGitHubPullRequestPlan({ repository, headRef, baseRef, candidate, approval, queue, title, body = '', existingPullNumber = null, requiredChecks = [], requireGitHubApproval = true, allowMergeRequest = false } = {}) {
  safeRepository(repository); safeRef(headRef, 'head'); safeRef(baseRef, 'base');
  if (!object(candidate) || !ID_PATTERN.test(String(candidate.id ?? ''))) throw extensionError('GitHub plan requires a frozen VLD candidate receipt', 'GITHUB_PLAN_TUPLE_INVALID');
  for (const field of ['candidateSha', 'targetSha']) safeSha(candidate[field], field);
  for (const field of ['packetDigest', 'policyDigest']) if (!/^[a-f0-9]{64}$/.test(String(candidate[field] ?? ''))) throw extensionError(`GitHub candidate ${field} is invalid`, 'GITHUB_PLAN_TUPLE_INVALID');
  if (!object(approval) || approval.candidateId !== candidate.id || approval.candidateSha !== candidate.candidateSha || approval.targetSha !== candidate.targetSha || approval.policyDigest !== candidate.policyDigest) throw extensionError('GitHub plan requires an exact approved candidate tuple', 'GITHUB_PLAN_TUPLE_INVALID');
  if (!object(queue) || queue.candidateId !== candidate.id || queue.candidateSha !== candidate.candidateSha || queue.targetSha !== candidate.targetSha || queue.policyDigest !== candidate.policyDigest) throw extensionError('GitHub plan requires an exact queued candidate tuple', 'GITHUB_PLAN_TUPLE_INVALID');
  if (!safeLine(title, 240) || !safeBody(body)) throw extensionError('GitHub pull request title/body is invalid', 'INVALID_GITHUB_PULL_REQUEST');
  if (existingPullNumber !== null) safeNumber(existingPullNumber);
  if (!Array.isArray(requiredChecks) || requiredChecks.length > 30 || requiredChecks.some((check) => !safeLine(check, 120)) || new Set(requiredChecks).size !== requiredChecks.length) throw extensionError('GitHub requiredChecks are invalid', 'INVALID_GITHUB_PLAN');
  if (typeof requireGitHubApproval !== 'boolean' || typeof allowMergeRequest !== 'boolean') throw extensionError('GitHub plan flags are invalid', 'INVALID_GITHUB_PLAN');
  const plan = { schemaVersion: 1, provider: 'github-v1', repository, headRef, headSha: candidate.candidateSha, baseRef, candidateId: candidate.id, candidateSha: candidate.candidateSha, targetSha: candidate.targetSha, packetDigest: candidate.packetDigest, policyDigest: candidate.policyDigest, title, body, ...(existingPullNumber ? { existingPullNumber } : {}), requiredChecks: [...requiredChecks].sort(), requireGitHubApproval, allowMergeRequest };
  return { ...plan, digest: digest(plan) };
}
