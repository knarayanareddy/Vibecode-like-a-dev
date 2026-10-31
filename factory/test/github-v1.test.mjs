/** M8 GitHub provider: fixture-only REST contract with exact immutable identities. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubPullRequestPlan, createGitHubV1Client, inspectGitHubPullRequest, publishGitHubPullRequest, requestGitHubMerge } from '../integrations/github-v1/index.mjs';

const SHA = 'a'.repeat(40); const TARGET = 'b'.repeat(40); const DIGEST = 'c'.repeat(64);
function plan(options = {}) {
  return createGitHubPullRequestPlan({
    repository: 'vld-fixtures/widget', headRef: 'vld/export-api', baseRef: 'main', title: 'Implement export API', body: 'Frozen VLD candidate evidence.', requiredChecks: ['check'], allowMergeRequest: true,
    candidate: { id: 'candidate-fixture', candidateSha: SHA, targetSha: TARGET, packetDigest: DIGEST, policyDigest: DIGEST },
    approval: { candidateId: 'candidate-fixture', candidateSha: SHA, targetSha: TARGET, policyDigest: DIGEST },
    queue: { candidateId: 'candidate-fixture', candidateSha: SHA, targetSha: TARGET, policyDigest: DIGEST },
    ...options
  });
}
function response(body, { status = 200, headers = {} } = {}) { return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body }; }
function pull({ sha = SHA, base = 'main' } = {}) { return { number: 42, html_url: 'https://github.com/vld-fixtures/widget/pull/42', state: 'open', draft: false, head: { ref: 'vld/export-api', sha }, base: { ref: base, sha: TARGET } }; }
function fixtureClient(queue, calls) {
  return createGitHubV1Client({ token: 'example-auth-material', fetchImpl: async (url, request) => { calls.push({ url, request }); const next = queue.shift(); if (!next) throw new Error('unexpected request'); return next; } });
}

test('M8 GitHub adapter creates exact PR plans and rejects altered tuple/remote identity before a merge request', async () => {
  const reviewed = plan(); assert.match(reviewed.digest, /^[a-f0-9]{64}$/); assert.equal(reviewed.headSha, SHA);
  assert.throws(() => plan({ approval: { candidateId: 'other', candidateSha: SHA, targetSha: TARGET, policyDigest: DIGEST } }), (error) => error.code === 'GITHUB_PLAN_TUPLE_INVALID');
  const calls = []; const client = fixtureClient([response(pull())], calls);
  const published = await publishGitHubPullRequest({ client, plan: reviewed });
  assert.equal(published.pullRequest.number, 42); assert.match(calls[0].url, /\/repos\/vld-fixtures\/widget\/pulls$/); assert.equal(calls[0].request.method, 'POST'); assert.equal(JSON.parse(calls[0].request.body).head, 'vld/export-api'); assert.match(calls[0].request.headers.authorization, /^Bearer /);
  assert.doesNotMatch(JSON.stringify(published), /example-auth-material/);
  const updateCalls = []; const updating = fixtureClient([response(pull())], updateCalls);
  await publishGitHubPullRequest({ client: updating, plan: plan({ existingPullNumber: 42 }) });
  assert.equal(updateCalls[0].request.method, 'PATCH'); assert.equal(JSON.parse(updateCalls[0].request.body).head, undefined);

  const identityCalls = []; const identityClient = fixtureClient([response(pull({ sha: 'd'.repeat(40) }))], identityCalls);
  await assert.rejects(() => publishGitHubPullRequest({ client: identityClient, plan: reviewed }), (error) => error.code === 'GITHUB_IDENTITY_MISMATCH');
  const tampered = { ...reviewed, title: 'different content' };
  await assert.rejects(() => publishGitHubPullRequest({ client, plan: tampered }), (error) => error.code === 'GITHUB_PLAN_DIGEST_MISMATCH');
});

test('M8 GitHub adapter reads fixture checks/reviews and requests merge only after exact remote gates', async () => {
  const reviewed = plan(); const calls = []; const client = fixtureClient([
    response(pull()),
    response({ check_runs: [{ name: 'check', status: 'completed', conclusion: 'success' } ] }),
    response([{ state: 'APPROVED', user: { login: 'independent-reviewer' } }]),
    response(pull()),
    response({ check_runs: [{ name: 'check', status: 'completed', conclusion: 'success' } ] }),
    response([{ state: 'APPROVED', user: { login: 'independent-reviewer' } }]),
    response({ merged: true, sha: 'e'.repeat(40), message: 'Pull Request successfully merged' })
  ], calls);
  const facts = await inspectGitHubPullRequest({ client, plan: reviewed, pullNumber: 42 });
  assert.equal(facts.requiredChecksPassed, true); assert.equal(facts.githubApproval, true);
  const merged = await requestGitHubMerge({ client, plan: reviewed, pullNumber: 42 });
  assert.equal(merged.mergedSha, 'e'.repeat(40)); assert.equal(calls.at(-1).request.method, 'PUT'); assert.equal(JSON.parse(calls.at(-1).request.body).sha, SHA);

  const blocked = fixtureClient([response(pull()), response({ check_runs: [{ name: 'check', status: 'completed', conclusion: 'failure' }] }), response([])], []);
  await assert.rejects(() => requestGitHubMerge({ client: blocked, plan: reviewed, pullNumber: 42 }), (error) => error.code === 'GITHUB_MERGE_GATES_UNMET');
});

test('M8 GitHub adapter normalizes credential, rate-limit and malformed-response failures without ambient auth', async () => {
  const prior = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'example-auth-material';
  try { assert.throws(() => createGitHubV1Client(), (error) => error.code === 'GITHUB_TOKEN_REQUIRED'); } finally { if (prior === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prior; }
  assert.throws(() => createGitHubV1Client({ token: 'short' }), (error) => error.code === 'GITHUB_TOKEN_REQUIRED');
  const rateLimited = createGitHubV1Client({ token: 'example-auth-material', fetchImpl: async () => response({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) });
  await assert.rejects(() => publishGitHubPullRequest({ client: rateLimited, plan: plan() }), (error) => error.code === 'GITHUB_RATE_LIMITED');
  const malformed = fixtureClient([response({ number: 42, head: {}, base: {} })], []);
  await assert.rejects(() => publishGitHubPullRequest({ client: malformed, plan: plan() }), (error) => error.code === 'GITHUB_IDENTITY_MISMATCH');
  const network = createGitHubV1Client({ token: 'example-auth-material', fetchImpl: async () => { throw new Error('socket timeout private-value'); } });
  await assert.rejects(() => publishGitHubPullRequest({ client: network, plan: plan() }), (error) => error.code === 'GITHUB_NETWORK_FAILED' && !error.message.includes('example-auth-material'));
  const timeout = createGitHubV1Client({ token: 'example-auth-material', timeoutMs: 100, fetchImpl: (_url, request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(() => publishGitHubPullRequest({ client: timeout, plan: plan() }), (error) => error.code === 'GITHUB_NETWORK_FAILED');
  const ambiguous = fixtureClient([
    response(pull()), response({ check_runs: [{ name: 'check', status: 'completed', conclusion: 'success' }] }), response([{ state: 'APPROVED', user: { login: 'independent-reviewer' } }]), response({ merged: false, sha: SHA })
  ], []);
  await assert.rejects(() => requestGitHubMerge({ client: ambiguous, plan: plan(), pullNumber: 42 }), (error) => error.code === 'GITHUB_MERGE_AMBIGUOUS');
});
