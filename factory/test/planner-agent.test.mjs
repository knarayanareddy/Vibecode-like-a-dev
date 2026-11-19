/**
 * Roadmap P4.2 — multi-turn mission planner & context assembly.
 *
 * Covers the bounded digest-pinned context assembler, the plan → validate →
 * critique → refine planner session (with repair and fail-closed paths), the
 * deterministic offline fallback, cassette record/replay parity, and the
 * `vld mission plan` CLI wiring into `vld mission init`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { runPlannerAgent } from '../agents/planner.mjs';
import { assemblePacketContext, assembleWorkPackageContext } from '../lib/context.mjs';
import { planMissionDefinitionFromPacket, validateMissionDefinition } from '../lib/missions.mjs';
import {
  git,
  gitEnv,
  runCli,
  startScriptedUpstream
} from './fixtures/golden-journey/journey-lib.mjs';

const REQUIREMENT = /^REQ-(?:C\d{2,}|\d{3,})$/;

let root;
let packetDir;
let requirementIds;

const definitionWith = (requirements) => ({
  schemaVersion: 1,
  id: 'context-demo-build',
  title: 'Build the context demo against the verified packet',
  workPackages: [{
    id: 'pkg-core',
    title: 'Implement and verify core specification requirements',
    requirements: [...requirements].sort(),
    dependsOn: []
  }]
});

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vld-p42-'));
  writeFileSync(path.join(root, 'profile.json'), `${JSON.stringify({
    name: 'context-demo',
    idea: 'A tiny inventory API that tracks equipment categories for field technicians.',
    kind: 'api',
    stage: 'mvp',
    users: { scale: 'small' },
    traits: [],
    risks: { pii: false, payments: false, regulated: false, multiTenant: false, destructiveWrites: false, publicFacing: false, integrations: false },
    rules: [
      { slug: 'category-required', text: 'Every inventory item must include an equipment category.' },
      { slug: 'audit-log', text: 'Every category change must be written to an audit log.' }
    ],
    conflicts: [],
    riskWaivers: [],
    traitWaivers: []
  }, null, 2)}\n`, 'utf8');
  const plan = await runCli(['plan', 'profile.json'], { cwd: root });
  assert.equal(plan.code, 0, plan.stderr);
  const compile = await runCli(['compile', 'profile.json', '-o', 'specs', '--force'], { cwd: root });
  assert.equal(compile.code, 0, compile.stderr);
  packetDir = path.join(root, 'specs');
  const spec = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  requirementIds = spec.requirements.map((r) => r?.id).filter((id) => REQUIREMENT.test(String(id))).sort();
  assert.ok(requirementIds.includes('REQ-C01'), `expected custom rule ids in ${requirementIds.join(',')}`);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('P4.2 context assembly is deterministic, bounded and slice-aware', () => {
  const first = assemblePacketContext({ packetDir });
  const second = assemblePacketContext({ packetDir });
  assert.equal(first.digest, second.digest, 'same packet must assemble byte-identically');
  assert.equal(first.text, second.text);
  assert.deepEqual(first.requirementIds, requirementIds);
  assert.match(first.text, /## project/);
  assert.match(first.text, /## requirements/);
  assert.match(first.text, /category-required:/, 'product rules must be in the context');

  const bounded = assemblePacketContext({ packetDir, maxChars: 2000 });
  assert.ok(bounded.chars <= 2000, `bounded context must respect the budget: ${bounded.chars}`);
  assert.ok(bounded.truncated.length > 0, 'truncation must be reported, never silent');
  assert.equal(bounded.digest, assemblePacketContext({ packetDir, maxChars: 2000 }).digest);

  const slice = assembleWorkPackageContext({
    packetDir,
    workPackage: { id: 'pkg-core', requirements: requirementIds.slice(0, 1) }
  });
  assert.equal(slice.packageId, 'pkg-core');
  assert.deepEqual(slice.requirementIds, requirementIds.slice(0, 1));
  assert.deepEqual(slice.assignedElsewhere, requirementIds.slice(1), 'the rest of the packet is named as out of scope');
  assert.ok(slice.text.includes(requirementIds[0]));

  assert.throws(
    () => assemblePacketContext({ packetDir, maxChars: 10 }),
    /maxChars/,
    'a budget below the floor must be rejected'
  );
});

test('P4.2 multi-turn planner: draft, deterministic critique, final definition', async (t) => {
  const draft = definitionWith(requirementIds);
  const stub = await startScriptedUpstream([
    { content: JSON.stringify(draft) },
    { content: JSON.stringify(draft) }
  ]);
  t.after(() => stub.close());

  const result = await runPlannerAgent({
    packetDir,
    provider: 'openai',
    model: 'golden-planner',
    baseUrl: `${stub.url}/v1`,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test' }
  });

  assert.equal(result.ok, true, `planner failed: ${result.errors.join('; ')}`);
  assert.equal(result.mode, 'model-live');
  assert.equal(result.turns.length, 2, 'a clean draft still gets the critique/final turn');
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(result.validation.errors, []);

  // The critique turn carries the deterministic report back to the model.
  const conversation = stub.calls[1].body.messages.filter((message) => message.role !== 'system');
  assert.equal(conversation.length, 3, 'turn 2 is a real multi-turn continuation');
  assert.equal(conversation[0].role, 'user');
  assert.equal(conversation[1].role, 'assistant');
  assert.equal(conversation[2].role, 'user');
  assert.match(conversation[2].content, /no schema or coverage defects found/);

  const checked = validateMissionDefinition(result.definition, { requirementIds });
  assert.equal(checked.ok, true, checked.errors.join('; '));

  // The per-work-package context bundles pin what downstream agents see.
  assert.equal(result.workPackageContexts.length, 1);
  const bundle = assembleWorkPackageContext({ packetDir, workPackage: draft.workPackages[0] });
  assert.equal(result.workPackageContexts[0].digest, bundle.digest);
  assert.equal(result.workPackageContexts[0].packageId, 'pkg-core');
});

test('P4.2 planner repairs a coverage gap through the critique turn', async (t) => {
  const broken = definitionWith(requirementIds.slice(0, -1));
  const fixed = definitionWith(requirementIds);
  const stub = await startScriptedUpstream([
    { content: JSON.stringify(broken) },
    { content: JSON.stringify(fixed) }
  ]);
  t.after(() => stub.close());

  const result = await runPlannerAgent({
    packetDir,
    missionId: 'repair-demo',
    provider: 'openai',
    model: 'golden-planner',
    baseUrl: `${stub.url}/v1`,
    maxTurns: 2,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test' }
  });

  assert.equal(result.ok, true, `planner failed: ${result.errors.join('; ')}`);
  assert.equal(result.turns.length, 2);
  assert.ok(
    result.turns[0].validationErrors.some((error) => /is not assigned/.test(error)),
    `turn 1 critique must name the coverage gap: ${JSON.stringify(result.turns[0].validationErrors)}`
  );
  const critiqueTurn = stub.calls[1].body.messages.filter((message) => message.role !== 'system').at(-1);
  assert.match(critiqueTurn.content, /ERROR: requirement .* is not assigned/);
  assert.deepEqual(result.definition.workPackages[0].requirements.slice().sort(), requirementIds);
});

test('P4.2 planner fails closed after maxTurns, naming the critique errors', async (t) => {
  const broken = definitionWith(requirementIds.slice(0, 1));
  const stub = await startScriptedUpstream([
    { content: JSON.stringify(broken) },
    { content: JSON.stringify(broken) }
  ]);
  t.after(() => stub.close());

  const result = await runPlannerAgent({
    packetDir,
    provider: 'openai',
    model: 'golden-planner',
    baseUrl: `${stub.url}/v1`,
    maxTurns: 2,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test' }
  });

  assert.equal(result.ok, false, 'a never-valid draft must not produce a plan');
  assert.equal(result.turns.length, 2, 'maxTurns is a hard cap');
  assert.ok(result.errors.some((error) => /is not assigned/.test(error)), result.errors.join('; '));
  assert.equal(result.workPackageContexts.length, 0);
});

test('P4.2 offline fallback is byte-identical to the deterministic planner', async () => {
  const result = await runPlannerAgent({ packetDir, missionId: 'offline-demo', title: 'Offline deterministic planning demo' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'offline-deterministic');
  assert.deepEqual(result.turns, []);
  const deterministic = planMissionDefinitionFromPacket({
    packetDir,
    missionId: 'offline-demo',
    title: 'Offline deterministic planning demo'
  });
  assert.deepEqual(result.definition, deterministic, 'keyless planning must stay byte-identical to today');
});

test('P4.2 cassette record then keyless replay reproduces the plan', async (t) => {
  const draft = definitionWith(requirementIds);
  const stub = await startScriptedUpstream([
    { content: JSON.stringify(draft) },
    { content: JSON.stringify(draft) }
  ]);
  const cassetteDir = path.join(root, 'cassettes', 'planner');

  const recorded = await runPlannerAgent({
    packetDir,
    missionId: 'cassette-demo',
    title: 'Cassette record and replay planning demo',
    provider: 'openai',
    model: 'golden-planner',
    baseUrl: `${stub.url}/v1`,
    cassetteDir,
    cassetteMode: 'record',
    env: { ...process.env, OPENAI_API_KEY: 'sk-test' }
  });
  assert.equal(recorded.ok, true, recorded.errors.join('; '));
  assert.equal(recorded.turns.length, 2);
  stub.close();

  const replayed = await runPlannerAgent({
    packetDir,
    missionId: 'cassette-demo',
    title: 'Cassette record and replay planning demo',
    provider: 'openai',
    model: 'golden-planner',
    baseUrl: 'http://127.0.0.1:9/v1', // never dialed: replay is keyless and offline
    cassetteDir,
    cassetteMode: 'replay',
    env: { ...process.env, OPENAI_API_KEY: '' }
  });
  assert.equal(replayed.ok, true, replayed.errors.join('; '));
  assert.equal(replayed.mode, 'model-cassette');
  assert.deepEqual(replayed.definition, recorded.definition, 'replay must reproduce the recorded plan byte-identically');
  assert.equal(replayed.turns.length, 2);
  assert.ok(replayed.turns.every((turn) => turn.cached), JSON.stringify(replayed.turns));
});

test('P4.2 CLI mission plan wires offline planning into mission init', async (t) => {
  await git(root, ['init', '-q']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'profile + verified packet'], gitEnv(1));

  const planned = await runCli(['mission', 'plan', 'specs', '-o', 'def.json', '--offline', '--json'], { cwd: root });
  assert.equal(planned.code, 0, `${planned.stderr}\n${planned.stdout}`);
  const summary = JSON.parse(planned.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'offline-deterministic');
  assert.match(summary.contextDigest, /^[a-f0-9]{64}$/);

  const definition = JSON.parse(readFileSync(path.join(root, 'def.json'), 'utf8'));
  const checked = validateMissionDefinition(definition, { requirementIds });
  assert.equal(checked.ok, true, checked.errors.join('; '));

  const init = await runCli(['mission', 'init', 'def.json', '--packet', 'specs', '--target', 'HEAD', '-o', 'missions/cli.json'], { cwd: root });
  assert.equal(init.code, 0, `mission init must accept the planned definition: ${init.stderr}`);

  const failed = await runCli(['mission', 'plan', 'specs', '--provider', 'openai', '--model', 'x', '--max-turns', '9'], { cwd: root });
  assert.notEqual(failed.code, 0, 'turn limits must be validated');
  assert.match(failed.stderr, /maxTurns/);
});
