/* VLD Studio VS Code command entry. It never invokes Git, agents or a shell. */

const crypto = require('node:crypto');
const http = require('node:http');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loopbackStudioUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname.replace(/\/$/, '') !== '/studio' || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function runtimeEndpoint(studioUrl) {
  const endpoint = new URL(studioUrl);
  endpoint.pathname = '/v1/runtime';
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function validWebviewMessage(value) {
  return isPlainObject(value) && Object.keys(value).length === 1 && value.type === 'refresh';
}

function safeError(error) {
  return String(error && error.message || 'Runtime request failed').replace(/[\r\n\0]/g, ' ').slice(0, 500);
}

function safeRuntimeValue(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return Array.from(value, (character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ? '�' : character;
  }).join('').slice(0, 4_000);
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => safeRuntimeValue(entry, depth + 1));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, entry]) => [safeRuntimeValue(key, depth + 1), safeRuntimeValue(entry, depth + 1)]));
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  return String(value).slice(0, 4_000);
}

function runtimeStatus(endpoint, token) {
  const payload = JSON.stringify({ schemaVersion: 1, requestId: `vscode-${crypto.randomUUID()}`, method: 'status', params: {} });
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { body += part; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (response.statusCode !== 200 || !parsed.ok) reject(new Error(parsed.error && parsed.error.message || 'Runtime rejected the request'));
          else resolve(parsed.result);
        } catch { reject(new Error('Runtime returned an invalid response')); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function panelHtml(webview) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-src 'none'; img-src 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style nonce="${nonce}">body{font:var(--vscode-font-family);padding:1rem}button{font:inherit;padding:.4rem}.error{color:var(--vscode-errorForeground)}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>VLD Runtime inspector</h1><p id="state">Loading local Runtime status…</p><button id="refresh" type="button">Refresh authoritative status</button><pre id="output" aria-live="polite"></pre><script nonce="${nonce}">(() => { const api = acquireVsCodeApi(); const state = document.getElementById('state'); const output = document.getElementById('output'); function refresh(){ api.postMessage({type:'refresh'}); } document.getElementById('refresh').addEventListener('click', refresh); window.addEventListener('message', (event) => { const data = event.data; if (!data || typeof data !== 'object' || (data.type !== 'status' && data.type !== 'error')) return; state.textContent = data.type === 'error' ? 'Runtime error' : 'Authoritative Runtime status'; state.className = data.type === 'error' ? 'error' : ''; output.textContent = data.type === 'error' ? String(data.message || 'Runtime request failed') : JSON.stringify(data.status, null, 2); }); refresh(); })();</script></body></html>`;
}

function activate(context) {
  const vscode = require('vscode');
  context.subscriptions.push(vscode.commands.registerCommand('vld.studio.openDashboard', async () => {
    const raw = await vscode.window.showInputBox({ prompt: 'Local VLD Studio URL (from vld studio serve)', placeHolder: 'http://127.0.0.1:PORT/studio', ignoreFocusOut: true });
    if (raw === undefined) return;
    const url = loopbackStudioUrl(raw);
    if (!url) { vscode.window.showErrorMessage('VLD Studio accepts only an exact loopback http://127.0.0.1:PORT/studio URL.'); return; }
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vld.studio.inspectRuntime', async () => {
    const raw = await vscode.window.showInputBox({ prompt: 'Local VLD Studio URL (from vld studio serve)', placeHolder: 'http://127.0.0.1:PORT/studio', ignoreFocusOut: true });
    if (raw === undefined) return;
    const url = loopbackStudioUrl(raw);
    if (!url) { vscode.window.showErrorMessage('VLD Runtime must be a loopback Studio URL.'); return; }
    const token = await vscode.window.showInputBox({ prompt: 'Runtime bearer token (kept only for this inspector session)', password: true, ignoreFocusOut: true });
    if (!token) return;
    const endpoint = runtimeEndpoint(url);
    const panel = vscode.window.createWebviewPanel('vldStudioRuntime', 'VLD Runtime inspector', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    panel.webview.html = panelHtml(panel.webview);
    panel.webview.onDidReceiveMessage(async (message) => {
      if (!validWebviewMessage(message)) return;
      try { panel.webview.postMessage({ type: 'status', status: safeRuntimeValue(await runtimeStatus(endpoint, token)) }); }
      catch (error) { panel.webview.postMessage({ type: 'error', message: safeError(error) }); }
    }, null, context.subscriptions);
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, loopbackStudioUrl, runtimeEndpoint, validWebviewMessage, panelHtml, safeError, safeRuntimeValue };
