/** Versioned, dependency-free JSON envelope helpers for the optional Runtime API. */

import { randomUUID } from 'node:crypto';
import { extensionError } from './extension-utils.mjs';

export const RUNTIME_API_VERSION = 1;
export const RUNTIME_API_METHODS = Object.freeze([
  'status',
  'events',
  'allocate',
  'heartbeat',
  'transition',
  'recover',
  'shutdown'
]);

const REQUEST_FIELDS = new Set(['schemaVersion', 'requestId', 'method', 'params']);
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,120}$/;

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a deliberately small closed request envelope before endpoint routing. */
export function validateRuntimeRequest(request) {
  const errors = [];
  if (!object(request)) return { ok: false, errors: ['request must be an object'] };
  for (const key of Object.keys(request)) if (!REQUEST_FIELDS.has(key)) errors.push(`request.${key} is not allowed`);
  if (request.schemaVersion !== RUNTIME_API_VERSION) errors.push(`request.schemaVersion must be ${RUNTIME_API_VERSION}`);
  if (!REQUEST_ID.test(String(request.requestId ?? ''))) errors.push('request.requestId must be a bounded identifier');
  if (!RUNTIME_API_METHODS.includes(request.method)) errors.push('request.method is not supported');
  if (!object(request.params)) errors.push('request.params must be an object');
  return { ok: errors.length === 0, errors };
}

export function assertRuntimeRequest(request) {
  const checked = validateRuntimeRequest(request);
  if (!checked.ok) throw extensionError(`runtime request is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_RUNTIME_REQUEST');
  return request;
}

export function runtimeSuccess(requestId, result) {
  return { schemaVersion: RUNTIME_API_VERSION, requestId, ok: true, result };
}

export function runtimeFailure(requestId, error) {
  return {
    schemaVersion: RUNTIME_API_VERSION,
    requestId: requestId && REQUEST_ID.test(requestId) ? requestId : null,
    ok: false,
    error: {
      code: typeof error?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(error.code) ? error.code : 'RUNTIME_REQUEST_FAILED',
      message: String(error?.message ?? 'Runtime request failed').replace(/[\r\n\0]/g, ' ').slice(0, 500)
    }
  };
}

/** Validate the closed response envelope before a remote client trusts it. */
export function validateRuntimeResponse(response) {
  const errors = [];
  if (!object(response)) return { ok: false, errors: ['response must be an object'] };
  const allowed = new Set(['schemaVersion', 'requestId', 'ok', 'result', 'error']);
  for (const key of Object.keys(response)) if (!allowed.has(key)) errors.push(`response.${key} is not allowed`);
  if (response.schemaVersion !== RUNTIME_API_VERSION) errors.push(`response.schemaVersion must be ${RUNTIME_API_VERSION}`);
  if (response.requestId !== null && !REQUEST_ID.test(String(response.requestId ?? ''))) errors.push('response.requestId must be a bounded identifier or null');
  if (typeof response.ok !== 'boolean') errors.push('response.ok must be boolean');
  if (response.ok === true) {
    if (!('result' in response) || !object(response.result)) errors.push('successful response.result must be an object');
    if ('error' in response) errors.push('successful response must not contain error');
  }
  if (response.ok === false) {
    if (!object(response.error)) errors.push('failed response.error must be an object');
    else {
      const keys = Object.keys(response.error);
      if (keys.some((key) => !['code', 'message'].includes(key))) errors.push('response.error has an unknown field');
      if (typeof response.error.code !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(response.error.code)) errors.push('response.error.code is invalid');
      if (typeof response.error.message !== 'string' || response.error.message.length > 500 || /[\r\n\0]/.test(response.error.message)) errors.push('response.error.message is invalid');
    }
    if ('result' in response) errors.push('failed response must not contain result');
  }
  return { ok: errors.length === 0, errors };
}

export function assertRuntimeResponse(response) {
  const checked = validateRuntimeResponse(response);
  if (!checked.ok) throw extensionError(`runtime response is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_RUNTIME_RESPONSE');
  return response;
}

export function newRuntimeRequestId() {
  return `request-${randomUUID()}`;
}
