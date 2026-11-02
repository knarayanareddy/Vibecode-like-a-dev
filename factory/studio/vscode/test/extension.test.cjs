const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const extension = require('../extension.cjs');

test('Studio accepts only an exact loopback dashboard URL', () => {
  assert.equal(extension.loopbackStudioUrl('http://127.0.0.1:4567/studio').href, 'http://127.0.0.1:4567/studio');
  for (const unsafe of ['https://127.0.0.1:4567/studio', 'http://example.test/studio', 'http://127.0.0.1:4567/studio?token=x', 'http://127.0.0.1:4567/v1/runtime']) {
    assert.equal(extension.loopbackStudioUrl(unsafe), null, unsafe);
  }
});

test('Studio derives a fixed Runtime endpoint and accepts only refresh messages', () => {
  assert.equal(extension.runtimeEndpoint('http://localhost:8999/studio').href, 'http://localhost:8999/v1/runtime');
  assert.equal(extension.validWebviewMessage({ type: 'refresh' }), true);
  assert.equal(extension.validWebviewMessage({ type: 'refresh', extra: true }), false);
  assert.equal(extension.validWebviewMessage({ type: 'command' }), false);
});

test('Studio rendering keeps its content-security boundary and redacts control characters', () => {
  const html = extension.panelHtml({});
  assert.match(html, /default-src 'none'/);
  assert.match(html, /acquireVsCodeApi/);
  assert.equal(extension.safeError(new Error('bad\nmessage\0')), 'bad message ');
  assert.deepEqual(extension.safeRuntimeValue({ value: 'safe\u202eevil' }), { value: 'safe�evil' });
});

test('Studio rejects an oversized Runtime response before buffering it', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: { payload: 'x'.repeat(20_000) } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await assert.rejects(
      extension.runtimeStatus(new URL(`http://127.0.0.1:${port}/v1/runtime`), 'test-token', { maxBytes: 512 }),
      /exceeds 512 bytes/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
