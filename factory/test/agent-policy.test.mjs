import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  agentPolicyDigest,
  defaultFakeAgentPolicy,
  loadAgentPolicy,
  validateAgentPolicy
} from '../lib/agent-policy.mjs';

test('M4 fake agent policy is closed, canonical and has no process/network/credential/Git authority', () => {
  const policy = defaultFakeAgentPolicy();
  assert.equal(validateAgentPolicy(policy).ok, true);
  assert.match(agentPolicyDigest(policy), /^[a-f0-9]{64}$/);
  assert.equal(policy.capabilities.network, false);
  assert.equal(policy.capabilities.credentialAccess, false);
  assert.equal(policy.capabilities.gitPush, false);
  assert.equal(policy.capabilities.gitMerge, false);
  assert.equal(policy.capabilities.runDeclaredCommands, false);

  const broadened = structuredClone(policy);
  broadened.capabilities.network = true;
  assert.equal(validateAgentPolicy(broadened).ok, false);
  broadened.capabilities.network = false;
  broadened.command.shell = 'echo unsafe';
  assert.equal(validateAgentPolicy(broadened).ok, false);
});

test('M4 local-process policy is explicit one-argv, no VLD workspace-write authority and rejects unsafe environment/write claims', (t) => {
  const policy = {
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
    limits: { durationMs: 1_000, outputBytes: 4_096, retryBudget: 0 },
    environment: { LANG: 'C' },
    command: { script: null, executable: process.execPath, args: ['--version'] }
  };
  assert.equal(validateAgentPolicy(policy).ok, true);
  const writes = structuredClone(policy);
  writes.mode = 'write-workspace';
  writes.capabilities.writeWorkspace = true;
  writes.capabilities.sandbox = true;
  const checkedWrites = validateAgentPolicy(writes);
  assert.equal(checkedWrites.ok, false, 'CWD is not misrepresented as a sandbox');
  assert.match(checkedWrites.errors.join('\n'), /unconfined host process/);
  const inherited = structuredClone(policy);
  inherited.environment.PARENT_SECRET = 'should-not-pass';
  assert.equal(validateAgentPolicy(inherited).ok, false);
  const evalFlag = structuredClone(policy);
  evalFlag.command.args = ['-e', 'process.exit(0)'];
  assert.equal(validateAgentPolicy(evalFlag).ok, false, 'policy argv may not carry a hidden eval payload');

  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-agent-policy-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(path.join(project, 'policy.json'), `${JSON.stringify(policy)}\n`);
  const loaded = loadAgentPolicy('policy.json', { projectDir: project });
  assert.equal(loaded.policy.id, policy.id);
  assert.equal(loaded.digest, agentPolicyDigest(policy));
  assert.throws(() => loadAgentPolicy('../policy.json', { projectDir: project }), (error) => error.code === 'INVALID_AGENT_POLICY_PATH');
});
