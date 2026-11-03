/**
 * Typed HTTP client for an optional Runtime API endpoint.
 *
 * Runtime remains local by default. Supplying an endpoint is explicit, and an
 * http URL is permitted only for loopback development; remote endpoints require
 * HTTPS so the bearer capability is never sent over a clear-text network hop.
 */

import { extensionError } from './extension-utils.mjs';
import { readBoundedRuntimeText } from './bounded-runtime-response.mjs';
import { assertRuntimeResponse, assertRuntimeRequest, newRuntimeRequestId, RUNTIME_API_VERSION } from './runtime-contracts.mjs';

const TOKEN = /^[^\s\r\n\0]{16,200}$/;
const MAX_RESPONSE_BYTES = 1_000_000;

function loopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/** Normalize a base URL or exact Runtime route into the one versioned endpoint. */
export function runtimeEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) throw extensionError('Runtime endpoint URL is required', 'INVALID_RUNTIME_ENDPOINT');
  let endpoint;
  try { endpoint = new URL(value); } catch { throw extensionError('Runtime endpoint URL is invalid', 'INVALID_RUNTIME_ENDPOINT'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw extensionError('Runtime endpoint URL must not contain credentials, query, or fragment', 'INVALID_RUNTIME_ENDPOINT');
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname) throw extensionError('Runtime endpoint URL must use http or https', 'INVALID_RUNTIME_ENDPOINT');
  if (endpoint.protocol === 'http:' && !loopback(endpoint.hostname)) throw extensionError('a non-loopback Runtime endpoint must use https', 'RUNTIME_ENDPOINT_HTTPS_REQUIRED');
  const pathname = endpoint.pathname.replace(/\/+$/, '') || '';
  if (pathname && pathname !== '/v1/runtime') throw extensionError('Runtime endpoint URL must be a base URL or end exactly with /v1/runtime', 'INVALID_RUNTIME_ENDPOINT');
  endpoint.pathname = '/v1/runtime';
  return endpoint;
}

function token(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw extensionError('Runtime client bearer token must be a bounded non-whitespace value', 'INVALID_RUNTIME_TOKEN');
  return value;
}

async function boundedJson(response, maxBytes) {
  let text;
  try { text = await readBoundedRuntimeText(response, maxBytes); }
  catch (error) {
    if (error?.code === 'RUNTIME_RESPONSE_TOO_LARGE') throw extensionError(error.message, error.code);
    throw error;
  }
  try { return JSON.parse(text); } catch { throw extensionError('Runtime response is not valid JSON', 'INVALID_RUNTIME_RESPONSE'); }
}

/** Create a narrow client; callers can inject fetch for deterministic transport tests. */
export function createRuntimeClient({ endpoint, token: bearerToken, fetchImpl = globalThis.fetch, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const url = runtimeEndpoint(endpoint);
  const bearer = token(bearerToken);
  if (typeof fetchImpl !== 'function') throw extensionError('Runtime client requires a fetch implementation', 'RUNTIME_CLIENT_UNAVAILABLE');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) throw extensionError('Runtime response byte limit is invalid', 'INVALID_RUNTIME_CLIENT');

  return {
    endpoint: url.toString(),
    async request(method, params = {}, { requestId = newRuntimeRequestId(), signal } = {}) {
      const request = assertRuntimeRequest({ schemaVersion: RUNTIME_API_VERSION, requestId, method, params });
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST', signal,
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body: JSON.stringify(request)
        });
      } catch (error) {
        throw extensionError(`Runtime endpoint request failed: ${String(error?.message ?? error).replace(/[\r\n\0]/g, ' ').slice(0, 300)}`, 'RUNTIME_CLIENT_REQUEST_FAILED');
      }
      const envelope = assertRuntimeResponse(await boundedJson(response, maxResponseBytes));
      if (envelope.requestId !== requestId) throw extensionError('Runtime response requestId does not match the request', 'INVALID_RUNTIME_RESPONSE');
      if (!response.ok && envelope.ok) throw extensionError('Runtime HTTP status conflicts with its success envelope', 'INVALID_RUNTIME_RESPONSE');
      if (!envelope.ok) throw extensionError(envelope.error.message, envelope.error.code);
      return envelope.result;
    }
  };
}

export { MAX_RESPONSE_BYTES as MAX_RUNTIME_CLIENT_RESPONSE_BYTES };
