import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeClient, runtimeEndpoint } from '../lib/runtime-client.mjs';

function response(status, value, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(value)
  };
}

test('Runtime client normalizes an explicit endpoint and validates typed request/response envelopes', async () => {
  const calls = [];
  const client = createRuntimeClient({
    endpoint: 'https://runtime.example.test/',
    token: 'example-auth-material',
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      const request = JSON.parse(init.body);
      return response(200, {
        schemaVersion: 1,
        requestId: request.requestId,
        ok: true,
        result: { ok: true, runtime: { missionId: 'remote-runtime' }, packages: [] }
      });
    }
  });
  const result = await client.request('status', {}, { requestId: 'remote-status-0001' });
  assert.equal(result.runtime.missionId, 'remote-runtime');
  assert.equal(calls[0].url, 'https://runtime.example.test/v1/runtime');
  assert.equal(calls[0].init.headers.authorization, 'Bearer example-auth-material');
  assert.deepEqual(JSON.parse(calls[0].init.body), { schemaVersion: 1, requestId: 'remote-status-0001', method: 'status', params: {} });
});

test('Runtime client rejects unsafe remote transport and malformed or mismatched responses', async () => {
  assert.throws(() => runtimeEndpoint('http://runtime.example.test/v1/runtime'), (error) => error.code === 'RUNTIME_ENDPOINT_HTTPS_REQUIRED');
  assert.equal(runtimeEndpoint('http://127.0.0.1:9911').toString(), 'http://127.0.0.1:9911/v1/runtime');
  assert.throws(() => runtimeEndpoint('https://runtime.example.test/other'), (error) => error.code === 'INVALID_RUNTIME_ENDPOINT');

  const malformed = createRuntimeClient({
    endpoint: 'https://runtime.example.test/v1/runtime', token: 'example-auth-material',
    fetchImpl: async () => response(200, { schemaVersion: 1, requestId: 'remote-status-0002', ok: true, result: [] })
  });
  await assert.rejects(() => malformed.request('status', {}, { requestId: 'remote-status-0002' }), (error) => error.code === 'INVALID_RUNTIME_RESPONSE');

  const mismatched = createRuntimeClient({
    endpoint: 'https://runtime.example.test/v1/runtime', token: 'example-auth-material',
    fetchImpl: async () => response(200, { schemaVersion: 1, requestId: 'other-request-0002', ok: true, result: {} })
  });
  await assert.rejects(() => mismatched.request('status', {}, { requestId: 'remote-status-0003' }), (error) => error.code === 'INVALID_RUNTIME_RESPONSE');
});
