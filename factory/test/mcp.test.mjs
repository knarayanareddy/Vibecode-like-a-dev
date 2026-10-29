/**
 * MCP server tests.
 *
 * Two layers: the protocol handler in isolation, and one real stdio session, so
 * a broken transport is caught rather than assumed to work.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOLS, handleMessage } from '../lib/mcp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const paymentProfile = {
  idea: 'An API that pays marketplace sellers and reconciles against a provider without paying twice.',
  kind: 'api',
  stage: 'production',
  name: 'payout-service',
  traits: ['auth', 'payments', 'webhooks'],
  risks: { payments: true, regulated: true, multiTenant: true },
  scale: 'large'
};

const call = (name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const payload = (response) => JSON.parse(response.result.content[0].text);

test('initialize advertises tools and an instruction to compute rigor first', () => {
  const response = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(response.result.serverInfo.name, 'vibecode-like-a-dev');
  assert.ok(response.result.capabilities.tools);
  assert.match(response.result.instructions, /compute_rigor/);
});

test('every tool has a name, a description and an input schema', () => {
  const response = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = response.result.tools;
  assert.equal(tools.length, TOOLS.length);
  for (const tool of tools) {
    assert.ok(tool.name && /^[a-z_]+$/.test(tool.name), `bad tool name: ${tool.name}`);
    assert.ok(tool.description.length > 60, `${tool.name} has no usable description`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('compute_rigor returns the tier, the signals and the ceilings', () => {
  const result = payload(call('compute_rigor', paymentProfile));
  assert.equal(result.tier, 3);
  assert.ok(result.signals.length >= 3);
  assert.equal(result.limits.practices, 34);
  assert.ok(result.limits.markdownLines >= 900);
});

test('select_primitives returns reasons and records what was skipped', () => {
  const result = payload(call('select_primitives', paymentProfile));
  const ids = result.selected.map((primitive) => primitive.id);
  assert.ok(ids.includes('security.threat-model'));
  assert.ok(ids.includes('testing.property-based-testing'));
  for (const primitive of result.selected) {
    assert.ok(primitive.why.length > 20, `${primitive.id} has no reason`);
  }
  assert.ok(Array.isArray(result.skipped));
  assert.ok(result.skipped.length > 0, 'a tier-3 api still skips frontend practices');
});

test('a prototype selection stays small', () => {
  const result = payload(
    call('select_primitives', {
      idea: 'A throwaway local script that proves one idea and will be deleted.',
      kind: 'cli',
      stage: 'prototype',
      name: 'sketch'
    })
  );
  assert.equal(result.tier, 0);
  assert.ok(result.selected.length <= 6);
});

test('get_requirements returns criteria, failure paths and anchors', () => {
  const result = payload(call('get_requirements', paymentProfile));
  assert.ok(result.requirements.length > 5);
  for (const requirement of result.requirements) {
    assert.match(requirement.id, /^REQ-\d{3}$/);
    assert.ok(requirement.acceptance.length > 0);
    assert.ok(requirement.failurePath.length > 10, `${requirement.id} has no failure path`);
    if (requirement.verify === 'automated') assert.ok(requirement.anchor);
  }
  assert.ok(result.requirements.some((requirement) => requirement.key === 'payments.correctness'));
});

test('search_primitives ranks the right practice first and filters by tier', () => {
  const found = payload(call('search_primitives', { query: 'webhook duplicate retry' }));
  assert.equal(found.matches[0].id, 'reliability.idempotency-and-retries');

  const tierOne = payload(call('search_primitives', { query: 'testing', maxTier: 1 }));
  for (const match of tierOne.matches) assert.ok(match.tier_min <= 1, `${match.id} exceeds maxTier`);

  const none = payload(call('search_primitives', { query: 'zzzzz-not-a-practice' }));
  assert.deepEqual(none.matches, []);
  assert.match(none.hint, /No match/);
});

test('get_primitive returns the practice body, and fails loudly on an unknown id', () => {
  const result = payload(call('get_primitive', { id: 'testing.mutation-testing' }));
  assert.equal(result.id, 'testing.mutation-testing');
  assert.match(result.body, /## The practice/);
  assert.match(result.body, /## Anti-patterns/);
  assert.ok(!result.body.startsWith('---'), 'frontmatter is stripped for the caller');

  const missing = call('get_primitive', { id: 'does.not-exist' });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /unknown primitive/);
});

test('get_gates accumulates obligations from lower tiers', () => {
  const tierTwo = payload(call('get_gates', { tier: 2 }));
  const ids = tierTwo.gates.map((gate) => gate.id);
  assert.ok(ids.includes('G0-RUN'));
  assert.ok(ids.includes('G1-AC-TRACE'));
  assert.ok(ids.includes('G2-DRIFT'));
  assert.ok(!ids.includes('G3-MUTATION'));

  const tierZero = payload(call('get_gates', { tier: 0 }));
  assert.deepEqual(tierZero.gates.map((gate) => gate.id), ['G0-RUN', 'G0-CHECK', 'G0-SMOKE']);
});

test('plan_project returns a compact plan with a next step', () => {
  const result = payload(call('plan_project', paymentProfile));
  assert.equal(result.rigor.tier, 3);
  assert.ok(result.primitives.length > 10);
  assert.ok(result.requirements.length > 5);
  assert.ok(result.stats.gates >= 15);
  assert.match(result.next, /documents|spec\.md/);
});

test('get_anchor_convention states the ratchet and the commands', () => {
  const result = payload(call('get_anchor_convention', {}));
  assert.equal(result.marker, '@req');
  assert.match(result.checks.join(' '), /--strict/);
  assert.match(result.ratchet, /done/);
});

test('invalid input is reported as a tool error, not a crash', () => {
  const result = call('compute_rigor', { idea: 'too short', kind: 'spaceship', stage: 'nope' });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /invalid profile/);
});

test('protocol errors follow JSON-RPC', () => {
  const unknownTool = handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(unknownTool.error.code, -32602);

  const unknownMethod = handleMessage({ jsonrpc: '2.0', id: 10, method: 'nope/nope' });
  assert.equal(unknownMethod.error.code, -32601);

  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'some/notification' }), null);
});

test('a real stdio session works end to end', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'factory', 'cli.mjs'), 'mcp'], {
    stdio: ['pipe', 'pipe', 'ignore']
  });

  const responses = [];
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      responses.push(JSON.parse(line));
    }
  });

  const waitFor = (count, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (responses.length >= count) return resolve();
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`timed out waiting for ${count} responses (got ${responses.length})`));
        }
        setTimeout(tick, 20);
      };
      tick();
    });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'compute_rigor', arguments: paymentProfile } });

    await waitFor(3);

    const init = responses.find((response) => response.id === 1);
    assert.equal(init.result.serverInfo.name, 'vibecode-like-a-dev');

    const list = responses.find((response) => response.id === 2);
    assert.equal(list.result.tools.length, TOOLS.length);

    const rigor = responses.find((response) => response.id === 3);
    assert.equal(JSON.parse(rigor.result.content[0].text).tier, 3);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
