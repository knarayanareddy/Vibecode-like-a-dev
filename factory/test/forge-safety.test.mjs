/**
 * Roadmap 4.2 — Safe-by-default forge delivery.
 *
 * Governed `forge execute` must stay conservative:
 *   - publishing creates a DRAFT pull request unless the plan says `ready`;
 *   - draft pull requests can never merge (remote state is the source of truth);
 *   - the PR body carries the evidence export and sandbox receipt sections;
 *   - a tampered evidence ledger blocks publishing outright;
 *   - escalation packets (tier >= 2 or money/regulated/destructiveWrites)
 *     publish only with a human sign-off recorded on the independent review.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const reqTag = '@' + 'req';

import { createMission } from '../lib/missions.mjs';
import { createWorkspace } from '../lib/workspaces.mjs';
import { allocateRuntimePackage, initializeRuntime, transitionRuntimePackage } from '../lib/runtime.mjs';
import { defaultDeliveryPolicy } from '../lib/delivery-policy.mjs';
import {
  approveRuntimeDeliveryCandidate,
  queueRuntimeDeliveryCandidate,
  recordRuntimeDeliveryReview,
  submitRuntimeDeliveryCandidate,
  verifyRuntimeDeliveryCandidate
} from '../lib/runtime-delivery.mjs';
import { REVIEW_CATEGORIES } from '../lib/review.mjs';
import { executeRuntimeForgePlan } from '../lib/runtime-forge.mjs';

function compilePacket(profilePath, outDir) {
  execFileSync(process.execPath, [path.join(ROOT, 'factory', 'cli.mjs'), 'compile', profilePath, '-o', outDir, '--force'], { stdio: 'ignore' });
}

function makeTempGitRepo(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'forge-safety@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Forge Safety Test'], { stdio: 'ignore' });
  return dir;
}

function commitAll(dir, msg) {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', msg, '--allow-empty'], { stdio: 'ignore' });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function cleanCategories() {
  return Object.fromEntries(REVIEW_CATEGORIES.map((c) => [c, 'none']));
}

/** Run the delivery pipeline up to `queued` and return the handles the forge needs. */
function seedQueuedDelivery({ destructive = false, signoff = null } = {}) {
  const repo = makeTempGitRepo('vld-forge-safety-');
  const profilePath = path.join(repo, 'profile.json');
  writeFileSync(profilePath, JSON.stringify({
    name: 'forge-safety-demo',
    idea: 'A small CLI that logs shift handover notes for on-call engineers and searches them offline.',
    kind: 'cli',
    stage: 'prototype',
    users: { scale: 'small' },
    traits: [],
    risks: { pii: false, payments: false, regulated: false, multiTenant: false, destructiveWrites: destructive, publicFacing: false, integrations: false }
  }, null, 2));
  compilePacket(profilePath, path.join(repo, 'specs'));
  const spec = JSON.parse(readFileSync(path.join(repo, 'specs', 'spec.json'), 'utf8'));
  const autoReqs = spec.requirements.filter((r) => r.verify === 'automated').map((r) => r.id);
  mkdirSync(path.join(repo, 'tests'), { recursive: true });
  writeFileSync(
    path.join(repo, 'tests', 'demo.test.mjs'),
    `${autoReqs.map((id) => `// ${reqTag} ${id}`).join('\n')}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n`
  );
  commitAll(repo, 'initial verified repo');

  createMission({
    definition: {
      schemaVersion: 1,
      id: 'mission-forge-safety',
      title: 'Forge safety fixture mission',
      workPackages: [{
        id: 'pkg-demo',
        title: 'Demo work package',
        dependsOn: [],
        requirements: spec.requirements.map((r) => r.id),
        resourceClaims: { paths: ['tests/**'] }
      }]
    },
    packetDir: 'specs',
    target: 'main',
    projectDir: repo,
    outFile: '.vld/mission.json'
  });
  writeFileSync(path.join(repo, '.vld', 'delivery-policy.json'), `${JSON.stringify(defaultDeliveryPolicy(), null, 2)}\n`);
  initializeRuntime({ missionFile: '.vld/mission.json', projectDir: repo });
  const alloc = allocateRuntimePackage({
    missionFile: '.vld/mission.json',
    packageId: 'pkg-demo',
    assignee: { role: 'implementer', id: 'dev-bot' },
    actor: { role: 'operator', id: 'op' },
    leaseMs: 60_000,
    projectDir: repo
  });
  const ws = createWorkspace({ missionFile: '.vld/mission.json', packageId: 'pkg-demo', projectDir: repo });
  writeFileSync(
    path.join(ws.allocation.worktree, 'tests', 'demo.test.mjs'),
    `${autoReqs.map((id) => `// ${reqTag} ${id}`).join('\n')}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(2, 2));\n`
  );
  const candidateSha = commitAll(ws.allocation.worktree, 'implement pkg-demo');
  transitionRuntimePackage({ missionFile: '.vld/mission.json', packageId: 'pkg-demo', to: 'running', actor: { role: 'implementer', id: 'dev-bot' }, expectedVersion: 1, leaseToken: alloc.leaseToken, projectDir: repo });
  transitionRuntimePackage({ missionFile: '.vld/mission.json', packageId: 'pkg-demo', to: 'changes_ready', actor: { role: 'implementer', id: 'dev-bot' }, expectedVersion: 2, leaseToken: alloc.leaseToken, projectDir: repo });

  const sub = submitRuntimeDeliveryCandidate({
    missionFile: '.vld/mission.json',
    packageId: 'pkg-demo',
    policyFile: '.vld/delivery-policy.json',
    leaseToken: alloc.leaseToken,
    actor: { role: 'implementer', id: 'dev-bot' },
    candidateSha,
    projectDir: repo
  });
  const ver = verifyRuntimeDeliveryCandidate({
    missionFile: '.vld/mission.json',
    packageId: 'pkg-demo',
    policyFile: '.vld/delivery-policy.json',
    actor: { role: 'operator', id: 'op' },
    projectDir: repo
  });
  assert.equal(ver.verification.outcome, 'passed');

  // Independent review (escalation packets may carry a human sign-off).
  recordRuntimeDeliveryReview({
    missionFile: '.vld/mission.json',
    packageId: 'pkg-demo',
    candidateId: sub.candidate.id,
    policyFile: '.vld/delivery-policy.json',
    reviewerModelId: 'openai:safety-reviewer',
    categories: cleanCategories(),
    // The review API refuses an 'approved' verdict without a sign-off on an
    // escalation packet; 'escalated-to-human' is the reachable unsigned state,
    // and the forge must refuse to publish it (the operator records the human
    // sign-off on a later review to publish).
    verdict: signoff ? 'approved' : 'escalated-to-human',
    ...(signoff ? { humanSignoff: signoff } : {}),
    actor: { role: 'reviewer', id: 'alice-reviewer' },
    projectDir: repo
  });
  approveRuntimeDeliveryCandidate({
    missionFile: '.vld/mission.json',
    packageId: 'pkg-demo',
    candidateId: sub.candidate.id,
    policyFile: '.vld/delivery-policy.json',
    actor: { role: 'reviewer', id: 'alice-reviewer' },
    reason: 'Independent review of the frozen candidate against the verified packet',
    projectDir: repo
  });
  queueRuntimeDeliveryCandidate({
    missionFile: '.vld/mission.json',
    packageId: 'pkg-demo',
    candidateId: sub.candidate.id,
    policyFile: '.vld/delivery-policy.json',
    actor: { role: 'release-approver', id: 'bob-release' },
    projectDir: repo
  });

  return { repo, candidateSha, candidateId: sub.candidate.id, targetSha: sub.candidate.targetSha };
}

/** Deterministic GitHub REST mock; records every request so the test can assert the wire shape. */
function mockGitHub({ repoName, candidateSha, targetSha, remoteDraft = false }) {
  const calls = [];
  const mockFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const okJson = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });
    const pull = {
      number: 7,
      html_url: `https://github.com/acme/${repoName}/pull/7`,
      state: 'open',
      draft: remoteDraft,
      head: { ref: 'vld/pkg-demo', sha: candidateSha },
      base: { ref: 'main', sha: targetSha }
    };
    if (init.method === 'POST' && u.pathname === `/repos/acme/${repoName}/pulls`) return okJson(pull);
    if (init.method === 'GET' && u.pathname === `/repos/acme/${repoName}/pulls/7`) return okJson(pull);
    if (init.method === 'POST' && u.pathname === `/repos/acme/${repoName}/issues/7/comments`) {
      return okJson({ id: 901, html_url: `https://github.com/acme/${repoName}/pull/7#issuecomment-901` });
    }
    if (init.method === 'GET' && u.pathname.endsWith('/check-runs')) {
      return okJson({ check_runs: [{ id: 11, name: 'spec', head_sha: candidateSha, status: 'completed', conclusion: 'success', completed_at: '2026-11-16T00:00:00Z' }] });
    }
    if (init.method === 'GET' && u.pathname.endsWith('/reviews')) {
      return okJson([{ id: 22, state: 'APPROVED', commit_id: candidateSha, submitted_at: '2026-11-16T00:01:00Z', user: { login: 'alice' } }]);
    }
    if (init.method === 'PUT' && u.pathname === `/repos/acme/${repoName}/pulls/7/merge`) {
      return okJson({ merged: true, sha: 'f'.repeat(40), message: 'Pull Request successfully merged' });
    }
    throw new Error(`unexpected mock GitHub call: ${init.method} ${u.pathname}`);
  };
  return { calls, mockFetch };
}

const forgeArgs = (seed, mock) => ({
  missionFile: '.vld/mission.json',
  packageId: 'pkg-demo',
  candidateId: seed.candidateId,
  repository: 'acme/forge-safety-demo',
  headRef: 'vld/pkg-demo',
  baseRef: 'main',
  action: 'publish',
  postEvidence: false,
  token: 'ghp_EphemeralForgeSafety99',
  fetchImpl: mock.mockFetch,
  projectDir: seed.repo
});

test('4.2 governed publish is a draft PR by default; --ready opts into a ready PR; body carries the audit sections', async (t) => {
  const seed = seedQueuedDelivery();
  t.after(() => rmSync(seed.repo, { recursive: true, force: true }));
  const mock = mockGitHub({ repoName: 'forge-safety-demo', candidateSha: seed.candidateSha, targetSha: seed.targetSha });

  const published = await executeRuntimeForgePlan(forgeArgs(seed, mock));
  assert.equal(published.ok, true);
  const create = mock.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'));
  assert.ok(create, 'the forge must create the pull request');
  assert.equal(create.body.draft, true, 'default governed publish must be a draft PR');
  assert.equal(published.receipt.draft, true);

  // The PR body carries the audit sections (roadmap 4.2).
  assert.match(create.body.body, /\nSandbox receipts:\n/);
  assert.match(create.body.body, /\nEvidence export:\n/);
  assert.match(create.body.body, /chain head: [a-f0-9]{64}/);

  // An explicitly ready plan publishes a non-draft PR.
  const readyMock = mockGitHub({ repoName: 'forge-safety-demo', candidateSha: seed.candidateSha, targetSha: seed.targetSha });
  const ready = await executeRuntimeForgePlan({ ...forgeArgs(seed, readyMock), draft: false });
  assert.equal(ready.ok, true);
  assert.equal(readyMock.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls')).body.draft, false);
  assert.equal(ready.receipt.draft, false);
});

test('4.2 a tampered evidence ledger blocks publishing', async (t) => {
  const seed = seedQueuedDelivery();
  t.after(() => rmSync(seed.repo, { recursive: true, force: true }));
  const mock = mockGitHub({ repoName: 'forge-safety-demo', candidateSha: seed.candidateSha, targetSha: seed.targetSha });

  // One clean publish first so the chain has entries to tamper with.
  const first = await executeRuntimeForgePlan(forgeArgs(seed, mock));
  assert.equal(first.ok, true);

  const ledgerFile = path.join(seed.repo, '.vld', 'evidence', 'evidence.jsonl');
  const ledger = readFileSync(ledgerFile, 'utf8');
  writeFileSync(ledgerFile, ledger.replace('"kind"', '"kinc"'), 'utf8'); // single-byte-class tamper

  const callsBefore = mock.calls.length;
  await assert.rejects(
    () => executeRuntimeForgePlan(forgeArgs(seed, mock)),
    (err) => err?.code === 'FORGE_EVIDENCE_CHAIN_INVALID' && /refusing to publish/.test(err.message)
  );
  assert.equal(mock.calls.length, callsBefore, 'no GitHub call may happen from a tampered ledger');
});

test('4.2 escalation packets publish only with a recorded human sign-off', async (t) => {
  const unsigned = seedQueuedDelivery({ destructive: true });
  t.after(() => rmSync(unsigned.repo, { recursive: true, force: true }));
  const mock = mockGitHub({ repoName: 'forge-safety-demo', candidateSha: unsigned.candidateSha, targetSha: unsigned.targetSha });

  await assert.rejects(
    () => executeRuntimeForgePlan(forgeArgs(unsigned, mock)),
    (err) => err?.code === 'FORGE_HUMAN_SIGNOFF_REQUIRED' && /human sign-off/.test(err.message)
  );
  assert.ok(!mock.calls.some((c) => c.method === 'POST' && c.path.endsWith('/pulls')), 'no PR without the human sign-off record');

  const signed = seedQueuedDelivery({
    destructive: true,
    signoff: { reviewerId: 'human-gatekeeper', reason: 'Reviewed the escalation risks by hand' }
  });
  t.after(() => rmSync(signed.repo, { recursive: true, force: true }));
  const signedMock = mockGitHub({ repoName: 'forge-safety-demo', candidateSha: signed.candidateSha, targetSha: signed.targetSha });
  const published = await executeRuntimeForgePlan(forgeArgs(signed, signedMock));
  assert.equal(published.ok, true, 'a signed escalation packet publishes');
});

test('4.2 draft pull requests can never merge', async (t) => {
  const seed = seedQueuedDelivery();
  t.after(() => rmSync(seed.repo, { recursive: true, force: true }));
  const mock = mockGitHub({ repoName: 'forge-safety-demo', candidateSha: seed.candidateSha, targetSha: seed.targetSha, remoteDraft: true });

  await assert.rejects(
    () => executeRuntimeForgePlan({ ...forgeArgs(seed, mock), action: 'merge', pullNumber: 7, allowMergeRequest: true, postEvidence: false }),
    (err) => err?.code === 'GITHUB_MERGE_DRAFT' && /draft/.test(err.message)
  );
  assert.ok(!mock.calls.some((c) => c.method === 'PUT' && /\/merge$/.test(c.path)), 'the merge endpoint must not be called');
});
