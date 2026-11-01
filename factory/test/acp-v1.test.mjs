/** M8 ACP v1 contract: stable negotiation and inert normalized peer metadata. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acpV1Prompt, negotiateAcpV1, normalizeAcpV1Stop, normalizeAcpV1Update } from '../integrations/acp-v1/contract.mjs';
import { adapterCapabilities, executeAgentAdapter } from '../lib/agent-adapters.mjs';
import { defaultFakeAgentPolicy, validateAgentPolicy } from '../lib/agent-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIGEST = 'a'.repeat(64);
const spec = { id: 'agent-run-abc', missionId: 'delivery-mission', packageId: 'export-api', packetDigest: DIGEST, contextDigest: DIGEST, requirementIds: ['REQ-001', 'REQ-002'] };

test('M8 ACP v1 accepts only stable v1 anonymous peer negotiation and emits no raw peer content', () => {
  const negotiated = negotiateAcpV1({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }, agentInfo: { name: 'fixture-peer', version: '1.2.3' } }, { requireReconnect: true });
  assert.deepEqual(negotiated, { protocolVersion: 1, agent: { name: 'fixture-peer', version: '1.2.3' }, reconnect: true, close: true });
  assert.throws(() => negotiateAcpV1({ protocolVersion: 2 }), (error) => error.code === 'ACP_V1_VERSION_UNSUPPORTED');
  assert.throws(() => negotiateAcpV1({ protocolVersion: 1, authMethods: [{ id: 'login' }] }), (error) => error.code === 'ACP_V1_AUTH_UNSUPPORTED');
  assert.throws(() => negotiateAcpV1({ protocolVersion: 1, agentCapabilities: { loadSession: false } }, { requireReconnect: true }), (error) => error.code === 'ACP_V1_CAPABILITY_MISSING');

  const prompt = acpV1Prompt(spec);
  assert.match(prompt, /delivery-mission/); assert.match(prompt, /REQ-001, REQ-002/); assert.match(prompt, /does not grant them through ACP/);
  assert.throws(() => acpV1Prompt({ ...spec, packetDigest: 'not-a-digest' }), (error) => error.code === 'INVALID_ACP_V1_RUN');
  const event = normalizeAcpV1Update({ sessionUpdate: 'tool_call', content: 'token=do-not-persist' }, { at: '2030-01-01T00:00:00.000Z' });
  assert.equal(event.type, 'progress'); assert.equal(event.message, 'ACP v1 tool call'); assert.match(event.digest, /^[a-f0-9]{64}$/); assert.doesNotMatch(event.message, /token/);
  assert.throws(() => normalizeAcpV1Update({ sessionUpdate: 'unknown' }), (error) => error.code === 'ACP_V1_PROTOCOL_INVALID');
  assert.deepEqual(normalizeAcpV1Stop({ stopReason: 'end_turn' }).outcome, 'completed');
  assert.deepEqual(normalizeAcpV1Stop({ stopReason: 'cancelled' }).outcome, 'cancelled');
  assert.throws(() => normalizeAcpV1Stop({ stopReason: 'out-of-order' }), (error) => error.code === 'ACP_V1_PROTOCOL_INVALID');
});

test('M8 ACP policy remains an unconfined direct-argv optional boundary with no VLD workspace-write authority and Core does not import the SDK', async () => {
  const policy = defaultFakeAgentPolicy();
  policy.id = 'acp-read-only'; policy.adapter = 'acp-v1'; policy.mode = 'read-only'; policy.capabilities = { ...policy.capabilities, writeWorkspace: false, runDeclaredCommands: true, sandbox: false, reconnect: true }; policy.command = { script: null, executable: '/opt/fixture/acp-peer', args: ['--stdio'] };
  assert.equal(validateAgentPolicy(policy).ok, true);
  const unavailablePolicy = JSON.parse(JSON.stringify(policy));
  assert.equal(adapterCapabilities('acp-v1').reconnect, true);
  policy.capabilities.writeWorkspace = true;
  assert.match(validateAgentPolicy(policy).errors.join('\n'), /unconfined host process/);

  const adapter = readFileSync(path.join(ROOT, 'factory', 'lib', 'agent-adapters.mjs'), 'utf8');
  const bridge = readFileSync(path.join(ROOT, 'factory', 'integrations', 'acp-v1', 'index.mjs'), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'factory', 'integrations', 'acp-v1', 'package.json'), 'utf8'));
  const rootManifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const agents = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(adapter, /from ['"]@agentclientprotocol\/sdk/);
  assert.match(bridge, /from '@agentclientprotocol\/sdk'/);
  assert.doesNotMatch(bridge, /@agentclientprotocol\/sdk\/unstable|experimental\/v2/);
  assert.equal(manifest.dependencies['@agentclientprotocol/sdk'], '2.2.0');
  assert.equal(rootManifest.engines.node, '>=22');
  assert.equal(manifest.engines.node, '>=22');
  assert.match(agents, /Node 22\+/);
  assert.match(ci, /node-version: 22/);
  await assert.rejects(() => executeAgentAdapter({ spec: { ...spec, workspace: ROOT }, policy: unavailablePolicy }), (error) => error.code === 'ACP_V1_ADAPTER_UNAVAILABLE');
});
