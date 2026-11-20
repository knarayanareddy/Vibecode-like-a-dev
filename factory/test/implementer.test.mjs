/**
 * P3.3 Implementer agent tests (roadmap 3.3):
 *   - tool-loop transcripts: digest verifies and detects tampering
 *   - model egress decision: broker only for live models (cassette replay is offline)
 *   - tool loop (read_file, write_file, list_dir, run_tests, run_command, finish)
 *     runs against a recorded cassette with write-glob and command allow-listing
 *   - hard limits (steps / tokens / wall-clock) abort with a recorded reason
 *   - ACCEPTANCE: the Todo CLI from Test F builds green with adapter
 *     `sandboxed-agent` against a cassette; the transcript digest verifies and
 *     reaches the agent-run receipt, the delivery candidate, and evidence.jsonl.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { agentModelBrokerSpec } from '../lib/agent-adapters.mjs';
import {
  computeTranscriptDigest,
  harvestTranscripts,
  transcriptEntryDigest,
  verifyAgentTranscript,
  verifyAgentTranscriptFile
} from '../lib/agent-transcript.mjs';
import { runBuild } from '../lib/build.mjs';
import { verifyEvidenceChain } from '../lib/evidence.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { planMissionDefinitionFromPacket } from '../lib/missions.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { runtimeAgentStatus } from '../lib/runtime-agent.mjs';
import { runtimeStatus } from '../lib/runtime.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPLEMENTER = path.join(ROOT, 'factory', 'agents', 'implementer.mjs');
const INDEX = buildIndex();

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Minimal OpenAI-compatible upstream that replays a fixed tool-call script. */
function startScriptedUpstream(script) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const turn = calls.length % script.length;
      calls.push({ url: req.url, authorization: req.headers.authorization ?? null, body: JSON.parse(body || '{}') });
      const step = script[turn];
      const toolCalls = (step.toolCalls ?? []).map((tc, idx) => ({
        id: `call_${turn}_${idx}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) }
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-${turn}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: step.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
        }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VLD_')) continue;
    if (key.startsWith('NODE_TEST')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

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

test('P3.3 transcript digest verifies and detects tampering', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p33-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const entries = [
    {
      seq: 1,
      at: '2026-11-16T10:00:00.000Z',
      type: 'tool',
      tool: 'write_file',
      argsDigest: 'a'.repeat(64),
      resultDigest: 'b'.repeat(64),
      ok: true,
      durationMs: 5
    },
    {
      seq: 2,
      at: '2026-11-16T10:00:01.000Z',
      type: 'tool',
      tool: 'finish',
      argsDigest: 'c'.repeat(64),
      resultDigest: 'd'.repeat(64),
      ok: true
    }
  ].map((entry) => ({ ...entry, entryDigest: transcriptEntryDigest(entry) }));

  const digestValue = computeTranscriptDigest(entries);
  assert.match(digestValue, /^[a-f0-9]{64}$/);
  const lines = [...entries.map((e) => JSON.stringify(e)), JSON.stringify({ type: 'summary', transcriptDigest: digestValue, ok: true })];

  const clean = verifyAgentTranscript(lines.join('\n'));
  assert.equal(clean.ok, true, clean.errors.join('; '));
  assert.equal(clean.digest, digestValue);

  // Tamper with one recorded tool result digest -> verification fails.
  const tampered = [...entries];
  tampered[0] = { ...tampered[0], resultDigest: 'e'.repeat(64) };
  const badLines = [...tampered.map((e) => JSON.stringify(e)), JSON.stringify({ type: 'summary', transcriptDigest: digestValue, ok: true })];
  const bad = verifyAgentTranscript(badLines.join('\n'));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('; '), /entryDigest mismatch|summary transcriptDigest/);

  // harvestTranscripts moves artifacts out of a workspace.
  const from = path.join(dir, 'ws', '.vld', 'agent-transcripts');
  const to = path.join(dir, 'project', '.vld', 'agent-transcripts');
  mkdirSync(from, { recursive: true });
  writeFileSync(path.join(from, 'run-1.jsonl'), lines.join('\n'), 'utf8');
  const moved = harvestTranscripts({ from, to, runId: 'run-1' });
  assert.equal(moved.length, 1);
  assert.equal(existsSync(path.join(from, 'run-1.jsonl')), false);
  assert.equal(verifyAgentTranscriptFile(path.join(to, 'run-1.jsonl')).ok, true);
});

test('P3.3 model egress is broker-only for live models, offline for cassettes and command', () => {
  assert.equal(agentModelBrokerSpec({ modelSpec: null }), null);
  assert.equal(agentModelBrokerSpec({ modelSpec: 'command:shim' }), null);
  assert.equal(agentModelBrokerSpec({ modelSpec: 'anthropic:claude-sonnet-4-6', cassetteMode: 'replay' }), null);
  assert.equal(agentModelBrokerSpec({ modelSpec: 'openai:gpt-5.2', env: { VLD_MODEL_NO_BROKER: '1' } }), null);

  const live = agentModelBrokerSpec({ modelSpec: 'anthropic:claude-sonnet-4-6', env: {} });
  assert.equal(live.provider, 'anthropic');
  assert.equal(live.model, 'claude-sonnet-4-6');
  assert.equal(live.budget.maxCalls > 0, true);

  const withBase = agentModelBrokerSpec({ modelSpec: 'openai:gpt-5.2:https://proxy.internal/v1', env: {} });
  assert.equal(withBase.provider, 'openai');
  assert.equal(withBase.model, 'gpt-5.2');
  assert.equal(withBase.baseUrl, 'https://proxy.internal/v1');
});

test('P3.3 tool loop completes against a cassette with write-glob and allow-list enforcement', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p33-loop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const FIXED_APP = 'export function add(a, b) {\n  return a + b;\n}\n';
  const TESTS_APP = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/app.js';",
    '',
    "test('adds numbers', () => {",
    '  assert.equal(add(2, 3), 5);',
    '});',
    ''
  ].join('\n');

  const script = [
    { toolCalls: [{ name: 'read_file', input: { path: 'src/app.js' } }] },
    { toolCalls: [{ name: 'write_file', input: { path: 'src/app.js', content: FIXED_APP } }] },
    { toolCalls: [{ name: 'write_file', input: { path: 'tests/app.test.mjs', content: TESTS_APP } }] },
    { toolCalls: [{ name: 'write_file', input: { path: 'secret.txt', content: 'exfiltrate' } }] },
    { toolCalls: [{ name: 'run_command', input: { command: 'rm -rf /' } }] },
    { toolCalls: [{ name: 'run_tests', input: {} }] },
    { toolCalls: [{ name: 'finish', input: { summary: 'implemented add()', success: true } }] }
  ];

  function seedWorkspace(name) {
    const ws = path.join(dir, name);
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    mkdirSync(path.join(ws, 'tests'), { recursive: true });
    // `type: module` keeps src/app.js ESM on Node 22.0, which predates the
    // default module-syntax detection of later 22.x releases. Without it the
    // run_tests leg fails differently per Node line and the cassette diverges.
    writeFileSync(path.join(ws, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(path.join(ws, 'src', 'app.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
    return ws;
  }

  const cassetteDir = path.join(dir, 'cassettes');
  const shared = ['--write-globs', 'src/**,tests/**', '--test-cmd', JSON.stringify({ executable: process.execPath, args: ['tests/app.test.mjs'] }), '--max-steps', '12'];

  // Phase A: RECORD against the scripted upstream (auth via token env).
  const upstream = await startScriptedUpstream(script);
  t.after(() => upstream.close());
  const wsRecord = seedWorkspace('record-ws');
  const recorded = await runImplementer({
    workspace: wsRecord,
    model: `openai:test-model:${upstream.url}/v1`,
    cassetteDir,
    cassetteMode: 'record',
    env: { VLD_MODEL_TOKEN_ENV: 'VLD_OPENAI_API_KEY', VLD_OPENAI_API_KEY: 'sk-record-test', VLD_RUN_ID: 'loop-record' },
    args: [...shared, '--allow-cmd', 'node --version']
  });
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.equal(readdirSync(cassetteDir).length, script.length, 'one cassette entry per model call');

  // Phase B: REPLAY with no upstream, no API key — cassette only.
  const wsReplay = seedWorkspace('replay-ws');
  const replayed = await runImplementer({
    workspace: wsReplay,
    model: 'openai:test-model',
    cassetteDir,
    cassetteMode: 'replay',
    env: { VLD_RUN_ID: 'loop-replay' },
    args: [...shared, '--allow-cmd', 'node --version']
  });
  assert.equal(replayed.code, 0, `${replayed.stderr}\ncassette entries: ${readdirSync(cassetteDir).map((f) => f.slice(0, 12)).join(', ')}\nreplay transcript: ${existsSync(path.join(wsReplay, '.vld', 'agent-transcripts', 'loop-replay.jsonl')) ? readFileSync(path.join(wsReplay, '.vld', 'agent-transcripts', 'loop-replay.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).tool ?? 'summary').join(' -> ') : 'none'}\nrecord transcript: ${existsSync(path.join(wsRecord, '.vld', 'agent-transcripts', 'loop-record.jsonl')) ? readFileSync(path.join(wsRecord, '.vld', 'agent-transcripts', 'loop-record.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).tool ?? 'summary').join(' -> ') : 'none'}`);
  assert.equal(upstream.calls.length, script.length, 'replay phase made zero live calls');

  // Workspace effects: fixed source, tests written, denials held.
  assert.equal(readFileSync(path.join(wsReplay, 'src', 'app.js'), 'utf8'), FIXED_APP);
  assert.equal(readFileSync(path.join(wsReplay, 'tests', 'app.test.mjs'), 'utf8'), TESTS_APP);
  assert.equal(existsSync(path.join(wsReplay, 'secret.txt')), false, 'write outside the write globs must be denied');

  // Transcript verifies and records the full tool sequence.
  const summary = JSON.parse(readFileSync(path.join(wsReplay, '.vld', 'agent-transcripts', 'loop-replay.summary.json'), 'utf8'));
  assert.equal(summary.ok, true);
  assert.equal(summary.finish.success, true);
  const transcript = verifyAgentTranscriptFile(path.join(wsReplay, '.vld', 'agent-transcripts', 'loop-replay.jsonl'));
  assert.equal(transcript.ok, true, transcript.errors.join('; '));
  assert.equal(transcript.digest, summary.transcriptDigest);
  const toolSequence = transcript.entries.map((entry) => entry.tool);
  assert.deepEqual(toolSequence, ['read_file', 'write_file', 'write_file', 'write_file', 'run_command', 'run_tests', 'finish']);
});

test('P3.3 hard step limit aborts the loop and records the reason', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p33-limits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const ws = path.join(dir, 'ws');
  mkdirSync(path.join(ws, 'src'), { recursive: true });
  const cassetteDir = path.join(dir, 'cassettes');
  const script = [{ toolCalls: [{ name: 'write_file', input: { path: 'src/scribble.txt', content: 'more' } }] }];

  const upstream = await startScriptedUpstream(script);
  t.after(() => upstream.close());
  const run = await runImplementer({
    workspace: ws,
    model: `openai:test-model:${upstream.url}/v1`,
    cassetteDir,
    cassetteMode: 'record',
    env: { VLD_MODEL_TOKEN_ENV: 'VLD_OPENAI_API_KEY', VLD_OPENAI_API_KEY: 'sk-record-test' },
    args: ['--write-globs', '**', '--max-steps', '1']
  });
  assert.equal(run.code, 1, run.stderr);
  const summaries = readdirSync(path.join(ws, '.vld', 'agent-transcripts')).filter((f) => f.endsWith('.summary.json'));
  assert.equal(summaries.length, 1);
  const summary = JSON.parse(readFileSync(path.join(ws, '.vld', 'agent-transcripts', summaries[0]), 'utf8'));
  assert.equal(summary.ok, false);
  assert.match(String(summary.limitError), /step limit exceeded/);
});

test('P3.3 acceptance: Todo CLI from Test F builds green with adapter sandboxed-agent against a cassette', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-p33-accept-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proj = path.join(dir, 'todo-cli');

  // --- Fixture: the Test F todo CLI whose done() is broken. -----------------
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
  writeFileSync(path.join(proj, 'profile.json'), `${JSON.stringify(rawProfile, null, 2)}\n`, 'utf8');
  mkdirSync(path.join(proj, 'src'), { recursive: true });
  writeFileSync(path.join(proj, '.gitignore'), '.vld/\n', 'utf8');

  const BROKEN_TODO = [
    'export class TodoList {',
    '  constructor() {',
    '    this.items = [];',
    '  }',
    '  add(text) {',
    '    this.items.push({ text, done: false });',
    '    return this.items.length;',
    '  }',
    '  list() {',
    '    return this.items.map((item) => ({ ...item }));',
    '  }',
    '  done(index) {',
    '    if (index < 0 || index >= this.items.length) return false;',
    '    this.items[index].done = false;',
    '    return true;',
    '  }',
    '}',
    'export default TodoList;',
    ''
  ].join('\n');

  const FIXED_TODO = BROKEN_TODO.replace('this.items[index].done = false;', 'this.items[index].done = true;');
  writeFileSync(path.join(proj, 'src', 'todo.mjs'), BROKEN_TODO, 'utf8');

  const plan = buildPlan(normalizeProfile(rawProfile), { index: INDEX });
  emitPacket(plan, path.join(proj, 'specs'), { force: true, packetDir: 'specs' });
  git(proj, ['add', '-A']);
  git(proj, ['commit', '-qm', 'initial']);

  // Anchored tests covering every automated packet requirement (built from the
  // actual packet so the fixture stays green through spec-check).
  const packetSpec = JSON.parse(readFileSync(path.join(proj, 'specs', 'spec.json'), 'utf8'));
  const automated = packetSpec.requirements.filter((r) => r.verify === 'automated');
  assert.ok(automated.length >= 1, 'packet has automated requirements');
  const behaviors = [
    { title: 'records added items', body: "  const list = new TodoList();\n  list.add('ship it');\n  assert.equal(list.list().length, 1);" },
    { title: 'marks items done', body: "  const list = new TodoList();\n  list.add('ship it');\n  list.done(0);\n  assert.equal(list.list()[0].done, true);" },
    { title: 'rejects unknown indices', body: '  const list = new TodoList();\n  assert.equal(list.done(7), false);' },
    { title: 'keeps items independent', body: "  const list = new TodoList();\n  list.add('a');\n  list.add('b');\n  list.done(1);\n  assert.equal(list.list()[0].done, false);\n  assert.equal(list.list()[1].done, true);" }
  ];
  const TESTS_TODO = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { TodoList } from '../src/todo.mjs';",
    '',
    ...automated.flatMap((req, i) => {
      const b = behaviors[i % behaviors.length];
      return [`// @req ${req.id}`, `test('${req.id} ${b.title}', () => {`, b.body, '});', ''];
    })
  ].join('\n');

  const testCommand = { id: 'todo-tests', executable: process.execPath, args: ['tests/todo.test.mjs'], timeoutMs: 30_000 };
  const definition = planMissionDefinitionFromPacket({ packetDir: path.join(proj, 'specs') });
  const defaultClaims = definition.workPackages[0].resourceClaims.paths.join(',');
  const cassetteDir = path.join(dir, 'cassettes');

  const script = [
    { toolCalls: [{ name: 'read_file', input: { path: 'src/todo.mjs' } }] },
    { toolCalls: [{ name: 'write_file', input: { path: 'src/todo.mjs', content: FIXED_TODO } }] },
    { toolCalls: [{ name: 'write_file', input: { path: 'tests/todo.test.mjs', content: TESTS_TODO } }] },
    { toolCalls: [{ name: 'run_tests', input: {} }] },
    { toolCalls: [{ name: 'finish', input: { summary: 'fixed done() and added anchored tests', success: true } }] }
  ];

  // --- Record one cassette conversation per planned work package. ----------
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
      args: [
        '--packet', 'specs',
        '--write-globs', defaultClaims,
        '--test-cmd', JSON.stringify(testCommand),
        '--max-steps', '12'
      ]
    });
    assert.equal(recorded.code, 0, `record for ${pkg.id} failed: ${recorded.stderr}`);
  }

  // --- Replay through the real build pipeline: `--adapter sandboxed-agent`. -
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
  const tSummaries = readdirSync(path.join(proj, '.vld', 'agent-transcripts'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => readdirSync(path.join(proj, '.vld', 'agent-transcripts', e.name)).filter((f) => f.endsWith('.summary.json')).map((f) => path.join(e.name, f)))
    .concat(readdirSync(path.join(proj, '.vld', 'agent-transcripts')).filter((f) => f.endsWith('.summary.json')))
    .map((f) => JSON.parse(readFileSync(path.join(proj, '.vld', 'agent-transcripts', f), 'utf8')));
  assert.equal(live.ok, true, JSON.stringify({ stages: live.packages.map((p) => `${p.packageId}:${p.stage}`), limits: tSummaries.map((s) => s.limitError ?? `ok=${s.ok}`), reqs: tSummaries.map((s) => (s.requestDigests ?? []).map((d) => String(d).slice(0, 12))), cassettes: readdirSync(cassetteDir).map((f) => f.slice(0, 12)) }, null, 2));
  assert.ok(live.packages.length >= 1);
  for (const pkg of live.packages) {
    assert.equal(pkg.verificationOutcome, 'passed', JSON.stringify(pkg));
    assert.equal(pkg.repairsUsed, 0, 'the cassette-driven fix must converge on the first attempt');
    assert.ok(pkg.candidateId, 'a delivery candidate was created');
  }

  // The shipped candidate (package-branch commit) carries the fixed source.
  assert.equal(readFileSync(path.join(proj, 'src', 'todo.mjs'), 'utf8'), BROKEN_TODO, 'project working tree stays untouched; the fix ships on the candidate');

  // Agent-run receipts carry verified transcript digests.
  assert.ok(live.missionFile, 'build report names the mission file');
  const agentStatus = runtimeAgentStatus({ missionFile: live.missionFile, projectDir: proj });
  assert.equal(agentStatus.ok, true, JSON.stringify(agentStatus, null, 2));
  const runs = (agentStatus.agentRuns ?? []).filter((r) => r.outcome === 'completed');
  assert.ok(runs.length >= live.packages.length, 'one completed agent run per package');
  const digests = [];
  for (const run of runs) {
    assert.match(String(run.transcriptDigest ?? ''), /^[a-f0-9]{64}$/, `agent run ${run.id} carries a transcript digest`);
    assert.ok(run.usage && run.usage.totalTokens > 0, 'agent run records token usage');
    digests.push(run.transcriptDigest);
    // The harvested transcript verifies against the recorded digest.
    const harvested = path.join(proj, '.vld', 'agent-transcripts', `${run.id}.jsonl`);
    assert.equal(existsSync(harvested), true, `transcript harvested for ${run.id}`);
    const verified = verifyAgentTranscriptFile(harvested);
    assert.equal(verified.ok, true, verified.errors.join('; '));
    assert.equal(verified.digest, run.transcriptDigest);
  }

  // Evidence chain carries the same digest.
  const chain = verifyEvidenceChain({ projectDir: proj });
  assert.equal(chain.ok, true, JSON.stringify(chain.errors ?? []));
  const ledger = readFileSync(path.join(proj, '.vld', 'evidence', 'evidence.jsonl'), 'utf8');
  const transcriptEntries = ledger.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.kind === 'agent-transcript');
  assert.equal(transcriptEntries.length, runs.length, 'one evidence entry per agent run');
  for (const entry of transcriptEntries) {
    assert.ok(digests.includes(entry.payload.transcriptDigest), 'evidence payload carries a verified transcript digest');
  }

  // The delivery candidate carries the transcript digest and the fixed source.
  const status = runtimeStatus({ missionFile: live.missionFile, projectDir: proj });
  const serialized = JSON.stringify(status);
  assert.ok(digests.some((d) => serialized.includes(d)), 'runtime delivery candidate records the transcript digest');
  const candidateSha = String(serialized.match(/"candidateSha":"([a-f0-9]{40})"/)?.[1] ?? '');
  assert.match(candidateSha, /^[a-f0-9]{40}$/, 'delivery candidate records a commit sha');
  assert.equal(git(proj, ['show', `${candidateSha}:src/todo.mjs`]), FIXED_TODO.trimEnd(), 'candidate commit contains the fixed done()');
  assert.ok(git(proj, ['show', `${candidateSha}:tests/todo.test.mjs`]).includes('@req REQ-'), 'candidate commit contains anchored tests');
});
