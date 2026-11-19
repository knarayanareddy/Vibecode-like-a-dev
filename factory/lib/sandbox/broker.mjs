/**
 * Host-side model broker for brokered sandbox egress (roadmap P3.2).
 *
 * The sandbox denies the network, so an agent inside it cannot call a model and
 * opening the network would void the execution receipts. This broker runs on the
 * host and is reachable from inside the sandbox over one bound unix socket (or
 * one loopback port on Windows/macOS). It:
 *
 *   - forwards ONLY JSON POSTs to allow-listed model endpoints, one path per
 *     provider (`/v1/messages`, `/v1/chat/completions`, `/v1/completions`);
 *   - holds the API keys in host memory (read from the environment) and injects
 *     them upstream after stripping every credential the caller smuggled in;
 *   - authenticates each caller with a per-run bearer nonce (constant-time);
 *   - enforces call/step, token and cost budgets, answering 429 once spent;
 *   - never logs prompt or completion content — only request/response digests
 *     with secret-shaped strings redacted first;
 *   - reports its own policy through `receiptPolicy()` so the sandbox receipt
 *     binds exactly what egress was allowed.
 */

import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, extensionError } from '../extension-utils.mjs';
import { computeUsageCost, DEFAULT_TOKEN_ENV, redactSecrets } from '../model-client.mjs';

export const BROKER_HEALTH_PATH = '/__vld/broker/health';

/** The only request paths a brokered caller may reach, per provider. */
export const BROKER_PROVIDER_PATHS = Object.freeze({
  anthropic: Object.freeze(['/v1/messages']),
  openai: Object.freeze(['/v1/chat/completions', '/v1/completions']),
  'openai-compatible': Object.freeze(['/v1/chat/completions', '/v1/completions', '/v1/messages'])
});

/** Default allow-list: the public model APIs, with their well-known token env vars. */
export const DEFAULT_BROKER_PROVIDERS = Object.freeze({
  anthropic: Object.freeze({ baseUrl: 'https://api.anthropic.com', tokenEnv: 'ANTHROPIC_API_KEY' }),
  openai: Object.freeze({ baseUrl: 'https://api.openai.com/v1', tokenEnv: 'OPENAI_API_KEY' })
});

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'x-vld-broker-token',
  'x-vld-provider',
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'host',
  'content-length'
]);

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

function jsonError(res, status, code, message) {
  const body = JSON.stringify({ ok: false, error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function jsonOk(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function joinUpstreamUrl(baseUrl, requestPath) {
  const root = String(baseUrl ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${root}${requestPath}`;
}

function estimateInputTokens(bodyText) {
  return Math.ceil(String(bodyText ?? '').length / 4);
}

function readUsage(provider, payload) {
  const usage = payload?.usage ?? {};
  const inputTokens = Number(
    provider === 'anthropic' ? usage.input_tokens ?? 0 : usage.prompt_tokens ?? usage.input_tokens ?? 0
  );
  const outputTokens = Number(
    provider === 'anthropic' ? usage.output_tokens ?? 0 : usage.completion_tokens ?? usage.output_tokens ?? 0
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0
  };
}

/**
 * Start a model broker. Returns an async handle with:
 *   - `binding()`       the { mode, socketPath|port, nonce } object `runSandboxed` consumes
 *   - `receiptPolicy()` the broker policy snapshot bound into sandbox receipts
 *   - `logs()` / `totals()` bounded redacted audit data (digests only, never content)
 *   - `start()` / `stop()`
 */
export function createModelBroker({
  mode = 'unix-socket',
  socketPath = null,
  socketDir = null,
  port = 0,
  nonce = null,
  providers = DEFAULT_BROKER_PROVIDERS,
  allowModels = [],
  budget = {},
  env = process.env,
  pricing = null,
  maxRequestBytes = 4 * 1024 * 1024,
  maxResponseBytes = 8 * 1024 * 1024,
  logLimit = 256,
  onEvent = null
} = {}) {
  if (!['unix-socket', 'loopback-port'].includes(mode)) {
    throw extensionError(`unknown model broker mode \"${mode}\"`, 'INVALID_BROKER_CONFIG');
  }
  const providerTable = new Map();
  for (const [name, config] of Object.entries(providers ?? {})) {
    if (!BROKER_PROVIDER_PATHS[name]) {
      throw extensionError(`provider \"${name}\" cannot be brokered`, 'INVALID_BROKER_CONFIG');
    }
    providerTable.set(name, {
      baseUrl: String(config.baseUrl ?? ''),
      tokenEnv: config.tokenEnv === undefined ? (DEFAULT_TOKEN_ENV[name] ?? null) : config.tokenEnv,
      headers: { ...(config.headers ?? {}) }
    });
  }
  if (providerTable.size === 0) {
    throw extensionError('model broker needs at least one allow-listed provider', 'INVALID_BROKER_CONFIG');
  }

  const resolvedNonce = String(nonce ?? randomBytes(24).toString('base64url'));
  const resolvedSocketPath = mode === 'unix-socket'
    ? path.resolve(socketPath ?? path.join(socketDir ?? path.join(os.tmpdir(), `vld-broker-${process.pid}`), 'model.sock'))
    : null;

  const limits = {
    maxCalls: Number.isSafeInteger(budget.maxCalls) && budget.maxCalls > 0 ? budget.maxCalls
      : Number.isSafeInteger(budget.maxSteps) && budget.maxSteps > 0 ? budget.maxSteps : null,
    maxTokens: Number.isSafeInteger(budget.maxTokens) && budget.maxTokens > 0 ? budget.maxTokens : null,
    maxCostUsd: typeof budget.maxCostUsd === 'number' && Number.isFinite(budget.maxCostUsd) && budget.maxCostUsd > 0
      ? budget.maxCostUsd : null
  };

  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  const logEntries = [];
  const allowedModels = [...allowModels].map(String);
  let server = null;
  let listeningPort = null;
  let stopped = false;

  function record(entry) {
    logEntries.push(entry);
    while (logEntries.length > Math.max(1, logLimit)) logEntries.shift();
    if (typeof onEvent === 'function') {
      try { onEvent({ ...entry }); } catch {}
    }
  }

  function logDigest() {
    return digest(logEntries.map((e) => `${e.seq}|${e.at}|${e.provider}|${e.status}|${e.requestDigest}|${e.responseDigest}`).join('\n'));
  }

  function receiptPolicy() {
    return {
      mode,
      endpoint: mode === 'unix-socket' ? resolvedSocketPath : `http://127.0.0.1:${listeningPort ?? port}`,
      allowedProviders: [...providerTable.keys()],
      allowedModels,
      maxSteps: limits.maxCalls ?? 0,
      maxTokens: limits.maxTokens ?? 0,
      maxCostUsd: limits.maxCostUsd ?? 0,
      callCount: totals.calls,
      totalTokens: totals.totalTokens,
      totalCostUsd: totals.costUsd,
      logDigest: logEntries.length > 0 ? logDigest() : null
    };
  }

  function binding() {
    return {
      mode,
      ...(mode === 'unix-socket' ? { socketPath: resolvedSocketPath } : { port: listeningPort ?? port }),
      nonce: resolvedNonce
    };
  }

  async function handle(req, res) {
    if (req.method !== 'POST') return jsonError(res, 405, 'BROKER_METHOD', 'the broker accepts POST only');
    const token = req.headers['x-vld-broker-token'];
    if (typeof token !== 'string' || !safeEqual(token, resolvedNonce)) {
      return jsonError(res, 401, 'BROKER_AUTH', 'missing or invalid broker token');
    }
    if (req.url === BROKER_HEALTH_PATH) {
      // Local liveness only; it forwards nothing and consumes no budget.
      return jsonOk(res, 200, { ok: true, broker: 'vld-model-broker', providers: [...providerTable.keys()] });
    }

    const providerName = String(req.headers['x-vld-provider'] ?? '');
    const provider = providerTable.get(providerName);
    if (!provider) return jsonError(res, 403, 'BROKER_PROVIDER_DENIED', `provider \"${providerName || 'unset'}\" is not allow-listed`);
    const allowedPaths = BROKER_PROVIDER_PATHS[providerName];
    const requestPath = String(req.url ?? '').split('?')[0];
    if (!allowedPaths.includes(requestPath)) {
      return jsonError(res, 403, 'BROKER_PATH_DENIED', `path \"${requestPath}\" is not an allow-listed ${providerName} endpoint`);
    }

    // Budget gates, before any upstream work is spent.
    if (limits.maxCalls !== null && totals.calls >= limits.maxCalls) {
      return jsonError(res, 429, 'MODEL_BUDGET_EXCEEDED', `call budget exhausted (${totals.calls}/${limits.maxCalls})`);
    }
    if (limits.maxCostUsd !== null && totals.costUsd >= limits.maxCostUsd) {
      return jsonError(res, 429, 'MODEL_BUDGET_EXCEEDED', `cost budget exhausted ($${totals.costUsd.toFixed(6)})`);
    }

    const chunks = [];
    let bytes = 0;
    const bodyText = await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) {
          reject(extensionError(`broker request exceeded ${maxRequestBytes} bytes`, 'BROKER_REQUEST_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    }).catch((error) => {
      jsonError(res, error?.code === 'BROKER_REQUEST_TOO_LARGE' ? 413 : 400, error?.code ?? 'BROKER_REQUEST', error.message);
      return null;
    });
    if (bodyText === null) return;

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return jsonError(res, 400, 'BROKER_REQUEST', 'broker request body must be JSON');
    }
    const model = String(payload?.model ?? '');
    if (allowedModels.length > 0 && !allowedModels.includes(model)) {
      return jsonError(res, 403, 'BROKER_MODEL_DENIED', `model \"${model || 'unset'}\" is not allow-listed`);
    }

    const estimatedInput = estimateInputTokens(bodyText);
    if (limits.maxTokens !== null && totals.totalTokens + estimatedInput > limits.maxTokens) {
      return jsonError(res, 429, 'MODEL_BUDGET_EXCEEDED', `token budget exceeded (${totals.totalTokens + estimatedInput} > ${limits.maxTokens})`);
    }

    const tokenEnvName = provider.tokenEnv;
    const apiKey = tokenEnvName ? String(env?.[tokenEnvName] ?? '').trim() : '';
    if (tokenEnvName && !apiKey) {
      return jsonError(res, 502, 'BROKER_UPSTREAM_UNCONFIGURED', `environment variable ${tokenEnvName} is not set for provider \"${providerName}\"`);
    }
    const secretsToScrub = [apiKey, resolvedNonce].filter(Boolean);

    // Forward a minimal header set: every credential-shaped header is dropped
    // first, then the key is injected here — the caller never sees it and can
    // never override it.
    const forwardHeaders = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(providerName === 'anthropic' ? { 'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01') } : {}),
      ...provider.headers
    };
    for (const header of CREDENTIAL_HEADERS) delete forwardHeaders[header];
    if (apiKey) {
      if (providerName === 'anthropic') forwardHeaders['x-api-key'] = apiKey;
      else forwardHeaders.authorization = `Bearer ${apiKey}`;
    }

    const upstreamUrl = joinUpstreamUrl(provider.baseUrl, requestPath);
    const upstream = new URL(upstreamUrl);
    const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;

    const requestRaw = bodyText;
    const requestDigest = digest(redactSecrets(requestRaw, secretsToScrub));

    let upstreamRes;
    let responseText;
    try {
      const result = await new Promise((resolve, reject) => {
        const proxied = transport(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
            path: `${upstream.pathname}${upstream.search}`,
            method: 'POST',
            headers: { ...forwardHeaders, 'content-length': Buffer.byteLength(bodyText, 'utf8') },
            timeout: 120_000
          },
          (response) => {
            const parts = [];
            let size = 0;
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > maxResponseBytes) {
                proxied.destroy(new Error(`broker response exceeded ${maxResponseBytes} bytes`));
                return;
              }
              parts.push(chunk);
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
          }
        );
        proxied.on('timeout', () => proxied.destroy(new Error('broker upstream timed out')));
        proxied.on('error', reject);
        proxied.write(bodyText);
        proxied.end();
      });
      upstreamRes = result.status;
      responseText = result.text;
    } catch (error) {
      record({
        seq: totals.calls + 1,
        at: new Date().toISOString(),
        provider: providerName,
        model,
        path: requestPath,
        status: 502,
        requestDigest,
        responseDigest: digest(''),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0
      });
      return jsonError(res, 502, 'BROKER_UPSTREAM', `model endpoint unreachable: ${error.message}`);
    }

    const responseDigest = digest(redactSecrets(responseText, secretsToScrub));
    let usage = { inputTokens: 0, outputTokens: 0 };
    let parsedResponse = null;
    try { parsedResponse = JSON.parse(responseText); } catch {}
    if (parsedResponse && typeof parsedResponse === 'object') {
      usage = readUsage(providerName, parsedResponse);
    }
    const costUsd = computeUsageCost({ model: model || payload?.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, pricing });

    totals.calls += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalTokens += usage.inputTokens + usage.outputTokens;
    totals.costUsd = Number((totals.costUsd + Number(costUsd ?? 0)).toFixed(8));

    record({
      seq: totals.calls,
      at: new Date().toISOString(),
      provider: providerName,
      model,
      path: requestPath,
      status: upstreamRes,
      requestDigest,
      responseDigest,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: Number(costUsd ?? 0)
    });

    res.writeHead(upstreamRes, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseText, 'utf8') });
    res.end(responseText);
  }

  async function start() {
    if (server) return binding();
    if (mode === 'unix-socket') {
      mkdirSync(path.dirname(resolvedSocketPath), { recursive: true });
      if (existsSync(resolvedSocketPath)) unlinkSync(resolvedSocketPath);
    }
    server = createHttpServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) jsonError(res, 500, 'BROKER_INTERNAL', 'broker failed closed');
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      if (mode === 'unix-socket') {
        server.listen(resolvedSocketPath, () => {
          try { chmodSync(resolvedSocketPath, 0o600); } catch {}
          resolve();
        });
      } else {
        server.listen(port, '127.0.0.1', () => {
          listeningPort = server.address()?.port ?? port;
          resolve();
        });
      }
    });
    return binding();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    }
    if (mode === 'unix-socket' && resolvedSocketPath && existsSync(resolvedSocketPath)) {
      try { unlinkSync(resolvedSocketPath); } catch {}
      try { rmSync(path.dirname(resolvedSocketPath), { recursive: true, force: true }); } catch {}
    }
  }

  return {
    mode,
    nonce: resolvedNonce,
    socketPath: resolvedSocketPath,
    get port() { return listeningPort ?? port; },
    start,
    stop,
    binding,
    receiptPolicy,
    logs: () => logEntries.map((entry) => ({ ...entry })),
    logDigest: () => (logEntries.length > 0 ? logDigest() : null),
    totals: () => ({ ...totals })
  };
}

/**
 * Roadmap P3.2 conformance probes, in the same spirit as the 8-probe sandbox
 * suite: arbitrary hosts stay unreachable, only the broker answers, and the API
 * key never becomes visible to the sandboxed agent.
 */
export async function probeBrokerConformance({
  broker,
  workspace,
  backend = 'auto',
  executable = process.execPath,
  canaryKeyValue = null,
  runSandboxedImpl = null
} = {}) {
  const { runSandboxed, classifyConformanceProbe } = runSandboxedImpl
    ? runSandboxedImpl
    : await import('./index.mjs');
  const run = (args) => runSandboxed({
    id: 'broker-conformance',
    executable,
    args,
    workspace,
    mode: 'read-only',
    network: false,
    broker,
    backend,
    limits: { durationMs: 30_000, outputBytes: 65536 }
  });

  const denyScript = [
    "const targets = ['http://127.0.0.1:9/egress', 'https://api.openai.com/v1/models'];",
    '(async () => {',
    '  for (const target of targets) {',
    '    try { await fetch(target); process.exit(2); } catch {}',
    '  }',
    '  process.exit(0);',
    '})();'
  ].join(' ');

  const brokerScript = [
    "const http = require('node:http');",
    "const socket = process.env.VLD_MODEL_BROKER_SOCKET || null;",
    "const port = Number(process.env.VLD_MODEL_BROKER_PORT || 0);",
    "const nonce = process.env.VLD_MODEL_BROKER_NONCE || '';",
    "const body = '{}';",
    'const options = socket',
    "  ? { socketPath: socket, path: '/__vld/broker/health', method: 'POST', headers: { 'content-type': 'application/json', 'x-vld-broker-token': nonce, 'content-length': Buffer.byteLength(body) } }",
    "  : { hostname: '127.0.0.1', port, path: '/__vld/broker/health', method: 'POST', headers: { 'content-type': 'application/json', 'x-vld-broker-token': nonce, 'content-length': Buffer.byteLength(body) } };",
    'const req = http.request(options, (res) => {',
    "  let data = '';",
    "  res.on('data', (c) => { data += c; });",
    "  res.on('end', () => {",
    '    try {',
    '      const parsed = JSON.parse(data);',
    "      process.exit(res.statusCode === 200 && parsed.ok === true ? 0 : 3);",
    '    } catch { process.exit(4); }',
    '  });',
    '});',
    "req.on('error', () => process.exit(2));",
    'req.end(body);'
  ].join(' ');

  const keyScript = [
    "const suspicious = Object.entries(process.env).filter(([key, value]) =>",
    '  (/(?:api[_-]?key|secret|password|credential|authorization)/i.test(key) && key !== "VLD_MODEL_BROKER_NONCE") ||',
    '  (/-----BEGIN/.test(String(value)))',
    ');',
    'process.stdout.write(JSON.stringify({ env: process.env, suspicious: suspicious.map(([key]) => key) }));',
    'process.exit(suspicious.length === 0 ? 0 : 5);'
  ].join(' ');

  const denyRun = await run(['-e', denyScript]);
  const brokerRun = await run(['-e', brokerScript]);
  const keyRun = await run(['-e', keyScript]);
  const keyCanary = Boolean(canaryKeyValue) && `${keyRun.stdout ?? ''}`.includes(String(canaryKeyValue));

  const probes = [
    classifyConformanceProbe({
      id: 'broker-egress-denied',
      expectSuccess: true,
      runOk: denyRun.ok && denyRun.exitCode === 0,
      canaryRead: false,
      exitCode: denyRun.exitCode,
      stderr: denyRun.stderr,
      passedDetail: 'arbitrary hosts remain unreachable from the sandbox',
      leakDetail: 'sandbox reached a non-broker host'
    }),
    classifyConformanceProbe({
      id: 'broker-only-egress',
      expectSuccess: true,
      runOk: brokerRun.ok && brokerRun.exitCode === 0,
      canaryRead: false,
      exitCode: brokerRun.exitCode,
      stderr: brokerRun.stderr,
      passedDetail: 'the broker answers over the bound socket/port and nothing else does',
      leakDetail: 'broker unreachable or answered without nonce auth'
    }),
    classifyConformanceProbe({
      id: 'broker-key-never-visible',
      expectSuccess: true,
      runOk: keyRun.ok && keyRun.exitCode === 0,
      canaryRead: keyCanary,
      exitCode: keyRun.exitCode,
      stderr: keyRun.stderr,
      passedDetail: 'no API key or credential-shaped variable is visible to the sandboxed agent',
      leakDetail: 'the model API key was visible inside the sandbox'
    })
  ];

  return {
    ok: probes.every((probe) => probe.passed),
    leakDetected: probes.some((probe) => probe.status === 'leak-detected'),
    probes
  };
}
