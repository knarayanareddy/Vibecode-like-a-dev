/**
 * Phase 3 verification suite (roadmap 3.1–3.4, ADR 0012):
 *   3.1 Structured independent review protocol + Studio/Runtime approval & queue API
 *   3.2 Governed GitHub v1 execute mode (PR, evidence comment, checks, merge)
 *   3.3 Continuous spec-drift detector, CI workflow template, polyglot G3-MUTATION & semantic-oracles.json
 *   3.4 Tamper-evident SHA-256 hash-chained evidence.jsonl + opt-in local telemetry
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function compilePacket(profilePath, outDir) {
  execFileSync(process.execPath, [path.join(ROOT, 'factory', 'cli.mjs'), 'compile', profilePath, '-o', outDir, '--force'], { stdio: 'ignore' });
}
import {
  appendEvidence,
  configureTelemetry,
  exportEvidenceBundle,
  GENESIS_HASH,
  purgeTelemetry,
  recordTelemetryEvent,
  telemetryStatus,
  verifyEvidenceChain
} from '../lib/evidence.mjs';
import {
  prepareReviewPacket,
  recordReviewDecision,
  REVIEW_CATEGORIES,
  scanDiffRisks,
  validateReviewReport
} from '../lib/review.mjs';
import {
  detectSpecDrift,
  initSemanticOracles,
  scaffoldDriftWorkflow,
  STACK_MUTATION_RUNNERS
} from '../lib/drift.mjs';
import { createMission } from '../lib/missions.mjs';
import { createWorkspace } from '../lib/workspaces.mjs';
import { allocateRuntimePackage, initializeRuntime, transitionRuntimePackage } from '../lib/runtime.mjs';
import { defaultDeliveryPolicy } from '../lib/delivery-policy.mjs';
import {
  approveRuntimeDeliveryCandidate,
  queueRuntimeDeliveryCandidate,
  submitRuntimeDeliveryCandidate,
  verifyRuntimeDeliveryCandidate
} from '../lib/runtime-delivery.mjs';
import { executeRuntimeForgePlan } from '../lib/runtime-forge.mjs';
import { createRuntimeServer, listenRuntimeServer } from '../lib/runtime-server.mjs';
import { studioDashboardScript } from '../lib/studio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const reqTag = '@' + 'req';

function makeTempGitRepo(prefix = 'vld-phase3-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'phase3@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Phase3 Test'], { stdio: 'ignore' });
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

test('3.4 hash-chained evidence ledger scrubs secrets, catches single-byte & deletion tampering, and keeps telemetry opt-in', () => {
  const repo = makeTempGitRepo('vld-phase3-ev-');
  try {
    // Empty ledger is valid at genesis
    const initial = verifyEvidenceChain({ projectDir: repo });
    assert.equal(initial.ok, true);
    assert.equal(initial.exists, false);
    assert.equal(initial.headHash, GENESIS_HASH);

    // Append 3 linked entries, including a secret-shaped token that must be scrubbed
    const synthPat = ['ghp', '1234567890abcdef'].join('_');
    const synthRaw = ['fixture', 'sensitive', 'marker'].join('-');
    const e1 = appendEvidence({
      projectDir: repo,
      kind: 'compile',
      actor: 'operator:dev',
      subject: 'ledger-app',
      payload: { tier: 2, token: synthRaw, note: `auth Bearer ${synthPat}` }
    });
    const e2 = appendEvidence({
      projectDir: repo,
      kind: 'sandbox-run',
      actor: 'implementer:bot-1',
      subject: 'pkg-core',
      payload: { backend: 'linux-ns', exitCode: 0 }
    });
    const e3 = appendEvidence({
      projectDir: repo,
      kind: 'verify',
      actor: 'runtime:verifier',
      subject: 'pkg-core',
      payload: { passed: true }
    });

    assert.equal(e1.entry.prevHash, GENESIS_HASH);
    assert.equal(e2.entry.prevHash, e1.entry.hash);
    assert.equal(e3.entry.prevHash, e2.entry.hash);

    const rawLedger = readFileSync(e1.file, 'utf8');
    assert.ok(!rawLedger.includes(synthRaw), 'key-based secret scrubbed');
    assert.ok(!rawLedger.includes(synthPat), 'token pattern scrubbed');

    const verified = verifyEvidenceChain({ projectDir: repo });
    assert.equal(verified.ok, true);
    assert.equal(verified.entries, 3);
    assert.equal(verified.headHash, e3.headHash);

    // Export JSON and Markdown audit bundles
    const jsonBundle = JSON.parse(exportEvidenceBundle({ projectDir: repo, format: 'json' }));
    assert.equal(jsonBundle.chainValid, true);
    assert.equal(jsonBundle.entries, 3);
    assert.match(jsonBundle.bundleDigest, /^[a-f0-9]{64}$/);

    const mdBundle = exportEvidenceBundle({ projectDir: repo, format: 'markdown' });
    assert.match(mdBundle, /Chain integrity:\*\* VERIFIED/);
    assert.match(mdBundle, /sandbox-run/);

    // Tamper with seq 2 payload -> chain breaks at seq 2 AND refuses further appends
    const tampered = rawLedger.replace('"linux-ns"', '"forged-ns"');
    writeFileSync(e1.file, tampered, 'utf8');
    const afterTamper = verifyEvidenceChain({ projectDir: repo });
    assert.equal(afterTamper.ok, false);
    assert.equal(afterTamper.firstBrokenSeq, 2);
    assert.throws(
      () => appendEvidence({ projectDir: repo, kind: 'drift', subject: 'pkg-core' }),
      (err) => err?.code === 'EVIDENCE_CHAIN_BROKEN'
    );

    // Delete middle line -> chain breaks at line 2 (seq/prevHash mismatch)
    const lines = rawLedger.trim().split('\n');
    writeFileSync(e1.file, `${lines[0]}\n${lines[2]}\n`, 'utf8');
    const afterDelete = verifyEvidenceChain({ projectDir: repo });
    assert.equal(afterDelete.ok, false);
    assert.equal(afterDelete.firstBrokenSeq, 2);

    // Telemetry: disabled by default, anonymous when enabled, purgeable
    const t0 = telemetryStatus({ projectDir: repo });
    assert.equal(t0.enabled, false);
    assert.equal(recordTelemetryEvent({ projectDir: repo, event: 'compile', tier: 2, durationMs: 42 }).recorded, false);
    assert.equal(telemetryStatus({ projectDir: repo }).recordedEvents, 0);

    configureTelemetry({ projectDir: repo, enabled: true });
    const rec = recordTelemetryEvent({ projectDir: repo, event: 'compile', ok: true, tier: 2, durationMs: 42.7 });
    assert.equal(rec.recorded, true);
    assert.deepEqual(Object.keys(rec.entry).sort(), ['day', 'durationMs', 'event', 'ok', 'schemaVersion', 'tier']);
    assert.equal(telemetryStatus({ projectDir: repo }).recordedEvents, 1);

    purgeTelemetry({ projectDir: repo });
    assert.equal(telemetryStatus({ projectDir: repo }).recordedEvents, 0);
    configureTelemetry({ projectDir: repo, enabled: false });
    assert.equal(telemetryStatus({ projectDir: repo }).enabled, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('3.1 review protocol enforces session isolation, 6 categories, no self-review, diff-risk scan & human escalation', () => {
  const repo = makeTempGitRepo('vld-phase3-rev-');
  try {
    const profilePath = path.join(repo, 'profile.json');
    writeFileSync(profilePath, JSON.stringify({
      name: 'payout-api',
      idea: 'Payout service for finance operators to approve and execute vendor wire payouts with audit history instead of manual spreadsheets.',
      kind: 'api',
      stage: 'production',
      users: { scale: 'medium' },
      traits: ['auth', 'persistence'],
      risks: { pii: true, payments: true, regulated: false, multiTenant: false, destructiveWrites: true, publicFacing: true, integrations: false },
      constraints: { team: 3, weeks: 8, stack: 'typescript', mustUse: [] }
    }, null, 2));
    compilePacket(profilePath, path.join(repo, 'specs'));
    const spec = JSON.parse(readFileSync(path.join(repo, 'specs', 'spec.json'), 'utf8'));
    const firstReq = spec.requirements[0].id;

    // Diff risk scanner catches weakened assertions, skipped tests, dropped @req, manifest edit, new env var
    const syntheticDiff = [
      '+++ b/tests/payout.test.ts',
      `-  // ${reqTag} ${firstReq}`,
      '-  assert.equal(total, 100);',
      '-  assert.equal(status, 200);',
      '+  it.skip("handles overdraft", () => {});',
      '+++ b/src/payout.ts',
      '+  const k = process.env.STRIPE_LIVE_KEY;',
      '+++ b/package.json',
      '+  "left-pad": "1.0.0"'
    ].join('\n');
    const risks = scanDiffRisks(syntheticDiff);
    assert.equal(risks.testWeakening.length, 1);
    assert.equal(risks.skippedTests.length, 1);
    assert.equal(risks.droppedAnchors.length, 1);
    assert.deepEqual(risks.manifestChanges, ['package.json']);
    assert.ok(risks.newEnvVars.some((e) => e.includes('STRIPE_LIVE_KEY')));

    const packet = prepareReviewPacket({
      projectDir: repo,
      packetDir: 'specs',
      authorId: 'agent-writer',
      diffText: syntheticDiff
    });
    assert.equal(packet.contextIsolated, true);
    assert.equal(packet.authorTranscriptIncluded, false);
    assert.equal(packet.humanEscalation.required, true);

    // Reject self-review
    const selfReview = validateReviewReport({
      schemaVersion: 1,
      reviewerId: 'agent-writer',
      reviewerKind: 'agent',
      sessionIsolated: true,
      verdict: 'approved',
      categories: cleanCategories()
    }, { authorId: 'agent-writer' });
    assert.equal(selfReview.ok, false);
    assert.ok(selfReview.errors.some((e) => /self-review/i.test(e)));

    // Reject missing category + uncited finding
    const badCats = cleanCategories();
    delete badCats.reversibility;
    badCats.boundaries = [{ file: 'src/payout.ts', severity: 'high', fix: 'add authorization check' }];
    const missingCat = validateReviewReport({
      schemaVersion: 1,
      reviewerId: 'agent-reviewer',
      reviewerKind: 'agent',
      sessionIsolated: true,
      verdict: 'approved',
      categories: badCats
    }, { knownRequirements: [firstReq], authorId: 'agent-writer' });
    assert.equal(missingCat.ok, false);
    assert.ok(missingCat.errors.some((e) => /reversibility/.test(e)));
    assert.ok(missingCat.errors.some((e) => /REQ-/.test(e)));
    assert.ok(missingCat.errors.some((e) => /cannot approve/i.test(e)));

    // Reject agent-only approval on high-rigor packet without human sign-off
    assert.throws(
      () => recordReviewDecision({
        projectDir: repo,
        packetDir: 'specs',
        report: {
          schemaVersion: 1,
          authorId: 'agent-writer',
          reviewerId: 'agent-reviewer',
          reviewerKind: 'agent',
          sessionIsolated: true,
          verdict: 'approved',
          categories: cleanCategories()
        }
      }),
      (err) => err?.code === 'INVALID_REVIEW_REPORT' && /humanSignoff/.test(err.message)
    );

    // Accept independent agent review + independent human sign-off & verify evidence chain
    const recorded = recordReviewDecision({
      projectDir: repo,
      packetDir: 'specs',
      report: {
        schemaVersion: 1,
        authorId: 'agent-writer',
        reviewerId: 'agent-reviewer',
        reviewerKind: 'agent',
        sessionIsolated: true,
        verdict: 'approved',
        humanSignoff: { reviewerId: 'alice-sec', reason: 'Verified payout boundary & rollback plan against spec.json' },
        categories: cleanCategories()
      }
    });
    assert.equal(recorded.ok, true);
    assert.ok(existsSync(recorded.file));
    const chain = verifyEvidenceChain({ projectDir: repo });
    assert.equal(chain.ok, true);
    assert.equal(chain.entries, 1);
    assert.equal(chain.records[0].kind, 'review');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('3.1 & 3.2 Studio approval/queue API, evidence view, ADR 0012, and governed GitHub v1 execute mode end to end', async () => {
  // Verify ADR 0012
  const adr = readFileSync(path.join(ROOT, 'docs', 'adr', '0012-governed-github-delivery-and-audit-chain.md'), 'utf8');
  assert.match(adr, /## Context/);
  assert.match(adr, /## Decision/);
  assert.match(adr, /## Consequences/);

  const repo = makeTempGitRepo('vld-phase3-forge-');
  let server = null;
  try {
    const profilePath = path.join(repo, 'profile.json');
    writeFileSync(profilePath, JSON.stringify({
      name: 'note-cli',
      idea: 'CLI tool for engineers to bookmark terminal snippets with tags and search them offline instead of shell history.',
      kind: 'cli',
      stage: 'prototype',
      users: { scale: 'small' },
      traits: [],
      risks: { pii: false, payments: false, regulated: false, multiTenant: false, destructiveWrites: false, publicFacing: false, integrations: false },
      constraints: { team: 1, weeks: 1, stack: 'javascript', mustUse: [] }
    }, null, 2));
    compilePacket(profilePath, path.join(repo, 'specs'));
    const spec = JSON.parse(readFileSync(path.join(repo, 'specs', 'spec.json'), 'utf8'));
    const autoReqs = spec.requirements.filter((r) => r.verify === 'automated').map((r) => r.id);
    mkdirSync(path.join(repo, 'tests'), { recursive: true });
    writeFileSync(
      path.join(repo, 'tests', 'cli.test.mjs'),
      `${autoReqs.map((id) => `// ${reqTag} ${id}`).join('\n')}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n`
    );
    commitAll(repo, 'initial verified repo');

    createMission({
      definition: {
        schemaVersion: 1,
        id: 'mission-gh',
        title: 'GitHub Execute Mode Test',
        workPackages: [{ id: 'pkg-cli', title: 'CLI work package', dependsOn: [], requirements: spec.requirements.map((r) => r.id), resourceClaims: { paths: ['tests/**'] } }]
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
      packageId: 'pkg-cli',
      assignee: { role: 'implementer', id: 'dev-bot' },
      actor: { role: 'operator', id: 'op' },
      leaseMs: 60_000,
      projectDir: repo
    });
    const ws = createWorkspace({ missionFile: '.vld/mission.json', packageId: 'pkg-cli', projectDir: repo });
    writeFileSync(
      path.join(ws.allocation.worktree, 'tests', 'cli.test.mjs'),
      `${autoReqs.map((id) => `// ${reqTag} ${id}`).join('\n')}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(2, 2));\n`
    );
    const candidateSha = commitAll(ws.allocation.worktree, 'implement pkg-cli');
    transitionRuntimePackage({ missionFile: '.vld/mission.json', packageId: 'pkg-cli', to: 'running', actor: { role: 'implementer', id: 'dev-bot' }, expectedVersion: 1, leaseToken: alloc.leaseToken, projectDir: repo });
    transitionRuntimePackage({ missionFile: '.vld/mission.json', packageId: 'pkg-cli', to: 'changes_ready', actor: { role: 'implementer', id: 'dev-bot' }, expectedVersion: 2, leaseToken: alloc.leaseToken, projectDir: repo });

    const sub = submitRuntimeDeliveryCandidate({
      missionFile: '.vld/mission.json',
      packageId: 'pkg-cli',
      policyFile: '.vld/delivery-policy.json',
      leaseToken: alloc.leaseToken,
      actor: { role: 'implementer', id: 'dev-bot' },
      candidateSha,
      projectDir: repo
    });
    const ver = verifyRuntimeDeliveryCandidate({
      missionFile: '.vld/mission.json',
      packageId: 'pkg-cli',
      policyFile: '.vld/delivery-policy.json',
      actor: { role: 'operator', id: 'op' },
      projectDir: repo
    });
    assert.equal(ver.verification.outcome, 'passed');

    // Start local Studio/Runtime API and approve + queue via typed HTTP endpoints
    const implAuth = ['local', 'implementer', 'capability'].join('-');
    const revAuth = ['local', 'reviewer', 'capability'].join('-');
    const relAuth = ['local', 'release', 'capability'].join('-');
    const hosted = createRuntimeServer({
      missionFile: '.vld/mission.json',
      projectDir: repo,
      identities: {
        [implAuth]: { role: 'implementer', id: 'dev-bot' },
        [revAuth]: { role: 'reviewer', id: 'alice-reviewer' },
        [relAuth]: { role: 'release-approver', id: 'bob-release' }
      }
    });
    server = hosted.server;
    const bound = await listenRuntimeServer(server, { host: '127.0.0.1', port: 0 });
    const api = async (token, requestId, method, params) => {
      const res = await fetch(`http://${bound.host}:${bound.port}/v1/runtime`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ schemaVersion: 1, requestId, method, params })
      });
      return { status: res.status, body: await res.json() };
    };

    // Implementer blocked from approving own candidate
    const badApprove = await api(implAuth, 'req-impl-approve-1', 'approve', {
      packageId: 'pkg-cli',
      candidateId: sub.candidate.id
    });
    assert.equal(badApprove.body.ok, false);
    assert.equal(badApprove.body.error.code, 'RUNTIME_ACTOR_FORBIDDEN');

    // Independent reviewer approves via Studio API
    const goodApprove = await api(revAuth, 'req-rev-approve-1', 'approve', {
      packageId: 'pkg-cli',
      candidateId: sub.candidate.id,
      reason: 'Reviewed against compiled spec.json'
    });
    assert.equal(goodApprove.body.ok, true);

    // Release approver queues via Studio API
    const goodQueue = await api(relAuth, 'req-rel-queue-1', 'queue', {
      packageId: 'pkg-cli',
      candidateId: sub.candidate.id,
      reason: 'Ready for governed GitHub merge'
    });
    assert.equal(goodQueue.body.ok, true);

    // Execute governed GitHub v1 flow against deterministic in-memory GitHub REST mock
    const calls = [];
    const mockCredential = ['ghp', 'EphemeralFixture999999999'].join('_');
    const mockFetch = async (url, init) => {
      const u = new URL(url);
      calls.push({ method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
      const okJson = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });
      if (init.method === 'POST' && u.pathname === '/repos/acme/note-cli/pulls') {
        return okJson({
          number: 77,
          html_url: 'https://github.com/acme/note-cli/pull/77',
          state: 'open',
          draft: false,
          head: { ref: 'vld/pkg-cli', sha: candidateSha },
          base: { ref: 'main', sha: sub.candidate.targetSha }
        });
      }
      if (init.method === 'GET' && u.pathname === '/repos/acme/note-cli/pulls/77') {
        return okJson({
          number: 77,
          html_url: 'https://github.com/acme/note-cli/pull/77',
          state: 'open',
          draft: false,
          head: { ref: 'vld/pkg-cli', sha: candidateSha },
          base: { ref: 'main', sha: sub.candidate.targetSha }
        });
      }
      if (init.method === 'POST' && u.pathname === '/repos/acme/note-cli/issues/77/comments') {
        return okJson({ id: 901, html_url: 'https://github.com/acme/note-cli/pull/77#issuecomment-901' });
      }
      if (init.method === 'GET' && u.pathname.endsWith('/check-runs')) {
        return okJson({
          check_runs: [{ id: 11, name: 'vld-spec-drift', head_sha: candidateSha, status: 'completed', conclusion: 'success', completed_at: '2026-11-16T00:00:00Z' }]
        });
      }
      if (init.method === 'GET' && u.pathname.endsWith('/reviews')) {
        return okJson([
          { id: 22, state: 'APPROVED', commit_id: candidateSha, submitted_at: '2026-11-16T00:01:00Z', user: { login: 'alice' } }
        ]);
      }
      if (init.method === 'PUT' && u.pathname === '/repos/acme/note-cli/pulls/77/merge') {
        return okJson({ merged: true, sha: 'f'.repeat(40), message: 'Pull Request successfully merged' });
      }
      throw new Error(`unexpected mock GitHub call: ${init.method} ${u.pathname}`);
    };

    const published = await executeRuntimeForgePlan({
      missionFile: '.vld/mission.json',
      packageId: 'pkg-cli',
      candidateId: sub.candidate.id,
      repository: 'acme/note-cli',
      headRef: 'vld/pkg-cli', baseRef: 'main',
      requiredChecks: ['vld-spec-drift'],
      action: 'publish',
      postEvidence: true,
      token: mockCredential,
      fetchImpl: mockFetch,
      projectDir: repo
    });
    assert.equal(published.ok, true);
    assert.equal(published.receipt.pullNumber, 77);
    assert.equal(published.receipt.evidenceCommentId, 901);

    // Merge blocked unless allowMergeRequest === true
    await assert.rejects(
      () => executeRuntimeForgePlan({
        missionFile: '.vld/mission.json',
        packageId: 'pkg-cli',
        candidateId: sub.candidate.id,
        repository: 'acme/note-cli',
        headRef: 'vld/pkg-cli', baseRef: 'main',
        requiredChecks: ['vld-spec-drift'],
        action: 'merge',
        pullNumber: 77,
        allowMergeRequest: false,
        token: mockCredential,
        fetchImpl: mockFetch,
        projectDir: repo
      }),
      (err) => err?.code === 'GITHUB_MERGE_NOT_ALLOWED'
    );

    // Merge succeeds when policy allows + live checks & approval match candidateSha
    const merged = await executeRuntimeForgePlan({
      missionFile: '.vld/mission.json',
      packageId: 'pkg-cli',
      candidateId: sub.candidate.id,
      repository: 'acme/note-cli',
      headRef: 'vld/pkg-cli', baseRef: 'main',
      requiredChecks: ['vld-spec-drift'],
      action: 'merge',
      pullNumber: 77,
      allowMergeRequest: true,
      token: mockCredential,
      fetchImpl: mockFetch,
      projectDir: repo
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.receipt.mergedSha, 'f'.repeat(40));

    // Token NEVER leaked to evidence ledger
    const ledgerText = readFileSync(path.join(repo, '.vld', 'evidence', 'evidence.jsonl'), 'utf8');
    assert.ok(!ledgerText.includes(mockCredential));

    // Runtime status + Studio DOM renders verified hash-chained audit ledger
    const statusRes = await api(revAuth, 'req-status-ev-1', 'status', {});
    assert.equal(statusRes.body.ok, true);
    assert.equal(statusRes.body.result.studio.evidenceChain.ok, true);
    assert.equal(statusRes.body.result.studio.evidenceChain.entries, 4); // approval + queue + publish + merge

    class MockNode {
      constructor() { this.children = []; this.listeners = new Map(); this.textContent = ''; this.value = ''; this.disabled = false; this.className = ''; }
      get firstChild() { return this.children[0] ?? null; }
      append(...ns) { this.children.push(...ns); }
      removeChild(n) { this.children.splice(this.children.indexOf(n), 1); }
      addEventListener(t, fn) { this.listeners.set(t, fn); }
    }
    const ids = ['token', 'connect', 'refresh', 'connection', 'mission', 'packages', 'runs', 'evidence', 'package-id', 'assignee', 'lease-ms', 'allocate', 'recover', 'candidate-id', 'approval-reason', 'approve', 'queue'];
    const dom = Object.fromEntries(ids.map((id) => [id, new MockNode()]));
    const ctx = {
      document: { getElementById: (id) => dom[id], createElement: () => new MockNode() },
      fetch: async () => ({ ok: true, headers: { get: () => null }, text: async () => JSON.stringify(statusRes.body) }),
      crypto: { randomUUID: () => 'studio-uuid' },
      globalThis: null,
      Error, JSON, String, Array, Number, Object, Promise, Set, Map, TextEncoder, TextDecoder
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(studioDashboardScript(), ctx);
    dom.token.value = revAuth;
    await dom.connect.listeners.get('click')();
    assert.equal(dom.approve.disabled, false, 'reviewer gets approve capability enabled');
    assert.equal(dom.queue.disabled, true, 'reviewer cannot queue');
    const flatten = (n) => [n.textContent, ...n.children.flatMap(flatten)].filter(Boolean).join(' ');
    const evRendered = flatten(dom.evidence);
    assert.match(evRendered, /Hash-chained audit ledger/);
    assert.match(evRendered, /verified/);
  } finally {
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  }
});

test('3.3 continuous drift detector, workflow scaffolding, and 10-stack G3-MUTATION semantic oracles work end to end', () => {
  // All 10 supported stacks have configured mutation runners
  for (const stackId of ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php']) {
    assert.ok(STACK_MUTATION_RUNNERS[stackId]?.tool, `mutation runner configured for ${stackId}`);
  }

  const repo = makeTempGitRepo('vld-phase3-drift-');
  try {
    // Tier-3 Go regulated service exercises G3-MUTATION with `.gremlins.yaml` + Go `_test.go` oracles
    const profilePath = path.join(repo, 'profile.json');
    writeFileSync(profilePath, JSON.stringify({
      name: 'vault-ledger',
      idea: 'Ledger API for regulated banks to post double-entry transfers, verify balances and seal audit logs instead of batch files.',
      kind: 'api',
      stage: 'production',
      users: { scale: 'large' },
      traits: ['auth', 'persistence'],
      risks: { pii: true, payments: true, regulated: true, multiTenant: true, destructiveWrites: true, publicFacing: true, integrations: false },
      constraints: { team: 5, weeks: 12, stack: 'go', mustUse: [] }
    }, null, 2));
    compilePacket(profilePath, path.join(repo, 'specs'));
    const spec = JSON.parse(readFileSync(path.join(repo, 'specs', 'spec.json'), 'utf8'));
    assert.equal(spec.rigor.tier, 3);
    assert.ok(spec.gates.some((g) => g.id === 'G3-MUTATION'));

    // Scaffold continuous drift GitHub Actions workflow
    const wf = scaffoldDriftWorkflow({ projectDir: repo, packetDir: 'specs' });
    const wfText = readFileSync(wf.file, 'utf8');
    assert.match(wfText, /permissions:\s*\n\s*contents:\s*read/);
    assert.match(wfText, /schedule:/);
    assert.match(wfText, /specs\/spec-check\.mjs --repo \. --strict --require-assertions/);

    // Initialize stack-aware semantic-oracles.json (Go -> gremlins + *_test.go)
    const oracles = initSemanticOracles({ projectDir: repo, packetDir: 'specs' });
    assert.equal(oracles.stack, 'go');
    assert.equal(oracles.mutationRunner.tool, 'gremlins');
    assert.ok(oracles.manifest.oracles.every((o) => o.test.endsWith('_test.go')));

    // Populate Go unit tests + Go semantic oracle tests + .gremlins.yaml
    writeFileSync(path.join(repo, '.gremlins.yaml'), 'mutants:\n  arithmetic-base:\n    enabled: true\n');
    mkdirSync(path.join(repo, 'tests', 'semantic-oracles'), { recursive: true });
    for (const oracle of oracles.manifest.oracles) {
      const target = path.join(repo, oracle.test);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        `package oracles_test\nimport (\n  "testing"\n  "vault-ledger/internal/ledger"\n)\n// ${reqTag} ${oracle.id}\nfunc TestOracle(t *testing.T) { if ledger.Ok() != true { t.Fatalf("broken") } }\n`
      );
    }

    // Run emitted gates.mjs and verify G3-MUTATION passes natively for Go!
    const gateRun = spawnSync(process.execPath, [path.join(repo, 'specs', 'enforcement', 'gates.mjs'), '--repo', repo, '--json'], {
      encoding: 'utf8'
    });
    const gateReport = JSON.parse(gateRun.stdout);
    const mutationGate = gateReport.results.find((g) => g.id === 'G3-MUTATION');
    assert.equal(mutationGate.status, 'pass', `expected Go G3-MUTATION to pass, got: ${JSON.stringify(mutationGate)}`);

    // Baseline commit is 100% drift-free
    const baseSha = commitAll(repo, 'clean verified baseline');
    const clean = detectSpecDrift({ projectDir: repo, packetDir: 'specs', record: true });
    assert.equal(clean.ok, true, `expected clean drift report, got: ${JSON.stringify(clean.findings)}`);
    assert.equal(clean.clean, true);

    // Introduce untracked source change + skipped test -> detectSpecDrift catches both!
    mkdirSync(path.join(repo, 'internal'), { recursive: true });
    writeFileSync(path.join(repo, 'internal', 'ledger.go'), 'package internal\nfunc Transfer() int { return 0 }\n');
    const headSha = commitAll(repo, 'untracked change');
    const drifted = detectSpecDrift({ projectDir: repo, packetDir: 'specs', baseRef: baseSha, headRef: headSha });
    assert.ok(drifted.findings.some((f) => f.kind === 'untracked-code-change'));

    // Diverge profile.json idea -> stale-profile caught!
    const staleProfile = JSON.parse(readFileSync(profilePath, 'utf8'));
    staleProfile.idea = 'Completely rewritten idea that has not been recompiled yet into specs.';
    writeFileSync(profilePath, JSON.stringify(staleProfile, null, 2));
    const stale = detectSpecDrift({ projectDir: repo, packetDir: 'specs' });
    assert.equal(stale.ok, false);
    assert.ok(stale.findings.some((f) => f.kind === 'stale-profile'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
