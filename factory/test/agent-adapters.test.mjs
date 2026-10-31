import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeAgentAdapter, normalizeAdapterEvent } from '../lib/agent-adapters.mjs';

function localPolicy(script, mode, durationMs = 1_000) {
  return {
    schemaVersion: 1,
    id: 'fixture-process',
    adapter: 'local-process',
    mode: 'read-only',
    capabilities: {
      readWorkspace: true,
      writeWorkspace: false,
      runDeclaredCommands: true,
      network: false,
      streamEvents: true,
      cancel: true,
      reconnect: false,
      sandbox: false,
      credentialAccess: false,
      gitPush: false,
      gitMerge: false
    },
    limits: { durationMs, outputBytes: 1_024, retryBudget: 0 },
    environment: { LANG: 'C' },
    command: { script: null, executable: process.execPath, args: [script, mode, '; touch not-a-command'] }
  };
}

function spec(workspace) {
  return {
    id: 'agent-run-fixture',
    missionId: 'fixture-mission',
    packageId: 'fixture-work',
    packetDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    requirementIds: ['REQ-001'],
    workspace
  };
}

test('local-process preserves argv, uses the allocated CWD, inherits no parent secret and redacts bounded output', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-adapter-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fixture = path.join(workspace, 'fixture.mjs');
  writeFileSync(fixture, `
    console.log('cwd=' + process.cwd());
    console.log('parent=' + String(process.env.PARENT_SECRET));
    console.log('token=very-secret-fixture-value');
    console.log('argv=' + JSON.stringify(process.argv.slice(2)));
  `);
  process.env.PARENT_SECRET = 'parent-secret-must-not-reach-child';
  const events = [];
  const result = await executeAgentAdapter({ spec: spec(workspace), policy: localPolicy(fixture, 'probe'), onEvent: (event) => events.push(event) });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputSummary.includes('parent-secret-must-not-reach-child'), false);
  assert.equal(result.outputSummary.includes('very-secret-fixture-value'), false);
  assert.equal(result.outputSummary.includes(workspace), false, 'host workspace path is redacted from retained output');
  assert.match(result.outputSummary, /parent=undefined/);
  assert.match(result.outputSummary, /token=\[REDACTED\]/);
  assert.match(result.outputSummary, /; touch not-a-command/, 'semicolon remains a literal argv value, never a shell command');
  assert.ok(events.some((event) => event.type === 'output' && event.bytes > 0));
  assert.equal(events.every((event) => !Object.hasOwn(event, 'raw')), true);
  delete process.env.PARENT_SECRET;
});

test('local-process timeout/cancel terminate an isolated process group and malformed events fail closed', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-timeout-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fixture = path.join(workspace, 'fixture.mjs');
  writeFileSync(fixture, `process.on('SIGTERM', () => {}); setInterval(() => console.log('tick'), 20);`);
  const result = await executeAgentAdapter({ spec: spec(workspace), policy: localPolicy(fixture, 'sleep', 100) });
  assert.equal(result.outcome, 'timed-out');
  assert.ok(result.outputBytes > 0);

  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(), 40);
  const cancelled = await executeAgentAdapter({ spec: spec(workspace), policy: localPolicy(fixture, 'sleep', 1_000), signal: controller.signal });
  clearTimeout(cancelTimer);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.throws(
    () => normalizeAdapterEvent({ type: 'output', at: new Date().toISOString(), raw: 'not allowed' }),
    (error) => error.code === 'INVALID_AGENT_EVENT'
  );
});

test('local-process hashes full oversized output while retaining only a capped redacted summary', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-output-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const fixture = path.join(workspace, 'fixture.mjs');
  writeFileSync(fixture, `process.stdout.write('token=large-secret-value ' + 'x'.repeat(12_000));`);
  const result = await executeAgentAdapter({ spec: spec(workspace), policy: localPolicy(fixture, 'large') });
  assert.equal(result.outcome, 'completed');
  assert.ok(result.outputBytes > 1_024);
  assert.ok(result.outputSummary.length < 1_200);
  assert.equal(result.outputSummary.includes('large-secret-value'), false);
  assert.match(result.outputDigest, /^[a-f0-9]{64}$/);
});
