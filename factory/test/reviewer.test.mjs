import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runReviewerAgent, riskSignalsToFindings, verdictFor, RULES_REVIEWER_MODEL_ID } from '../agents/reviewer.mjs';
import {
  measureDiffRiskSensitivity,
  normalizeModelId,
  prepareReviewPacket,
  requiresHumanReview,
  scanDiffRisks,
  validateReviewReport
} from '../lib/review.mjs';
import { createMission } from '../lib/missions.mjs';
import { createWorkspace } from '../lib/workspaces.mjs';
import { defaultDeliveryPolicy } from '../lib/delivery-policy.mjs';
import { allocateRuntimePackage, initializeRuntime } from '../lib/runtime.mjs';
import {
  queueRuntimeDeliveryCandidate,
  recordRuntimeDeliveryReview,
  approveRuntimeDeliveryCandidate,
  submitRuntimeDeliveryCandidate,
  verifyRuntimeDeliveryCandidate
} from '../lib/runtime-delivery.mjs';
import { runRuntimeAgent } from '../lib/runtime-agent.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { runtimeStatus } from '../lib/runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACTORY = path.dirname(HERE);
const RETRO = path.join(FACTORY, '..', 'examples', 'retro-board');

const ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const REVIEWER = Object.freeze({ role: 'reviewer', id: 'reviewer-beta' });
const RELEASE = Object.freeze({ role: 'release-approver', id: 'release-gamma' });

function fakeAgentPolicy(modelSpec) {
  return {
    schemaVersion: 1,
    id: 'reviewer-fake-agent',
    adapter: 'fake',
    mode: 'write-workspace',
    capabilities: { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: false, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true, credentialAccess: false, gitPush: false, gitMerge: false },
    limits: { durationMs: 1_000, outputBytes: 1_024, retryBudget: 0 },
    environment: { VLD_MODEL_SPEC: modelSpec },
    command: { script: 'succeed', executable: null, args: [] }
  };
}

function cleanCategories() {
  return {
    scope: 'none',
    coverage: 'none',
    failurePaths: 'none',
    assertionStrength: 'none',
    boundaries: 'none',
    reversibility: 'none'
  };
}

const REGULATED_PROFILE = {
  name: 'care-pay',
  idea: 'Clinical payout and billing platform that processes insurance claims and card payments for regulated care providers.',
  kind: 'api',
  stage: 'production',
  users: { scale: 'medium' },
  traits: ['auth', 'persistence'],
  risks: { pii: true, payments: true, regulated: true, multiTenant: true, destructiveWrites: true, publicFacing: true, integrations: true },
  constraints: { team: 4, weeks: 10, stack: 'typescript', mustUse: ['hipaa', 'pci-dss'] }
};

function makeFixture(name, { profileSource = RETRO, rawProfile = null, pkgId = 'review-work' } = {}) {
  const root = fsMktemp(`vld-reviewer-${name}-`);
  const projectDir = path.join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  execFileSync('git', ['-C', projectDir, 'init', '-q']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.email', 'reviewer@example.test']);
  execFileSync('git', ['-C', projectDir, 'config', 'user.name', 'Reviewer Fixture']);
  writeFileSync(path.join(projectDir, 'README.md'), '# review fixture\n');
  execFileSync('git', ['-C', projectDir, 'add', '-A']);
  execFileSync('git', ['-C', projectDir, 'commit', '-q', '-m', 'chore: seed review fixture']);
  mkdirSync(path.join(projectDir, 'specs'), { recursive: true });
  const raw = rawProfile ?? JSON.parse(readFileSync(path.join(profileSource, 'profile.json'), 'utf8'));
  const profile = normalizeProfile(raw);
  const plan = buildPlan(profile, { index: buildIndex() });
  emitPacket(plan, path.join(projectDir, 'specs'), { force: true, packetDir: 'specs' });
  const spec = JSON.parse(readFileSync(path.join(projectDir, 'specs', 'spec.json'), 'utf8'));
  execFileSync('git', ['-C', projectDir, 'add', '-A']);
  execFileSync('git', ['-C', projectDir, 'commit', '-q', '-m', 'chore: seed review packet']);
  const mission = createMission({
    projectDir,
    packetDir: 'specs',
    definition: {
      schemaVersion: 1,
      id: 'delivery-review',
      title: 'Delivery review',
      workPackages: [{
        id: pkgId,
        title: 'Review work',
        requirements: spec.requirements.map((r) => r.id),
        dependsOn: [],
        resourceClaims: { paths: ['src/**'] }
      }]
    }
  });
  const missionFile = path.relative(projectDir, mission.file);
  createWorkspace({ missionFile, packageId: pkgId, projectDir });
  initializeRuntime({ missionFile, projectDir });
  const allocated = allocateRuntimePackage({
    missionFile,
    projectDir,
    packageId: pkgId,
    assignee: { role: 'implementer', id: 'agent-alpha' },
    leaseMs: 30_000
  });
  writeFileSync(path.join(projectDir, 'agent-policy.json'), `${JSON.stringify(fakeAgentPolicy('openai:writer-model'))}\n`);
  writeFileSync(path.join(projectDir, 'delivery-policy.json'), `${JSON.stringify(defaultDeliveryPolicy())}\n`);
  return { root, projectDir, missionFile, spec, pkgId, allocated, requirementIds: spec.requirements.map((r) => r.id) };
}

function fsMktemp(prefix) {
  return execFileSync('mktemp', ['-d', '-t', `${prefix}XXXXXX`], { encoding: 'utf8' }).trim();
}

async function toInReview(fixture, { pkgId = 'review-work' } = {}) {
  const agent = await runRuntimeAgent({
    missionFile: fixture.missionFile,
    packageId: pkgId,
    policyFile: 'agent-policy.json',
    leaseToken: fixture.allocated.leaseToken,
    projectDir: fixture.projectDir
  });
  assert.equal(agent.ok, true);
  const worktrees = execFileSync('git', ['-C', fixture.projectDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  const workspace = worktrees[1];
  assert.equal(typeof workspace, 'string', 'fixture creates exactly one linked worktree');
  const candidateSha = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const submitted = submitRuntimeDeliveryCandidate({
    missionFile: fixture.missionFile,
    packageId: pkgId,
    candidateSha,
    policyFile: 'delivery-policy.json',
    leaseToken: fixture.allocated.leaseToken,
    adapterRunId: agent.agentRun.id,
    projectDir: fixture.projectDir
  });
  const verification = verifyRuntimeDeliveryCandidate({
    missionFile: fixture.missionFile,
    packageId: pkgId,
    policyFile: 'delivery-policy.json',
    projectDir: fixture.projectDir
  });
  assert.equal(verification.verification.outcome, 'passed');
  return { agent, candidate: submitted.candidate, verification, policyFile: 'delivery-policy.json' };
}

function reviewArgs(fixture, ready, overrides = {}) {
  return {
    missionFile: fixture.missionFile,
    packageId: 'review-work',
    candidateId: ready.candidate.id,
    policyFile: ready.policyFile,
    reviewerModelId: 'anthropic:judge-model',
    categories: cleanCategories(),
    verdict: 'approved',
    actor: REVIEWER,
    projectDir: fixture.projectDir,
    ...overrides
  };
}

test('P3.5 review packet isolates spec obligations, diff and diff-risk signals', () => {
  const fixture = makeFixture('packet');
  try {
    const firstReq = fixture.spec.requirements[0].id;
    const diff = [
      '+++ b/tests/list.test.ts',
      `  // @req ${firstReq}`,
      '-  assert.equal(list.filter((i) => i.done).length, 1);',
      '+  assert.ok(list.list()[0].done);',
      '+++ b/src/store.ts',
      '+  const key = process.env.PAYMENTS_MASTER_KEY;'
    ].join('\n');
    const packet = prepareReviewPacket({
      projectDir: fixture.projectDir,
      packetDir: 'specs',
      authorId: 'dev-alpha',
      diffText: diff
    });
    assert.equal(packet.contextIsolated, true);
    assert.equal(packet.authorTranscriptIncluded, false);
    assert.ok(packet.requirements.length > 0);
    assert.ok(packet.requirements.every((r) => /^REQ-(C\d{2,}|\d{3,})$/.test(r.id) && typeof r.statement === 'string'));
    assert.ok(SHA_RE.test(packet.reviewPacketDigest));
    // strict-to-loose assertion swap is flagged even at 1:1 parity
    assert.equal(packet.diffRisks.testWeakening.length, 1);
    assert.equal(packet.diffRisks.testWeakening[0].file, 'tests/list.test.ts');
    assert.ok(packet.diffRisks.newEnvVars.some((e) => e.includes('PAYMENTS_MASTER_KEY')));
    // tautological replacement is flagged too
    const tautology = scanDiffRisks(['+++ b/tests/x.test.ts', '-  assert.equal(total, 42);', '+  assert.ok(true);'].join('\n'));
    assert.equal(tautology.testWeakening.length, 1);
    // escalation reflects the packet profile (retro-board: tier 1, no money/regulated/destructiveWrites)
    assert.equal(packet.humanEscalation.required, false);
  } finally {
    fsRm(fixture.root);
  }
});

test('P3.5 seeded-defect measurement: diff-risk scan catches >= 80% of seeded defects', () => {
  const measured = measureDiffRiskSensitivity();
  assert.equal(measured.total, 10);
  assert.ok(measured.ratio >= 0.8, `seeded-defect sensitivity ${measured.caught}/${measured.total} < 0.8`);
  for (const kind of ['weakened-assertion', 'deleted-test', 'skipped-test', 'new-dependency', 'new-env-read']) {
    const seeds = measured.results.filter((r) => r.kind === kind);
    assert.ok(seeds.length >= 2, `kind ${kind} needs at least two seeds`);
    assert.ok(seeds.every((r) => r.caught), `kind ${kind} has an uncaught seed`);
  }
});

test('P3.5 findings schema is six-category, requirement-cited; verdicts are computed', () => {
  const known = ['REQ-001', 'REQ-002'];
  const finding = (over = {}) => ({ requirement: 'REQ-001', file: 'src/lib.mjs', severity: 'high', summary: 'boundary check dropped', fix: 'Restore the boundary check for REQ-001.', ...over });
  // unknown requirement citation is rejected
  const unknown = validateReviewReport({
    schemaVersion: 1, reviewerId: 'reviewer-beta', reviewerKind: 'agent', sessionIsolated: true,
    verdict: 'changes-requested', categories: { ...cleanCategories(), coverage: [finding({ requirement: 'REQ-999' })] }
  }, { knownRequirements: known });
  assert.equal(unknown.ok, false);
  // unknown severity is rejected
  const badSeverity = validateReviewReport({
    schemaVersion: 1, reviewerId: 'reviewer-beta', reviewerKind: 'agent', sessionIsolated: true,
    verdict: 'changes-requested', categories: { ...cleanCategories(), coverage: [finding({ severity: 'catastrophic' })] }
  }, { knownRequirements: known });
  assert.equal(badSeverity.ok, false);
  // missing category is rejected
  const missing = cleanCategories();
  delete missing.reversibility;
  assert.equal(validateReviewReport({
    schemaVersion: 1, reviewerId: 'reviewer-beta', reviewerKind: 'agent', sessionIsolated: true,
    verdict: 'approved', categories: missing
  }, { knownRequirements: known }).ok, false);
  // cannot approve with high findings
  const approvedHigh = validateReviewReport({
    schemaVersion: 1, reviewerId: 'reviewer-beta', reviewerKind: 'agent', sessionIsolated: true,
    verdict: 'approved', categories: { ...cleanCategories(), coverage: [finding()] }
  }, { knownRequirements: known });
  assert.equal(approvedHigh.ok, false);
  // self-review is rejected at the report layer
  const selfReview = validateReviewReport({
    schemaVersion: 1, reviewerId: 'dev-alpha', reviewerKind: 'agent', sessionIsolated: true,
    verdict: 'approved', categories: cleanCategories()
  }, { authorId: 'dev-alpha' });
  assert.equal(selfReview.ok, false);
  // a valid report passes and counts blocking findings
  const valid = validateReviewReport({
    schemaVersion: 1, reviewerId: 'reviewer-beta', reviewerKind: 'agent', sessionIsolated: true,
    verdict: 'changes-requested', categories: { ...cleanCategories(), coverage: [finding()] }
  }, { knownRequirements: known });
  assert.equal(valid.ok, true);
  assert.equal(valid.blockingFindings, 1);
  // computed verdicts (never negotiated)
  assert.equal(verdictFor({ ...cleanCategories(), coverage: [finding()] }), 'changes-requested');
  assert.equal(verdictFor(cleanCategories(), { humanEscalationRequired: true }), 'escalated-to-human');
  assert.equal(verdictFor(cleanCategories()), 'approved');
});

test('P3.5 reviewer agent: rules mode derives citable findings; model findings are schema-filtered', async () => {
  const fixture = makeFixture('agent');
  try {
    const firstReq = fixture.spec.requirements[0].id;
    const diff = [
      '+++ b/tests/list.test.ts',
      `  // @req ${firstReq}`,
      '-  assert.equal(list.filter((i) => i.done).length, 1);',
      '+  assert.ok(list.list()[0].done);',
      '+++ b/src/store.ts',
      `  // @req ${firstReq}`,
      '+  const key = process.env.PAYMENTS_MASTER_KEY;'
    ].join('\n');
    const packet = prepareReviewPacket({ projectDir: fixture.projectDir, packetDir: 'specs', authorId: 'dev-alpha', diffText: diff });

    // rules mode: deterministic diff-risk reviewer
    const rules = await runReviewerAgent({ packet, provider: 'rules' });
    assert.equal(rules.mode, 'rules');
    assert.equal(rules.reviewerModelId, RULES_REVIEWER_MODEL_ID);
    assert.equal(rules.report.sessionIsolated, true);
    assert.equal(rules.reportCheck.ok, true);
    const strength = rules.report.categories.assertionStrength;
    assert.ok(Array.isArray(strength) && strength.length >= 1);
    assert.equal(strength[0].requirement, firstReq);
    assert.equal(strength[0].severity, 'high');
    assert.equal(rules.verdict, 'changes-requested');
    assert.ok(rules.report.categories.boundaries !== 'none', 'env reads land in boundaries');

    // model mode: invalid canned findings are dropped to warnings, never trusted
    const canned = {
      categories: {
        scope: 'none',
        coverage: [{
          requirement: firstReq,
          file: 'src/store.mjs',
          severity: 'high',
          summary: 'Boundary check dropped in the store commit path.',
          fix: 'Restore the boundary check before writing commits.'
        }],
        failurePaths: 'none',
        assertionStrength: [{
          requirement: firstReq,
          file: 'tests/list.test.mjs',
          severity: 'catastrophic',
          summary: 'bogus severity',
          fix: 'This finding must be dropped by the schema filter.'
        }],
        boundaries: 'none',
        reversibility: 'none'
      }
    };
    const calls = [];
    const transport = async (request) => {
      calls.push(request);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(canned) } }],
          usage: { prompt_tokens: 210, completion_tokens: 45 }
        })
      };
    };
    const modelRun = await runReviewerAgent({
      packet,
      provider: 'openai',
      model: 'judge-model',
      env: { OPENAI_API_KEY: 'changeme-placeholder' },
      transport
    });
    assert.equal(modelRun.mode, 'model');
    assert.equal(modelRun.reviewerModelId, 'openai:judge-model');
    assert.equal(calls.length, 1);
    assert.ok(modelRun.usage.totalTokens > 0, 'usage is captured');
    assert.ok(modelRun.warnings.some((w) => w.includes('dropped')), 'invalid finding becomes a warning');
    const coverage = modelRun.report.categories.coverage;
    assert.ok(Array.isArray(coverage) && coverage.length === 1);
    assert.equal(coverage[0].requirement, firstReq);
    assert.equal(modelRun.report.categories.assertionStrength, 'none', 'invalid finding never enters the report');
    assert.equal(modelRun.verdict, 'changes-requested');
    assert.equal(modelRun.reportCheck.ok, true);
  } finally {
    fsRm(fixture.root);
  }
});

test('P3.5 same-model review is rejected: reviewer must differ from the implementer model', async () => {
  const fixture = makeFixture('self');
  try {
    const ready = await toInReview(fixture);
    assert.equal(ready.agent.agentRun.modelId, 'openai:writer-model', 'implementer model is recorded on the agent run');
    assert.equal(ready.candidate.implementerModelId, 'openai:writer-model', 'implementer model is frozen on the candidate');

    // same provider:model as the implementer -> rejected
    assert.throws(
      () => recordRuntimeDeliveryReview(reviewArgs(fixture, ready, { reviewerModelId: 'openai:writer-model' })),
      (error) => error?.code === 'SELF_REVIEW_FORBIDDEN' && /must differ/.test(error.message)
    );
    // a different reviewer model is recorded with both identities
    const ok = recordRuntimeDeliveryReview(reviewArgs(fixture, ready, { reviewerModelId: 'Anthropic:Judge-Model' }));
    assert.equal(ok.review.reviewerModelId, 'anthropic:judge-model');
    assert.equal(ok.review.implementerModelId, 'openai:writer-model');
    assert.equal(ok.review.verdict, 'approved');
  } finally {
    fsRm(fixture.root);
  }
});

test('P3.5 high or critical findings block the delivery queue; clean reviews queue', async () => {
  // blocking finding -> queue refused even after approval
  const blockedFixture = makeFixture('blocked');
  try {
    const ready = await toInReview(blockedFixture);
    const firstReq = blockedFixture.spec.requirements[0].id;
    recordRuntimeDeliveryReview(reviewArgs(blockedFixture, ready, {
      reviewerModelId: 'anthropic:judge-model',
      categories: {
        ...cleanCategories(),
        assertionStrength: [{
          requirement: firstReq,
          file: 'src/lib.mjs',
          severity: 'high',
          summary: 'Asserted behaviour replaced with an unconditional success check.',
          fix: 'Restore the strict assertion that exercises the requirement.'
        }]
      },
      verdict: 'changes-requested'
    }));
    approveRuntimeDeliveryCandidate({
      missionFile: blockedFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: REVIEWER,
      reason: 'Approved despite findings to prove the queue still refuses.',
      projectDir: blockedFixture.projectDir
    });
    assert.throws(
      () => queueRuntimeDeliveryCandidate({
        missionFile: blockedFixture.missionFile,
        packageId: 'review-work',
        candidateId: ready.candidate.id,
        policyFile: ready.policyFile,
        actor: RELEASE,
        projectDir: blockedFixture.projectDir
      }),
      (error) => error?.code === 'REVIEW_FINDINGS_BLOCK'
    );
  } finally {
    fsRm(blockedFixture.root);
  }

  // clean review -> approve -> queued
  const cleanFixture = makeFixture('clean');
  try {
    const ready = await toInReview(cleanFixture);
    recordRuntimeDeliveryReview(reviewArgs(cleanFixture, ready, { reviewerModelId: 'anthropic:judge-model' }));
    approveRuntimeDeliveryCandidate({
      missionFile: cleanFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: REVIEWER,
      reason: 'Independent review approved; candidate accepted.',
      projectDir: cleanFixture.projectDir
    });
    const queued = queueRuntimeDeliveryCandidate({
      missionFile: cleanFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: RELEASE,
      projectDir: cleanFixture.projectDir
    });
    assert.equal(queued.queue.candidateId, ready.candidate.id);
    const kinds = runtimeStatus({ missionFile: cleanFixture.missionFile, projectDir: cleanFixture.projectDir }).delivery
      .map((entry) => ['candidate', 'verification', 'review', 'approval', 'queue'].find((key) => key in entry));
    assert.deepEqual(kinds, ['candidate', 'verification', 'review', 'approval', 'queue']);
  } finally {
    fsRm(cleanFixture.root);
  }
});

test('P3.5 escalation packets need an independent review and human sign-off', async () => {
  // regulated care-pay profile: production + regulated risks + hipaa/pci-dss -> rigor tier >= 2
  // sign-off before the review: REVIEW_REQUIRED, then a late review: HUMAN_SIGNOFF_REQUIRED
  const lateFixture = makeFixture('late', { rawProfile: REGULATED_PROFILE });
  try {
    const ready = await toInReview(lateFixture);
    assert.equal(requiresHumanReview(lateFixture.spec).required, true, 'regulated care-pay must demand human sign-off');
    approveRuntimeDeliveryCandidate({
      missionFile: lateFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: REVIEWER,
      reason: 'Release sign-off recorded before the independent review.',
      projectDir: lateFixture.projectDir
    });
    assert.throws(
      () => queueRuntimeDeliveryCandidate({
        missionFile: lateFixture.missionFile,
        packageId: 'review-work',
        candidateId: ready.candidate.id,
        policyFile: ready.policyFile,
        actor: RELEASE,
        projectDir: lateFixture.projectDir
      }),
      (error) => error?.code === 'REVIEW_REQUIRED'
    );
    const lateReview = recordRuntimeDeliveryReview(reviewArgs(lateFixture, ready, {
      reviewerModelId: 'anthropic:judge-model',
      verdict: 'escalated-to-human'
    }));
    assert.equal(lateReview.review.requiresHumanSignoff, true);
    assert.throws(
      () => queueRuntimeDeliveryCandidate({
        missionFile: lateFixture.missionFile,
        packageId: 'review-work',
        candidateId: ready.candidate.id,
        policyFile: ready.policyFile,
        actor: RELEASE,
        projectDir: lateFixture.projectDir
      }),
      (error) => error?.code === 'HUMAN_SIGNOFF_REQUIRED'
    );
  } finally {
    fsRm(lateFixture.root);
  }

  // review -> approve (sign-off after review) -> queued
  const orderedFixture = makeFixture('ordered', { rawProfile: REGULATED_PROFILE });
  try {
    const ready = await toInReview(orderedFixture);
    const review = recordRuntimeDeliveryReview(reviewArgs(orderedFixture, ready, {
      reviewerModelId: 'anthropic:judge-model',
      verdict: 'escalated-to-human'
    }));
    assert.equal(review.review.requiresHumanSignoff, true);
    assert.equal(review.review.blockingFindings, 0);
    approveRuntimeDeliveryCandidate({
      missionFile: orderedFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: REVIEWER,
      reason: 'Regulated packet reviewed; release sign-off recorded after the review.',
      projectDir: orderedFixture.projectDir
    });
    const queued = queueRuntimeDeliveryCandidate({
      missionFile: orderedFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: RELEASE,
      projectDir: orderedFixture.projectDir
    });
    assert.equal(queued.queue.candidateId, ready.candidate.id);
    const kinds = runtimeStatus({ missionFile: orderedFixture.missionFile, projectDir: orderedFixture.projectDir }).delivery
      .map((entry) => ['candidate', 'verification', 'review', 'approval', 'queue'].find((key) => key in entry));
    assert.deepEqual(kinds, ['candidate', 'verification', 'review', 'approval', 'queue']);
  } finally {
    fsRm(orderedFixture.root);
  }

  // human sign-off embedded in the review also satisfies the gate
  const signedFixture = makeFixture('signed', { rawProfile: REGULATED_PROFILE });
  try {
    const ready = await toInReview(signedFixture);
    approveRuntimeDeliveryCandidate({
      missionFile: signedFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: REVIEWER,
      reason: 'Provisional acceptance pending the signed independent review.',
      projectDir: signedFixture.projectDir
    });
    recordRuntimeDeliveryReview(reviewArgs(signedFixture, ready, {
      reviewerModelId: 'anthropic:judge-model',
      verdict: 'escalated-to-human',
      humanSignoff: { reviewerId: 'release-gamma', reason: 'Verified payout boundary and rollback plan against spec.json.' }
    }));
    const queued = queueRuntimeDeliveryCandidate({
      missionFile: signedFixture.missionFile,
      packageId: 'review-work',
      candidateId: ready.candidate.id,
      policyFile: ready.policyFile,
      actor: RELEASE,
      projectDir: signedFixture.projectDir
    });
    assert.equal(queued.queue.candidateId, ready.candidate.id);
  } finally {
    fsRm(signedFixture.root);
  }
});

function fsRm(dir) {
  try {
    execFileSync('rm', ['-rf', dir]);
  } catch {
    // best effort
  }
}
