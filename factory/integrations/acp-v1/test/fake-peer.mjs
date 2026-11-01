/** Minimal stable ACP v1 fixture peer for the opt-in package test only. */

import readline from 'node:readline';

const ignoreCancellation = process.argv.includes('--ignore-cancel');
if (ignoreCancellation) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}

function response(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
  if (message.method === 'initialize') response(message.id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'vld-fixture-peer', version: '1.0.0' } });
  else if (message.method === 'session/new') response(message.id, { sessionId: 'fixture-session' });
  else if (message.method === 'session/prompt') { if (!ignoreCancellation) response(message.id, { stopReason: 'end_turn' }); }
  else if (message.method === 'session/cancel') { if (!ignoreCancellation) response(message.id, {}); }
  else response(message.id, {});
}
