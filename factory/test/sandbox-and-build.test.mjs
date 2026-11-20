/**
 * Phase 2 Autonomous Execution Engine tests (ADR 0011, roadmap 2.1–2.7):
 *   2.1 ADR 0011 & honest experimental boundary documentation
 *   2.2 Sandbox backends, seccomp-default.json, receipt integrity & 8 live conformance probes
 *   2.3 Sandboxed CLI / ACP v2 agent policies & resource-claim receipt gates
 *   2.4 Receipt-gated candidate submission & sandboxed v2 integration verifier
 *   2.5 Failure classification & bounded repair loop (converge, stall, non-retryable halt)
 *   2.6 Mission rebase across target commits and requirement additions/retirements
 *   2.7 End-to-end `vld build` with real sandboxed execution and self-repair convergence
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultSandboxedCliPolicy, validateAgentPolicy } from '../lib/agent-policy.mjs';
import { runBuild } from '../lib/build.mjs';
import { defaultSandboxedDeliveryPolicy, validateDeliveryPolicy } from '../lib/delivery-policy.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { digest } from '../lib/extension-utils.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { createMission, planMissionDefinitionFromPacket, rebaseMission, validateMissionDefinition } from '../lib/missions.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { buildRepairPrompt, classifyVerificationFailures, runRepairLoop } from '../lib/repair.mjs';
import { allocateRuntimePackage, initializeRuntime } from '../lib/runtime.mjs';
import { runRuntimeAgent } from '../lib/runtime-agent.mjs';
import { submitRuntimeDeliveryCandidate, verifyRuntimeDeliveryCandidateAsync } from '../lib/runtime-delivery.mjs';
import {
  detectSandboxBackends,
  runSandboxConformance,
  SECCOMP_DEFAULT_PATH,
  verifySandboxReceipt
} from '../lib/sandbox/index.mjs';
import { createWorkspace } from '../lib/workspaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = buildIndex();

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createGitProject({ name = 'tiny-cli', stage = 'prototype', rules = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-phase2-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'VLD Test']);
  git(root, ['config', 'user.email', 'vld@test.local']);
  const rawProfile = {
    name,
    idea: 'A command-line checksum tool that validates release tarballs and writes signed manifests.',
    kind: 'cli',
    stage,
    traits: [],
    risks: {},
    constraints: { stack: 'javascript' },
    ...(rules.length ? { rules } : {})
  };
  writeFileSync(path.join(root, 'profile.json'), `${JSON.stringify(rawProfile, null, 2)}\n`, 'utf8');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.mjs'), 'export const hashArchive = (s) => `sha256:${s.length}`;\n', 'utf8');
  const plan = buildPlan(normalizeProfile(rawProfile), { index: INDEX });
  emitPacket(plan, path.join(root, 'specs'), { force: true, packetDir: 'specs' });
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'initial']);
  return { root, rawProfile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('2.1 & 2.2 ADR 0011, seccomp profile, and all 8 live sandbox conformance probes pass', async () => {
  assert.ok(existsSync(path.join(ROOT, 'docs', 'adr', '0011-sandboxed-execution-and-autonomous-build.md')));
  const seccomp = JSON.parse(readFileSync(SECCOMP_DEFAULT_PATH, 'utf8'));
  assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO');
  const deniedRule = seccomp.syscalls.find((s) => s.action === 'SCMP_ACT_ERRNO' && s.names.includes('ptrace'));
  assert.ok(deniedRule, 'seccomp explicitly blocks ptrace');
  for (const dangerous of ['mount', 'pivot_root', 'bpf', 'unshare', 'setns', 'connect', 'init_module']) {
    assert.ok(deniedRule.names.includes(dangerous), `seccomp blocks ${dangerous}`);
  }

  const probe = detectSandboxBackends({ refresh: true });
  assert.ok(probe.preferred, 'at least one sandbox backend is available');

  const activeConformance = await runSandboxConformance({ backend: 'auto' });
  assert.equal(activeConformance.total, 8);
  assert.equal(activeConformance.passed, 8, JSON.stringify(activeConformance.probes, null, 2));
  assert.equal(activeConformance.ok, true);

  // If the preferred backend was OS-level (e.g. linux-ns), also test portable node-permission.
  const nodePerm = probe.backends.find((b) => b.id === 'node-permission');
  if (nodePerm?.available && activeConformance.backend !== 'node-permission') {
    const portable = await runSandboxConformance({ backend: 'node-permission' });
    assert.equal(portable.passed, 8, JSON.stringify(portable.probes, null, 2));
    assert.equal(portable.ok, true);
  }
});

test('2.3 & 2.4 sandboxed-cli v2 policy, resource-claim gate, receipt-gated candidate submission & sandboxed verifier', async (t) => {
  // v1 local-process remains strictly prohibited from write-workspace.
  const badV1 = validateAgentPolicy({
    ...defaultSandboxedCliPolicy(),
    schemaVersion: 1,
    adapter: 'local-process'
  });
  assert.equal(badV1.ok, false);

  // v2 sandboxed-cli & sandboxed-acp validate cleanly and deny network/credentials.
  const goodCli = validateAgentPolicy(defaultSandboxedCliPolicy());
  assert.equal(goodCli.ok, true, goodCli.errors.join('; '));
  const goodAcp = validateAgentPolicy({ ...defaultSandboxedCliPolicy(), id: 'sandboxed-acp-v2', adapter: 'sandboxed-acp' });
  assert.equal(goodAcp.ok, true, goodAcp.errors.join('; '));
  const badNet = validateAgentPolicy({
    ...defaultSandboxedCliPolicy(),
    capabilities: { ...defaultSandboxedCliPolicy().capabilities, network: true }
  });
  assert.equal(badNet.ok, false);

  const goodDelivery = validateDeliveryPolicy(defaultSandboxedDeliveryPolicy({
    commands: [{ id: 'unit-tests', executable: process.execPath, args: ['tests/unit.test.mjs'], timeoutMs: 15_000 }]
  }));
  assert.equal(goodDelivery.ok, true, goodDelivery.errors.join('; '));

  const proj = createGitProject({ stage: 'mvp' });
  t.after(proj.cleanup);

  // Commit an out-of-worktree-safe helper agent script inside `tools/` before creating mission.
  const reqTag = ['@', 'req'].join('');
  const spec = JSON.parse(readFileSync(path.join(proj.root, 'specs', 'spec.json'), 'utf8'));
  const autoReqs = spec.requirements.filter((r) => r.verify === 'automated').map((r) => r.id);
  mkdirSync(path.join(proj.root, 'tools'), { recursive: true });
  writeFileSync(
    path.join(proj.root, 'tools', 'good-agent.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.mkdirSync('tests', { recursive: true });",
      `const anchors = ${JSON.stringify(autoReqs)}.map((id) => '// ${reqTag} ' + id).join('\\n');`,
      "fs.writeFileSync('tests/unit.test.mjs', `import test from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { hashArchive } from '../src/index.mjs';\\n${anchors}\\ntest('hashes archive', () => {\\n  assert.equal(hashArchive('abc'), 'sha256:3');\\n});\\n`);"
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    path.join(proj.root, 'tools', 'rogue-agent.mjs'),
    "import fs from 'node:fs';\nfs.writeFileSync('README-ROGUE.md', 'outside resourceClaims!\\n');\n",
    'utf8'
  );
  git(proj.root, ['add', '-A']);
  git(proj.root, ['commit', '-qm', 'add agent fixtures']);

  const allReqs = spec.requirements.map((r) => r.id);
  const created = createMission({
    definition: {
      schemaVersion: 1,
      id: 'sandboxed-mission',
      title: 'Test receipt-gated sandboxed execution',
      workPackages: [
        {
          id: 'pkg-good',
          title: 'In-bounds implementation',
          requirements: allReqs.slice(0, Math.ceil(allReqs.length / 2)),
          dependsOn: [],
          resourceClaims: { paths: ['src/**', 'tests/**'] }
        },
        {
          id: 'pkg-rogue',
          title: 'Out-of-bounds mutation test',
          requirements: allReqs.slice(Math.ceil(allReqs.length / 2)),
          dependsOn: [],
          resourceClaims: { paths: ['src/**'] }
        }
      ]
    },
    packetDir: 'specs',
    projectDir: proj.root,
    force: true
  });
  const missionRel = path.relative(proj.root, created.file);
  initializeRuntime({ missionFile: missionRel, projectDir: proj.root });

  // Rogue agent mutates README-ROGUE.md outside `src/**` -> blocked by receipt gate!
  createWorkspace({ missionFile: missionRel, packageId: 'pkg-rogue', projectDir: proj.root });
  const rogueLease = allocateRuntimePackage({ missionFile: missionRel, packageId: 'pkg-rogue', assignee: { role: 'implementer', id: 'bot-rogue' }, projectDir: proj.root }).leaseToken;
  writeFileSync(
    path.join(proj.root, 'rogue-policy.json'),
    `${JSON.stringify(defaultSandboxedCliPolicy({ executable: process.execPath, args: ['tools/rogue-agent.mjs'] }), null, 2)}\n`
  );
  const rogueRun = await runRuntimeAgent({ missionFile: missionRel, packageId: 'pkg-rogue', policyFile: 'rogue-policy.json', leaseToken: rogueLease, projectDir: proj.root });
  assert.equal(rogueRun.ok, false, 'out-of-scope write must block changes_ready');
  assert.equal(rogueRun.status.packages.find((p) => p.id === 'pkg-rogue').state, 'blocked');

  // Good agent writes only `tests/unit.test.mjs` inside `tests/**` -> reaches changes_ready with sandbox receipt!
  const goodWs = createWorkspace({ missionFile: missionRel, packageId: 'pkg-good', projectDir: proj.root }).allocation;
  const goodLease = allocateRuntimePackage({ missionFile: missionRel, packageId: 'pkg-good', assignee: { role: 'implementer', id: 'bot-good' }, projectDir: proj.root }).leaseToken;
  writeFileSync(
    path.join(proj.root, 'good-policy.json'),
    `${JSON.stringify(defaultSandboxedCliPolicy({ executable: process.execPath, args: ['tools/good-agent.mjs'] }), null, 2)}\n`
  );
  const goodRun = await runRuntimeAgent({ missionFile: missionRel, packageId: 'pkg-good', policyFile: 'good-policy.json', leaseToken: goodLease, projectDir: proj.root });
  assert.equal(goodRun.ok, true);
  assert.ok(goodRun.agentRun.sandbox?.receiptDigest);
  assert.deepEqual(goodRun.agentRun.sandbox.changedPaths, ['tests/unit.test.mjs']);

  // Delivery policy v2 requires receipt + enforces unattested-edit rejection + runs sandboxed verifier!
  const delPol = defaultSandboxedDeliveryPolicy({
    commands: [{ id: 'unit-tests', executable: process.execPath, args: ['tests/unit.test.mjs'], timeoutMs: 15_000 }]
  });
  delPol.verification.verifyGates = false;
  writeFileSync(path.join(proj.root, 'delivery-v2.json'), `${JSON.stringify(delPol, null, 2)}\n`);

  git(goodWs.worktree, ['add', '-A']);
  git(goodWs.worktree, ['commit', '-qm', 'attested tests']);
  const goodSha = git(goodWs.worktree, ['rev-parse', 'HEAD']);

  // Missing adapterRunId is rejected under requireSandboxReceipt: true.
  assert.throws(
    () => submitRuntimeDeliveryCandidate({
      missionFile: missionRel,
      packageId: 'pkg-good',
      policyFile: 'delivery-v2.json',
      leaseToken: goodLease,
      candidateSha: goodSha,
      adapterRunId: null,
      projectDir: proj.root
    }),
    (err) => err?.code === 'SANDBOX_RECEIPT_REQUIRED'
  );

  // Tampering with workspace after sandbox run is rejected with SANDBOX_RECEIPT_MISMATCH!
  writeFileSync(path.join(goodWs.worktree, 'src', 'sneaky.mjs'), 'export const x = 1;\n');
  git(goodWs.worktree, ['add', '-A']);
  git(goodWs.worktree, ['commit', '-qm', 'unattested commit']);
  const sneakySha = git(goodWs.worktree, ['rev-parse', 'HEAD']);
  assert.throws(
    () => submitRuntimeDeliveryCandidate({
      missionFile: missionRel,
      packageId: 'pkg-good',
      policyFile: 'delivery-v2.json',
      leaseToken: goodLease,
      candidateSha: sneakySha,
      adapterRunId: goodRun.agentRun.id,
      projectDir: proj.root
    }),
    (err) => err?.code === 'SANDBOX_RECEIPT_MISMATCH'
  );
  git(goodWs.worktree, ['reset', '--hard', goodSha]);

  // Genuine attested candidate submits cleanly and passes full sandboxed integration verification!
  const sub = submitRuntimeDeliveryCandidate({
    missionFile: missionRel,
    packageId: 'pkg-good',
    policyFile: 'delivery-v2.json',
    leaseToken: goodLease,
    candidateSha: goodSha,
    adapterRunId: goodRun.agentRun.id,
    projectDir: proj.root
  });
  assert.ok(sub.candidate.id);

  const ver = await verifyRuntimeDeliveryCandidateAsync({
    missionFile: missionRel,
    packageId: 'pkg-good',
    policyFile: 'delivery-v2.json',
    projectDir: proj.root
  });
  assert.equal(ver.verification.outcome, 'passed', JSON.stringify(ver.verification.checks, null, 2));
  assert.equal(ver.verification.checks.length, 4);
  assert.ok(ver.verification.checks.some((c) => c.kind === 'sandboxed-command' && c.passed && c.sandboxReceiptDigest));

  // Verify receipt tamper check rejects forged digests.
  const tampered = verifySandboxReceipt({
    schemaVersion: 1,
    id: 'sbx-1',
    backend: 'node-permission',
    confinementClass: 'runtime-permission',
    mode: 'read-only',
    network: false,
    childProcess: false,
    policyDigest: null,
    seccompDigest: null,
    workspaceDigestBefore: digest('a'),
    workspaceDigestAfter: digest('a'),
    changedPaths: [],
    outcome: 'completed',
    exitCode: 0,
    signal: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    outputDigest: digest(''),
    outputBytes: 0,
    receiptDigest: digest('forged')
  });
  assert.equal(tampered.ok, false);
});

test('2.5 repair loop classifies failures, redacts secrets, converges, detects stalls and halts on sandbox violations', async () => {
  const diag = classifyVerificationFailures({
    drift: { errors: ['REQ-002 has no test anchor (api_key=sk_live_secret_999)', 'REQ-C01 test has no assertion'] },
    gates: { stdout: '✗ G2-AUTONOMY missing allowlist test' },
    tests: { ok: false, exitCode: 1, stdout: 'not ok 1 - rejects invalid token' }
  });
  assert.equal(diag.ok, false);
  assert.deepEqual(diag.failingRequirements, ['REQ-002', 'REQ-C01']);
  assert.deepEqual(diag.failingGates, ['G2-AUTONOMY']);
  assert.ok(!JSON.stringify(diag).includes('sk_live_secret_999'), 'secrets redacted from repair diagnostics');

  // Converges after 1 repair
  let step = 0;
  const converged = await runRepairLoop({
    packageId: 'pkg-core',
    requirements: [{ id: 'REQ-002', title: 'Primary journey', statement: 'The CLI shall hash archives.' }],
    maxRepairs: 3,
    verify: async () => (step === 0 ? { ok: false, drift: { errors: ['REQ-002 has no test anchor'] } } : { ok: true }),
    repair: async ({ prompt }) => {
      assert.match(prompt, /REQ-002/);
      step += 1;
      return { receiptDigest: digest('rep-1') };
    }
  });
  assert.equal(converged.ok, true);
  assert.equal(converged.outcome, 'converged');
  assert.equal(converged.repairsUsed, 1);

  // Stalls immediately when repair produces identical failure signature —
  // halted as `stuck` and escalated for human review (roadmap P3.4).
  const stalled = await runRepairLoop({
    packageId: 'pkg-core',
    maxRepairs: 3,
    verify: async () => ({ ok: false, drift: { errors: ['REQ-003 has no test anchor'] } }),
    repair: async () => ({})
  });
  assert.equal(stalled.ok, false);
  assert.equal(stalled.outcome, 'stuck');
  assert.equal(stalled.escalated, true);
  assert.equal(stalled.repairsUsed, 1);

  // Halts with 0 repairs on non-retryable sandbox violation
  const halted = await runRepairLoop({
    packageId: 'pkg-core',
    maxRepairs: 3,
    verify: async () => ({ ok: false, sandboxOutcome: 'violation', sandboxDetail: 'network denied' }),
    repair: async () => { throw new Error('must not run repair after sandbox violation'); }
  });
  assert.equal(halted.ok, false);
  assert.equal(halted.outcome, 'halted-non-retryable');
  assert.equal(halted.repairsUsed, 0);
});

test('2.6 mission rebase advances target commits, isolates added requirements, and guards retirements', (t) => {
  const proj = createGitProject({
    stage: 'mvp',
    rules: ['Tarballs larger than 500MB must be rejected before hashing.']
  });
  t.after(proj.cleanup);

  const spec1 = JSON.parse(readFileSync(path.join(proj.root, 'specs', 'spec.json'), 'utf8'));
  const created = createMission({
    definition: {
      schemaVersion: 1,
      id: 'rebase-demo',
      title: 'Mission rebase verification',
      workPackages: [{
        id: 'pkg-core',
        title: 'Core checksum features',
        requirements: spec1.requirements.map((r) => r.id),
        dependsOn: [],
        resourceClaims: { paths: ['src/**', 'tests/**'] }
      }]
    },
    packetDir: 'specs',
    projectDir: proj.root,
    force: true
  });
  const missionRel = path.relative(proj.root, created.file);

  // Advance target commit and add a second custom rule to the packet!
  const updatedProfile = {
    ...proj.rawProfile,
    rules: [
      'Tarballs larger than 500MB must be rejected before hashing.',
      'Manifest files must record the UTC generation timestamp in ISO-8601 format.'
    ]
  };
  emitPacket(buildPlan(normalizeProfile(updatedProfile), { index: INDEX }), path.join(proj.root, 'specs'), {
    force: true,
    packetDir: 'specs'
  });
  writeFileSync(path.join(proj.root, 'README.md'), '# tiny-cli\n', 'utf8');
  git(proj.root, ['add', '-A']);
  git(proj.root, ['commit', '-qm', 'evolve spec and docs']);

  const preview = rebaseMission({ file: missionRel, projectDir: proj.root, dryRun: true });
  assert.equal(preview.changed, true);
  assert.equal(preview.fastForward, true);
  assert.deepEqual(preview.diff.addedRequirements, ['REQ-C02']);
  assert.deepEqual(preview.diff.unaffectedPackages, ['pkg-core']);

  const applied = rebaseMission({ file: missionRel, projectDir: proj.root });
  assert.equal(applied.changed, true);
  assert.equal(applied.mission.workPackages.length, 2);
  assert.equal(applied.mission.rebaseHistory.length, 1);

  // Removing REQ-C02 refuses without dropRemoved!
  emitPacket(buildPlan(normalizeProfile(proj.rawProfile), { index: INDEX }), path.join(proj.root, 'specs'), {
    force: true,
    packetDir: 'specs'
  });
  assert.throws(
    () => rebaseMission({ file: missionRel, projectDir: proj.root }),
    (err) => err?.code === 'MISSION_REBASE_REMOVED_REQUIREMENTS'
  );
});

test('2.7 vld build compiles, executes in sandbox, self-repairs from repair brief, and emits verified build-report.json', async (t) => {
  const proj = createGitProject({ stage: 'mvp' });
  t.after(proj.cleanup);

  const reqTag = ['@', 'req'].join('');
  mkdirSync(path.join(proj.root, 'tools'), { recursive: true });
  // On initial attempt (no VLD_REPAIR_BRIEF), agent writes a hollow test with missing anchors;
  // on repair attempt 1, agent reads VLD_REPAIR_BRIEF and writes complete passing anchored tests!
  writeFileSync(
    path.join(proj.root, 'tools', 'self-healing-agent.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.mkdirSync('tests', { recursive: true });",
      "const briefFile = process.env.VLD_REPAIR_BRIEF;",
      "if (!briefFile || !fs.existsSync(briefFile)) {",
      "  fs.writeFileSync('tests/checksum.test.mjs', '// incomplete first draft\\n');",
      "} else {",
      "  const spec = JSON.parse(fs.readFileSync('specs/spec.json', 'utf8'));",
      `  const anchors = spec.requirements.filter((r) => r.verify === 'automated').map((r) => '// ${reqTag} ' + r.id).join('\\n');`,
      "  fs.writeFileSync('tests/checksum.test.mjs', [",
      "    \"import test from 'node:test';\",",
      "    \"import assert from 'node:assert/strict';\",",
      "    \"import { hashArchive } from '../src/index.mjs';\",",
      "    anchors,",
      "    \"test('hashes archive', () => {\",",
      "    \"  assert.equal(hashArchive('hello'), 'sha256:5');\",",
      "    \"});\",",
      "    ''",
      "  ].join('\\n'));",
      "}"
    ].join('\n'),
    'utf8'
  );
  git(proj.root, ['add', '-A']);
  git(proj.root, ['commit', '-qm', 'add self-healing sandboxed agent']);

  // Dry-run plans without mutating runtime state.
  const dry = await runBuild({ projectDir: proj.root, packetDir: 'specs', dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.order.length >= 1);

  // Live sandboxed build with self-repair loop + sandboxed test execution!
  const live = await runBuild({
    projectDir: proj.root,
    packetDir: 'specs',
    adapter: 'sandboxed-cli',
    executable: process.execPath,
    args: ['tools/self-healing-agent.mjs'],
    testCommand: { id: 'checksum-tests', executable: process.execPath, args: ['tests/checksum.test.mjs'], timeoutMs: 15_000 },
    verifyGates: false,
    requireAssertions: true,
    maxRepairs: 2
  });
  assert.equal(live.ok, true, JSON.stringify(live, null, 2));
  assert.ok(live.packages.length >= 1);
  assert.equal(live.packages[0].repairOutcome, 'converged');
  assert.equal(live.packages[0].repairsUsed, 1);
  assert.equal(live.packages[0].verificationOutcome, 'passed');
  assert.ok(existsSync(path.join(proj.root, live.reportFile)));
});

// --- P3.4 Smarter packages + repair (roadmap) -------------------------------------------

function emitFixturePacket(profileFields) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p34-'));
  const plan = buildPlan(normalizeProfile(profileFields), { index: INDEX });
  emitPacket(plan, path.join(dir, 'specs'), { force: true, packetDir: 'specs' });
  const spec = JSON.parse(readFileSync(path.join(dir, 'specs', 'spec.json'), 'utf8'));
  return {
    dir,
    spec,
    packetDir: path.join(dir, 'specs'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('P3.4 package derivation: CLI profile collapses to one package; API profile derives core/api/contract in dependency order', (t) => {
  // CLI is one bounded context: every requirement lands in a single work package.
  const cli = emitFixturePacket({
    name: 'todo-cli',
    idea: 'A command-line checklist tool that stores tasks in a local file and prints status reports.',
    kind: 'cli',
    stage: 'mvp',
    traits: [],
    risks: {},
    constraints: { stack: 'javascript' }
  });
  t.after(cli.cleanup);
  const cliDef = planMissionDefinitionFromPacket({ packetDir: cli.packetDir });
  assert.equal(cliDef.workPackages.length, 1, `CLI profile derives a single package, got ${cliDef.workPackages.map((p) => p.id).join(',')}`);
  assert.equal(cliDef.workPackages[0].id, 'pkg-app');
  assert.deepEqual(cliDef.workPackages[0].requirements, cli.spec.requirements.map((r) => r.id).sort());
  assert.equal(validateMissionDefinition(cliDef).ok, true);

  // A service product separates core / api / contract, with the interface
  // contract landing before the API that realizes it (contract dependency order).
  const api = emitFixturePacket({
    name: 'svc',
    idea: 'A payments API with idempotent transfers and a signed contract.',
    kind: 'api',
    stage: 'production',
    traits: [],
    risks: { financial: true },
    constraints: { stack: 'python' }
  });
  t.after(api.cleanup);
  const apiDef = planMissionDefinitionFromPacket({ packetDir: api.packetDir });
  assert.deepEqual(apiDef.workPackages.map((p) => p.id), ['pkg-core', 'pkg-contract', 'pkg-api']);
  const byId = new Map(apiDef.workPackages.map((p) => [p.id, p]));
  const byKey = new Map(api.spec.requirements.map((r) => [r.key, r.id]));
  assert.ok(byId.get('pkg-contract').requirements.includes(byKey.get('api.contract')), 'api.contract lands in the contract package');
  assert.ok(byId.get('pkg-api').requirements.includes(byKey.get('api.error-envelope')), 'api error behaviour lands in the api package');
  assert.ok(byId.get('pkg-core').requirements.includes(byKey.get('data.persistence')), 'service products fold data obligations into core');
  assert.deepEqual(byId.get('pkg-contract').dependsOn, ['pkg-core']);
  assert.deepEqual(byId.get('pkg-api').dependsOn, ['pkg-contract', 'pkg-core']);
  assert.ok(byId.get('pkg-contract').resourceClaims.paths.includes('contracts/**'));
  assert.ok(!byId.get('pkg-contract').resourceClaims.paths.includes('src/**'), 'contract claims follow the contract stack layout');
  const assigned = apiDef.workPackages.flatMap((p) => p.requirements);
  assert.equal(assigned.length, api.spec.requirements.length, 'every requirement is assigned exactly once');
  assert.equal(new Set(assigned).size, assigned.length);
  assert.equal(validateMissionDefinition(apiDef).ok, true);
});

test('P3.4 mission.json overrides merge packages, set the concurrency cap and cost ceilings, and validate strictly', (t) => {
  const api = emitFixturePacket({
    name: 'svc',
    idea: 'A payments API with idempotent transfers and a signed contract.',
    kind: 'api',
    stage: 'production',
    traits: [],
    risks: { financial: true },
    constraints: { stack: 'python' }
  });
  t.after(api.cleanup);
  const apiReq = api.spec.requirements.find((r) => r.key === 'api.error-envelope').id;

  const merged = planMissionDefinitionFromPacket({
    packetDir: api.packetDir,
    overrides: {
      maxConcurrentWorktrees: 3,
      budget: { maxCostUsd: 4, maxTokens: 500000 },
      removePackages: ['pkg-api'],
      workPackages: [
        { id: 'pkg-contract', budget: { maxCostUsd: 1 } },
        {
          id: 'pkg-surface',
          title: 'Implement the api surface requirements',
          requirements: [apiReq],
          dependsOn: ['pkg-contract'],
          resourceClaims: { paths: ['src/**', 'tests/**'] },
          budget: { maxTokens: 9000 }
        }
      ]
    }
  });
  assert.equal(merged.maxConcurrentWorktrees, 3);
  assert.equal(merged.budget.maxCostUsd, 4);
  assert.equal(merged.budget.maxTokens, 500000);
  assert.deepEqual(merged.workPackages.map((p) => p.id), ['pkg-core', 'pkg-contract', 'pkg-surface']);
  assert.deepEqual(merged.workPackages.find((p) => p.id === 'pkg-surface').dependsOn, ['pkg-contract']);
  assert.deepEqual(merged.workPackages.find((p) => p.id === 'pkg-contract').budget, { maxCostUsd: 1 });
  assert.deepEqual(merged.workPackages.find((p) => p.id === 'pkg-surface').budget, { maxTokens: 9000 });
  assert.equal(validateMissionDefinition(merged).ok, true);

  // Strict validation of overrides.
  assert.throws(
    () => planMissionDefinitionFromPacket({ packetDir: api.packetDir, overrides: { maxConcurrentWorktrees: 5 } }),
    /maxConcurrentWorktrees must be an integer between 1 and 4/
  );
  assert.throws(
    () => planMissionDefinitionFromPacket({ packetDir: api.packetDir, overrides: { mystery: true } }),
    /mission overrides.mystery is not allowed/
  );
  assert.throws(
    () => planMissionDefinitionFromPacket({ packetDir: api.packetDir, overrides: { budget: { maxTokens: -1 } } }),
    /maxTokens must be a non-negative integer/
  );
  assert.throws(
    () => planMissionDefinitionFromPacket({
      packetDir: api.packetDir,
      overrides: { workPackages: [{ id: 'pkg-surface', title: 'x'.repeat(12), requirements: [] }] }
    }),
    /requirements must name at least one requirement id/
  );
});

test('P3.4 repair brief names failing tests, spec-check findings, gate output and last-attempt diff; cost ceilings halt', async () => {
  const diagnosis = classifyVerificationFailures({
    ok: false,
    drift: { errors: ['REQ-003 has no test anchor'] },
    gates: { failures: ['G1-DOMAIN-TESTS ✗ domain test missing'] },
    tests: { ok: false, exitCode: 1, stdout: 'not ok 2 - sums two numbers\nnot ok 3 - rejects negatives', stderr: '' }
  });
  const prompt = buildRepairPrompt({
    packageId: 'pkg-core',
    attempt: 1,
    maxAttempts: 2,
    diagnosis,
    requirements: [],
    verification: { ok: false, gates: { stdout: 'gate runner: mutation score below threshold', failures: [] } },
    previousAttemptDiff: 'diff --git a/src/calc.mjs b/src/calc.mjs\n- return a + b + 7;\n+ return a + b;'
  });
  assert.match(prompt, /## Failing tests/);
  assert.match(prompt, /sums two numbers/);
  assert.match(prompt, /rejects negatives/);
  assert.match(prompt, /## Spec-check findings/);
  assert.match(prompt, /REQ-003 has no test anchor/);
  assert.match(prompt, /## Gate output/);
  assert.match(prompt, /mutation score below threshold/);
  assert.match(prompt, /## Changes since the previous attempt/);
  assert.match(prompt, /return a \+ b \+ 7;/);

  // Distinct, escalating failures accumulate against the package cost ceiling.
  let round = 0;
  const capped = await runRepairLoop({
    packageId: 'pkg-core',
    maxRepairs: 3,
    budget: { maxCostUsd: 1 },
    verify: async () => ({ ok: false, drift: { errors: [`REQ-00${(round += 1)} has no test anchor`] } }),
    repair: async () => ({ usage: { totalTokens: 100, costUsd: 0.8 } })
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.outcome, 'cost-ceiling');
  assert.equal(capped.escalated, true);
  assert.equal(capped.repairsUsed, 2);
  assert.ok(capped.usage.costUsd > 1);

  // A spend already past the ceiling halts before any repair runs.
  const preSpent = await runRepairLoop({
    packageId: 'pkg-core',
    maxRepairs: 3,
    budget: { maxCostUsd: 1 },
    initialUsage: { totalTokens: 10000, costUsd: 9 },
    verify: async () => ({ ok: false, drift: { errors: ['REQ-002 has no test anchor'] } }),
    repair: async () => { throw new Error('must not repair past the cost ceiling'); }
  });
  assert.equal(preSpent.outcome, 'cost-ceiling');
  assert.equal(preSpent.repairsUsed, 0);
  assert.equal(preSpent.escalated, true);
});

test('P3.4 parallel worktrees honor the mission concurrency cap', async (t) => {
  const reqTag = ['@', 'req'].join('');

  async function greenProject(name, cap) {
    const proj = createGitProject({ name, stage: 'mvp' });
    t.after(proj.cleanup);
    const spec = JSON.parse(readFileSync(path.join(proj.root, 'specs', 'spec.json'), 'utf8'));
    const allIds = spec.requirements.map((r) => r.id).sort();
    const automated = spec.requirements.filter((r) => r.verify === 'automated');
    const tests = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { hashArchive } from '../src/index.mjs';",
      '',
      ...automated.flatMap((r) => [
        `// ${reqTag} ${r.id}`,
        `test('${r.id} hashes deterministically', () => { assert.equal(hashArchive('hi'), 'sha256:2'); });`,
        ''
      ])
    ].join('\n');
    writeFileSync(path.join(proj.root, 'tests', 'anchored.test.mjs'), tests, 'utf8');
    git(proj.root, ['add', '-A']);
    git(proj.root, ['commit', '-qm', 'anchored green tests']);
    const derived = planMissionDefinitionFromPacket({ packetDir: path.join(proj.root, 'specs') });
    const half = Math.ceil(allIds.length / 2);
    return {
      proj,
      overrides: {
        maxConcurrentWorktrees: cap,
        removePackages: derived.workPackages.map((p) => p.id),
        workPackages: [
          {
            id: 'pkg-alpha',
            title: 'Implement alpha half of the specification requirements',
            requirements: allIds.slice(0, half),
            dependsOn: [],
            resourceClaims: { paths: ['src/**', 'tests/**', 'spec/**', 'docs/**'] }
          },
          {
            id: 'pkg-beta',
            title: 'Implement beta half of the specification requirements',
            requirements: allIds.slice(half),
            dependsOn: [],
            resourceClaims: { paths: ['src/**', 'tests/**', 'spec/**', 'docs/**'] }
          }
        ]
      }
    };
  }

  // Cap 2: two independent packages run concurrently (worktrees overlap).
  const parallel = await greenProject('par-two', 2);
  const live2 = await runBuild({
    projectDir: parallel.proj.root,
    packetDir: 'specs',
    adapter: 'fake',
    missionOverrides: parallel.overrides,
    verifyGates: false,
    requireAssertions: true
  });
  assert.equal(live2.ok, true, JSON.stringify(live2, null, 2));
  assert.equal(live2.packages.length, 2);
  assert.ok(live2.packages.every((p) => p.verificationOutcome === 'passed'));
  assert.equal(live2.maxConcurrentWorktrees, 2);
  const [alpha, beta] = live2.packages;
  assert.ok(
    alpha.startedAt < beta.finishedAt && beta.startedAt < alpha.finishedAt,
    `packages must overlap under cap 2 (${alpha.startedAt}..${alpha.finishedAt} vs ${beta.startedAt}..${beta.finishedAt})`
  );

  // Cap 1 (default): packages run strictly serially.
  const serial = await greenProject('par-one', 1);
  const live1 = await runBuild({
    projectDir: serial.proj.root,
    packetDir: 'specs',
    adapter: 'fake',
    missionOverrides: serial.overrides,
    verifyGates: false,
    requireAssertions: true
  });
  assert.equal(live1.ok, true, JSON.stringify(live1, null, 2));
  assert.equal(live1.maxConcurrentWorktrees, 1);
  const [first, second] = live1.packages;
  assert.ok(
    first.finishedAt <= second.startedAt || second.finishedAt <= first.startedAt,
    `packages must not overlap under cap 1 (${first.startedAt}..${first.finishedAt} vs ${second.startedAt}..${second.finishedAt})`
  );
});
