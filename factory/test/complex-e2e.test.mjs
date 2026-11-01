/**
 * A high-rigor public CLI information-flow journey.
 *
 * The unit suites exercise individual schemas and adapters. This fixture starts
 * with one deliberately complex product profile and follows its immutable facts
 * through optional local setup, packet generation, exports, mission authority,
 * a fake Runtime delivery, independent approval, queueing and the offline forge
 * plan. No command in this test receives a credential or contacts a network.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function json(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

const COMPLEX_PROFILE = {
  name: 'care-payments-orchestrator',
  idea: 'A multi-tenant regulated care payment orchestration platform that coordinates multilingual patient reimbursement, consent-aware records, provider webhooks, offline field uploads, searchable payment disputes, real-time notifications and bounded AI triage.',
  kind: 'web-app',
  stage: 'production',
  users: { scale: 'large' },
  traits: ['auth', 'admin', 'payments', 'realtime', 'search', 'upload', 'notifications', 'webhooks', 'offline', 'ai', 'i18n', 'persistence', 'background-jobs'],
  risks: { pii: true, payments: true, regulated: true, multiTenant: true, destructiveWrites: true, publicFacing: true, integrations: true },
  constraints: { team: 8, weeks: 20, stack: 'typescript', mustUse: ['postgres', 'stripe'] },
  overlays: ['org-baseline', 'health-data', 'two-person-review']
};

const FAKE_AGENT_POLICY = {
  schemaVersion: 1,
  id: 'complex-fake-agent',
  adapter: 'fake',
  mode: 'write-workspace',
  capabilities: { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: false, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true, credentialAccess: false, gitPush: false, gitMerge: false },
  limits: { durationMs: 1_000, outputBytes: 1_024, retryBudget: 0 },
  environment: {},
  command: { script: 'succeed', executable: null, args: [] }
};

const DELIVERY_POLICY = {
  schemaVersion: 1,
  id: 'complex-delivery-v1',
  verification: { verifyPacket: true, commands: [] },
  review: { independent: true },
  queue: { enabled: true },
  merge: { local: false, push: false, forge: false }
};

// @req REQ-002
// @req REQ-004
test('complex public information flow preserves profile, packet, mission, delivery and offline forge authority', async (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-complex-e2e-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const profileFile = path.join(project, 'profile.json');
  writeFileSync(profileFile, `${JSON.stringify(COMPLEX_PROFILE, null, 2)}\n`);

  // Exercise the optional setup layers without allowing them to become compiler
  // input authority: the bundle locks modules/workflows and the handoff remains
  // generated local content.
  const bundle = json(await cli(['bundle', 'apply', 'regulated-payments', '--project', project, '--profile', profileFile, '--json']));
  assert.deepEqual(bundle.modules.state.modules.map((module) => module.id), ['architecture', 'delivery', 'product', 'qa', 'review']);
  assert.equal(json(await cli(['module', 'verify', '--project', project, '--json'])).ok, true);
  assert.equal(json(await cli(['workflow', 'lint', '--json'])).errors.length, 0);
  const handoff = json(await cli(['agent', 'install', 'codex', '--project', project, '--json']));
  assert.ok(handoff.files.length > 0);
  assert.ok(existsSync(path.join(project, '.agents', 'skills', 'vld-discovery', 'SKILL.md')));

  const planned = json(await cli(['plan', profileFile, '--json']));
  assert.equal(planned.profile.name, COMPLEX_PROFILE.name);
  assert.ok(planned.requirements.length >= 20, 'complex profile selects a broad requirement set');
  assert.ok(planned.gates.length >= 10, 'complex profile selects high-rigor gates');

  const packetDir = path.join(project, 'specs');
  const compiled = await cli(['compile', profileFile, '-o', packetDir]);
  assert.equal(compiled.code, 0, compiled.stderr);
  const packet = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  const packetDigest = sha256(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  assert.equal(packet.project.name, COMPLEX_PROFILE.name);
  assert.equal(packet.requirements.length, planned.requirements.length);
  assert.ok(packet.requirements.some((requirement) => requirement.key === 'data.consent-basis'), 'overlay information reaches the packet');
  assert.ok(packet.requirements.some((requirement) => requirement.key === 'ops.review-record'), 'independent-review overlay reaches the packet');
  assert.equal((await cli(['verify', packetDir, '--json'])).code, 0);

  // Two bounded generated views must carry the authoritative spec digest rather
  // than inventing a separate requirements source.
  const specKit = json(await cli(['export', 'spec-kit', packetDir, '--out', path.join(project, 'spec-kit'), '--json']));
  const kiro = json(await cli(['export', 'kiro', packetDir, '--out', path.join(project, 'kiro'), '--json']));
  assert.equal(specKit.source.specDigest, packetDigest);
  assert.equal(kiro.source.specDigest, packetDigest);
  assert.ok(existsSync(path.join(project, 'spec-kit', '.specify', 'memory', 'constitution.md')));
  assert.ok(existsSync(path.join(project, 'kiro', '.kiro', 'specs', 'vld-packet', 'requirements.md')));

  // Artifact templates are optional human-authored evidence. Their initialized
  // requirement links prove they consume the packet but do not replace it.
  const artifact = json(await cli(['artifact', 'init', 'product-brief', '--project', project, '--packet', packetDir, '--json']));
  assert.equal(artifact.requirements, packet.requirements.length);

  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'complex-e2e@example.invalid']);
  git(project, ['config', 'user.name', 'Complex E2E']);
  git(project, ['add', '.']);
  git(project, ['commit', '-qm', 'freeze complex packet']);

  const definition = {
    schemaVersion: 1,
    id: 'care-delivery',
    title: 'Deliver the complex care payment capability safely',
    workPackages: [{
      id: 'payment-orchestrator',
      title: 'Implement the approved care payment orchestration package',
      requirements: packet.requirements.map((requirement) => requirement.id),
      dependsOn: [],
      resourceClaims: { paths: ['src/payments/**', 'test/payments/**'] }
    }]
  };
  writeFileSync(path.join(project, 'mission-definition.json'), `${JSON.stringify(definition, null, 2)}\n`);
  const missionResult = json(await cli(['mission', 'init', 'mission-definition.json', '--packet', 'specs', '--project', project, '--json']));
  const missionFile = path.join('missions', 'care-delivery', 'mission.json');
  assert.equal(missionResult.mission.packet.digest, packetDigest);
  assert.equal(missionResult.mission.workPackages[0].requirements.length, packet.requirements.length);

  const workspace = json(await cli(['workspace', 'create', missionFile, 'payment-orchestrator', '--project', project, '--json'])).allocation;
  assert.ok(existsSync(workspace.worktree));
  const initialized = json(await cli(['runtime', 'init', missionFile, '--project', project, '--json']));
  assert.equal(initialized.status.runtime.packetDigest, packetDigest);
  const allocated = json(await cli(['runtime', 'allocate', missionFile, 'payment-orchestrator', '--assignee', 'agent-alpha', '--project', project, '--json']));
  assert.match(allocated.leaseToken, /^lease-/);

  writeFileSync(path.join(project, 'agent-policy.json'), `${JSON.stringify(FAKE_AGENT_POLICY, null, 2)}\n`);
  writeFileSync(path.join(project, 'delivery-policy.json'), `${JSON.stringify(DELIVERY_POLICY, null, 2)}\n`);
  const agent = json(await cli(['runtime', 'agent', 'run', missionFile, 'payment-orchestrator', '--policy', 'agent-policy.json', '--lease-token', allocated.leaseToken, '--project', project, '--json']));
  assert.equal(agent.agentRun.adapter, 'fake');
  assert.equal(agent.status.packages[0].state, 'changes_ready');

  const candidateSha = git(workspace.worktree, ['rev-parse', 'HEAD']);
  const submitted = json(await cli(['runtime', 'delivery', 'submit', missionFile, 'payment-orchestrator', '--policy', 'delivery-policy.json', '--lease-token', allocated.leaseToken, '--sha', candidateSha, '--adapter-run', agent.agentRun.id, '--project', project, '--json']));
  assert.equal(submitted.candidate.candidateSha, candidateSha);
  assert.equal(submitted.candidate.packetDigest, packetDigest);
  const verified = json(await cli(['runtime', 'delivery', 'verify', missionFile, 'payment-orchestrator', '--policy', 'delivery-policy.json', '--project', project, '--json']));
  assert.equal(verified.verification.outcome, 'passed');
  assert.equal(verified.verification.candidateId, submitted.candidate.id);
  const approved = json(await cli(['runtime', 'delivery', 'approve', missionFile, 'payment-orchestrator', '--policy', 'delivery-policy.json', '--candidate', submitted.candidate.id, '--actor', 'reviewer:reviewer-beta', '--reason', 'Independent review confirms the frozen candidate and complex packet evidence.', '--project', project, '--json']));
  assert.equal(approved.approval.candidateId, submitted.candidate.id);
  const queued = json(await cli(['runtime', 'delivery', 'queue', missionFile, 'payment-orchestrator', '--policy', 'delivery-policy.json', '--candidate', submitted.candidate.id, '--actor', 'release-approver:release-gamma', '--project', project, '--json']));
  assert.equal(queued.queue.candidateSha, candidateSha);

  // The final handoff is intentionally offline. A dry run has no receipt/file;
  // the real export appends exactly one receipt and writes a review artifact.
  const forgeArgs = ['runtime', 'forge', 'plan-export', missionFile, 'payment-orchestrator', '--candidate', submitted.candidate.id, '--actor', 'release-approver:release-gamma', '--repository', 'example-org/care-payments', '--head-ref', 'vld/care-delivery/payment-orchestrator', '--base-ref', 'main', '--checks', 'packet-check,lint', '--project', project, '--json'];
  const dry = json(await cli([...forgeArgs, '--dry-run']));
  assert.equal(dry.dryRun, true);
  assert.equal(json(await cli(['runtime', 'delivery', 'status', missionFile, '--project', project, '--json'])).delivery.length, 4);
  const forge = json(await cli([...forgeArgs, '--out', 'docs/review/care-payments-plan.json']));
  assert.equal(forge.plan.allowMergeRequest, false);
  assert.equal(forge.plan.headSha, candidateSha);
  assert.equal(forge.plan.targetSha, missionResult.mission.target.commit);
  assert.equal(forge.plan.packetDigest, packetDigest);
  assert.equal(forge.forge.candidateId, submitted.candidate.id);
  assert.equal(forge.forge.verificationId, verified.verification.id);
  assert.equal(forge.forge.approvalId, approved.approval.id);
  assert.equal(forge.forge.queueId, queued.queue.id);
  assert.equal(forge.output.file, 'docs/review/care-payments-plan.json');
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, forge.output.file), 'utf8')), forge.plan);

  const delivery = json(await cli(['runtime', 'delivery', 'status', missionFile, '--project', project, '--json']));
  assert.deepEqual(delivery.delivery.map((entry) => entry.candidate ? 'candidate' : entry.verification ? 'verification' : entry.approval ? 'approval' : entry.queue ? 'queue' : 'forge-plan'), ['candidate', 'verification', 'approval', 'queue', 'forge-plan']);
  assert.equal(delivery.delivery.at(-1).forge.plan.digest, forge.plan.digest);
  const publicText = JSON.stringify(delivery);
  assert.equal(publicText.includes(allocated.leaseToken), false, 'status does not leak the lease secret');
  assert.equal(publicText.includes(workspace.worktree), false, 'status does not leak a workspace path');
  assert.equal(publicText.includes('authorization:'), false, 'status does not carry credential-shaped plan text');
});
