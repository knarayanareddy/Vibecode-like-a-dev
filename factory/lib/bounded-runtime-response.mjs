/**
 * Streaming byte limit for Runtime JSON responses.
 *
 * Browser fetch, Node's built-in fetch and injectable test transports all expose
 * slightly different response shapes. This helper uses a ReadableStream when it
 * exists and keeps the legacy `.text()` path only for bounded fixture shims.
 */

export async function readBoundedRuntimeText(response, maxBytes) {
  const declared = Number(response?.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`Runtime response exceeds ${maxBytes} bytes`);
    error.code = 'RUNTIME_RESPONSE_TOO_LARGE';
    throw error;
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      const error = new Error(`Runtime response exceeds ${maxBytes} bytes`);
      error.code = 'RUNTIME_RESPONSE_TOO_LARGE';
      throw error;
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        const error = new Error(`Runtime response exceeds ${maxBytes} bytes`);
        error.code = 'RUNTIME_RESPONSE_TOO_LARGE';
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}
