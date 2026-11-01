import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAcpV1Adapter } from '../index.mjs';

const HASH = 'a'.repeat(64);
const PEER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-peer.mjs');

test('optional bridge completes a stable v1 fake peer session without client capability grants', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-acp-v1-')); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const events = [];
  const result = await runAcpV1Adapter({
    spec: { id: 'agent-run-fixture', missionId: 'fixture-mission', packageId: 'fixture-package', packetDigest: HASH, contextDigest: HASH, requirementIds: ['REQ-001'], workspace },
    policy: { environment: {}, limits: { durationMs: 2_000 }, command: { script: null, executable: process.execPath, args: [PEER] }, capabilities: { reconnect: false } },
    onEvent: (event) => events.push(event)
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.outputBytes, 0);
  assert.deepEqual(events.map((event) => event.type), ['started', 'completed']);
});


test('abort bounds an unresponsive ACP cancel RPC and escalates a SIGTERM-ignoring peer', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-acp-v1-cancel-')); t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 40);
  const started = Date.now();
  const result = await runAcpV1Adapter({
    spec: { id: 'agent-run-cancel', missionId: 'fixture-mission', packageId: 'fixture-package', packetDigest: HASH, contextDigest: HASH, requirementIds: ['REQ-001'], workspace },
    policy: { environment: {}, limits: { durationMs: 3_000 }, command: { script: null, executable: process.execPath, args: [PEER, '--ignore-cancel'] }, capabilities: { reconnect: false } },
    signal: controller.signal
  });
  clearTimeout(abortTimer);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(Date.now() - started < 1_500, 'local termination must not wait for the peer policy timeout');
});
