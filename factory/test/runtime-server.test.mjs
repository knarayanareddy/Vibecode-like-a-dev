import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createMission } from '../lib/missions.mjs';
import { initializeRuntime } from '../lib/runtime.mjs';
import { createRuntimeServer, listenRuntimeServer } from '../lib/runtime-server.mjs';
import { createRuntimeClient } from '../lib/runtime-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const run = promisify(execFile);

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
  const typedClient = createRuntimeClient({ endpoint: `http://127.0.0.1:${address.port}`, token: operatorProof });
  const typedStatus = await typedClient.request('status', {}, { requestId: 'typed-status-0001' });
  assert.deepEqual(typedStatus.runtime, status.body.result.runtime, 'the typed client and local HTTP transport expose the same Runtime status contract');
  assert.ok(Array.isArray(typedStatus.recentEvents), 'status names its bounded window explicitly');
  const historic = await typedClient.request('events', { limit: 1, maxBytes: 4096 }, { requestId: 'typed-events-0001' });
  assert.equal(historic.events.length, 1);
  assert.equal(historic.page.truncated, false);
  const invalidEvents = await request('request-events-invalid-0001', 'events', { after: -1 });
  assert.equal(invalidEvents.status, 400);
  assert.equal(invalidEvents.body.error.code, 'INVALID_RUNTIME_EVENT_CURSOR');
  const remoteCli = await run(process.execPath, [CLI, 'runtime', 'status', '--runtime-url', `http://127.0.0.1:${address.port}`, '--runtime-token', operatorProof, '--json']);
  assert.deepEqual(JSON.parse(remoteCli.stdout).runtime, typedStatus.runtime, 'the CLI remote-client form has local HTTP parity without accepting a mission path');
  const remoteEvents = await run(process.execPath, [CLI, 'runtime', 'events', '--runtime-url', `http://127.0.0.1:${address.port}`, '--runtime-token', operatorProof, '--limit', '1', '--json']);
  assert.equal(JSON.parse(remoteEvents.stdout).events.length, 1, 'remote event history uses the endpoint identity and no mission positional');

  const firstAllocation = await request('request-0004-first-allocation', 'allocate', { packageId: 'api-work', assignee: { role: 'implementer', id: 'agent-alpha' }, leaseMs: 10_000 });
  assert.equal(firstAllocation.status, 200);
  assert.match(firstAllocation.body.result.leaseToken, /^lease-/);
  const allocationReplay = await request('request-0004-first-allocation', 'allocate', { packageId: 'api-work', assignee: { role: 'implementer', id: 'agent-alpha' }, leaseMs: 10_000 });
  assert.equal(allocationReplay.status, 200);
  assert.equal(allocationReplay.body.result.changed, false);
  assert.equal(allocationReplay.body.result.leaseToken, null, 'a generated capability is intentionally never recovered from the ledger');
  assert.match(allocationReplay.body.result.leaseTokenRecovery, /one-time capability/);

  const impersonation = await request('request-0005', 'transition', { packageId: 'api-work', to: 'approved', expectedVersion: 1 });
  assert.equal(impersonation.status, 400);
  assert.equal(impersonation.body.error.code, 'RUNTIME_RECEIPT_REQUIRED', 'generic API cannot manufacture an approval state');

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

test('Runtime API drains an oversized chunked request and returns the documented JSON 413 envelope', async (t) => {
  const fixture = runtimeFixture(t);
  const operatorProof = 'oversize-fixture-token-12345';
  const { server } = createRuntimeServer({ missionFile: fixture.missionFile, projectDir: fixture.project, identities: { [operatorProof]: { role: 'operator', id: 'local-operator' } } });
  t.after(() => server.close());
  const { port } = await listenRuntimeServer(server, { host: '127.0.0.1', port: 0 });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/runtime', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorProof}` } }, (incoming) => {
      let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', (part) => { raw += part; }); incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(raw) }));
    });
    request.on('error', reject);
    request.write('{"schemaVersion":1,"requestId":"oversize-0001","method":"status","params":{"padding":"');
    request.write('x'.repeat(70 * 1024));
    request.end('"}}');
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'RUNTIME_REQUEST_TOO_LARGE');
});

test('Runtime HTTP conformance covers OPTIONS, missing routes, unsupported methods, recovery, and lease heartbeat', async (t) => {
  const fixture = runtimeFixture(t); const proof = 'http-paths-fixture-token-12345'; const workerProof = 'http-paths-worker-token-12345';
  const { server } = createRuntimeServer({ missionFile: fixture.missionFile, projectDir: fixture.project, identities: { [proof]: { role: 'operator', id: 'local-operator' }, [workerProof]: { role: 'implementer', id: 'agent-alpha' } } });
  t.after(() => server.close()); const { port } = await listenRuntimeServer(server, { host: '127.0.0.1', port: 0 });
  const raw = (method, pathname, headers = {}, payload = '') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (incoming) => { let body = ''; incoming.setEncoding('utf8'); incoming.on('data', (part) => { body += part; }); incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: body ? JSON.parse(body) : null })); }); request.on('error', reject); request.end(payload);
  });
  const optionsMissing = await raw('OPTIONS', '/v1/runtime'); assert.equal(optionsMissing.status, 403); assert.equal(optionsMissing.body.error.code, 'RUNTIME_ORIGIN_FORBIDDEN');
  const options = await raw('OPTIONS', '/v1/runtime', { origin: `http://127.0.0.1:${port}` }); assert.equal(options.status, 204); assert.equal(options.headers['access-control-allow-methods'], 'POST');
  const missing = await raw('GET', '/no-such-route'); assert.equal(missing.status, 404); assert.equal(missing.body.error.code, 'RUNTIME_ROUTE_NOT_FOUND');
  const unsupported = await raw('PUT', '/v1/runtime'); assert.equal(unsupported.status, 404); assert.equal(unsupported.body.error.code, 'RUNTIME_ROUTE_NOT_FOUND');
  const call = (requestId, method, params, token = proof) => post({ port, token, body: { schemaVersion: 1, requestId, method, params } });
  const allocated = await call('paths-allocate-0001', 'allocate', { packageId: 'api-work', assignee: { role: 'implementer', id: 'agent-alpha' }, leaseMs: 10_000 });
  assert.equal(allocated.status, 200);
  const heartbeat = await call('paths-heartbeat-0001', 'heartbeat', { packageId: 'api-work', runId: allocated.body.result.allocation.run.id, leaseToken: allocated.body.result.leaseToken, leaseMs: 10_000 }, workerProof);
  assert.equal(heartbeat.status, 200); assert.equal(heartbeat.body.ok, true);
  const recovered = await call('paths-recover-0001', 'recover', {}); assert.equal(recovered.status, 200); assert.equal(recovered.body.ok, true);
});


test('Runtime status projects degraded catalog state without exposing its project path', async (t) => {
  const fixture = runtimeFixture(t); const proof = 'catalog-projection-token-12345';
  writeFileSync(path.join(fixture.project, '.vld', 'catalog.json'), '{"schemaVersion":1,"catalogs":[]}\n');
  const { server } = createRuntimeServer({ missionFile: fixture.missionFile, projectDir: fixture.project, identities: { [proof]: { role: 'operator', id: 'local-operator' } } });
  t.after(() => server.close()); const { port } = await listenRuntimeServer(server, { host: '127.0.0.1', port: 0 });
  const response = await post({ port, token: proof, body: { schemaVersion: 1, requestId: 'catalog-projection-0001', method: 'status', params: {} } });
  assert.equal(response.status, 200); const catalog = response.body.result.studio.catalog;
  assert.equal(catalog.ok, false); assert.ok(Array.isArray(catalog.errors));
  assert.equal(JSON.stringify(catalog).includes(fixture.project), false);
});
