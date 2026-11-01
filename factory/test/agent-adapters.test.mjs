import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
  // A Windows child can be terminated during process start-up before its first
  // timer callback; timeout correctness must not depend on incidental output.

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


test('local-process policy flags do not claim OS containment for a same-user child', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-boundary-workspace-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-boundary-outside-'));
  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  // This fixture is intentionally outside the selected workspace. It models a
  // file readable by the invoking OS user, not a real secret.
  const controlledCredentialFixture = path.join(outside, 'controlled-credential-fixture.txt');
  writeFileSync(controlledCredentialFixture, 'controlled-fixture-not-a-secret');
  const server = net.createServer((socket) => socket.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const fixture = path.join(workspace, 'unconfined-child.mjs');
  writeFileSync(fixture, `
    import { readFileSync, writeFileSync } from 'node:fs';
    import net from 'node:net';
    const outsideFile = ${JSON.stringify(controlledCredentialFixture)};
    if (readFileSync(outsideFile, 'utf8') !== 'controlled-fixture-not-a-secret') throw new Error('outside read failed');
    writeFileSync(outsideFile, 'child-wrote-outside-workspace');
    const socket = net.connect({ host: '127.0.0.1', port: ${port} });
    socket.once('connect', () => { console.log('same-user-outside-access-and-loopback-egress'); socket.end(); });
    socket.once('error', (error) => { throw error; });
  `);

  const result = await executeAgentAdapter({ spec: spec(workspace), policy: localPolicy(fixture, 'boundary-probe', 2_000) });
  assert.equal(result.outcome, 'completed');
  assert.equal(readFileSync(controlledCredentialFixture, 'utf8'), 'child-wrote-outside-workspace');
  assert.match(result.outputSummary, /same-user-outside-access-and-loopback-egress/);

  // This is a regression probe for the *current unconfined baseline*. A future
  // sandbox adapter must invert these observations before advertising enforced
  // filesystem, credential or network isolation.
});
