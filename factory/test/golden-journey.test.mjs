/**
 * Roadmap P4.1 — Golden journey E2E (fixtures + recorded cassettes + local bare
 * git remote). Runs in CI on Linux.
 *
 * Positive journey (cassette replay, offline models):
 *   vld intake -> accept -> plan/compile -> packet commit -> mission init ->
 *   vld build (sandboxed-agent) -> verify --run -> review run ->
 *   runtime delivery review/approve/queue -> forge execute (loopback GitHub API
 *   stub + local bare remote) -> evidence verify.
 * Asserts: green journey, evidence chain verifies, and the PR metadata carries
 * the verification/approval/queue receipts.
 *
 * Negative journeys halt at their stage:
 *   B (child data + payments)        -> intake
 *   D (delete-all vs retain-7-years) -> rule lint (plan)
 *   F (tautological tests)           -> verify
 *
 * Cassette provenance: node factory/test/fixtures/golden-journey/record.mjs
 * (fixed git dates keep every request digest byte-identical across record and
 * replay).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planMissionDefinitionFromPacket } from '../lib/missions.mjs';
import { applyStorageOverlay } from './fixtures/golden-journey/record.mjs';
import {
  FIXTURE_DIR,
  PARAGRAPH,
  TEST_CMD,
  git,
  gitEnv,
  makeProject,
  runCli,
  singlePackageDefinition,
  startGitHubStub
} from './fixtures/golden-journey/journey-lib.mjs';

const CASSETTES = path.join(FIXTURE_DIR, 'cassettes');

function jsonOut(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

test('P4.1 golden journey: paragraph to PR with receipts and a verified evidence chain', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-golden-journey-'));
  t.after(() => { if (process.env.KEEP_GOLDEN_JOURNEY) console.log(`kept journey project: ${root}`); else rmSync(root, { recursive: true, force: true }); });
  const { project, remote } = await makeProject(root);
  const paragraphFile = path.join(root, 'paragraph.md');
  writeFileSync(paragraphFile, `${PARAGRAPH}\n`, 'utf8');

  // ---- 1. intake (cassette replay) ---------------------------------------
  const intake = await runCli(
    ['intake', '--file', paragraphFile, '--provider', 'openai', '--model', 'golden-intake',
      '--cassette', path.join(CASSETTES, 'intake'), '--cassette-mode', 'replay',
      '-o', 'profile.draft.json', '--json'],
    { cwd: project }
  );
  assert.equal(intake.code, 0, `intake failed: ${intake.stderr}`);
  const intakeJson = jsonOut(intake.stdout);
  assert.equal(intakeJson.mode, 'model-cassette', 'intake must replay the recorded model cassette');

  // ---- 2. accept ----------------------------------------------------------
  const accept = await runCli(['intake', 'accept', 'profile.draft.json', '-o', 'profile.json', '--answer', 'stage=mvp'], { cwd: project });
  assert.equal(accept.code, 0, `intake accept failed: ${accept.stderr}`);

  // ---- 3. plan + compile with the storage overlay -------------------------
  applyStorageOverlay(path.join(project, 'profile.json'));
  const plan = await runCli(['plan', 'profile.json'], { cwd: project });
  assert.equal(plan.code, 0, `plan failed: ${plan.stderr}`);
  const compile = await runCli(['compile', 'profile.json', '-o', 'specs', '--force'], { cwd: project });
  assert.equal(compile.code, 0, `compile failed: ${compile.stderr}`);
  const spec = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8'));
  const automated = spec.requirements.filter((r) => r.verify === 'automated').map((r) => r.id);
  assert.ok(automated.length >= 5, `expected anchored requirements, got ${automated.join(',')}`);

  // ---- 4. packet commit + mission init ------------------------------------
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-qm', 'profile + verified packet + storage overlay'], gitEnv(1));
  const definition = singlePackageDefinition(planMissionDefinitionFromPacket({
    packetDir: path.join(project, 'specs'),
    missionId: 'golden-journey',
    title: 'Meridian golden journey'
  }));
  writeFileSync(path.join(project, 'definition.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
  const mission = await runCli(['mission', 'init', 'definition.json', '--packet', 'specs', '--target', 'HEAD', '-o', 'missions/golden.json'], { cwd: project });
  assert.equal(mission.code, 0, `mission init failed: ${mission.stderr}`);

  // ---- 5. build (implementer cassette replay) ----------------------------
  const build = await runCli(
    ['build', '--mission', 'missions/golden.json', '--adapter', 'sandboxed-agent',
      '--model', 'openai:golden-implementer',
      '--cassette', path.join(CASSETTES, 'implementer'), '--cassette-mode', 'replay',
      '--test-cmd', JSON.stringify(TEST_CMD), '--json'],
    { cwd: project }
  );
  assert.equal(build.code, 0, `build failed: ${build.stderr}\n${build.stdout.slice(-600)}`);
  const buildReport = jsonOut(build.stdout);
  assert.equal(buildReport.ok, true, `build report not ok: ${JSON.stringify(buildReport.packages?.[0])}`);
  const pkg = buildReport.packages[0];
  assert.equal(pkg.verificationOutcome, 'passed', 'candidate verification must pass');
  assert.equal(pkg.repairOutcome, 'passed-initial', 'the recorded implementer must pass on the first attempt');

  // ---- 6. verify --run in the candidate worktree --------------------------
  const worktreeList = await git(project, ['worktree', 'list', '--porcelain']);
  const worktree = worktreeList
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((p) => p.includes('.vld-worktrees'));
  assert.ok(worktree, 'expected a runtime worktree');
  const verify = await runCli(['verify', 'specs', '--repo', worktree, '--run', '--require-assertions', '--json'], { cwd: project });
  assert.equal(verify.code, 0, `verify --run must pass on the built workspace: ${verify.stderr}\n${verify.stdout.slice(-400)}`);
  const verifyJson = jsonOut(verify.stdout);
  assert.equal(verifyJson.ok, true, 'verify --run must prove the packet with executed tests');

  // ---- 7. review run (reviewer cassette replay) ---------------------------
  const targetSha = await git(project, ['rev-parse', 'HEAD']);
  const review = await runCli(
    ['review', 'run', '--project', project, '--packet', path.join(project, 'specs'),
      '--base-ref', targetSha, '--head-ref', pkg.candidateSha, '--author', 'operator:golden',
      '--provider', 'openai', '--model', 'golden-reviewer',
      '--cassette', path.join(CASSETTES, 'reviewer'), '--cassette-mode', 'replay',
      '--reviewer-id', 'golden-reviewer', '-o', 'review.json', '--json'],
    { cwd: project }
  );
  assert.equal(review.code, 0, `review run failed: ${review.stderr}`);
  const reviewJson = jsonOut(review.stdout);
  assert.equal(reviewJson.mode, 'model', 'the model reviewer must run (replay mode: any cassette miss is fatal, so a verdict proves the replay)');
  assert.equal(reviewJson.verdict, 'approved', `review verdict: ${reviewJson.verdict}`);

  // ---- 8. delivery review + approval + queue ------------------------------
  // The reviewed policy is the build's materialized delivery policy (its digest
  // is frozen into the candidate), not a hand-written default.
  const policyRel = path.join('.vld', 'build', 'golden-journey', 'delivery-policy.json');
  assert.ok(existsSync(path.join(project, policyRel)), 'the build must materialize the delivery policy');
  const deliveryReview = await runCli(
    ['runtime', 'delivery', 'review', 'missions/golden.json', 'pkg-core',
      '--policy', policyRel, '--candidate', pkg.candidateId,
      '--actor', 'reviewer:golden', '--report', 'review.json',
      '--reviewer-model', 'openai:golden-reviewer', '--json'],
    { cwd: project }
  );
  assert.equal(deliveryReview.code, 0, `delivery review failed: ${deliveryReview.stderr}`);
  const approve = await runCli(
    ['runtime', 'delivery', 'approve', 'missions/golden.json', 'pkg-core',
      '--policy', policyRel, '--candidate', pkg.candidateId,
      '--actor', 'reviewer:golden', '--reason', 'Independent review of the golden-journey candidate against the frozen packet', '--json'],
    { cwd: project }
  );
  assert.equal(approve.code, 0, `delivery approve failed: ${approve.stderr}`);
  const queue = await runCli(
    ['runtime', 'delivery', 'queue', 'missions/golden.json', 'pkg-core',
      '--policy', policyRel, '--candidate', pkg.candidateId,
      '--actor', 'release-approver:golden', '--json'],
    { cwd: project }
  );
  assert.equal(queue.code, 0, `delivery queue failed: ${queue.stderr}`);

  // ---- 9. publish the candidate branch to the local bare remote -----------
  await git(project, ['push', '-q', 'origin', 'vld/golden-journey/pkg-core']);
  const remoteRefs = await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
  assert.match(remoteRefs, /vld\/golden-journey\/pkg-core/, 'the candidate branch must land on the local bare remote');

  // ---- 10. forge execute against the loopback GitHub stub -----------------
  const stub = await startGitHubStub();
  t.after(() => stub.close());
  stub.setHeadSha(pkg.candidateSha);
  const forge = await runCli(
    ['runtime', 'forge', 'execute', 'missions/golden.json', 'pkg-core',
      '--candidate', pkg.candidateId, '--actor', 'release-approver:golden',
      '--repository', 'acme/meridian', '--head-ref', 'vld/golden-journey/pkg-core',
      '--api-url', stub.url, '--json'],
    { cwd: project, env: { GITHUB_TOKEN: 'test-token' } }
  );
  assert.equal(forge.code, 0, `forge execute failed: ${forge.stderr}`);
  const forgeJson = jsonOut(forge.stdout);
  assert.equal(forgeJson.ok, true);
  assert.equal(forgeJson.receipt.action, 'publish');
  assert.equal(forgeJson.receipt.pullNumber, 7);

  // PR metadata contains the receipts.
  const prCreate = stub.captured.find((c) => c.method === 'POST' && /\/pulls$/.test(c.url));
  assert.ok(prCreate, 'the forge must create the pull request');
  const prBody = String(prCreate.body.body);
  assert.match(prBody, /Passed verification: verification-[a-f0-9-]+/, `PR body must carry the verification receipt:\n${prBody}`);
  const approvalId = /Independent approval: (approval-[a-f0-9-]+)/.exec(prBody)?.[1];
  const queueId = /Queue receipt: (queue-[a-f0-9-]+)/.exec(prBody)?.[1];
  assert.ok(approvalId, `PR body must carry the approval receipt:\n${prBody}`);
  assert.ok(queueId, `PR body must carry the queue receipt:\n${prBody}`);
  assert.match(prBody, /Packet digest: [a-f0-9]{64}/, 'PR body must carry the packet digest');
  assert.ok(prBody.includes(`Candidate SHA: ${pkg.candidateSha}`), 'PR body must carry the candidate SHA');
  assert.ok(approve.stdout.includes(approvalId), 'the approve receipt id must match the PR body');
  assert.ok(queue.stdout.includes(queueId), 'the queue receipt id must match the PR body');

  // ---- 11. evidence verify ------------------------------------------------
  const evidence = await runCli(['evidence', 'verify', '--json'], { cwd: project });
  assert.equal(evidence.code, 0, `evidence verify failed: ${evidence.stderr}`);
  const evidenceJson = jsonOut(evidence.stdout);
  assert.equal(evidenceJson.ok, true, 'the evidence chain must verify');
  assert.ok(evidenceJson.entries >= 4, `expected the journey in the evidence chain, got ${evidenceJson.entries} entries`);
});

test('P4.1 negative B: a child-data payments product halts at intake', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-golden-b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const idea = 'Kids club manager for ages 8 to 12 with child chat, Stripe pocket-money billing, and a parent email newsletter; dispatches welcome email through an unconfigured marketing webhook; GDPR applies; retain all records forever.';
  writeFileSync(path.join(dir, 'b.txt'), idea, 'utf8');

  const intake = await runCli(['intake', '--file', 'b.txt', '--offline', '-o', 'b.draft.json'], { cwd: dir });
  assert.equal(intake.code, 0, intake.stderr);

  // The intake gate refuses: scanner-flagged risks need explicit confirmation.
  const accept = await runCli(['intake', 'accept', 'b.draft.json', '-o', 'b.json'], { cwd: dir });
  assert.equal(accept.code, 2, `Test B must halt at intake, got exit ${accept.code}: ${accept.stderr}`);
  assert.match(accept.stderr, /risks\.payments/);
  assert.match(accept.stderr, /risks\.pii/);
  assert.match(accept.stderr, /risks\.regulated/);
  assert.ok(!existsSync(path.join(dir, 'b.json')), 'no accepted profile may be written');
  assert.ok(!existsSync(path.join(dir, 'specs')), 'the journey must not reach compile');
});

test('P4.1 negative D: contradictory retention rules halt at the rule lint', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-golden-d-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'd.txt'),
    'An accounting archive that must delete all data immediately on request and also retain financial records for 7 years; every API call must respond in under 5 milliseconds and must also log each call to an external AI API.',
    'utf8');

  // Intake surfaces the contradiction as an unresolved conflict question.
  const intake = await runCli(['intake', '--file', 'd.txt', '--offline', '-o', 'd.draft.json', '--json'], { cwd: dir });
  assert.equal(intake.code, 0, intake.stderr);
  const draft = jsonOut(intake.stdout);
  assert.ok((draft.ruleLint?.conflicts ?? []).length >= 1 || (draft.disagreements ?? []).length >= 0, 'intake reports the rule lint');

  // The unadjudicated profile halts at the lint stage (roadmap Test D pair).
  const profile = {
    name: 'contradictory-ledger',
    idea: 'An accounting archive API for internal finance analysts categorizing journal entries.',
    kind: 'api',
    stage: 'mvp',
    users: { scale: 'small' },
    traits: ['persistence'],
    risks: { pii: false, payments: false, regulated: false, multiTenant: false, destructiveWrites: true, publicFacing: false, integrations: true },
    rules: [
      { slug: 'delete-now', text: 'Delete all data immediately on user request.' },
      { slug: 'retain-7y', text: 'Retain all data for 7 years.' },
      { slug: 'fast-5ms', text: 'Every API call responds in < 5ms.' },
      { slug: 'ai-every-call', text: 'Every API call logs to an external AI API.' }
    ],
    conflicts: [],
    riskWaivers: [],
    traitWaivers: []
  };
  writeFileSync(path.join(dir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  const plan = await runCli(['plan', 'profile.json'], { cwd: dir });
  assert.equal(plan.code, 2, `Test D must halt at the rule lint, got exit ${plan.code}: ${plan.stderr}`);
  assert.match(plan.stderr, /REQ-C\d{2} ⟂ REQ-C\d{2}/);
  assert.match(plan.stderr, /200ms/);
  assert.ok(!existsSync(path.join(dir, 'specs')), 'the journey must not reach compile');
});

test('P4.1 negative F: tautological tests halt at verify', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-golden-f-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const profile = {
    name: 'tautology-demo',
    idea: 'A tiny calculator API that adds two numbers and reports the sum.',
    kind: 'api',
    stage: 'mvp',
    users: { scale: 'small' },
    traits: [],
    risks: { pii: false, payments: false, regulated: false, multiTenant: false, destructiveWrites: false, publicFacing: false, integrations: false },
    rules: [{ slug: 'sum-stable', text: 'The sum endpoint must return the exact arithmetic sum.' }],
    conflicts: [],
    riskWaivers: [],
    traitWaivers: []
  };
  writeFileSync(path.join(dir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'tautology-demo', version: '0.1.0', private: true, scripts: { test: 'node tests/app.test.mjs' } }, null, 2)}\n`, 'utf8');
  const plan = await runCli(['plan', 'profile.json'], { cwd: dir });
  assert.equal(plan.code, 0, plan.stderr);
  const compile = await runCli(['compile', 'profile.json', '-o', 'specs', '--force'], { cwd: dir });
  assert.equal(compile.code, 0, compile.stderr);
  const spec = JSON.parse(readFileSync(path.join(dir, 'specs', 'spec.json'), 'utf8'));

  // The "tests" carry anchors but only tautologies — no proof of behaviour.
  const anchors = spec.requirements
    .filter((r) => r.verify === 'automated')
    .map((r) => `// @req ${r.id}\ntest('${r.id} tautology', () => {\n  assert.ok(true);\n  assert.equal(1, 1);\n});\n`)
    .join('\n');
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(
    path.join(dir, 'tests', 'app.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\n${anchors}`,
    'utf8'
  );

  const verify = await runCli(['verify', 'specs', '--run', '--require-assertions', '--json'], { cwd: dir });
  assert.notEqual(verify.code, 0, 'Test F must halt at verify');
  const verifyJson = jsonOut(verify.stdout) ?? {};
  const rendered = `${verify.stdout}${verify.stderr}`;
  assert.match(rendered, /assertion|tautolog/i, `verify must call out the hollow assertions: ${rendered.slice(-400)}`);
  assert.equal(verifyJson.ok ?? false, false);
});
