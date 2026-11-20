/**
 * Tamper-evident sandbox execution receipts and workspace tree attestation
 * (ADR 0011, roadmap P0.2, 2.2 & P3.2).
 *
 * Every sandboxed process run yields a canonical JSON receipt binding:
 *   - backend and confinement class (`os-container`, `os-namespace`, `os-seatbelt`, `runtime-permission`)
 *   - filesystem mode (`read-only` | `write-workspace`) and network flag (`false` | `brokered` | `true`)
 *   - optional broker policy binding (`brokerPolicy`) when brokered model egress was enabled
 *   - policy digest and seccomp profile digest (when applicable)
 *   - pre- and post-execution workspace SHA-256 tree digests + exact changed path list
 *   - bounded timing, exit code, signal and output digest
 *   - `receiptDigest`: SHA-256 over the canonical receipt body
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { digest, extensionError } from '../extension-utils.mjs';

export const SANDBOX_RECEIPT_SCHEMA_VERSION = 1;

export const CONFINEMENT_CLASSES = Object.freeze([
  'os-container',
  'os-namespace',
  'os-seatbelt',
  'runtime-permission'
]);

export const SANDBOX_BACKEND_CLASS = Object.freeze({
  oci: 'os-container',
  bwrap: 'os-namespace',
  'linux-ns': 'os-namespace',
  'darwin-seatbelt': 'os-seatbelt',
  'node-permission': 'runtime-permission'
});

const IGNORED_ENTRIES = new Set(['.git', 'node_modules', '.vld-sandbox-tmp', '.vld-transcript.json', '.vld']);
const SHA256_HEX = /^[a-f0-9]{64}$/;

function matchesGlob(relPath, glob) {
  const escaped = String(glob)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${escaped}$`).test(relPath);
}

/**
 * Snapshot every non-ignored file inside a workspace directory as a sorted map
 * of `posixRelPath -> sha256Hex` (or `symlink:<mode>` without following links).
 */
export function snapshotWorkspace(workspaceDir) {
  const root = path.resolve(workspaceDir);
  const files = new Map();
  if (!existsSync(root)) return files;

  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        files.set(rel, `symlink:${stats.size}:${stats.mode}`);
      } else if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile()) {
        const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        files.set(rel, hash);
      }
    }
  };
  walk(root);
  return files;
}

/** Deterministic SHA-256 over a workspace snapshot map. */
export function workspaceTreeDigest(snapshotOrDir) {
  const snap = snapshotOrDir instanceof Map ? snapshotOrDir : snapshotWorkspace(snapshotOrDir);
  const ordered = [...snap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return digest(ordered);
}

/** List every POSIX relative path added, modified or deleted between two snapshots. */
export function diffWorkspaceSnapshots(before, after) {
  const changed = new Set();
  for (const [rel, hash] of before.entries()) {
    if (!after.has(rel) || after.get(rel) !== hash) changed.add(rel);
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) changed.add(rel);
  }
  return [...changed].sort((a, b) => a.localeCompare(b));
}

/** Check changed relative paths against a work package's declared `resourceClaims.paths` globs. */
export function checkResourceClaims(changedPaths, allowedGlobs = []) {
  if (!Array.isArray(allowedGlobs) || allowedGlobs.length === 0) {
    return { ok: true, violations: [] };
  }
  const violations = [];
  for (const rel of changedPaths) {
    const clean = String(rel).replace(/^\/+/, '');
    const matched = allowedGlobs.some((glob) => matchesGlob(clean, glob));
    if (!matched) violations.push(clean);
  }
  return { ok: violations.length === 0, violations };
}

function receiptBody(receipt) {
  const { receiptDigest: _ignored, ...body } = receipt;
  return body;
}

function normalizeBrokerPolicy(brokerPolicy) {
  if (!brokerPolicy) return null;
  return {
    mode: brokerPolicy.mode === 'loopback-port' ? 'loopback-port' : 'unix-socket',
    endpoint: String(brokerPolicy.endpoint ?? brokerPolicy.socketPath ?? ''),
    allowedProviders: [...(brokerPolicy.allowedProviders ?? [])].map(String).sort(),
    allowedModels: [...(brokerPolicy.allowedModels ?? [])].map(String).sort(),
    maxSteps: Number.isSafeInteger(brokerPolicy.maxSteps) ? brokerPolicy.maxSteps : 0,
    maxTokens: Number.isSafeInteger(brokerPolicy.maxTokens) ? brokerPolicy.maxTokens : 0,
    maxCostUsd: typeof brokerPolicy.maxCostUsd === 'number' && Number.isFinite(brokerPolicy.maxCostUsd)
      ? Number(brokerPolicy.maxCostUsd.toFixed(6))
      : 0,
    callCount: Number.isSafeInteger(brokerPolicy.callCount) ? brokerPolicy.callCount : 0,
    totalTokens: Number.isSafeInteger(brokerPolicy.totalTokens) ? brokerPolicy.totalTokens : 0,
    totalCostUsd: typeof brokerPolicy.totalCostUsd === 'number' && Number.isFinite(brokerPolicy.totalCostUsd)
      ? Number(brokerPolicy.totalCostUsd.toFixed(6))
      : 0,
    logDigest: typeof brokerPolicy.logDigest === 'string' && SHA256_HEX.test(brokerPolicy.logDigest)
      ? brokerPolicy.logDigest
      : null
  };
}

/** Construct a canonical, self-digested sandbox execution receipt. */
export function createSandboxReceipt({
  id = `sbx-${randomUUID()}`,
  backend,
  mode,
  network = false,
  childProcess = false,
  brokerPolicy = null,
  policyDigest = null,
  seccompDigest = null,
  workspaceDigestBefore,
  workspaceDigestAfter,
  changedPaths = [],
  outcome,
  exitCode = null,
  signal = null,
  startedAt,
  finishedAt,
  durationMs = 0,
  outputDigest,
  outputBytes = 0
}) {
  const confinementClass = SANDBOX_BACKEND_CLASS[backend];
  if (!confinementClass) throw extensionError(`unknown sandbox backend "${backend}"`, 'INVALID_SANDBOX_RECEIPT');
  const normalizedBroker = normalizeBrokerPolicy(brokerPolicy);
  const body = {
    schemaVersion: SANDBOX_RECEIPT_SCHEMA_VERSION,
    id: String(id),
    backend,
    confinementClass,
    mode,
    network: Boolean(network),
    childProcess: Boolean(childProcess),
    ...(normalizedBroker ? { brokerPolicy: normalizedBroker } : {}),
    policyDigest: policyDigest ?? null,
    seccompDigest: seccompDigest ?? null,
    workspaceDigestBefore,
    workspaceDigestAfter,
    changedPaths: [...changedPaths].sort((a, b) => a.localeCompare(b)),
    outcome,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    signal: typeof signal === 'string' ? signal : null,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Math.round(durationMs)),
    outputDigest,
    outputBytes: Math.max(0, Math.round(outputBytes))
  };
  return { ...body, receiptDigest: digest(body) };
}

/**
 * Verify a sandbox receipt's shape, digest integrity, confinement posture and
 * optional expected policy/workspace hashes. Fails closed on any mismatch.
 */
export function verifySandboxReceipt(receipt, {
  requireWriteCapable = false,
  requireNoNetwork = false,
  requireOsConfinement = false,
  allowBroker = true,
  expectedPolicyDigest = null,
  expectedWorkspaceDigestBefore = null,
  expectedWorkspaceDigestAfter = null,
  allowedResourceGlobs = null,
  allowedResourcePaths = null
} = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, errors: ['sandbox receipt must be a JSON object'] };
  }
  if (receipt.schemaVersion !== SANDBOX_RECEIPT_SCHEMA_VERSION) {
    errors.push(`sandbox receipt schemaVersion must be ${SANDBOX_RECEIPT_SCHEMA_VERSION}`);
  }
  if (!Object.hasOwn(SANDBOX_BACKEND_CLASS, receipt.backend)) {
    errors.push(`sandbox receipt backend "${receipt.backend}" is not recognized`);
  } else if (receipt.confinementClass !== SANDBOX_BACKEND_CLASS[receipt.backend]) {
    errors.push(`sandbox receipt confinementClass "${receipt.confinementClass}" does not match backend "${receipt.backend}"`);
  }
  if (!['read-only', 'write-workspace'].includes(receipt.mode)) {
    errors.push('sandbox receipt mode must be read-only or write-workspace');
  }
  if (typeof receipt.network !== 'boolean') errors.push('sandbox receipt network must be boolean');
  if (typeof receipt.childProcess !== 'boolean') errors.push('sandbox receipt childProcess must be boolean');
  if (receipt.brokerPolicy !== undefined && receipt.brokerPolicy !== null) {
    const bp = receipt.brokerPolicy;
    if (typeof bp !== 'object' || Array.isArray(bp)) {
      errors.push('sandbox receipt brokerPolicy must be an object');
    } else {
      if (!allowBroker) errors.push('sandbox receipt includes brokerPolicy where brokered egress is disallowed');
      if (!['unix-socket', 'loopback-port'].includes(bp.mode)) errors.push('sandbox receipt brokerPolicy.mode is invalid');
      if (typeof bp.endpoint !== 'string' || !bp.endpoint) errors.push('sandbox receipt brokerPolicy.endpoint is missing');
      if (!Array.isArray(bp.allowedProviders) || bp.allowedProviders.length === 0) {
        errors.push('sandbox receipt brokerPolicy.allowedProviders must be non-empty');
      }
      if (bp.logDigest !== null && !SHA256_HEX.test(String(bp.logDigest ?? ''))) {
        errors.push('sandbox receipt brokerPolicy.logDigest must be sha256 hex or null');
      }
    }
  }
  for (const field of ['workspaceDigestBefore', 'workspaceDigestAfter', 'outputDigest', 'receiptDigest']) {
    if (typeof receipt[field] !== 'string' || !SHA256_HEX.test(receipt[field])) {
      errors.push(`sandbox receipt.${field} must be a lowercase 64-character SHA-256 hex digest`);
    }
  }
  if (receipt.policyDigest !== null && (typeof receipt.policyDigest !== 'string' || !SHA256_HEX.test(receipt.policyDigest))) {
    errors.push('sandbox receipt.policyDigest must be null or a 64-character SHA-256 hex digest');
  }
  if (receipt.seccompDigest !== null && (typeof receipt.seccompDigest !== 'string' || !SHA256_HEX.test(receipt.seccompDigest))) {
    errors.push('sandbox receipt.seccompDigest must be null or a 64-character SHA-256 hex digest');
  }
  if (!Array.isArray(receipt.changedPaths) || receipt.changedPaths.some((p) => typeof p !== 'string' || p.includes('..') || path.isAbsolute(p))) {
    errors.push('sandbox receipt.changedPaths must be an array of safe relative paths');
  }
  if (!['completed', 'failed', 'cancelled', 'timed-out'].includes(receipt.outcome)) {
    errors.push('sandbox receipt.outcome is invalid');
  }
  if (receipt.mode === 'read-only' && receipt.workspaceDigestBefore !== receipt.workspaceDigestAfter) {
    errors.push('read-only sandbox run mutated the workspace tree');
  }
  if (requireWriteCapable && receipt.mode !== 'write-workspace') {
    errors.push('sandbox receipt must have mode "write-workspace"');
  }
  if (requireNoNetwork && receipt.network !== false) {
    errors.push('sandbox receipt must enforce network=false');
  }
  if (requireOsConfinement && receipt.confinementClass === 'runtime-permission') {
    errors.push('sandbox receipt uses runtime-permission confinement where OS-level confinement is required');
  }
  if (expectedPolicyDigest && receipt.policyDigest !== expectedPolicyDigest) {
    errors.push('sandbox receipt policyDigest does not match the active policy');
  }
  if (expectedWorkspaceDigestBefore && receipt.workspaceDigestBefore !== expectedWorkspaceDigestBefore) {
    errors.push('sandbox receipt workspaceDigestBefore does not match expected tree digest');
  }
  if (expectedWorkspaceDigestAfter && receipt.workspaceDigestAfter !== expectedWorkspaceDigestAfter) {
    errors.push('sandbox receipt workspaceDigestAfter does not match current workspace tree digest');
  }
  const effectiveGlobs = Array.isArray(allowedResourceGlobs) ? allowedResourceGlobs : allowedResourcePaths;
  if (Array.isArray(effectiveGlobs) && Array.isArray(receipt.changedPaths)) {
    const claimCheck = checkResourceClaims(receipt.changedPaths, effectiveGlobs);
    if (!claimCheck.ok) {
      errors.push(`sandbox modified undeclared path(s): ${claimCheck.violations.join(', ')}`);
    }
  }
  if (errors.length === 0) {
    const recomputed = digest(receiptBody(receipt));
    if (recomputed !== receipt.receiptDigest) {
      errors.push('sandbox receipt digest mismatch (receipt was tampered with)');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Assert that a workspace mutation carries a valid, network-denied sandbox receipt. */
export function assertWriteReceipt(receipt, options = {}) {
  const result = verifySandboxReceipt(receipt, {
    requireWriteCapable: true,
    requireNoNetwork: true,
    ...options
  });
  if (!result.ok) {
    throw extensionError(`invalid sandbox write receipt: ${result.errors.join('; ')}`, 'SANDBOX_RECEIPT_INVALID');
  }
  return receipt;
}
