/**
 * Loopback-only JSON API for the optional M3 Runtime host.
 *
 * It is intentionally a small control surface over Runtime operations, not a
 * general web server. It never serves project files, binds a LAN host, proxies
 * a model, runs a command or accepts a caller-selected filesystem path.
 */

import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extensionError, ID_PATTERN } from './extension-utils.mjs';
import { assertRuntimeActor } from './runtime-policy.mjs';
import { assertRuntimeRequest, runtimeFailure, runtimeSuccess } from './runtime-contracts.mjs';
import {
  allocateRuntimePackage,
  heartbeatRuntimeLease,
  recoverRuntime,
  runtimeStatus,
  transitionRuntimePackage
} from './runtime.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

function closedParams(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw extensionError(`${label} params must be an object`, 'INVALID_RUNTIME_REQUEST');
  for (const key of Object.keys(value)) if (!fields.has(key)) throw extensionError(`${label} params.${key} is not allowed`, 'INVALID_RUNTIME_REQUEST');
  return value;
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function loopbackOrigin(origin) {
  if (!origin) return null;
  let parsed;
  try { parsed = new URL(origin); } catch { return null; }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]') ? origin : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(extensionError('runtime request body exceeds 64 KiB', 'RUNTIME_REQUEST_TOO_LARGE'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response, status, value, origin = null) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(JSON.stringify(value)) };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

function actorMap(identities) {
  const normalized = new Map();
  for (const [token, actor] of Object.entries(identities ?? {})) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200 || /[\r\n\0]/.test(token)) throw extensionError('runtime API token is invalid', 'INVALID_RUNTIME_TOKEN');
    normalized.set(token, assertRuntimeActor(actor));
  }
  if (normalized.size === 0) throw extensionError('runtime API needs at least one local identity token', 'INVALID_RUNTIME_TOKEN');
  return normalized;
}

function authenticate(request, identities) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw extensionError('Runtime API requires a bearer token', 'RUNTIME_UNAUTHORIZED');
  const token = header.slice('Bearer '.length);
  for (const [candidate, actor] of identities) if (safeTokenEqual(token, candidate)) return actor;
  throw extensionError('Runtime API bearer token is invalid', 'RUNTIME_UNAUTHORIZED');
}

function dispatch({ request, actor, missionFile, projectDir, close }) {
  const params = request.params;
  switch (request.method) {
    case 'status':
      closedParams(params, new Set(), 'status');
      return runtimeStatus({ missionFile, projectDir });
    case 'allocate': {
      closedParams(params, new Set(['packageId', 'assignee', 'leaseMs']), 'allocate');
      if (!ID_PATTERN.test(String(params.packageId ?? ''))) throw extensionError('allocate params.packageId is invalid', 'INVALID_RUNTIME_REQUEST');
      return allocateRuntimePackage({ missionFile, projectDir, packageId: params.packageId, actor, assignee: params.assignee, leaseMs: params.leaseMs, idempotencyKey: request.requestId });
    }
    case 'heartbeat': {
      closedParams(params, new Set(['packageId', 'runId', 'leaseToken', 'leaseMs']), 'heartbeat');
      return heartbeatRuntimeLease({ missionFile, projectDir, packageId: params.packageId, runId: params.runId, leaseToken: params.leaseToken, actor, leaseMs: params.leaseMs, idempotencyKey: request.requestId });
    }
    case 'transition': {
      closedParams(params, new Set(['packageId', 'to', 'expectedVersion', 'leaseToken', 'reason']), 'transition');
      return transitionRuntimePackage({ missionFile, projectDir, packageId: params.packageId, to: params.to, actor, expectedVersion: params.expectedVersion, leaseToken: params.leaseToken ?? null, reason: params.reason ?? null, idempotencyKey: request.requestId });
    }
    case 'recover':
      closedParams(params, new Set(), 'recover');
      if (!['operator', 'runtime'].includes(actor.role)) throw extensionError('only local operator/runtime identity may recover Runtime state', 'RUNTIME_ACTOR_FORBIDDEN');
      return recoverRuntime({ missionFile, projectDir });
    case 'shutdown':
      closedParams(params, new Set(), 'shutdown');
      if (actor.role !== 'operator') throw extensionError('only local operator identity may stop the Runtime API', 'RUNTIME_ACTOR_FORBIDDEN');
      queueMicrotask(close);
      return { stopping: true };
    default:
      throw extensionError('runtime request method is not supported', 'INVALID_RUNTIME_REQUEST');
  }
}

/**
 * Create a server that can bind only a loopback IP. The caller owns `listen` and
 * `close`; generated identity tokens remain only in process memory.
 */
export function createRuntimeServer({ missionFile, projectDir = '.', host = '127.0.0.1', identities } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw extensionError('Runtime API may bind only 127.0.0.1 or ::1', 'RUNTIME_NON_LOOPBACK_BIND');
  if (typeof missionFile !== 'string' || !missionFile) throw extensionError('Runtime API requires a mission file', 'INVALID_RUNTIME_REQUEST');
  const tokens = actorMap(identities ?? { [`runtime-token-${randomUUID()}`]: { role: 'operator', id: 'local-operator' } });
  let server;
  server = http.createServer(async (request, response) => {
    const origin = loopbackOrigin(request.headers.origin);
    if (request.headers.origin && !origin) {
      json(response, 403, runtimeFailure(null, extensionError('Runtime API rejects non-loopback browser origins', 'RUNTIME_ORIGIN_FORBIDDEN')));
      return;
    }
    if (request.method === 'OPTIONS') {
      if (!origin) {
        json(response, 403, runtimeFailure(null, extensionError('Runtime API rejects missing CORS origin', 'RUNTIME_ORIGIN_FORBIDDEN')));
        return;
      }
      response.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' });
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/runtime') {
      json(response, 404, runtimeFailure(null, extensionError('Runtime API route is not found', 'RUNTIME_ROUTE_NOT_FOUND')), origin);
      return;
    }
    let parsed = null;
    try {
      const actor = authenticate(request, tokens);
      const raw = await readBody(request);
      try { parsed = JSON.parse(raw); } catch { throw extensionError('Runtime API body must be JSON', 'INVALID_RUNTIME_REQUEST'); }
      const envelope = assertRuntimeRequest(parsed);
      const result = dispatch({ request: envelope, actor, missionFile, projectDir, close: () => server.close() });
      json(response, 200, runtimeSuccess(envelope.requestId, result), origin);
    } catch (error) {
      const code = error?.code;
      const status = code === 'RUNTIME_UNAUTHORIZED' ? 401 : code === 'RUNTIME_ORIGIN_FORBIDDEN' ? 403 : code === 'RUNTIME_REQUEST_TOO_LARGE' ? 413 : code === 'RUNTIME_ROUTE_NOT_FOUND' ? 404 : 400;
      json(response, status, runtimeFailure(parsed?.requestId ?? null, error), origin);
    }
  });
  return { server, tokens: [...tokens.entries()].map(([token, actor]) => ({ token, actor })) };
}

export function listenRuntimeServer(server, { host = '127.0.0.1', port = 0 } = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw extensionError('Runtime API may bind only 127.0.0.1 or ::1', 'RUNTIME_NON_LOOPBACK_BIND');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw extensionError('Runtime API port must be an integer from 0 to 65535', 'INVALID_RUNTIME_PORT');
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? { host, port: address.port } : null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
