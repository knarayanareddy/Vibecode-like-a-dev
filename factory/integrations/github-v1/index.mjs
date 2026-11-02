/**
 * Optional narrow GitHub REST v1 adapter.
 *
 * VLD Core does not import this file, discover tokens, invoke `gh`, push refs,
 * run a webhook server or bypass GitHub branch protection. A caller supplies an
 * in-memory token and a reviewed immutable VLD candidate/approval/queue plan.
 * The adapter can create/update a PR, inspect remote facts and *request* merge;
 * GitHub remains the enforcement point for branch protection/authorization.
 */

import { extensionError } from '../../lib/extension-utils.mjs';
import { assertGitHubPullRequestPlan, createGitHubPullRequestPlan } from '../../lib/forge-plan.mjs';

export { assertGitHubPullRequestPlan, createGitHubPullRequestPlan } from '../../lib/forge-plan.mjs';

const SHA = /^[a-f0-9]{40}$/;
const API = 'https://api.github.com';

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeLine(value, maximum = 240) { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value); }
function safeNumber(value) { if (!Number.isSafeInteger(value) || value < 1) throw extensionError('GitHub pull request number is invalid', 'INVALID_GITHUB_PULL_REQUEST'); return value; }
function redactError(error) { return String(error?.message ?? error ?? 'network request failed').replace(/(?:token|secret|password|authorization|api[_-]?key)\s*(?:=|:)\s*[^\s,;]+/gi, '[REDACTED]').replace(/[\r\n\0]/g, ' ').slice(0, 200); }

function validatePull(raw, expected) {
  if (!object(raw) || !Number.isSafeInteger(raw.number) || raw.number < 1 || !object(raw.head) || !object(raw.base)) throw extensionError('GitHub response is missing pull request identity', 'GITHUB_IDENTITY_MISMATCH');
  if (raw.head.ref !== expected.headRef || raw.base.ref !== expected.baseRef || raw.head.sha !== expected.headSha) throw extensionError('GitHub response pull request head/base identity differs from the reviewed plan', 'GITHUB_IDENTITY_MISMATCH');
  try { if (typeof raw.html_url !== 'string' || new URL(raw.html_url).hostname !== 'github.com') throw new Error('invalid URL'); } catch { throw extensionError('GitHub response has an invalid pull request URL', 'GITHUB_IDENTITY_MISMATCH'); }
  return { number: raw.number, url: raw.html_url, headRef: raw.head.ref, headSha: raw.head.sha, baseRef: raw.base.ref, baseSha: typeof raw.base.sha === 'string' ? raw.base.sha : null, state: raw.state, draft: Boolean(raw.draft) };
}
function checkedPlan(plan) { return assertGitHubPullRequestPlan(plan); }

/** Create a GitHub REST client with an explicitly supplied, memory-only token. */
export function createGitHubV1Client({ token, fetchImpl = globalThis.fetch, apiUrl = API, timeoutMs = 15_000 } = {}) {
  if (typeof token !== 'string' || token.length < 8 || token.length > 8_192 || /[\r\n\0]/.test(token)) throw extensionError('GitHub adapter needs an explicit in-memory token', 'GITHUB_TOKEN_REQUIRED');
  if (typeof fetchImpl !== 'function') throw extensionError('GitHub adapter fetch implementation is invalid', 'INVALID_GITHUB_CLIENT');
  if (apiUrl !== API) throw extensionError('GitHub adapter only permits the public GitHub REST API endpoint', 'INVALID_GITHUB_ENDPOINT');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw extensionError('GitHub adapter timeout must be 100ms to 60s', 'INVALID_GITHUB_CLIENT');
  async function requestPage(method, pathname, body = null) {
    // Pagination links are accepted only when they remain on the public GitHub
    // API. The adapter never follows an arbitrary Link header supplied by a peer.
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) throw extensionError('GitHub request path is invalid', 'GITHUB_RESPONSE_INVALID');
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
    let result;
    try { result = await response.json(); } catch { throw extensionError('GitHub response was not valid JSON', 'GITHUB_RESPONSE_INVALID'); }
    const links = String(response.headers?.get?.('link') ?? '');
    const nextMatch = /<([^>]+)>;\s*rel="next"/i.exec(links);
    let next = null;
    if (nextMatch) {
      try {
        const url = new URL(nextMatch[1]);
        if (url.origin !== API || !url.pathname.startsWith('/')) throw new Error('foreign link');
        next = `${url.pathname}${url.search}`;
      } catch { throw extensionError('GitHub pagination link is invalid', 'GITHUB_RESPONSE_INVALID'); }
    }
    return { result, next };
  }
  async function request(method, pathname, body = null) { return (await requestPage(method, pathname, body)).result; }
  return { request, requestPage };
}

export async function publishGitHubPullRequest({ client, plan } = {}) {
  if (!client || typeof client.request !== 'function') throw extensionError('GitHub client is invalid', 'INVALID_GITHUB_PLAN');
  checkedPlan(plan);
  const expected = { headRef: plan.headRef, headSha: plan.headSha, baseRef: plan.baseRef };
  const resource = `/repos/${plan.repository}/pulls${plan.existingPullNumber ? `/${safeNumber(plan.existingPullNumber)}` : ''}`;
  const raw = await client.request(plan.existingPullNumber ? 'PATCH' : 'POST', resource, plan.existingPullNumber ? { title: plan.title, body: plan.body, base: plan.baseRef } : { title: plan.title, body: plan.body, head: plan.headRef, base: plan.baseRef });
  return { planDigest: plan.digest, pullRequest: validatePull(raw, expected) };
}

const MAX_PREFLIGHT_PAGES = 20;
const MAX_PREFLIGHT_ITEMS = 2_000;

function orderValue(item) {
  const timestamp = Date.parse(String(item?.completed_at ?? item?.submitted_at ?? item?.started_at ?? item?.updated_at ?? ''));
  return [Number.isFinite(timestamp) ? timestamp : -1, Number.isSafeInteger(item?.id) ? item.id : -1];
}
function later(left, right) {
  const a = orderValue(left), b = orderValue(right);
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

async function paged(client, pathname, kind) {
  const values = [];
  let next = pathname;
  let pages = 0;
  while (next) {
    if (pages >= MAX_PREFLIGHT_PAGES) throw extensionError(`GitHub ${kind} pagination exceeds the safety limit`, 'GITHUB_RESPONSE_INVALID');
    const page = typeof client.requestPage === 'function'
      ? await client.requestPage('GET', next)
      : { result: await client.request('GET', next), next: null };
    const result = page?.result;
    const items = kind === 'checks' ? result?.check_runs : result;
    if (!Array.isArray(items)) throw extensionError(`GitHub ${kind} response is invalid`, 'GITHUB_RESPONSE_INVALID');
    values.push(...items);
    if (values.length > MAX_PREFLIGHT_ITEMS) throw extensionError(`GitHub ${kind} response exceeds the safety limit`, 'GITHUB_RESPONSE_INVALID');
    next = page.next ?? null;
    pages += 1;
  }
  return values;
}

function latestChecks(checks, headSha) {
  const byName = new Map();
  for (const check of checks) {
    if (!object(check) || !safeLine(check.name, 120)) continue;
    // A preflight is a fact about one immutable candidate. Missing identity is
    // not evidence; accepting it could let a check from another commit authorize a merge.
    if (check.head_sha !== headSha) continue;
    const old = byName.get(check.name);
    if (!old || later(check, old)) byName.set(check.name, check);
  }
  return [...byName.values()].map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion ?? null, id: Number.isSafeInteger(check.id) ? check.id : null }));
}

function latestReviews(reviews, headSha) {
  const byUser = new Map();
  for (const review of reviews) {
    if (!object(review) || !object(review.user) || !safeLine(review.user.login, 120)) continue;
    // A review on another commit cannot approve this immutable candidate. GitHub's
    // review payload exposes commit_id for exactly this purpose.
    if (review.commit_id !== headSha) continue;
    const old = byUser.get(review.user.login);
    if (!old || later(review, old)) byUser.set(review.user.login, review);
  }
  return [...byUser.values()];
}

/** Read only the remote check/review facts for the reviewed plan's exact head SHA. */
export async function inspectGitHubPullRequest({ client, plan, pullNumber } = {}) {
  if (!client || typeof client.request !== 'function') throw extensionError('GitHub client is invalid', 'INVALID_GITHUB_PLAN');
  checkedPlan(plan);
  const number = safeNumber(pullNumber); const expected = { headRef: plan.headRef, headSha: plan.headSha, baseRef: plan.baseRef };
  const [pull, checks, reviews] = await Promise.all([
    client.request('GET', `/repos/${plan.repository}/pulls/${number}`),
    paged(client, `/repos/${plan.repository}/commits/${plan.headSha}/check-runs?per_page=100`, 'checks'),
    paged(client, `/repos/${plan.repository}/pulls/${number}/reviews?per_page=100`, 'reviews')
  ]);
  const pullRequest = validatePull(pull, expected);
  const completed = latestChecks(checks, plan.headSha);
  // A required name passes only if its *latest* run completed successfully. A
  // newer pending/failing rerun defeats an older success rather than being hidden
  // by `some(success)`.
  const requiredChecksPassed = plan.requiredChecks.every((name) => completed.some((check) => check.name === name && check.status === 'completed' && check.conclusion === 'success'));
  const effectiveReviews = latestReviews(reviews, plan.headSha);
  const approved = effectiveReviews.some((review) => review.state === 'APPROVED');
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
