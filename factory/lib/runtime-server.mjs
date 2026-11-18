/**
 * Loopback-only JSON API for the optional M3 Runtime host.
 *
 * It is intentionally a small control surface over Runtime operations, not a
 * general web server. It never serves project files, binds a LAN host, proxies
 * a model, runs a command or accepts a caller-selected filesystem path.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extensionError, ID_PATTERN } from './extension-utils.mjs';
import { applyProfileAnswer, generateProfileQuestions } from './questions.mjs';
import { assertRuntimeActor } from './runtime-policy.mjs';
import { assertRuntimeRequest, runtimeFailure, runtimeSuccess } from './runtime-contracts.mjs';
import { catalogStatus, readCatalogState } from './catalog.mjs';
import { appendEvidence, studioEvidenceProjection } from './evidence.mjs';
import { approveRuntimeDeliveryCandidate, queueRuntimeDeliveryCandidate } from './runtime-delivery.mjs';
import { execFileSync } from 'node:child_process';
import { STUDIO_PATH, studioCapabilities, studioContentSecurityPolicy, studioHtml, studioNonce } from './studio.mjs';
import {
  allocateRuntimePackage,
  heartbeatRuntimeLease,
  recordRuntimeRunStop,
  recoverRuntime,
  runtimeEventHistory,
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
    let settled = false;
    const tooLarge = () => {
      if (settled) return;
      settled = true;
      // Do not destroy the request: destroying its socket races the catch block
      // and turns the documented JSON 413 into ECONNRESET. Keep consuming input
      // while the server sends the bounded error envelope.
      reject(extensionError('runtime request body exceeds 64 KiB', 'RUNTIME_REQUEST_TOO_LARGE'));
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge();
      else if (!settled) chunks.push(chunk);
    });
    request.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    request.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
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

function studioPage(response) {
  const nonce = studioNonce();
  const body = studioHtml(nonce);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': studioContentSecurityPolicy(nonce),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
  response.end(body);
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

function studioCatalogProjection(report, projectDir) {
  const redact = (value) => String(value ?? '').split(path.resolve(projectDir)).join('<project>').replace(/[\r\n\0]/g, ' ').slice(0, 500);
  return {
    ok: report.ok,
    errors: (report.errors ?? []).map(redact),
    ...(report.trustedRoot ? { trustedRoot: { ...report.trustedRoot } } : {}),
    catalogs: (report.catalogs ?? []).map((catalog) => ({
      id: catalog.id,
      commit: catalog.commit,
      rootDigest: catalog.rootDigest,
      indexDigest: catalog.indexDigest,
      indexVersion: catalog.indexVersion,
      indexExpiresAt: catalog.indexExpiresAt,
      snapshotDigest: catalog.snapshotDigest,
      packages: (catalog.packages ?? []).map((item) => ({ name: item.name, version: item.version, license: item.license, publisher: { ...item.publisher }, manifestDigest: item.manifestDigest, coreCompatibility: item.coreCompatibility, releaseTimestamp: item.releaseTimestamp, capabilities: [...item.capabilities] })),
      drift: (catalog.drift ?? []).map(redact),
      ok: catalog.ok
    }))
  };
}

function boundedGit(projectDir, args, maxBytes = 96 * 1024) {
  try {
    const out = execFileSync('git', ['-C', projectDir, ...args], {
      encoding: 'utf8',
      maxBuffer: maxBytes,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.slice(0, maxBytes);
  } catch {
    return '';
  }
}

function reqAnchorsInTree(projectDir, commitSha) {
  const anchors = new Map();
  const out = boundedGit(projectDir, ['grep', '-n', '-e', '@req', commitSha], 256 * 1024);
  for (const line of out.split('\n')) {
    // git grep <tree>: "<sha>:<path>:<line>:<content>"
    const match = line.match(/^[0-9a-f]{40}:(.+?):\d+:(.*)$/);
    if (!match) continue;
    const file = match[1];
    for (const token of match[2].matchAll(/@req\s+(REQ-(?:C\d{2,}|\d{3,}))\b/g)) {
      const requirement = token[1];
      if (!anchors.has(requirement)) anchors.set(requirement, new Set());
      anchors.get(requirement).add(file);
    }
  }
  return anchors;
}

/**
 * P3.6 candidate page: requirement coverage matrix, mutation score, sandbox
 * verification receipt, independent review findings, bounded diff, run cost
 * and the evidence-chain badge — everything a reviewer needs to approve from
 * Studio alone.
 */
function candidateDetail({ missionFile, projectDir, packageId, candidateId = null }) {
  const status = runtimeStatus({ missionFile, projectDir });
  const workPackage = (status.packages ?? []).find((entry) => entry.id === packageId);
  if (!workPackage) throw extensionError(`runtime mission has no work package "${packageId}"`, 'UNKNOWN_WORK_PACKAGE');
  const delivery = (status.delivery ?? []).filter((entry) => entry.packageId === packageId);
  const candidateEntry = delivery.filter((entry) => entry.candidate && (!candidateId || entry.candidate.id === candidateId)).at(-1);
  if (!candidateEntry) throw extensionError('runtime package has no matching frozen candidate receipt', 'RUNTIME_CANDIDATE_NOT_FOUND');
  const candidate = candidateEntry.candidate;
  const verification = delivery.filter((entry) => entry.verification?.candidateId === candidate.id).map((entry) => entry.verification).at(-1) ?? null;
  const review = delivery.filter((entry) => entry.review?.candidateId === candidate.id).map((entry) => entry.review).at(-1) ?? null;
  const approval = delivery.filter((entry) => entry.approval?.candidateId === candidate.id).map((entry) => entry.approval).at(-1) ?? null;
  const queue = delivery.filter((entry) => entry.queue?.candidateId === candidate.id).map((entry) => entry.queue).at(-1) ?? null;

  const missionRaw = JSON.parse(readFileSync(path.resolve(projectDir, missionFile), 'utf8'));
  const specFile = path.resolve(projectDir, missionRaw.packet?.path ?? 'specs', 'spec.json');
  const spec = existsSync(specFile) ? JSON.parse(readFileSync(specFile, 'utf8')) : { requirements: [] };
  const anchors = reqAnchorsInTree(projectDir, candidate.candidateSha);
  const coverage = (spec.requirements ?? []).map((requirement) => ({
    id: requirement.id,
    title: requirement.title,
    area: requirement.area ?? null,
    verify: requirement.verify ?? null,
    anchored: anchors.has(requirement.id),
    anchoredFiles: [...(anchors.get(requirement.id) ?? [])].sort().slice(0, 8)
  }));

  const mutationChecks = (verification?.checks ?? []).filter((check) => /mutation/i.test(String(check.kind ?? '')));
  const mutation = mutationChecks.length > 0
    ? { checks: mutationChecks.map((check) => ({ id: check.id, kind: check.kind, passed: check.passed, output: check.output })), reported: true }
    : { checks: [], reported: false };

  const runCosts = (status.agentRuns ?? [])
    .filter((run) => run.packageId === packageId)
    .map((run) => ({ id: run.id, adapter: run.adapter, outcome: run.outcome, modelId: run.modelId ?? null, usage: run.usage ?? null }));
  const totals = runCosts.reduce((sum, run) => ({
    totalTokens: sum.totalTokens + (run.usage?.totalTokens ?? 0),
    costUsd: sum.costUsd + (run.usage?.costUsd ?? 0)
  }), { totalTokens: 0, costUsd: 0 });

  const diffText = boundedGit(projectDir, ['diff', '--unified=1', `${candidate.targetSha}..${candidate.candidateSha}`]);
  const truncated = diffText.length >= 96 * 1024;

  return {
    package: { id: workPackage.id, state: workPackage.state, requirements: workPackage.requirements },
    candidate,
    verification,
    review,
    approval,
    queue,
    coverage,
    mutation,
    cost: { runs: runCosts, totals },
    diff: { text: diffText, truncated },
    evidenceChain: studioEvidenceProjection({ projectDir })
  };
}

function dispatch({ request, actor, missionFile, projectDir, close }) {
  const params = request.params;
  switch (request.method) {
    case 'status': {
      closedParams(params, new Set(), 'status');
      const status = runtimeStatus({ missionFile, projectDir });
      // This is advisory display metadata only. Every action below still goes
      // through the ordinary Runtime role/policy validation path.
      const catalog = readCatalogState(projectDir);
      return {
        ...status,
        studio: {
          protocolVersion: 1,
          actor: { ...actor },
          actions: studioCapabilities(actor),
          ...(catalog.exists ? { catalog: studioCatalogProjection(catalogStatus(projectDir), projectDir) } : {}),
          evidenceChain: studioEvidenceProjection({ projectDir })
        }
      };
    }
    case 'evidence': {
      closedParams(params, new Set(['limit']), 'evidence');
      return studioEvidenceProjection({ projectDir, limit: Number.isSafeInteger(params.limit) ? params.limit : 20 });
    }
    case 'events': {
      closedParams(params, new Set(['after', 'limit', 'maxBytes']), 'events');
      return runtimeEventHistory({ missionFile, projectDir, actor, after: params.after ?? null, limit: params.limit ?? 50, maxBytes: params.maxBytes ?? 64 * 1024 });
    }
    case 'allocate': {
      closedParams(params, new Set(['packageId', 'assignee', 'leaseMs', 'leaseToken']), 'allocate');
      if (!ID_PATTERN.test(String(params.packageId ?? ''))) throw extensionError('allocate params.packageId is invalid', 'INVALID_RUNTIME_REQUEST');
      return allocateRuntimePackage({ missionFile, projectDir, packageId: params.packageId, actor, assignee: params.assignee, leaseMs: params.leaseMs, leaseToken: params.leaseToken, idempotencyKey: request.requestId });
    }
    case 'heartbeat': {
      closedParams(params, new Set(['packageId', 'runId', 'leaseToken', 'leaseMs']), 'heartbeat');
      return heartbeatRuntimeLease({ missionFile, projectDir, packageId: params.packageId, runId: params.runId, leaseToken: params.leaseToken, actor, leaseMs: params.leaseMs, idempotencyKey: request.requestId });
    }
    case 'transition': {
      closedParams(params, new Set(['packageId', 'to', 'expectedVersion', 'leaseToken', 'reason']), 'transition');
      return transitionRuntimePackage({ missionFile, projectDir, packageId: params.packageId, to: params.to, actor, expectedVersion: params.expectedVersion, leaseToken: params.leaseToken ?? null, reason: params.reason ?? null, idempotencyKey: request.requestId });
    }
    case 'candidate_detail': {
      closedParams(params, new Set(['packageId', 'candidateId']), 'candidate_detail');
      if (!ID_PATTERN.test(String(params.packageId ?? ''))) throw extensionError('candidate_detail params.packageId is invalid', 'INVALID_RUNTIME_REQUEST');
      return candidateDetail({ missionFile, projectDir, packageId: params.packageId, candidateId: params.candidateId ?? null });
    }
    case 'pause':
    case 'kill': {
      closedParams(params, new Set(['packageId', 'runId', 'reason']), request.method);
      if (!['operator', 'release-approver', 'runtime'].includes(actor.role)) {
        throw extensionError('only an operator, release-approver or runtime identity may pause or kill a run', 'RUNTIME_ACTOR_FORBIDDEN');
      }
      if (!ID_PATTERN.test(String(params.packageId ?? '')) || !ID_PATTERN.test(String(params.runId ?? ''))) {
        throw extensionError(`${request.method} requires valid packageId and runId`, 'INVALID_RUNTIME_REQUEST');
      }
      const stopped = recordRuntimeRunStop({
        missionFile,
        projectDir,
        packageId: params.packageId,
        runId: params.runId,
        action: request.method,
        reason: typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : (request.method === 'kill' ? 'Killed from local Studio' : 'Paused from local Studio'),
        actor
      });
      return stopped;
    }
    case 'approve': {
      closedParams(params, new Set(['packageId', 'candidateId', 'policyFile', 'reason']), 'approve');
      if (actor.role !== 'reviewer') throw extensionError('only an independent reviewer identity may approve a delivery candidate', 'RUNTIME_ACTOR_FORBIDDEN');
      if (!ID_PATTERN.test(String(params.packageId ?? '')) || !ID_PATTERN.test(String(params.candidateId ?? ''))) {
        throw extensionError('approve requires valid packageId and candidateId', 'INVALID_RUNTIME_REQUEST');
      }
      const policyFile = typeof params.policyFile === 'string' && params.policyFile ? params.policyFile : '.vld/delivery-policy.json';
      if (path.isAbsolute(policyFile) || policyFile.includes('..') || /[\r\n\0]/.test(policyFile)) {
        throw extensionError('approve policyFile must be a safe relative path inside the project', 'INVALID_RUNTIME_REQUEST');
      }
      const approved = approveRuntimeDeliveryCandidate({
        missionFile,
        projectDir,
        packageId: params.packageId,
        candidateId: params.candidateId,
        policyFile,
        actor,
        reason: typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : 'Approved via local Studio',
        idempotencyKey: request.requestId
      });
      try {
        appendEvidence({
          projectDir,
          kind: 'approval',
          actor,
          subject: `${params.packageId}/${params.candidateId}`,
          payload: { approvalId: approved.approval?.id ?? null, candidateSha: approved.approval?.candidateSha ?? null }
        });
      } catch {}
      return approved;
    }
    case 'queue': {
      closedParams(params, new Set(['packageId', 'candidateId', 'policyFile', 'reason']), 'queue');
      if (!['release-approver', 'operator'].includes(actor.role)) {
        throw extensionError('only a release-approver or operator identity may queue an approved candidate', 'RUNTIME_ACTOR_FORBIDDEN');
      }
      if (!ID_PATTERN.test(String(params.packageId ?? '')) || !ID_PATTERN.test(String(params.candidateId ?? ''))) {
        throw extensionError('queue requires valid packageId and candidateId', 'INVALID_RUNTIME_REQUEST');
      }
      const policyFile = typeof params.policyFile === 'string' && params.policyFile ? params.policyFile : '.vld/delivery-policy.json';
      if (path.isAbsolute(policyFile) || policyFile.includes('..') || /[\r\n\0]/.test(policyFile)) {
        throw extensionError('queue policyFile must be a safe relative path inside the project', 'INVALID_RUNTIME_REQUEST');
      }
      const queued = queueRuntimeDeliveryCandidate({
        missionFile,
        projectDir,
        packageId: params.packageId,
        candidateId: params.candidateId,
        policyFile,
        actor,
        reason: typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : 'Queued via local Studio',
        idempotencyKey: request.requestId
      });
      try {
        appendEvidence({
          projectDir,
          kind: 'queue',
          actor,
          subject: `${params.packageId}/${params.candidateId}`,
          payload: { queueId: queued.queue?.id ?? null, candidateSha: queued.queue?.candidateSha ?? null }
        });
      } catch {}
      return queued;
    }
    case 'get_questions': {
      closedParams(params, new Set(['profileFile']), 'get_questions');
      const rel = typeof params.profileFile === 'string' && params.profileFile ? params.profileFile : 'profile.json';
      if (path.isAbsolute(rel) || rel.includes('..') || /[\r\n\0]/.test(rel)) {
        throw extensionError('get_questions profileFile must be a safe relative path inside the project', 'INVALID_RUNTIME_REQUEST');
      }
      const target = path.resolve(projectDir, rel);
      if (!existsSync(target)) {
        throw extensionError(`profile file not found: ${rel}`, 'INVALID_RUNTIME_REQUEST');
      }
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      const raw = parsed.candidateProfile ?? parsed;
      return generateProfileQuestions(raw, { referenceDate: new Date().toISOString().slice(0, 10) });
    }
    case 'answer': {
      closedParams(params, new Set(['profileFile', 'questionId', 'field', 'value', 'waive']), 'answer');
      if (!['operator', 'reviewer', 'release-approver'].includes(actor.role)) {
        throw extensionError('only an operator, reviewer, or release-approver identity may record profile answers', 'RUNTIME_ACTOR_FORBIDDEN');
      }
      const rel = typeof params.profileFile === 'string' && params.profileFile ? params.profileFile : 'profile.json';
      if (path.isAbsolute(rel) || rel.includes('..') || /[\r\n\0]/.test(rel)) {
        throw extensionError('answer profileFile must be a safe relative path inside the project', 'INVALID_RUNTIME_REQUEST');
      }
      const target = path.resolve(projectDir, rel);
      if (!existsSync(target)) {
        throw extensionError(`profile file not found: ${rel}`, 'INVALID_RUNTIME_REQUEST');
      }
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      const base = parsed.candidateProfile ?? parsed;
      const result = applyProfileAnswer(base, {
        questionId: typeof params.questionId === 'string' ? params.questionId : null,
        field: typeof params.field === 'string' ? params.field : null,
        value: params.value,
        waive: params.waive && typeof params.waive === 'object' ? params.waive : null,
        actor: `${actor.role}:${actor.id}`,
        referenceDate: new Date().toISOString().slice(0, 10)
      });
      writeFileSync(target, `${JSON.stringify(result.profile, null, 2)}\n`, 'utf8');
      try {
        appendEvidence({
          projectDir,
          kind: 'profile-answer',
          actor,
          subject: params.field ?? params.questionId ?? rel,
          payload: { profileFile: rel, field: params.field ?? null, questionId: params.questionId ?? null }
        });
      } catch {}
      return result;
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
    if (request.method === 'GET' && (request.url === STUDIO_PATH || request.url === `${STUDIO_PATH}/`)) {
      studioPage(response);
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
    if (request.method === 'GET' && (request.url === '/v1/runtime/stream' || request.url.startsWith('/v1/runtime/stream?'))) {
      let streamActor;
      try { streamActor = authenticate(request, tokens); } catch (error) {
        json(response, 401, runtimeFailure(null, error), origin);
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff'
      });
      let after = 0;
      try {
        const streamUrl = new URL(request.url, 'http://127.0.0.1');
        const requested = Number.parseInt(streamUrl.searchParams.get('after') ?? '', 10);
        if (Number.isSafeInteger(requested) && requested >= 0) after = requested;
      } catch {}
      let closed = false;
      const write = (frame) => { if (!closed) { try { response.write(frame); } catch { closed = true; } } };
      write(`: stream opened\n\n`);
      const tick = () => {
        if (closed) return;
        try {
          const page = runtimeEventHistory({ missionFile, projectDir, actor: streamActor, after, limit: 25, maxBytes: 65536 });
          for (const event of page.events) {
            write(`data: ${JSON.stringify(event)}\n\n`);
            after = Math.max(after, Number(event.sequence) || 0);
          }
        } catch {}
      };
      tick();
      const poller = setInterval(tick, 300);
      const heartbeat = setInterval(() => write(': ping\n\n'), 15000);
      request.on('close', () => { closed = true; clearInterval(poller); clearInterval(heartbeat); try { response.end(); } catch {} });
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
