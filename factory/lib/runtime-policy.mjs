/**
 * Pure Phase 3 Runtime policy and transition rules.
 *
 * This module deliberately has no filesystem, process, network, Git or model
 * dependency. The optional Runtime host imports it; Core compilation does not.
 */

import { digest, extensionError, ID_PATTERN } from './extension-utils.mjs';

export const RUNTIME_POLICY_SCHEMA_VERSION = 1;
export const RUNTIME_ROLES = Object.freeze([
  'operator',
  'runtime',
  'implementer',
  'reviewer',
  'release-approver',
  'forge'
]);
export const RUNTIME_STATES = Object.freeze([
  'planned',
  'ready',
  'allocated',
  'running',
  'changes_ready',
  'verifying',
  'in_review',
  'approved',
  'queued',
  'merged',
  'blocked'
]);

const POLICY_FIELDS = new Set(['schemaVersion', 'id', 'localOnly', 'lease', 'capabilities']);
const LEASE_FIELDS = new Set(['minimumMs', 'maximumMs']);
const CAPABILITY_FIELDS = new Set(['network', 'processExecution', 'gitPush', 'gitMerge', 'credentialAccess']);
const STATE_SET = new Set(RUNTIME_STATES);
const ROLE_SET = new Set(RUNTIME_ROLES);

export function defaultRuntimePolicy() {
  return {
    schemaVersion: RUNTIME_POLICY_SCHEMA_VERSION,
    id: 'local-runtime-v1',
    localOnly: true,
    lease: { minimumMs: 1_000, maximumMs: 30 * 60 * 1_000 },
    capabilities: {
      network: false,
      processExecution: false,
      gitPush: false,
      gitMerge: false,
      credentialAccess: false
    }
  };
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(value, allowed, label, errors) {
  if (!object(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
}

/** Validate the small, fixed M3 local-only policy shape. */
export function validateRuntimePolicy(policy) {
  const errors = [];
  unknownFields(policy, POLICY_FIELDS, 'runtime policy', errors);
  if (!object(policy)) return { ok: false, errors };
  if (policy.schemaVersion !== RUNTIME_POLICY_SCHEMA_VERSION) errors.push(`runtime policy schemaVersion must be ${RUNTIME_POLICY_SCHEMA_VERSION}`);
  if (!ID_PATTERN.test(String(policy.id ?? ''))) errors.push('runtime policy id must be lowercase kebab-case');
  if (policy.localOnly !== true) errors.push('M3 Runtime policy must be localOnly: true');

  unknownFields(policy.lease, LEASE_FIELDS, 'runtime policy.lease', errors);
  const minimum = policy.lease?.minimumMs;
  const maximum = policy.lease?.maximumMs;
  if (!Number.isSafeInteger(minimum) || minimum < 1_000) errors.push('runtime policy.lease.minimumMs must be an integer of at least 1000');
  if (!Number.isSafeInteger(maximum) || maximum > 24 * 60 * 60 * 1_000) errors.push('runtime policy.lease.maximumMs must be an integer no greater than one day');
  if (Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum > maximum) errors.push('runtime policy.lease.minimumMs may not exceed maximumMs');

  unknownFields(policy.capabilities, CAPABILITY_FIELDS, 'runtime policy.capabilities', errors);
  for (const field of CAPABILITY_FIELDS) {
    if (policy.capabilities?.[field] !== false) errors.push(`M3 Runtime policy.capabilities.${field} must be false`);
  }
  return { ok: errors.length === 0, errors };
}

export function runtimePolicyDigest(policy) {
  const checked = validateRuntimePolicy(policy);
  if (!checked.ok) throw extensionError(`runtime policy is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_RUNTIME_POLICY');
  return digest(policy);
}

export function validateRuntimeActor(actor) {
  const errors = [];
  const allowed = new Set(['role', 'id']);
  unknownFields(actor, allowed, 'runtime actor', errors);
  if (!object(actor)) return { ok: false, errors };
  if (!ROLE_SET.has(actor.role)) errors.push(`runtime actor role must be one of: ${RUNTIME_ROLES.join(', ')}`);
  if (!ID_PATTERN.test(String(actor.id ?? ''))) errors.push('runtime actor id must be lowercase kebab-case');
  return { ok: errors.length === 0, errors };
}

export function assertRuntimeActor(actor) {
  const checked = validateRuntimeActor(actor);
  if (!checked.ok) throw extensionError(`runtime actor is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_RUNTIME_ACTOR');
  return { role: actor.role, id: actor.id };
}

export function assertLeaseDuration(value, policy) {
  const checked = validateRuntimePolicy(policy);
  if (!checked.ok) throw extensionError('runtime policy is invalid', 'INVALID_RUNTIME_POLICY');
  if (!Number.isSafeInteger(value) || value < policy.lease.minimumMs || value > policy.lease.maximumMs) {
    throw extensionError(`lease duration must be an integer between ${policy.lease.minimumMs} and ${policy.lease.maximumMs} milliseconds`, 'INVALID_RUNTIME_LEASE');
  }
  return value;
}

export function assertCanAllocate(actor) {
  const normalized = assertRuntimeActor(actor);
  if (!['operator', 'runtime'].includes(normalized.role)) throw extensionError('only an operator or Runtime host may allocate a package', 'RUNTIME_ACTOR_FORBIDDEN');
  return normalized;
}

export function assertCanHeartbeat(actor, holderId) {
  const normalized = assertRuntimeActor(actor);
  if (normalized.role !== 'implementer' || normalized.id !== holderId) throw extensionError('only the assigned implementer may heartbeat a lease', 'RUNTIME_ACTOR_FORBIDDEN');
  return normalized;
}

/**
 * Validate the Runtime-owned state graph. A caller can submit a request, but
 * only this host rule accepts or records the transition.
 */
export function assertRuntimeTransition({ from, to, actor, holderId = null } = {}) {
  const normalized = assertRuntimeActor(actor);
  if (!STATE_SET.has(from) || !STATE_SET.has(to)) throw extensionError('runtime transition names an unknown state', 'INVALID_RUNTIME_TRANSITION');
  if (from === to) throw extensionError('runtime transition must change state', 'INVALID_RUNTIME_TRANSITION');

  const transition = `${from}->${to}`;
  const permitted = {
    'planned->ready': ['runtime'],
    'ready->allocated': ['operator', 'runtime'],
    'allocated->running': ['implementer'],
    'running->changes_ready': ['implementer'],
    'changes_ready->verifying': ['runtime'],
    'verifying->in_review': ['runtime'],
    'in_review->approved': ['reviewer'],
    'in_review->ready': ['reviewer'],
    'approved->queued': ['release-approver'],
    'queued->merged': ['forge'],
    'blocked->ready': ['operator', 'runtime']
  };
  if (to === 'blocked' && !['operator', 'runtime', 'implementer', 'reviewer', 'release-approver', 'forge'].includes(normalized.role)) {
    throw extensionError(`actor role ${normalized.role} may not block a package`, 'RUNTIME_ACTOR_FORBIDDEN');
  } else if (to !== 'blocked' && !permitted[transition]?.includes(normalized.role)) {
    throw extensionError(`actor role ${normalized.role} may not transition ${transition}`, 'RUNTIME_ACTOR_FORBIDDEN');
  }
  if (['allocated->running', 'running->changes_ready'].includes(transition) && normalized.id !== holderId) {
    throw extensionError('only the assigned implementer may advance its active package', 'RUNTIME_ACTOR_FORBIDDEN');
  }
  if (transition === 'in_review->approved' && holderId && normalized.id === holderId) {
    throw extensionError('an implementer may not approve its own candidate', 'SELF_REVIEW_FORBIDDEN');
  }
  return normalized;
}

export function isTerminalRuntimeState(state) {
  return ['merged'].includes(state);
}
