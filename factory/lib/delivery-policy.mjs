/**
 * Closed M5 delivery policy for candidates, host-owned verification and review.
 *
 * M5 deliberately has no project-command runner or merge permission. The host
 * verifies the frozen VLD packet in a disposable integration worktree. A future
 * sandboxed verifier/forge adapter must expand this schema in a new ADR.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { digest, ensureProjectDir, extensionError, ID_PATTERN } from './extension-utils.mjs';

export const DELIVERY_POLICY_SCHEMA_VERSION = 1;

const POLICY_FIELDS = new Set(['schemaVersion', 'id', 'verification', 'review', 'queue', 'merge']);
const VERIFICATION_FIELDS = new Set(['verifyPacket', 'commands']);
const REVIEW_FIELDS = new Set(['independent']);
const QUEUE_FIELDS = new Set(['enabled']);
const MERGE_FIELDS = new Set(['local', 'push', 'forge']);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closedObject(value, allowed, label, errors) {
  if (!plainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  return true;
}

/** A safe default has exactly the VLD host packet verifier and no forge action. */
export function defaultDeliveryPolicy() {
  return {
    schemaVersion: DELIVERY_POLICY_SCHEMA_VERSION,
    id: 'local-delivery-v1',
    verification: { verifyPacket: true, commands: [] },
    review: { independent: true },
    queue: { enabled: true },
    merge: { local: false, push: false, forge: false }
  };
}

export function validateDeliveryPolicy(policy) {
  const errors = [];
  closedObject(policy, POLICY_FIELDS, 'delivery policy', errors);
  if (!plainObject(policy)) return { ok: false, errors };
  if (policy.schemaVersion !== DELIVERY_POLICY_SCHEMA_VERSION) errors.push(`delivery policy schemaVersion must be ${DELIVERY_POLICY_SCHEMA_VERSION}`);
  if (!ID_PATTERN.test(String(policy.id ?? ''))) errors.push('delivery policy id must be lowercase kebab-case');
  if (closedObject(policy.verification, VERIFICATION_FIELDS, 'delivery policy.verification', errors)) {
    if (policy.verification.verifyPacket !== true) errors.push('delivery policy verification.verifyPacket must be true');
    if (!Array.isArray(policy.verification.commands) || policy.verification.commands.length !== 0) {
      errors.push('M5 delivery policy supports no project command checks until a sandboxed verifier is separately approved');
    }
  }
  if (closedObject(policy.review, REVIEW_FIELDS, 'delivery policy.review', errors) && policy.review.independent !== true) errors.push('delivery policy review.independent must be true');
  if (closedObject(policy.queue, QUEUE_FIELDS, 'delivery policy.queue', errors) && policy.queue.enabled !== true) errors.push('delivery policy queue.enabled must be true');
  if (closedObject(policy.merge, MERGE_FIELDS, 'delivery policy.merge', errors)) {
    for (const field of MERGE_FIELDS) if (policy.merge[field] !== false) errors.push(`M5 delivery policy merge.${field} must be false`);
  }
  return { ok: errors.length === 0, errors };
}

export function assertDeliveryPolicy(policy) {
  const checked = validateDeliveryPolicy(policy);
  if (!checked.ok) throw extensionError(`delivery policy is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_DELIVERY_POLICY');
  return policy;
}

export function deliveryPolicyDigest(policy) {
  return digest(assertDeliveryPolicy(policy));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Load an explicitly reviewed, regular policy file within the project root. */
export function loadDeliveryPolicy(policyFile, { projectDir = '.' } = {}) {
  const project = ensureProjectDir(projectDir);
  if (typeof policyFile !== 'string' || !policyFile.trim() || path.isAbsolute(policyFile) || /[\r\n\0]/.test(policyFile)) {
    throw extensionError('delivery policy file must be a non-empty relative path inside the project', 'INVALID_DELIVERY_POLICY_PATH');
  }
  const file = path.resolve(project, policyFile);
  if (!isWithin(project, file)) throw extensionError('delivery policy file escapes the project', 'INVALID_DELIVERY_POLICY_PATH');
  let cursor = project;
  for (const part of path.relative(project, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw extensionError('delivery policy file may not traverse a symbolic link', 'INVALID_DELIVERY_POLICY_PATH');
  }
  if (!existsSync(file) || !lstatSync(file).isFile()) throw extensionError('delivery policy file is not a regular file', 'DELIVERY_POLICY_NOT_FOUND');
  let policy;
  try { policy = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw extensionError(`delivery policy file is invalid JSON: ${error.message}`, 'INVALID_DELIVERY_POLICY'); }
  assertDeliveryPolicy(policy);
  return { project, file, policy, digest: deliveryPolicyDigest(policy) };
}
