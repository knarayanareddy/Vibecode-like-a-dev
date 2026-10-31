/** M6 Studio security/unit contract: local HTML is static and VS Code input is closed. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
