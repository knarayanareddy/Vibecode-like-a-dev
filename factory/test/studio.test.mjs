/** M6 Studio security/unit contract: local HTML is static and VS Code input is closed. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { studioContentSecurityPolicy, studioDashboardScript, studioHtml } from '../lib/studio.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const extension = require(path.join(ROOT, 'factory', 'studio', 'vscode', 'extension.cjs'));

test('M6 public CLI exposes Studio with clean usage failure rather than attempting a local command', () => {
  const result = spawnSync(process.execPath, [CLI, 'studio', 'serve'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: vld studio serve/);
  assert.equal(result.stderr.includes('Error:'), false);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vld studio serve/);
});

test('M6 dashboard uses a nonce CSP, never interpolates Runtime fields as HTML, and keeps token storage ephemeral', () => {
  const nonce = 'unit-test-nonce';
  const csp = studioContentSecurityPolicy(nonce);
  const page = studioHtml(nonce);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-unit-test-nonce'/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(page.includes('localStorage'), false);
  assert.equal(page.includes('sessionStorage'), false);
  assert.equal(studioDashboardScript().includes('innerHTML'), false);
  assert.match(studioDashboardScript(), /textContent/);
  assert.match(studioDashboardScript(), /codePointAt/);
  assert.match(page, /type="password"/);
});

test('Studio renders forge receipts as a disabled-merge provider plan, not as a generic delivery outcome', () => {
  const script = studioDashboardScript();
  assert.match(script, /item\.forge/);
  assert.match(script, /Forge plan/);
  assert.match(script, /Repository/);
  assert.match(script, /Head ref/);
  assert.match(script, /Base ref/);
  assert.match(script, /Required checks/);
  assert.match(script, /Merge request/);
  assert.match(script, /plan\.allowMergeRequest \? 'allowed' : 'disabled'/);
});

test('Studio browser program renders an authoritative forge plan receipt into DOM fields', async () => {
  class Node {
    constructor() { this.children = []; this.listeners = new Map(); this.textContent = ''; this.value = ''; this.disabled = false; this.className = ''; }
    get firstChild() { return this.children[0] ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
  }
  const ids = ['token', 'connect', 'refresh', 'connection', 'mission', 'packages', 'runs', 'evidence', 'package-id', 'assignee', 'lease-ms', 'allocate', 'recover'];
  const nodes = Object.fromEntries(ids.map((id) => [id, new Node()]));
  const status = {
    ok: true,
    runtime: { missionId: 'mission-fixture', packetDigest: 'packet', corePolicyDigest: 'policy', sequence: 42 }, mission: { current: true }, packages: [], agentRuns: [], warnings: [],
    studio: { actions: { allocate: false, recover: false }, actor: { role: 'reviewer', id: 'fixture' } },
    delivery: [{ packageId: 'delivery-work', forge: {
      id: 'forge-fixture', candidateSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64), exportedAt: '2026-11-02T00:00:00.000Z',
      plan: { provider: 'github-v1', repository: 'owner/repository', headRef: 'review/fixture', baseRef: 'main', title: 'Review fixture', requiredChecks: ['npm run check'], allowMergeRequest: false }
    } }]
  };
  const context = {
    document: { getElementById: (id) => nodes[id], createElement: () => new Node() },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, result: status }) }),
    crypto: { randomUUID: () => 'fixture-request' },
    globalThis: null,
    Error, JSON, String, Array, Number, Object, Promise, Set, Map
  };
  context.globalThis = context;
  vm.runInNewContext(studioDashboardScript(), context);
  nodes.token.value = 'ephemeral-token';
  await nodes.connect.listeners.get('click')();
  const flatten = (node) => [node.textContent, ...node.children.flatMap(flatten)].filter(Boolean).join(' ');
  const rendered = flatten(nodes.runs);
  assert.match(rendered, /Forge plan/);
  assert.match(rendered, /owner\/repository/);
  assert.match(rendered, /review\/fixture/);
  assert.match(rendered, /npm run check/);
  assert.match(rendered, /disabled/);
  assert.equal(rendered.includes('Outcome'), false, 'forge receipts are plans, not generic outcomes');
});

test('M6 VS Code bridge accepts only exact loopback Studio URLs and its WebView message schema is closed', () => {
  assert.equal(extension.loopbackStudioUrl('http://127.0.0.1:4312/studio')?.pathname, '/studio');
  assert.equal(extension.loopbackStudioUrl('http://localhost:4312/studio/')?.pathname, '/studio/');
  assert.equal(extension.loopbackStudioUrl('https://127.0.0.1:4312/studio'), null);
  assert.equal(extension.loopbackStudioUrl('http://attacker.invalid/studio'), null);
  assert.equal(extension.loopbackStudioUrl('http://127.0.0.1:4312/studio?token=secret'), null);
  assert.equal(extension.loopbackStudioUrl('http://secret@127.0.0.1:4312/studio'), null);
  assert.equal(extension.validWebviewMessage({ type: 'refresh' }), true);
  assert.equal(extension.validWebviewMessage({ type: 'refresh', command: 'shell' }), false);
  assert.equal(extension.validWebviewMessage({ type: 'approve' }), false);
  assert.equal(extension.safeRuntimeValue('<script>fake approval</script>\u202E'), '<script>fake approval</script>�');
  const webview = extension.panelHtml({ cspSource: 'vscode-webview://fixture' });
  assert.match(webview, /default-src 'none'/);
  assert.equal(webview.includes('localStorage'), false);
  assert.equal(webview.includes('innerHTML'), false);
});
