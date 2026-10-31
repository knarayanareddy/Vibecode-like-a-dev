import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRuntimeTransition,
  defaultRuntimePolicy,
  runtimePolicyDigest,
  validateRuntimeActor,
  validateRuntimePolicy
} from '../lib/runtime-policy.mjs';

test('M3 default Runtime policy is closed, local-only and has no process/network/credential/Git authority', () => {
  const policy = defaultRuntimePolicy();
  assert.equal(validateRuntimePolicy(policy).ok, true);
  assert.match(runtimePolicyDigest(policy), /^[a-f0-9]{64}$/);
  assert.deepEqual(policy.capabilities, {
    network: false,
    processExecution: false,
    gitPush: false,
    gitMerge: false,
    credentialAccess: false
  });
  const malformed = { ...policy, capabilities: { ...policy.capabilities }, command: 'rm -rf /' };
  assert.equal(validateRuntimePolicy(malformed).ok, false);
  malformed.capabilities.network = true;
  assert.equal(validateRuntimePolicy(malformed).ok, false);
  assert.equal(validateRuntimeActor({ role: 'reviewer', id: 'reviewer-one' }).ok, true);
  assert.equal(validateRuntimeActor({ role: 'reviewer', id: 'reviewer\nspoof' }).ok, false);
});

test('M3 transition policy rejects role escalation and self-approval', () => {
  assert.throws(
    () => assertRuntimeTransition({ from: 'running', to: 'changes_ready', actor: { role: 'reviewer', id: 'reviewer-one' }, holderId: 'implementer-one' }),
    (error) => error.code === 'RUNTIME_ACTOR_FORBIDDEN'
  );
  assert.throws(
    () => assertRuntimeTransition({ from: 'in_review', to: 'approved', actor: { role: 'reviewer', id: 'implementer-one' }, holderId: 'implementer-one' }),
    (error) => error.code === 'SELF_REVIEW_FORBIDDEN'
  );
  assert.throws(
    () => assertRuntimeTransition({ from: 'queued', to: 'merged', actor: { role: 'implementer', id: 'implementer-one' }, holderId: 'implementer-one' }),
    (error) => error.code === 'RUNTIME_ACTOR_FORBIDDEN'
  );
  assert.deepEqual(
    assertRuntimeTransition({ from: 'queued', to: 'merged', actor: { role: 'forge', id: 'local-forge' }, holderId: 'implementer-one' }),
    { role: 'forge', id: 'local-forge' }
  );
});
