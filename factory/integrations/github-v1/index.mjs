/**
 * Optional narrow GitHub REST v1 adapter.
 *
 * VLD Core does not import this file, discover tokens, invoke `gh`, push refs,
 * run a webhook server or bypass GitHub branch protection. A caller supplies an
 * in-memory token and a reviewed immutable VLD candidate/approval/queue plan.
 * The adapter can create/update a PR, inspect remote facts and *request* merge;
 * GitHub remains the enforcement point for branch protection/authorization.
 */

import { digest, extensionError, ID_PATTERN } from '../../lib/extension-utils.mjs';

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const API = 'https://api.github.com';

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeLine(value, maximum = 240) { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value); }
function safeBody(value) { return typeof value === 'string' && value.length <= 10_000 && !/\0/.test(value); }
function safeRepository(value) { if (!REPOSITORY.test(String(value ?? ''))) throw extensionError('GitHub repository must be owner/name', 'INVALID_GITHUB_REPOSITORY'); return value; }
function safeRef(value, label) { if (!REF.test(String(value ?? ''))) throw extensionError(`GitHub ${label} ref is invalid`, 'INVALID_GITHUB_REF'); return value; }
function safeSha(value, label) { if (!SHA.test(String(value ?? ''))) throw extensionError(`GitHub ${label} SHA must be a full commit SHA`, 'INVALID_GITHUB_SHA'); return value; }
function safeNumber(value) { if (!Number.isSafeInteger(value) || value < 1) throw extensionError('GitHub pull request number is invalid', 'INVALID_GITHUB_PULL_REQUEST'); return value; }
function redactError(error) { return String(error?.message ?? error ?? 'network request failed').replace(/(?:token|secret|password|authorization|api[_-]?key)\s*(?:=|:)\s*[^\s,;]+/gi, '[REDACTED]').replace(/[\r\n\0]/g, ' ').slice(0, 200); }

function validatePull(raw, expected) {
  if (!object(raw) || !Number.isSafeInteger(raw.number) || raw.number < 1 || !object(raw.head) || !object(raw.base)) throw extensionError('GitHub response is missing pull request identity', 'GITHUB_IDENTITY_MISMATCH');
  if (raw.head.ref !== expected.headRef || raw.base.ref !== expected.baseRef || raw.head.sha !== expected.headSha) throw extensionError('GitHub response pull request head/base identity differs from the reviewed plan', 'GITHUB_IDENTITY_MISMATCH');
  try { if (typeof raw.html_url !== 'string' || new URL(raw.html_url).hostname !== 'github.com') throw new Error('invalid URL'); } catch { throw extensionError('GitHub response has an invalid pull request URL', 'GITHUB_IDENTITY_MISMATCH'); }
  return { number: raw.number, url: raw.html_url, headRef: raw.head.ref, headSha: raw.head.sha, baseRef: raw.base.ref, baseSha: typeof raw.base.sha === 'string' ? raw.base.sha : null, state: raw.state, draft: Boolean(raw.draft) };
}
function checkedPlan(plan) {
  const allowed = new Set(['schemaVersion', 'provider', 'repository', 'headRef', 'headSha', 'baseRef', 'candidateId', 'candidateSha', 'targetSha', 'packetDigest', 'policyDigest', 'title', 'body', 'existingPullNumber', 'requiredChecks', 'requireGitHubApproval', 'allowMergeRequest', 'digest']);
  if (!object(plan) || plan.provider !== 'github-v1' || Object.keys(plan).some((key) => !allowed.has(key))) throw extensionError('GitHub plan is invalid', 'INVALID_GITHUB_PLAN');
  const { digest: planDigest, ...unsigned } = plan;
  if (!/^[a-f0-9]{64}$/.test(String(planDigest ?? '')) || digest(unsigned) !== planDigest) throw extensionError('GitHub plan digest does not match its reviewed contents', 'GITHUB_PLAN_DIGEST_MISMATCH');
  safeRepository(plan.repository); safeRef(plan.headRef, 'head'); safeRef(plan.baseRef, 'base'); safeSha(plan.headSha, 'head'); safeSha(plan.candidateSha, 'candidate'); safeSha(plan.targetSha, 'target');
  for (const field of ['packetDigest', 'policyDigest']) if (!/^[a-f0-9]{64}$/.test(String(plan[field] ?? ''))) throw extensionError(`GitHub plan ${field} is invalid`, 'INVALID_GITHUB_PLAN');
  if (!ID_PATTERN.test(String(plan.candidateId ?? '')) || !safeLine(plan.title, 240) || !safeBody(plan.body) || !Array.isArray(plan.requiredChecks)) throw extensionError('GitHub plan fields are invalid', 'INVALID_GITHUB_PLAN');
  return plan;
}

/** Validate a frozen M5 tuple and produce a non-secret, reviewable forge plan. */
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

/** Create a GitHub REST client with an explicitly supplied, memory-only token. */
export function createGitHubV1Client({ token, fetchImpl = globalThis.fetch, apiUrl = API, timeoutMs = 15_000 } = {}) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 8_192 || /[\r\n\0]/.test(token)) throw extensionError('GitHub adapter needs an explicit in-memory token', 'GITHUB_TOKEN_REQUIRED');
  if (typeof fetchImpl !== 'function') throw extensionError('GitHub adapter fetch implementation is invalid', 'INVALID_GITHUB_CLIENT');
  if (apiUrl !== API) throw extensionError('GitHub adapter only permits the public GitHub REST API endpoint', 'INVALID_GITHUB_ENDPOINT');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw extensionError('GitHub adapter timeout must be 100ms to 60s', 'INVALID_GITHUB_CLIENT');
  async function request(method, pathname, body = null) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); let response;
    try {
      response = await fetchImpl(`${API}${pathname}`, {
        method,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'vld-github-v1', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
    } catch (error) { throw extensionError(`GitHub request failed: ${redactError(error)}`, 'GITHUB_NETWORK_FAILED'); }
    finally { clearTimeout(timer); }
    if (!response?.ok) {
      const status = Number(response?.status ?? 0); const exhausted = response?.headers?.get?.('x-ratelimit-remaining') === '0';
      const code = status === 401 ? 'GITHUB_AUTH_FAILED' : exhausted || status === 429 ? 'GITHUB_RATE_LIMITED' : status === 403 ? 'GITHUB_FORBIDDEN' : status >= 500 ? 'GITHUB_UNAVAILABLE' : 'GITHUB_REQUEST_FAILED';
      throw extensionError(`GitHub ${method} request was rejected (${status || 'network'})`, code);
    }
    try { return await response.json(); } catch { throw extensionError('GitHub response was not valid JSON', 'GITHUB_RESPONSE_INVALID'); }
  }
  return { request };
}

export async function publishGitHubPullRequest({ client, plan } = {}) {
  if (!client || typeof client.request !== 'function') throw extensionError('GitHub client is invalid', 'INVALID_GITHUB_PLAN');
  checkedPlan(plan);
  const expected = { headRef: plan.headRef, headSha: plan.headSha, baseRef: plan.baseRef };
  const resource = `/repos/${plan.repository}/pulls${plan.existingPullNumber ? `/${safeNumber(plan.existingPullNumber)}` : ''}`;
  const raw = await client.request(plan.existingPullNumber ? 'PATCH' : 'POST', resource, plan.existingPullNumber ? { title: plan.title, body: plan.body, base: plan.baseRef } : { title: plan.title, body: plan.body, head: plan.headRef, base: plan.baseRef });
  return { planDigest: plan.digest, pullRequest: validatePull(raw, expected) };
}

/** Read only the remote check/review facts for the reviewed plan's exact head SHA. */
export async function inspectGitHubPullRequest({ client, plan, pullNumber } = {}) {
  if (!client || typeof client.request !== 'function') throw extensionError('GitHub client is invalid', 'INVALID_GITHUB_PLAN');
  checkedPlan(plan);
  const number = safeNumber(pullNumber); const expected = { headRef: plan.headRef, headSha: plan.headSha, baseRef: plan.baseRef };
  const [pull, checks, reviews] = await Promise.all([
    client.request('GET', `/repos/${plan.repository}/pulls/${number}`),
    client.request('GET', `/repos/${plan.repository}/commits/${plan.headSha}/check-runs?per_page=100`),
    client.request('GET', `/repos/${plan.repository}/pulls/${number}/reviews?per_page=100`)
  ]);
  const pullRequest = validatePull(pull, expected);
  if (!object(checks) || !Array.isArray(checks.check_runs) || !Array.isArray(reviews)) throw extensionError('GitHub checks/reviews response is invalid', 'GITHUB_RESPONSE_INVALID');
  const completed = checks.check_runs.filter((item) => object(item) && safeLine(item.name, 120)).map((item) => ({ name: item.name, status: item.status, conclusion: item.conclusion ?? null }));
  const requiredChecksPassed = plan.requiredChecks.every((name) => completed.some((check) => check.name === name && check.status === 'completed' && check.conclusion === 'success'));
  const approved = reviews.some((review) => object(review) && review.state === 'APPROVED' && object(review.user) && safeLine(review.user.login, 120));
  return { planDigest: plan.digest, pullRequest, checks: completed, requiredChecksPassed, githubApproval: approved };
}

/** Request GitHub's merge endpoint only after remote facts still match the exact plan. */
export async function requestGitHubMerge({ client, plan, pullNumber } = {}) {
  if (plan?.allowMergeRequest !== true) throw extensionError('GitHub merge request is not enabled by the reviewed plan', 'GITHUB_MERGE_NOT_ALLOWED');
  const facts = await inspectGitHubPullRequest({ client, plan, pullNumber });
  if (!facts.requiredChecksPassed || (plan.requireGitHubApproval && !facts.githubApproval)) throw extensionError('GitHub remote checks/review facts do not satisfy the reviewed plan', 'GITHUB_MERGE_GATES_UNMET');
  const merged = await client.request('PUT', `/repos/${plan.repository}/pulls/${safeNumber(pullNumber)}/merge`, { sha: plan.headSha, merge_method: 'merge' });
  if (!object(merged) || merged.merged !== true || !SHA.test(String(merged.sha ?? ''))) throw extensionError('GitHub did not confirm an exact merge result; inspect the forge before retrying', 'GITHUB_MERGE_AMBIGUOUS');
  return { planDigest: plan.digest, pullNumber: safeNumber(pullNumber), mergedSha: merged.sha, message: typeof merged.message === 'string' ? merged.message.slice(0, 240) : 'GitHub confirmed merge' };
}
