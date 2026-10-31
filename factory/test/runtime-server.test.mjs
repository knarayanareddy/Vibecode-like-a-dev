import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMission } from '../lib/missions.mjs';
import { initializeRuntime } from '../lib/runtime.mjs';
import { createRuntimeServer, listenRuntimeServer } from '../lib/runtime-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runtimeFixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-runtime-api-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  cpSync(PACKET, path.join(project, 'specs'), { recursive: true });
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'api@example.invalid']);
  git(project, ['config', 'user.name', 'Runtime API Test']);
  git(project, ['add', 'specs']);
  git(project, ['commit', '-qm', 'packet']);
  const requirements = JSON.parse(readFileSync(path.join(project, 'specs', 'spec.json'), 'utf8')).requirements.map((entry) => entry.id);
  const mission = createMission({
    projectDir: project,
    packetDir: 'specs',
    definition: { schemaVersion: 1, id: 'api-runtime', title: 'Exercise a local runtime API safely', workPackages: [{ id: 'api-work', title: 'Implement runtime API fixture behavior', requirements, dependsOn: [] }] }
  });
  const missionFile = path.relative(project, mission.file);
  initializeRuntime({ missionFile, projectDir: project });
  return { project, missionFile };
}

function get({ port, path = '/studio', origin = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: origin ? { origin } : {} }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { raw += part; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: raw }));
    });
    request.on('error', reject);
    request.end();
  });
}

function post({ port, token = null, body, origin = null }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/runtime',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {})
      }
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { raw += part; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(raw) }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('loopback Runtime API requires a local token, rejects hostile origins and never lets an operator impersonate a reviewer', async (t) => {
  const fixture = runtimeFixture(t);
  assert.throws(
    () => createRuntimeServer({ missionFile: fixture.missionFile, projectDir: fixture.project, host: '0.0.0.0' }),
    (error) => error.code === 'RUNTIME_NON_LOOPBACK_BIND'
  );
  // A deliberately short, non-secret test proof; production tokens are generated
  // per launch and never committed.
  const operatorProof = 'fixture-auth-12345';
  const { server } = createRuntimeServer({
    missionFile: fixture.missionFile,
    projectDir: fixture.project,
    identities: { [operatorProof]: { role: 'operator', id: 'local-operator' } }
  });
  t.after(() => server.close());
  const address = await listenRuntimeServer(server, { host: '127.0.0.1', port: 0 });
  const request = (requestId, method, params, extra = {}) => post({ port: address.port, token: operatorProof, body: { schemaVersion: 1, requestId, method, params }, ...extra });

  const missing = await post({ port: address.port, body: { schemaVersion: 1, requestId: 'request-0001', method: 'status', params: {} } });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'RUNTIME_UNAUTHORIZED');

  const hostileOrigin = await request('request-0002', 'status', {}, { origin: 'https://attacker.invalid' });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(hostileOrigin.body.error.code, 'RUNTIME_ORIGIN_FORBIDDEN');

  const status = await request('request-0003', 'status', {}, { origin: `http://127.0.0.1:${address.port}` });
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.headers['access-control-allow-origin'], `http://127.0.0.1:${address.port}`);
  assert.equal(JSON.stringify(status.body).includes(fixture.project), false, 'API status does not reveal host project paths');
  assert.equal(status.body.result.studio.actions.allocate, true, 'Studio receives advisory capabilities but Runtime stays authoritative');

  const allocated = await request('request-0004', 'allocate', { packageId: 'api-work', assignee: { role: 'implementer', id: 'agent-alpha' }, leaseMs: 10_000 });
  assert.equal(allocated.status, 200);
  assert.match(allocated.body.result.leaseToken, /^lease-/);

  const impersonation = await request('request-0005', 'transition', { packageId: 'api-work', to: 'approved', expectedVersion: 1 });
  assert.equal(impersonation.status, 400);
  assert.equal(impersonation.body.error.code, 'RUNTIME_ACTOR_FORBIDDEN');

  const badEnvelope = await request('request-0006', 'status', { surprise: true });
  assert.equal(badEnvelope.status, 400);
  assert.equal(badEnvelope.body.error.code, 'INVALID_RUNTIME_REQUEST');

  const closed = once(server, 'close');
  const stopped = await request('request-0007', 'shutdown', {});
  assert.equal(stopped.status, 200);
  await closed;
});

test('M6 serves a static loopback Studio shell with strict CSP and no Runtime token, project path or unsafe HTML sink', async (t) => {
  const fixture = runtimeFixture(t);
  const studioTokenProof = 'studio-fixture-token-12345';
  const { server } = createRuntimeServer({ missionFile: fixture.missionFile, projectDir: fixture.project, identities: { [studioTokenProof]: { role: 'operator', id: 'local-operator' } } });
  t.after(() => server.close());
  const address = await listenRuntimeServer(server, { host: '127.0.0.1', port: 0 });
  const page = await get({ port: address.port });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.body.includes(studioTokenProof), false);
  assert.equal(page.body.includes(fixture.project), false);
  assert.equal(page.body.includes('innerHTML'), false);
  assert.match(page.body, /textContent/);
  const hostile = await get({ port: address.port, origin: 'https://attacker.invalid' });
  assert.equal(hostile.status, 403);
  assert.match(hostile.body, /RUNTIME_ORIGIN_FORBIDDEN/);
});
