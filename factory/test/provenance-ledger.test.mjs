/**
 * Roadmap 4.3 — Provenance and cost ledger.
 *
 * Acceptance:
 *   - every candidate carries a verifiable provenance block (model id, prompt
 *     hash over the run's model requests, tool-call transcript digest, token
 *     usage and cost) that recomputes from the stored transcript;
 *   - a mission budget overrun aborts the mission;
 *   - model-produced evidence entries record the same provenance and
 *     `evidence export --format markdown` renders the audit report;
 *   - the Studio status exposes the cost panel with budget alerts.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

import { runBuild } from '../lib/build.mjs';
import { exportEvidenceBundle, verifyEvidenceChain } from '../lib/evidence.mjs';
import { digest } from '../lib/extension-utils.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { planMissionDefinitionFromPacket } from '../lib/missions.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { cleanEnv, startScriptedUpstream } from './fixtures/golden-journey/journey-lib.mjs';

const execFileAsync = promisify(execFile);
const IMPLEMENTER = path.join(ROOT, 'factory', 'agents', 'implementer.mjs');

async function runImplementer({ workspace, model, cassetteDir, cassetteMode, env = {}, args = [] }) {
  const argv = [IMPLEMENTER, '--workspace', workspace, '--model', model, ...args];
  const childEnv = cleanEnv({
    ...(cassetteDir ? { VLD_MODEL_CASSETTE_DIR: cassetteDir } : {}),
    ...(cassetteMode ? { VLD_MODEL_CASSETTE_MODE: cassetteMode } : {}),
    ...env
  });
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, { env: childEnv, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const INDEX = buildIndex();
const BROKEN_TODO = [
  "export class TodoList {",
  "  constructor() { this.items = []; }",
  "  add(text) { this.items.push({ text, done: false }); }",
  "  done(index) { if (index < 0 || index >= this.items.length) return false; this.items[index].done = true; return true; }",
  "  list() { return this.items; }",
  "}"
].join('\n');
const FIXED_TODO = BROKEN_TODO;

/** Build the fixture project and record the implementer cassette once. */
async function seedProject(t, dir) {
  const proj = path.join(dir, 'todo-cli');
  mkdirSync(proj, { recursive: true });
  git(proj, ['init', '-q']);
  git(proj, ['config', 'user.name', 'VLD Test']);
  git(proj, ['config', 'user.email', 'vld@test.local']);
  const rawProfile = {
    name: 'todo-cli',
    idea: 'A command-line checklist tool whose done() function is broken.',
    kind: 'cli',
    stage: 'mvp',
    traits: [],
    risks: {},
    constraints: { stack: 'javascript' }
  };
  writeFileSync(path.join(proj, 'profile.json'), JSON.stringify(rawProfile, null, 2));
  const plan = buildPlan(normalizeProfile(rawProfile), { index: INDEX });
  emitPacket(plan, path.join(proj, 'specs'), { force: true, packetDir: 'specs' });
  mkdirSync(path.join(proj, 'src'), { recursive: true });
  writeFileSync(path.join(proj, 'src', 'todo.mjs'), BROKEN_TODO);
  git(proj, ['add', '-A']);
  git(proj, ['commit', '-qm', 'initial']);

  const packetSpec = JSON.parse(readFileSync(path.join(proj, 'specs', 'spec.json'), 'utf8'));
  const automated = packetSpec.requirements.filter((r) => r.verify === 'automated');
  assert.ok(automated.length >= 1);
  const TESTS_TODO = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { TodoList } from '../src/todo.mjs';",
    '',
    ...automated.flatMap((req, i) => [
      `// @req ${req.id}`,
      `test('${req.id} behaviour ${i}', () => {`,
      '  const list = new TodoList();',
      "  list.add('ship it');",
      '  assert.equal(list.list().length, 1);',
      '});',
      ''
    ])
  ].join('\n');

  const testCommand = { id: 'todo-tests', executable: process.execPath, args: ['tests/todo.test.mjs'], timeoutMs: 30_000 };
  const definition = planMissionDefinitionFromPacket({ packetDir: path.join(proj, 'specs') });
  const defaultClaims = definition.workPackages[0].resourceClaims.paths.join(',');
  const cassetteDir = path.join(dir, 'cassettes');

  const script = [
    { toolCalls: [{ name: 'write_file', input: { path: 'src/todo.mjs', content: FIXED_TODO } }] },
    { toolCalls: [{ name: 'write_file', input: { path: 'tests/todo.test.mjs', content: TESTS_TODO } }] },
    { toolCalls: [{ name: 'run_tests', input: {} }] },
    { toolCalls: [{ name: 'finish', input: { summary: 'added anchored tests', success: true } }] }
  ];
  const upstream = await startScriptedUpstream(script);
  t.after(() => upstream.close());
  for (const pkg of definition.workPackages) {
    const twin = path.join(dir, `twin-${pkg.id}`);
    // Exclude .git: fs.cpSync recursive can race on .git/objects (ENOENT on
  // macOS and overlayfs) and the recording twin never needs git state.
  cpSync(proj, twin, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    const recorded = await runImplementer({
      workspace: twin,
      model: `openai:test-model:${upstream.url}/v1`,
      cassetteDir,
      cassetteMode: 'record',
      env: {
        VLD_MODEL_TOKEN_ENV: 'VLD_OPENAI_API_KEY',
        VLD_OPENAI_API_KEY: 'sk-record-test',
        VLD_REQUIREMENT_IDS: pkg.requirements.slice().sort().join(','),
        VLD_WRITE_GLOBS: defaultClaims,
        VLD_TEST_COMMAND: JSON.stringify(testCommand)
      },
      args: ['--packet', 'specs', '--write-globs', defaultClaims, '--test-cmd', JSON.stringify(testCommand), '--max-steps', '12']
    });
    assert.equal(recorded.code, 0, `record for ${pkg.id} failed: ${recorded.stderr}`);
  }
  return { proj, testCommand, cassetteDir };
}

test('4.3 every candidate carries a verifiable provenance block and model evidence entries record it', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p43-prov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { proj, testCommand, cassetteDir } = await seedProject(t, dir);

  const live = await runBuild({
    projectDir: proj,
    packetDir: 'specs',
    adapter: 'sandboxed-agent',
    model: 'openai:test-model',
    cassetteDir,
    cassetteMode: 'replay',
    testCommand,
    verifyGates: false,
    requireAssertions: true,
    maxRepairs: 1
  });
  assert.equal(live.ok, true, JSON.stringify(live, null, 2).slice(0, 800));
  const pkg = live.packages[0];
  const provenance = pkg.provenance;
  assert.ok(provenance, 'the build report entry must carry the provenance block');
  assert.equal(provenance.modelId, 'openai:test-model');
  assert.match(provenance.promptHash, /^[a-f0-9]{64}$/, 'prompt hash is a digest over the run model requests');
  assert.match(provenance.transcriptDigest, /^[a-f0-9]{64}$/, 'tool-call transcript digest');
  assert.ok(Number.isFinite(provenance.usage?.totalTokens) && Number.isFinite(provenance.usage?.costUsd), 'token usage and cost');

  // Verifiable: the prompt hash recomputes from the stored transcript summary.
  const transcripts = readdirSync(path.join(proj, '.vld', 'agent-transcripts')).filter((f) => f.endsWith('.summary.json'));
  assert.ok(transcripts.length >= 1);
  const summary = JSON.parse(readFileSync(path.join(proj, '.vld', 'agent-transcripts', transcripts[0]), 'utf8'));
  assert.ok(Array.isArray(summary.requestDigests) && summary.requestDigests.length > 0, 'the transcript records the model request digests');
  assert.equal(digest(summary.requestDigests), provenance.promptHash, 'prompt hash must recompute from the recorded request digests');
  assert.equal(summary.transcriptDigest, provenance.transcriptDigest, 'provenance transcript digest must match the transcript summary');

  // Model-produced evidence entries record the same provenance.
  const chain = verifyEvidenceChain({ projectDir: proj });
  assert.equal(chain.ok, true, 'evidence chain verifies');
  const ledger = chain.records;
  const buildEntry = ledger.find((rec) => rec.kind === 'build');
  assert.ok(buildEntry, 'a build evidence entry exists');
  assert.ok(Array.isArray(buildEntry.payload.provenance) && buildEntry.payload.provenance.length >= 1, 'build evidence carries provenance');
  assert.equal(buildEntry.payload.provenance[0].promptHash, provenance.promptHash);

  // The markdown export is the audit report.
  const markdown = exportEvidenceBundle({ projectDir: proj, format: 'markdown' });
  assert.match(markdown, /# VLD Audit Evidence Bundle/);
  assert.match(markdown, /\| Seq \| Timestamp \| Kind \| Actor \| Subject \| Hash \|/);
  assert.match(markdown, /\| build \|/);
});

test('4.3 a mission budget overrun aborts the mission', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p43-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { proj, testCommand, cassetteDir } = await seedProject(t, dir);

  const blown = await runBuild({
    projectDir: proj,
    packetDir: 'specs',
    adapter: 'sandboxed-agent',
    model: 'openai:test-model',
    cassetteDir,
    cassetteMode: 'replay',
    testCommand,
    verifyGates: false,
    requireAssertions: true,
    maxRepairs: 0,
    missionOverrides: { budget: { maxCostUsd: 0.000000001 } }
  });
  assert.equal(blown.ok, false, 'a budget overrun must abort the mission build');
  const entry = blown.packages[0];
  assert.equal(entry.ok, false);
  assert.equal(entry.stage, 'agent-run', 'the run aborts before any candidate is submitted');
  assert.ok(!entry.candidateId, 'no candidate may be produced after a budget overrun');

  // The recorded failure names the budget.
  const summaries = readdirSync(path.join(proj, '.vld', 'agent-transcripts'), { withFileTypes: true });
  const runDirs = summaries.filter((d) => d.isDirectory()).map((d) => d.name);
  const flat = readdirSync(path.join(proj, '.vld', 'agent-transcripts')).filter((f) => f.endsWith('.summary.json'));
  const summaryFiles = [...flat, ...runDirs.flatMap((d) => readdirSync(path.join(proj, '.vld', 'agent-transcripts', d)).filter((f) => f.endsWith('.summary.json')).map((f) => path.join(d, f)))];
  const texts = summaryFiles.map((f) => readFileSync(path.join(proj, '.vld', 'agent-transcripts', f), 'utf8')).join('\n');
  assert.match(texts, /budget|cost/i, `the abort reason must name the budget: ${texts.slice(0, 300)}`);
});

test('4.3 the Studio status exposes the cost panel with budget state', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p43-studio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { proj, testCommand, cassetteDir } = await seedProject(t, dir);

  const live = await runBuild({
    projectDir: proj,
    packetDir: 'specs',
    adapter: 'sandboxed-agent',
    model: 'openai:test-model',
    cassetteDir,
    cassetteMode: 'replay',
    testCommand,
    verifyGates: false,
    requireAssertions: true,
    maxRepairs: 1
  });
  assert.equal(live.ok, true, JSON.stringify(live, null, 2).slice(0, 600));

  // The runtime status projection carries the cost panel data.
  const { runtimeStatus } = await import('../lib/runtime.mjs');
  const missionFile = path.join('missions', `${JSON.parse(readFileSync(path.join(proj, 'specs', 'spec.json'), 'utf8')).project.name.replace(/[^a-z0-9-]+/g, '-')}-build`, 'mission.json');
  const status = runtimeStatus({ missionFile, projectDir: proj });
  assert.ok((status.agentRuns ?? []).length >= 1);
  const run = status.agentRuns[0];
  assert.match(run.promptHash ?? '', /^[a-f0-9]{64}$/, 'agent runs carry the prompt hash for the cost panel');
  assert.ok(run.usage && Number.isFinite(run.usage.costUsd), 'agent runs carry usage and cost');
});
