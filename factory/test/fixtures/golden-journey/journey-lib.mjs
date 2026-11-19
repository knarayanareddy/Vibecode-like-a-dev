/**
 * Shared fixtures and helpers for the P4.1 golden-journey E2E (record + replay).
 *
 * The journey runs the documented pipeline end to end in a throwaway project:
 *   paragraph -> vld intake -> accept -> plan/compile -> packet commit ->
 *   mission init -> vld build (sandboxed-agent, cassette) -> verify --run ->
 *   review -> delivery approve/queue -> forge execute (loopback GitHub stub +
 *   local bare git remote) -> evidence verify.
 *
 * Determinism: every git commit uses fixed author/committer dates, so commit
 * SHAs — and therefore the review packet the reviewer model sees — are byte
 * identical between the recording pass and the replay pass.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(FIXTURE_DIR, '..', '..', '..', '..');
export const CLI = path.join(ROOT, 'factory', 'cli.mjs');
export const PARAGRAPH = readFileSync(path.join(FIXTURE_DIR, 'paragraph.md'), 'utf8').trim();

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Golden Bot',
  GIT_AUTHOR_EMAIL: 'golden@vld.test',
  GIT_COMMITTER_NAME: 'Golden Bot',
  GIT_COMMITTER_EMAIL: 'golden@vld.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00 +0000',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00 +0000'
};

/** Second and third commits reuse incremented fixed dates so SHAs stay stable. */
export function gitEnv(second = 0) {
  const stamp = `2026-01-01T00:00:0${second} +0000`;
  return { ...GIT_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
}

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VLD_') || key.startsWith('NODE_TEST')) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export async function runCli(args, { cwd, env = {} } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      env: cleanEnv(env),
      maxBuffer: 16 * 1024 * 1024
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

export async function git(cwd, args, env = gitEnv()) {
  const { stdout } = await execFileAsync('git', args, { cwd, env: cleanEnv(env) });
  return stdout.trim();
}

/**
 * Throwaway project: a local bare remote plus a clone that serves as the
 * project checkout, seeded with a README and a detectable node test runner.
 */
export async function makeProject(root) {
  const remote = path.join(root, 'remote.git');
  const project = path.join(root, 'project');
  mkdirSync(root, { recursive: true });
  await git(root, ['init', '-q', '--bare', remote]);
  await git(root, ['init', '-q', project]);
  await git(project, ['config', 'user.email', GIT_ENV.GIT_AUTHOR_EMAIL]);
  await git(project, ['config', 'user.name', GIT_ENV.GIT_AUTHOR_NAME]);
  await git(project, ['remote', 'add', 'origin', remote]);
  writeFileSync(path.join(project, 'README.md'), '# Meridian\n', 'utf8');
  writeFileSync(
    path.join(project, 'package.json'),
    `${JSON.stringify({ name: 'meridian', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node tests/app.test.mjs' } }, null, 2)}\n`,
    'utf8'
  );
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-qm', 'init'], gitEnv(0));
  await git(project, ['push', '-q', 'origin', 'HEAD:main'], gitEnv(0));
  return { remote, project };
}

/** Minimal OpenAI-compatible upstream that replays a scripted turn sequence. */
export async function startScriptedUpstream(script) {
  let turn = 0;
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const step = script[turn % script.length];
      turn += 1;
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

/**
 * Loopback GitHub REST stub for `runtime forge execute`. Captures every call
 * so tests can assert the PR metadata, and keeps head/base identity consistent
 * across create + re-fetch exactly like the real API.
 */
export async function startGitHubStub() {
  const captured = [];
  const state = { created: null, headSha: null };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const send = (obj) => {
        captured.push({ method: req.method, url: req.url, body: parsed, response: obj });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const prIdentity = () => ({
        number: 7,
        html_url: 'https://github.com/acme/meridian/pull/7',
        state: 'open',
        draft: false,
        head: { ref: state.created.head, sha: state.headSha },
        base: { ref: state.created.base, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
      });
      if (req.method === 'POST' && /\/pulls$/.test(req.url)) {
        state.created = { head: parsed.head, base: parsed.base };
        send({ ...prIdentity() });
      } else if (/\/pulls\/\d+$/.test(req.url)) {
        send({ ...prIdentity(), merged: false, mergeable: true });
      } else if (/\/reviews/.test(req.url)) {
        send([]);
      } else if (/\/comments/.test(req.url)) {
        send({ id: 901, comment_id: 901, html_url: 'https://github.com/acme/meridian/pull/7#issuecomment-901' });
      } else if (/\/merge$/.test(req.url)) {
        send({ merged: true, sha: state.headSha });
      } else {
        send({});
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        captured,
        /** The forge identity check compares the PR head sha against the plan. */
        setHeadSha(sha) { state.headSha = sha; },
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Scripted model replies (recorded verbatim into the checked-in cassettes).
// ---------------------------------------------------------------------------

/** Intake extraction: every evidence quote is a verbatim substring of paragraph.md. */
export const INTAKE_REPLY = JSON.stringify({
  name: { value: 'Meridian', evidence: 'Meridian is an internal equipment-maintenance ticket API', confidence: 0.95 },
  kind: { value: 'api', evidence: 'equipment-maintenance ticket API', confidence: 0.95 },
  stage: { value: 'mvp', evidence: 'Technicians create tickets for broken equipment', confidence: 0.55, question: 'What delivery stage are you targeting (prototype, mvp, internal-tool, or production)?' },
  scale: { value: 'small', evidence: 'a campus facilities team', confidence: 0.8 },
  stack: { value: 'node', evidence: 'a campus facilities team', confidence: 0.4, question: 'What implementation stack should the build target?' },
  traits: [{ value: 'persistence', evidence: 'the technician records one repair note when resolving a ticket', confidence: 0.75 }],
  risks: {},
  regulation: [],
  rules: [
    { value: 'Every ticket must include an equipment category.', evidence: 'Every ticket must include an equipment category.', confidence: 0.95 },
    { value: 'Exactly one repair note must be recorded before a ticket can be resolved.', evidence: 'Exactly one repair note must be recorded before a ticket can be resolved.', confidence: 0.95 },
    { value: 'The weekly report must group resolved tickets by equipment category.', evidence: 'The weekly report must group resolved tickets by equipment category.', confidence: 0.95 }
  ]
});

export const IMPLEMENTER_APP = `// Meridian ticket service.
export const RULES = {
  'ticket-category-required': 'Every ticket must include an equipment category.',
  'single-repair-note': 'Exactly one repair note must be recorded before a ticket can be resolved.',
  'weekly-category-report': 'The weekly report must group resolved tickets by equipment category.'
};

export function createTicket(description, category, technician) {
  if (!category) throw new Error('category-required');
  return { description, category, technician, state: 'open', repairNote: null };
}

export function assignTicket(ticket, technician) {
  return { ...ticket, technician, state: 'assigned' };
}

export function resolveTicket(ticket, repairNote) {
  if (!repairNote) throw new Error('repair-note-required');
  return { ...ticket, repairNote, state: 'resolved' };
}

export function persist(ticket) {
  return JSON.stringify(ticket);
}

export function restore(text) {
  return JSON.parse(text);
}

export function weeklyReport(tickets) {
  const byCategory = {};
  for (const ticket of tickets.filter((entry) => entry.state === 'resolved')) {
    byCategory[ticket.category] = (byCategory[ticket.category] ?? 0) + 1;
  }
  return byCategory;
}
`;

export const IMPLEMENTER_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES,
  assignTicket,
  createTicket,
  persist,
  resolveTicket,
  restore,
  weeklyReport
} from '../src/app.js';

// @req REQ-002
test('the primary journey works end to end', () => {
  const open = createTicket('Pump 3 leaking', 'hvac', 'dana');
  const assigned = assignTicket(open, 'eli');
  const resolved = resolveTicket(assigned, 'replaced gasket');
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.technician, 'eli');
  assert.equal(resolved.repairNote, 'replaced gasket');
});

// @req REQ-004
test('tickets and repair notes survive a service restart', () => {
  const resolved = resolveTicket(createTicket('Door jammed', 'doors', 'ana'), 'oiled hinge');
  assert.deepEqual(restore(persist(resolved)), resolved);
});

// @req REQ-003
test("the product's own rules are named and pinned", () => {
  assert.equal(Object.keys(RULES).length, 3);
  assert.equal(RULES['ticket-category-required'], 'Every ticket must include an equipment category.');
});

// @req REQ-C02
test('every ticket must include an equipment category', () => {
  assert.throws(() => createTicket('missing category', '', 'ana'), /category-required/);
});

// @req REQ-C01
test('exactly one repair note is required before resolution', () => {
  const open = createTicket('Filter clogged', 'hvac', 'ana');
  assert.throws(() => resolveTicket(open, ''), /repair-note-required/);
  assert.equal(resolveTicket(open, 'flushed filter').state, 'resolved');
});

// @req REQ-C03
test('the weekly report groups resolved tickets by equipment category', () => {
  const resolvedA = resolveTicket(createTicket('a', 'hvac', 'ana'), 'fixed');
  const resolvedB = resolveTicket(createTicket('b', 'hvac', 'ana'), 'fixed');
  const resolvedC = resolveTicket(createTicket('c', 'doors', 'ana'), 'fixed');
  const open = createTicket('still open', 'hvac', 'ana');
  assert.deepEqual(weeklyReport([resolvedA, resolvedB, resolvedC, open]), { hvac: 2, doors: 1 });
});
`;

/** One tool-loop script for the implementer cassette: write app + tests, run, finish. */
export function implementerScript() {
  return [
    { content: '', toolCalls: [{ name: 'write_file', input: { path: 'src/app.js', content: IMPLEMENTER_APP } }] },
    { content: '', toolCalls: [{ name: 'write_file', input: { path: 'tests/app.test.mjs', content: IMPLEMENTER_TESTS } }] },
    { content: '', toolCalls: [{ name: 'run_tests', input: {} }] },
    { content: '', toolCalls: [{ name: 'finish', input: { summary: 'Implemented the Meridian ticket API with anchored tests', success: true } }] }
  ];
}

/** Reviewer reply: clean six-category report, no findings. */
export const REVIEWER_REPLY = JSON.stringify({
  categories: {
    scope: [],
    coverage: [],
    failurePaths: [],
    assertionStrength: [],
    boundaries: [],
    reversibility: []
  },
  testWeakeningJustified: false
});

// Run the test file directly: the bare `--test` runner spawns child processes,
// which the sandboxed verification's permission model denies (P3.3).
export const TEST_CMD = { executable: process.execPath, args: ['tests/app.test.mjs'] };

/** Merge a planned definition into one work package so the golden journey runs
 * a single candidate through delivery (the packet checks all automated anchors
 * in every worktree regardless of assignment). */
export function singlePackageDefinition(definition) {
  const requirements = [...new Set((definition.workPackages ?? []).flatMap((p) => p.requirements ?? []))].sort();
  const paths = [...new Set((definition.workPackages ?? []).flatMap((p) => p.resourceClaims?.paths ?? []))].sort();
  return {
    ...definition,
    workPackages: [{
      id: 'pkg-core',
      title: 'Implement and verify the Meridian ticket API',
      requirements,
      dependsOn: [],
      resourceClaims: { paths }
    }]
  };
}
