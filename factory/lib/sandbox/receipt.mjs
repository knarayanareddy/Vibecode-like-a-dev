/**
 * Tamper-evident sandbox execution receipts and workspace change verification
 * (ADR 0011, roadmap 2.2 / 2.4).
 *
 * Every sandboxed adapter or verifier run emits a canonical JSON receipt whose
 * `receiptDigest` binds the backend, confinement class, mode, policy digest,
 * before/after workspace digests, changed relative paths, exit metadata and
 * redacted output digest. Workspace-write transitions and v2 candidate
 * submissions verify this receipt before accepting mutations.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { digest, extensionError } from '../extension-utils.mjs';
import { matchesGlob } from '../stacks.mjs';

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

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.vld-sandbox-tmp']);
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Snapshot every non-Git file inside `workspaceDir` as a deterministic map of
 * POSIX relative path -> SHA-256 hex digest (or `symlink:<target>` so symlink
 * creation is also tracked without traversing outside the workspace).
 */
export function snapshotWorkspace(workspaceDir) {
  const root = path.resolve(workspaceDir);
  const files = new Map();
  if (!existsSync(root)) return files;

  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
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

/** Construct a canonical, self-digested sandbox execution receipt. */
export function createSandboxReceipt({
  id = `sbx-${randomUUID()}`,
  backend,
  mode,
  network = false,
  childProcess = false,
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
  if (!confinementClass) {
    throw extensionError(`unknown sandbox backend "${backend}"`, 'INVALID_SANDBOX_BACKEND');
  }
  const body = {
    schemaVersion: SANDBOX_RECEIPT_SCHEMA_VERSION,
    id,
    backend,
    confinementClass,
    mode,
    network: Boolean(network),
    childProcess: Boolean(childProcess),
    policyDigest: policyDigest ?? null,
    seccompDigest: seccompDigest ?? null,
    workspaceDigestBefore,
    workspaceDigestAfter,
    changedPaths: [...changedPaths].sort(),
    outcome,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    signal: typeof signal === 'string' ? signal : null,
    startedAt,
    finishedAt,
    durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0,
    outputDigest,
    outputBytes: Number.isSafeInteger(outputBytes) && outputBytes >= 0 ? outputBytes : 0
  };
  return { ...body, receiptDigest: digest(body) };
}

/** Structurally and cryptographically verify a sandbox receipt. */
export function verifySandboxReceipt(receipt, {
  expectedPolicyDigest = null,
  requireOsConfinement = false,
  expectedWorkspaceDigestAfter = null,
  allowedResourceGlobs = null
} = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, errors: ['sandbox receipt must be an object'] };
  }
  if (receipt.schemaVersion !== SANDBOX_RECEIPT_SCHEMA_VERSION) {
    errors.push(`sandbox receipt schemaVersion must be ${SANDBOX_RECEIPT_SCHEMA_VERSION}`);
  }
  const expectedClass = SANDBOX_BACKEND_CLASS[receipt.backend];
  if (!expectedClass) errors.push(`sandbox receipt backend "${receipt.backend}" is not recognised`);
  else if (receipt.confinementClass !== expectedClass) {
    errors.push(`sandbox receipt confinementClass "${receipt.confinementClass}" does not match backend "${receipt.backend}"`);
  }
  if (requireOsConfinement && receipt.confinementClass === 'runtime-permission') {
    errors.push('sandbox receipt uses runtime-permission confinement where OS-level confinement is required');
  }
  if (!['read-only', 'write-workspace'].includes(receipt.mode)) {
    errors.push('sandbox receipt mode must be read-only or write-workspace');
  }
  if (receipt.network !== false) {
    errors.push('sandbox receipt must attest network: false');
  }
  for (const field of ['workspaceDigestBefore', 'workspaceDigestAfter', 'outputDigest', 'receiptDigest']) {
    if (!SHA256_HEX.test(String(receipt[field] ?? ''))) {
      errors.push(`sandbox receipt ${field} must be a 64-char lowercase sha256 digest`);
    }
  }
  if (receipt.mode === 'read-only' && receipt.workspaceDigestBefore !== receipt.workspaceDigestAfter) {
    errors.push('read-only sandbox receipt reports workspace mutation');
  }
  if (!Array.isArray(receipt.changedPaths)) {
    errors.push('sandbox receipt changedPaths must be an array');
  } else if (allowedResourceGlobs && allowedResourceGlobs.length > 0) {
    const claimCheck = checkResourceClaims(receipt.changedPaths, allowedResourceGlobs);
    if (!claimCheck.ok) {
      errors.push(`sandbox execution mutated path(s) outside declared resourceClaims: ${claimCheck.violations.join(', ')}`);
    }
  }
  if (expectedPolicyDigest && receipt.policyDigest !== expectedPolicyDigest) {
    errors.push('sandbox receipt policyDigest does not match expected policy');
  }
  if (expectedWorkspaceDigestAfter && receipt.workspaceDigestAfter !== expectedWorkspaceDigestAfter) {
    errors.push('workspace contents diverge from the verified sandbox receipt after-digest');
  }
  if (errors.length === 0) {
    const computed = digest(receiptBody(receipt));
    if (computed !== receipt.receiptDigest) {
      errors.push('sandbox receipt digest mismatch (tampered or corrupted receipt)');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Fail closed unless a receipt validly authorises workspace mutations. */
export function assertWriteReceipt(receipt, options = {}) {
  const checked = verifySandboxReceipt(receipt, options);
  if (!checked.ok) {
    throw extensionError(
      `sandbox receipt verification failed:\n${checked.errors.map((e) => `- ${e}`).join('\n')}`,
      'INVALID_SANDBOX_RECEIPT'
    );
  }
  if (receipt.mode !== 'write-workspace') {
    throw extensionError('sandbox receipt does not grant write-workspace authority', 'INVALID_SANDBOX_RECEIPT');
  }
  return receipt;
}
