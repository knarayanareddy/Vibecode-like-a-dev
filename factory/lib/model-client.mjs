/**
 * Runtime model client (roadmap P3.1).
 *
 * Zero-dependency provider transport for `vld intake`, `vld build`, `vld review`,
 * `routing-eval`, and `outcome-eval`. Supports `anthropic`, `openai`,
 * `openai-compatible` (including the P3.2 broker over Unix socket or loopback),
 * and direct-argv `command` providers.
 *
 * Security & determinism invariants:
 *   - Runtime extension module only: never imported by Core compiler modules.
 *   - API keys are read by env-var name (`tokenEnv`) into local call memory only;
 *     never written to disk, logs, cassettes, receipts, or thrown messages.
 *   - Supports deterministic record/replay cassettes keyed by canonical SHA-256
 *     of `(provider, model, system, messages, tools, schema, temperature, seed)`.
 *   - Enforces per-call and cumulative token + USD cost ceilings.
 *   - Exponential backoff with bounded jitter and `Retry-After` handling on 429/5xx.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { digest, extensionError, stableJson } from './extension-utils.mjs';

const modelError = (code, message) => extensionError(message, code);

export const MODEL_PROVIDERS = Object.freeze([
  'anthropic',
  'openai',
  'openai-compatible',
  'command'
]);

export const DEFAULT_TOKEN_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
  command: null
});

export const DEFAULT_BASE_URL = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  'openai-compatible': 'http://127.0.0.1:11434'
});

/**
 * USD cost per 1M input / output tokens for budget accounting. Unknown models
 * fall back to a conservative default unless overridden in `pricing`.
 */
export const DEFAULT_MODEL_PRICING = Object.freeze({
  'claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4.0 },
  'gpt-5': { inputPer1M: 5.0, outputPer1M: 15.0 },
  'gpt-4.1': { inputPer1M: 2.0, outputPer1M: 8.0 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  default: { inputPer1M: 3.0, outputPer1M: 15.0 }
});

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(x-api-key['":\s=]+)[A-Za-z0-9._~+/=-]{12,}/gi
];

export function redactSecrets(value, extraSecrets = []) {
  let out = String(value ?? '');
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

export function estimateTokenCount(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(text.length / 4));
}

export function computeUsageCost({ model, inputTokens = 0, outputTokens = 0, pricing = null }) {
  const table = { ...DEFAULT_MODEL_PRICING, ...(pricing ?? {}) };
  const key = Object.keys(table).find((k) => k !== 'default' && String(model ?? '').startsWith(k)) ?? 'default';
  const rates = table[key] ?? DEFAULT_MODEL_PRICING.default;
  const usd = (Number(inputTokens) * rates.inputPer1M + Number(outputTokens) * rates.outputPer1M) / 1_000_000;
  return Number(usd.toFixed(8));
}

/** Build the canonical cache key object used by record/replay cassettes. */
export function canonicalCompletionKey({
  provider,
  model,
  system = '',
  messages = [],
  tools = [],
  schema = null,
  temperature = 0,
  seed = null
}) {
  return {
    schemaVersion: 1,
    provider: String(provider),
    model: String(model),
    system: String(system ?? ''),
    messages: Array.isArray(messages) ? messages : [],
    tools: Array.isArray(tools) ? tools : [],
    schema: schema ?? null,
    temperature: Number(temperature ?? 0),
    seed: seed === undefined ? null : seed
  };
}

export function computeRequestDigest(params) {
  // Canonical serialization (sorted keys): cassettes store responses as
  // stableJson, so replayed tool-call objects rehydrate with different key
  // insertion order than live-normalized ones. The cache key must be
  // invariant to object key order or record/replay diverges.
  return digest(stableJson(canonicalCompletionKey(params)));
}

function cassetteFilePath(cassetteDir, requestDigest) {
  const hex = String(requestDigest).replace(/^sha256:/, '');
  return path.join(path.resolve(cassetteDir), `${hex}.json`);
}

export function readCassetteEntry(cassetteDir, requestDigest) {
  const file = cassetteFilePath(cassetteDir, requestDigest);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed.requestDigest !== requestDigest) {
    throw modelError('MODEL_CASSETTE_CORRUPT', `cassette digest mismatch in ${file}`);
  }
  return parsed.response;
}

export function writeCassetteEntry(cassetteDir, requestParams, response, extraSecrets = []) {
  const requestDigest = typeof requestParams === 'string'
    ? requestParams
    : computeRequestDigest(requestParams);
  const dir = path.resolve(cassetteDir);
  mkdirSync(dir, { recursive: true });
  const sanitizedRaw = redactSecrets(JSON.stringify(response), extraSecrets);
  const sanitizedResponse = JSON.parse(sanitizedRaw);
  const entry = {
    schemaVersion: 1,
    requestDigest,
    provider: sanitizedResponse.provider ?? requestParams?.provider ?? 'unknown',
    model: sanitizedResponse.model ?? requestParams?.model ?? 'unknown',
    responseDigest: digest(sanitizedResponse),
    response: sanitizedResponse
  };
  const file = cassetteFilePath(dir, requestDigest);
  writeFileSync(file, `${stableJson(entry)}\n`, 'utf8');
  return { file, requestDigest, responseDigest: entry.responseDigest };
}

export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (headerValue === undefined || headerValue === null || headerValue === '') return null;
  const raw = Array.isArray(headerValue) ? headerValue[0] : String(headerValue).trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(60_000, Math.max(0, dateMs - nowMs));
  }
  return null;
}

function computeBackoffMs(attempt, { baseDelayMs = 250, maxDelayMs = 15_000, retryAfterMs = null, randomFn = Math.random } = {}) {
  if (retryAfterMs !== null && retryAfterMs >= 0) {
    return Math.min(maxDelayMs, retryAfterMs);
  }
  const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  const jitter = Math.floor(exp * 0.25 * randomFn());
  return Math.min(maxDelayMs, exp + jitter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format provider-specific request URL, headers, and body. */
export function buildProviderHttpRequest({
  provider,
  baseUrl,
  apiKey,
  model,
  system = '',
  messages = [],
  tools = [],
  schema = null,
  maxTokens = 2048,
  temperature = 0,
  seed = null,
  brokerToken = null
}) {
  const root = String(baseUrl || DEFAULT_BASE_URL[provider] || '').replace(/\/+$/, '');
  if (provider === 'anthropic') {
    const anthropicMessages = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? msg.tool_use_id ?? 'tool_0',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              ...(msg.isError ? { is_error: true } : {})
            }
          ]
        };
      }
      if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        const blocks = [];
        if (msg.content) blocks.push({ type: 'text', text: String(msg.content) });
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input ?? {}
          });
        }
        return { role: 'assistant', content: blocks };
      }
      return { role: msg.role === 'assistant' ? 'assistant' : 'user', content: String(msg.content ?? '') };
    });

    const anthropicTools = [...tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} }
    }))];

    let effectiveSystem = system || '';
    if (schema) {
      effectiveSystem = `${effectiveSystem}\n\nRespond with a single valid JSON object conforming to schema: ${JSON.stringify(schema)}`.trim();
    }

    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      ...(effectiveSystem ? { system: effectiveSystem } : {}),
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {})
    };
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(brokerToken ? { 'x-vld-broker-token': brokerToken } : {})
    };
    return {
      url: root.endsWith('/v1') ? `${root}/messages` : `${root}/v1/messages`,
      path: '/v1/messages',
      headers,
      body
    };
  }

  // `openai` and `openai-compatible`
  const oaiMessages = [];
  if (system) oaiMessages.push({ role: 'system', content: String(system) });
  for (const msg of messages) {
    if (msg.role === 'tool') {
      oaiMessages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId ?? msg.tool_call_id ?? 'call_0',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      oaiMessages.push({
        role: 'assistant',
        content: msg.content ? String(msg.content) : null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) }
        }))
      });
    } else {
      oaiMessages.push({ role: msg.role, content: String(msg.content ?? '') });
    }
  }

  const oaiTools = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} }
    }
  }));

  const body = {
    model,
    messages: oaiMessages,
    max_tokens: maxTokens,
    temperature,
    ...(seed !== null && seed !== undefined ? { seed } : {}),
    ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
    ...(schema
      ? {
          response_format: provider === 'openai'
            ? { type: 'json_schema', json_schema: { name: schema.title ?? 'vld_response', strict: false, schema } }
            : { type: 'json_object' }
        }
      : {})
  };
  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(brokerToken ? { 'x-vld-broker-token': brokerToken } : {})
  };
  const endpoint = root.endsWith('/v1') ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
  return {
    url: endpoint,
    path: '/v1/chat/completions',
    headers,
    body
  };
}

function tryParseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch {}
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

/** Normalize raw Anthropic / OpenAI JSON responses into one typed completion record. */
export function parseProviderHttpResponse({ provider, model, payload, expectSchema = false, pricing = null }) {
  if (provider === 'anthropic') {
    const content = Array.isArray(payload?.content) ? payload.content : [];
    const textParts = [];
    const toolCalls = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block?.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id ?? `tool_${toolCalls.length + 1}`),
          name: String(block.name ?? ''),
          input: block.input && typeof block.input === 'object' ? block.input : {}
        });
      }
    }
    const text = textParts.join('\n').trim();
    const inputTokens = Number(payload?.usage?.input_tokens ?? 0);
    const outputTokens = Number(payload?.usage?.output_tokens ?? 0);
    const resolvedModel = String(payload?.model ?? model);
    return {
      provider,
      model: resolvedModel,
      text,
      json: expectSchema ? tryParseJsonText(text) : null,
      toolCalls,
      stopReason: String(payload?.stop_reason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn')),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: computeUsageCost({ model: resolvedModel, inputTokens, outputTokens, pricing })
      }
    };
  }

  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const msg = choice?.message ?? {};
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc, idx) => {
        let parsedArgs = {};
        try {
          parsedArgs = typeof tc?.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc?.function?.arguments ?? {});
        } catch {
          parsedArgs = { _raw: tc?.function?.arguments ?? '' };
        }
        return {
          id: String(tc?.id ?? `call_${idx + 1}`),
          name: String(tc?.function?.name ?? ''),
          input: parsedArgs
        };
      })
    : [];
  const inputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens ?? 0);
  const outputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? 0);
  const resolvedModel = String(payload?.model ?? model);
  return {
    provider,
    model: resolvedModel,
    text,
    json: expectSchema ? tryParseJsonText(text) : null,
    toolCalls,
    stopReason: String(choice?.finish_reason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: computeUsageCost({ model: resolvedModel, inputTokens, outputTokens, pricing })
    }
  };
}

/** Low-level HTTP/HTTPS/Unix-socket JSON POST with bounded timeout and body size. */
function sendJsonPost({ url, socketPath = null, pathOverride = null, headers, body, timeoutMs = 60_000, maxResponseBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const rawBody = JSON.stringify(body);
    const reqHeaders = { ...headers, 'content-length': Buffer.byteLength(rawBody, 'utf8') };

    let options;
    let mod;
    if (socketPath) {
      mod = http;
      options = {
        socketPath,
        path: pathOverride || '/v1/complete',
        method: 'POST',
        headers: reqHeaders
      };
    } else {
      const parsed = new URL(url);
      mod = parsed.protocol === 'https:' ? https : http;
      options = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: reqHeaders
      };
    }

    const req = mod.request(options, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          req.destroy(new Error(`response exceeded ${maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers ?? {},
          bodyText: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    const timer = setTimeout(() => {
      req.destroy(modelError('MODEL_TIMEOUT', `model call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    req.write(rawBody);
    req.end();
  });
}

/** Execute a direct-argv command model provider (never invokes a shell). */
function runCommandProvider({ command, requestBody, timeoutMs = 60_000, maxOutputBytes = 2 * 1024 * 1024, cwd = process.cwd() }) {
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== 'string') {
    throw modelError('MODEL_CONFIG_INVALID', 'command provider requires non-empty command argv array');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8' }
    });
    const out = [];
    const err = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(modelError('MODEL_TIMEOUT', `command provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 32) err.push(chunk);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) {
        reject(modelError('MODEL_COMMAND_FAILED', `command provider exited ${code}: ${stderr.slice(0, 240)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(requestBody)}\n`);
  });
}

/**
 * Create a stateful, budget-enforced model client instance.
 */
export function createModelClient({
  provider = 'anthropic',
  model = 'claude-sonnet-4-6',
  tokenEnv = undefined,
  baseUrl = null,
  brokerSocket = null,
  brokerUrl = null,
  brokerToken = null,
  command = null,
  cassetteDir = null,
  cassetteMode = null, // 'replay' | 'record' | 'auto' | 'off'
  budget = {},
  pricing = null,
  maxRetries = 3,
  baseDelayMs = 250,
  maxDelayMs = 15_000,
  timeoutMs = 60_000,
  transport = sendJsonPost,
  sleepFn = sleep,
  randomFn = Math.random,
  env = process.env,
  onEvent = null
} = {}) {
  if (!MODEL_PROVIDERS.includes(provider)) {
    throw modelError('MODEL_PROVIDER_UNKNOWN', `unknown model provider "${provider}" (expected ${MODEL_PROVIDERS.join(', ')})`);
  }

  const resolvedTokenEnv = tokenEnv === undefined ? DEFAULT_TOKEN_ENV[provider] : tokenEnv;
  const effectiveCassetteMode = cassetteMode ?? (cassetteDir ? 'auto' : 'off');
  const limits = {
    maxCallInputTokens: budget.maxCallInputTokens ?? null,
    maxCallOutputTokens: budget.maxCallOutputTokens ?? null,
    maxTotalTokens: budget.maxTotalTokens ?? null,
    maxCostUsd: budget.maxCostUsd ?? null,
    maxCalls: budget.maxCalls ?? null
  };

  const totals = {
    calls: 0,
    cachedCalls: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };
  const callRecords = [];

  function resolveApiKeyInMemory() {
    // When routed through the P3.2 broker or command provider, no API key is ever held by the client.
    if (provider === 'command' || brokerSocket || brokerUrl) return null;
    if (env?.VLD_MODEL_BROKER_SOCKET || env?.VLD_MODEL_BROKER_URL || env?.VLD_BROKER_SOCKET || env?.VLD_BROKER_URL) return null;
    if (!resolvedTokenEnv) return null;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(resolvedTokenEnv)) {
      throw modelError('MODEL_CONFIG_INVALID', `invalid --token-env variable name "${resolvedTokenEnv}"`);
    }
    const val = env?.[resolvedTokenEnv];
    if (typeof val !== 'string' || !val.trim()) {
      if (provider === 'openai-compatible') return null;
      throw modelError('MODEL_AUTH_MISSING',
        `environment variable ${resolvedTokenEnv} is not set for provider "${provider}"`
      );
    }
    return val.trim();
  }

  function assertPreCallBudget(estimatedInput, requestedMaxTokens) {
    if (limits.maxCalls !== null && totals.calls >= limits.maxCalls) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `model call limit exceeded (${totals.calls}/${limits.maxCalls})`);
    }
    if (limits.maxCallInputTokens !== null && estimatedInput > limits.maxCallInputTokens) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `estimated input tokens (${estimatedInput}) exceed per-call limit (${limits.maxCallInputTokens})`);
    }
    if (limits.maxCallOutputTokens !== null && requestedMaxTokens > limits.maxCallOutputTokens) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `requested maxTokens (${requestedMaxTokens}) exceeds per-call output limit (${limits.maxCallOutputTokens})`);
    }
    if (limits.maxTotalTokens !== null && totals.totalTokens + estimatedInput > limits.maxTotalTokens) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `token budget exceeded (${totals.totalTokens + estimatedInput} > ${limits.maxTotalTokens})`);
    }
    if (limits.maxCostUsd !== null && totals.costUsd >= limits.maxCostUsd) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `cost budget exhausted ($${totals.costUsd.toFixed(6)} >= $${Number(limits.maxCostUsd).toFixed(6)})`);
    }
  }

  function recordUsageAndCheckPostBudget(response, requestDigest, responseDigest, cached, durationMs) {
    const usage = response.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    const costUsd = usage.costUsd ?? computeUsageCost({
      model: response.model ?? model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      pricing
    });
    totals.calls += 1;
    if (cached) totals.cachedCalls += 1;
    totals.inputTokens += Number(usage.inputTokens ?? 0);
    totals.outputTokens += Number(usage.outputTokens ?? 0);
    totals.totalTokens += Number(usage.totalTokens ?? (Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)));
    totals.costUsd = Number((totals.costUsd + Number(costUsd)).toFixed(8));

    const entry = {
      index: totals.calls,
      provider: response.provider ?? provider,
      model: response.model ?? model,
      requestDigest,
      responseDigest,
      cached,
      durationMs,
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      costUsd: Number(costUsd)
    };
    callRecords.push(entry);
    if (typeof onEvent === 'function') onEvent(entry);

    if (limits.maxTotalTokens !== null && totals.totalTokens > limits.maxTotalTokens) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `cumulative token budget exceeded (${totals.totalTokens} > ${limits.maxTotalTokens})`);
    }
    if (limits.maxCostUsd !== null && totals.costUsd > limits.maxCostUsd) {
      throw modelError('MODEL_BUDGET_EXCEEDED', `cumulative cost budget exceeded ($${totals.costUsd.toFixed(6)} > $${Number(limits.maxCostUsd).toFixed(6)})`);
    }
  }

  async function complete(call = {}) {
    const startMs = Date.now();
    const activeProvider = call.provider ?? provider;
    const activeModel = call.model ?? model;
    const system = call.system ?? '';
    const messages = Array.isArray(call.messages) ? call.messages : [];
    const tools = Array.isArray(call.tools) ? call.tools : [];
    const schema = call.schema ?? null;
    const maxTokens = call.maxTokens ?? 2048;
    const temperature = call.temperature ?? 0;
    const seed = call.seed ?? null;

    const keyInput = {
      provider: activeProvider,
      model: activeModel,
      system,
      messages,
      tools,
      schema,
      temperature,
      seed
    };
    const requestDigest = computeRequestDigest(keyInput);
    const estimatedInput = estimateTokenCount({ system, messages, tools, schema });
    assertPreCallBudget(estimatedInput, maxTokens);

    // 1. Cassette replay check (zero network).
    if (cassetteDir && (effectiveCassetteMode === 'replay' || effectiveCassetteMode === 'auto')) {
      const hit = readCassetteEntry(cassetteDir, requestDigest);
      if (hit) {
        const normalized = {
          ...hit,
          json: schema ? (hit.json ?? tryParseJsonText(hit.text ?? '')) : (hit.json ?? null)
        };
        const responseDigest = digest(normalized);
        const durationMs = Date.now() - startMs;
        recordUsageAndCheckPostBudget(normalized, requestDigest, responseDigest, true, durationMs);
        return {
          ...normalized,
          requestDigest,
          responseDigest,
          cached: true,
          durationMs
        };
      }
      if (effectiveCassetteMode === 'replay') {
        throw modelError('MODEL_CASSETTE_MISS',
          `no cassette entry for ${activeProvider}/${activeModel} (${requestDigest}) in ${cassetteDir}`
        );
      }
    }

    // 2. Direct-argv command provider.
    if (activeProvider === 'command') {
      const { stdout } = await runCommandProvider({
        command: call.command ?? command,
        requestBody: { ...keyInput, maxTokens, requestDigest },
        timeoutMs: call.timeoutMs ?? timeoutMs
      });
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = { text: stdout };
      }
      const inputTokens = Number(parsed?.usage?.inputTokens ?? estimatedInput);
      const outputTokens = Number(parsed?.usage?.outputTokens ?? estimateTokenCount(parsed?.text ?? stdout));
      const text = typeof parsed.text === 'string' ? parsed.text : (parsed.json ? JSON.stringify(parsed.json) : stdout);
      const normalized = {
        provider: 'command',
        model: activeModel,
        text,
        json: schema ? (parsed.json ?? tryParseJsonText(text)) : (parsed.json ?? null),
        toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
        stopReason: String(parsed.stopReason ?? (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0 ? 'tool_use' : 'end_turn')),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUsd: Number(parsed?.usage?.costUsd ?? 0)
        }
      };
      if (cassetteDir && (effectiveCassetteMode === 'record' || effectiveCassetteMode === 'auto')) {
        writeCassetteEntry(cassetteDir, requestDigest, normalized);
      }
      const responseDigest = digest(normalized);
      const durationMs = Date.now() - startMs;
      recordUsageAndCheckPostBudget(normalized, requestDigest, responseDigest, false, durationMs);
      return { ...normalized, requestDigest, responseDigest, cached: false, durationMs };
    }

    // 3. HTTP / brokered provider with retry + Retry-After + secret redaction.
    // The sandbox injects VLD_MODEL_BROKER_* (see sandbox/backends.mjs); the
    // shorter VLD_BROKER_* names remain supported for external callers.
    const effectiveBrokerSocket = brokerSocket || env?.VLD_MODEL_BROKER_SOCKET || env?.VLD_BROKER_SOCKET || null;
    const effectiveBrokerUrl = brokerUrl || env?.VLD_MODEL_BROKER_URL || env?.VLD_BROKER_URL || null;
    const effectiveBrokerToken = brokerToken || env?.VLD_MODEL_BROKER_NONCE || env?.VLD_BROKER_TOKEN || null;
    const apiKey = resolveApiKeyInMemory();
    const secretsToScrub = apiKey ? [apiKey] : [];
    if (effectiveBrokerToken) secretsToScrub.push(effectiveBrokerToken);

    const effectiveBaseUrl = effectiveBrokerUrl || call.baseUrl || baseUrl || DEFAULT_BASE_URL[activeProvider];
    const httpReq = buildProviderHttpRequest({
      provider: activeProvider,
      baseUrl: effectiveBaseUrl,
      apiKey,
      model: activeModel,
      system,
      messages,
      tools,
      schema,
      maxTokens,
      temperature,
      seed,
      brokerToken: effectiveBrokerToken
    });

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const res = await transport({
          url: httpReq.url,
          socketPath: effectiveBrokerSocket,
          pathOverride: httpReq.path,
          headers: {
            ...httpReq.headers,
            ...(effectiveBrokerSocket || effectiveBrokerUrl ? { 'x-vld-provider': activeProvider } : {})
          },
          body: httpReq.body,
          timeoutMs: call.timeoutMs ?? timeoutMs
        });

        if (res.status >= 200 && res.status < 300) {
          const payload = JSON.parse(res.bodyText);
          const normalized = parseProviderHttpResponse({
            provider: activeProvider,
            model: activeModel,
            payload,
            expectSchema: Boolean(schema),
            pricing
          });
          if (cassetteDir && (effectiveCassetteMode === 'record' || effectiveCassetteMode === 'auto')) {
            writeCassetteEntry(cassetteDir, requestDigest, normalized, secretsToScrub);
          }
          const responseDigest = digest(normalized);
          const durationMs = Date.now() - startMs;
          recordUsageAndCheckPostBudget(normalized, requestDigest, responseDigest, false, durationMs);
          return { ...normalized, requestDigest, responseDigest, cached: false, durationMs };
        }

        const safeSnippet = redactSecrets(res.bodyText.slice(0, 300), secretsToScrub);
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          totals.retries += 1;
          const retryAfterMs = parseRetryAfterMs(res.headers?.['retry-after']);
          const delayMs = computeBackoffMs(attempt, { baseDelayMs, maxDelayMs, retryAfterMs, randomFn });
          await sleepFn(delayMs);
          continue;
        }

        throw extensionError(
          res.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_HTTP_ERROR',
          `${activeProvider} returned HTTP ${res.status}: ${safeSnippet}`
        );
      } catch (err) {
        const safeMsg = redactSecrets(err?.message ?? String(err), secretsToScrub);
        if (err?.code === 'MODEL_BUDGET_EXCEEDED' || err?.code === 'MODEL_HTTP_ERROR' || err?.code === 'MODEL_RATE_LIMITED') {
          err.message = safeMsg;
          throw err;
        }
        lastError = extensionError(err?.code ?? 'MODEL_TRANSPORT_ERROR', safeMsg);
        if (attempt < maxRetries) {
          totals.retries += 1;
          const delayMs = computeBackoffMs(attempt, { baseDelayMs, maxDelayMs, randomFn });
          await sleepFn(delayMs);
          continue;
        }
      }
    }
    throw lastError ?? modelError('MODEL_TRANSPORT_ERROR', `${activeProvider} call failed`);
  }

  function getUsageSummary() {
    return {
      provider,
      model,
      tokenEnv: resolvedTokenEnv ?? null,
      cassetteMode: effectiveCassetteMode,
      limits: { ...limits },
      totals: { ...totals },
      calls: callRecords.map((c) => ({ ...c }))
    };
  }

  return {
    provider,
    model,
    complete,
    getUsageSummary
  };
}
