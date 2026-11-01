/**
 * M7 curated, signed, content-only catalog.
 *
 * Catalogs are Git-fetched snapshots, but Git transport is never trust. An
 * explicitly trusted local root verifies signed index/package metadata and every
 * bounded inert payload before a cache/lock/copy is accepted. Nothing here can
 * execute content, enable a module, alter compiler policy, or invoke a workflow.
 */

import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateBundle } from './bundles.mjs';
import { validateModule } from './modules.mjs';
import { validateWorkflow } from './workflows.mjs';
import { digest, ensureProjectDir, extensionError, ID_PATTERN, readJson, SEMVER_PATTERN, stableJson, vldDir, writeJsonAtomic } from './extension-utils.mjs';
import { validateRepository } from './stores.mjs';

const CATALOG_VERSION = 1;
const STATE_VERSION = 1;
const ROOT_FILE = 'catalog-root.json';
const STATE_FILE = 'catalog.json';
const COPY_FILE = 'catalog-copies.json';
const INDEX_FILE = 'catalog-index.json';
const PACKAGE_FILE = 'catalog-package.json';
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_REF = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,240}$/;
const PAYLOAD_TYPES = new Map([
  ['guidance', '.md'],
  ['module', '.json'],
  ['bundle', '.json'],
  ['artifact-template', '.md'],
  ['workflow', '.json'],
  ['test-fixture', null],
  ['export-schema', '.json']
]);
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_SIGNATURES = 16;
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function catalogDir(project) { return path.join(vldDir(project), 'catalogs'); }
function catalogCache(project, id) { return path.join(catalogDir(project), id); }
function statePath(project) { return path.join(vldDir(project), STATE_FILE); }
function rootPath(project) { return path.join(vldDir(project), ROOT_FILE); }
function copiesPath(project) { return path.join(vldDir(project), COPY_FILE); }
function errorText(error) { return String(error?.stderr || error?.message || error || '').replace(/[\r\n\0]/g, ' ').slice(0, 500); }
function requireId(value, label) {
  if (!ID_PATTERN.test(String(value ?? ''))) throw extensionError(`${label} must be lowercase kebab-case`, 'INVALID_CATALOG_METADATA');
  return value;
}
function nowIso(now) { const value = now ? new Date(now) : new Date(); if (Number.isNaN(value.getTime())) throw extensionError('catalog verification time is invalid', 'INVALID_CATALOG_METADATA'); return value.toISOString(); }
function notExpired(value, label, now) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) throw extensionError(`${label} expiry is invalid`, 'INVALID_CATALOG_METADATA');
  if (new Date(value).getTime() <= new Date(now).getTime()) throw extensionError(`${label} is expired`, 'CATALOG_METADATA_EXPIRED');
}
function canonicalSigned(value) {
  if (!object(value)) throw extensionError('signed catalog metadata must be an object', 'INVALID_CATALOG_METADATA');
  const copy = { ...value }; delete copy.signatures;
  return Buffer.from(stableJson(copy), 'utf8');
}
function ensureKnown(value, allowed, label, errors) { for (const key of Object.keys(value ?? {})) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`); }
function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw extensionError(`git ${args[0]} failed: ${errorText(error)}`, 'GIT_CATALOG_FAILED'); }
}
function cloneCatalog(repository, ref, destination) {
  // Catalog digests bind exact Git blob bytes. Ignore a user's checkout-only
  // line-ending conversion so a Windows cache cannot silently change signed
  // JSON/Markdown content after clone.
  const args = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '--no-tags', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push('--', repository, destination);
  git(args);
}
function safePath(root, relative, label) {
  if (typeof relative !== 'string' || !SAFE_PATH.test(relative)) throw extensionError(`${label} path is unsafe`, 'INVALID_CATALOG_METADATA');
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw extensionError(`${label} path escapes the catalog`, 'INVALID_CATALOG_METADATA');
  let cursor = root;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) throw extensionError(`${label} is missing ${relative}`, 'INVALID_CATALOG_METADATA');
    const details = lstatSync(cursor);
    if (details.isSymbolicLink()) throw extensionError(`${label} may not traverse a symbolic link`, 'INVALID_CATALOG_METADATA');
  }
  return target;
}
function readRegular(root, relative, label) {
  const file = safePath(root, relative, label);
  if (!lstatSync(file).isFile()) throw extensionError(`${label} must be a regular file`, 'INVALID_CATALOG_METADATA');
  const bytes = readFileSync(file);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw extensionError(`${label} exceeds ${MAX_PAYLOAD_BYTES} bytes`, 'CATALOG_PAYLOAD_TOO_LARGE');
  return { file, bytes, text: bytes.toString('utf8') };
}
function publicKey(key) {
  try {
    const parsed = createPublicKey(key.publicKey);
    if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    return parsed;
  } catch { throw extensionError(`catalog key "${key?.id ?? '?'}" is not a valid Ed25519 public key`, 'INVALID_CATALOG_ROOT'); }
}
function rootKeys(root, role) {
  const keys = new Map();
  for (const key of root.keys) if (key.roles.includes(role)) keys.set(key.id, publicKey(key));
  return keys;
}
function verifySignatures(value, keys, threshold, label) {
  if (!Array.isArray(value?.signatures) || value.signatures.length < threshold || value.signatures.length > MAX_SIGNATURES) throw extensionError(`${label} has insufficient signatures`, 'CATALOG_SIGNATURE_INVALID');
  const message = canonicalSigned(value); const used = new Set(); const verified = new Set(); let valid = 0;
  for (const signature of value.signatures) {
    if (!object(signature) || !ID_PATTERN.test(String(signature.keyId ?? '')) || typeof signature.signature !== 'string' || signature.signature.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signature)) continue;
    if (used.has(signature.keyId)) continue;
    used.add(signature.keyId);
    const key = keys.get(signature.keyId);
    if (!key) continue;
    try { if (verify(null, message, key, Buffer.from(signature.signature, 'base64'))) { valid += 1; verified.add(signature.keyId); } } catch {}
  }
  if (valid < threshold) throw extensionError(`${label} signature threshold was not met`, 'CATALOG_SIGNATURE_INVALID');
  return verified;
}

/** Validate an explicit trust root. Roots are locally trusted, not discovered from a catalog. */
export function validateCatalogRoot(root, { now = nowIso() } = {}) {
  const errors = [];
  if (!object(root)) return { ok: false, errors: ['catalog root must be an object'] };
  ensureKnown(root, new Set(['schemaVersion', 'type', 'version', 'expiresAt', 'threshold', 'keys', 'previousRootDigest', 'signatures']), 'catalog root', errors);
  if (root.schemaVersion !== CATALOG_VERSION || root.type !== 'vld-catalog-root') errors.push('catalog root has an unsupported schema/type');
  if (!Number.isSafeInteger(root.version) || root.version < 1) errors.push('catalog root version must be a positive integer');
  try { notExpired(root.expiresAt, 'catalog root', now); } catch (error) { errors.push(error.message); }
  if (!Number.isSafeInteger(root.threshold) || root.threshold < 1) errors.push('catalog root threshold must be a positive integer');
  if (!Array.isArray(root.keys) || root.keys.length === 0 || root.keys.length > 32) errors.push('catalog root needs a bounded key list');
  const seen = new Set();
  for (const key of Array.isArray(root.keys) ? root.keys : []) {
    if (!object(key)) { errors.push('catalog root key must be an object'); continue; }
    ensureKnown(key, new Set(['id', 'algorithm', 'publicKey', 'roles']), 'catalog root key', errors);
    if (!ID_PATTERN.test(String(key.id ?? '')) || seen.has(key.id)) errors.push('catalog root keys need unique lowercase ids');
    seen.add(key.id);
    if (key.algorithm !== 'ed25519' || typeof key.publicKey !== 'string' || key.publicKey.length > 8_192 || !Array.isArray(key.roles) || key.roles.some((role) => !['index', 'package', 'root'].includes(role)) || key.roles.length === 0) errors.push(`catalog root key "${key.id ?? '?'}" is invalid`);
    else { try { publicKey(key); } catch (error) { errors.push(error.message); } }
  }
  if (Number.isSafeInteger(root.threshold) && Array.isArray(root.keys)) {
    for (const role of ['index', 'package', 'root']) if (root.threshold > root.keys.filter((key) => key?.roles?.includes(role)).length) errors.push(`catalog root ${role} threshold exceeds ${role}-capable keys`);
  }
  if (root.previousRootDigest !== undefined && !SHA256.test(String(root.previousRootDigest))) errors.push('catalog root previousRootDigest must be a SHA-256 digest');
  return { ok: errors.length === 0, errors };
}
function assertRoot(root, options) {
  const checked = validateCatalogRoot(root, options);
  if (!checked.ok) throw extensionError(`catalog root is invalid:\n${checked.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_CATALOG_ROOT');
  return root;
}
function readRootFile(file, now) {
  if (typeof file !== 'string' || !file) throw extensionError('catalog root file is required', 'CATALOG_ROOT_REQUIRED');
  let root; try { root = readJson(file); } catch (error) { throw extensionError(`catalog root file is invalid: ${error.message}`, 'INVALID_CATALOG_ROOT'); }
  return assertRoot(root, { now });
}

/** Trust the first locally supplied root, or rotate only through old-root signatures plus exact acknowledgement. */
export function trustCatalogRoot({ projectDir = '.', rootFile, acknowledge = null, now } = {}) {
  const project = ensureProjectDir(projectDir); const timestamp = nowIso(now); const next = readRootFile(rootFile, timestamp); const destination = rootPath(project); const nextDigest = digest(next);
  if (!existsSync(destination)) {
    writeJsonAtomic(destination, next);
    return { project, file: destination, changed: true, root: { version: next.version, digest: nextDigest, expiresAt: next.expiresAt, threshold: next.threshold, keyIds: next.keys.map((key) => key.id) } };
  }
  let previous; try { previous = assertRoot(readJson(destination), { now: timestamp }); } catch (error) { throw extensionError(`trusted catalog root is invalid: ${error.message}`, 'INVALID_CATALOG_ROOT'); }
  const previousDigest = digest(previous);
  if (previousDigest === nextDigest) return { project, file: destination, changed: false, root: { version: previous.version, digest: previousDigest, expiresAt: previous.expiresAt, threshold: previous.threshold, keyIds: previous.keys.map((key) => key.id) } };
  if (acknowledge !== nextDigest) throw extensionError(`catalog root rotation requires --acknowledge ${nextDigest}`, 'CATALOG_ROOT_ACKNOWLEDGEMENT_REQUIRED');
  if (next.version <= previous.version || next.previousRootDigest !== previousDigest) throw extensionError('catalog root rotation must increment version and bind the current root digest', 'CATALOG_ROOT_ROTATION_INVALID');
  verifySignatures(next, rootKeys(previous, 'root'), previous.threshold, 'catalog root rotation');
  writeJsonAtomic(destination, next);
  return { project, file: destination, changed: true, root: { version: next.version, digest: nextDigest, expiresAt: next.expiresAt, threshold: next.threshold, keyIds: next.keys.map((key) => key.id) } };
}
function trustedRoot(project, now) {
  const file = rootPath(project);
  if (!existsSync(file)) throw extensionError('no catalog root is trusted; run vld catalog trust <root.json> first', 'CATALOG_ROOT_NOT_TRUSTED');
  try { const root = assertRoot(readJson(file), { now }); return { file, root, digest: digest(root) }; } catch (error) { throw extensionError(`trusted catalog root is invalid: ${error.message}`, 'INVALID_CATALOG_ROOT'); }
}

function assertCompatibility(range) {
  if (range === '*' || range === VERSION) return;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range));
  const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(VERSION);
  if (caret && current && Number(caret[1]) === Number(current[1]) && (Number(caret[1]) > 0 || Number(caret[2]) === Number(current[2])) && (Number(caret[1]) > 0 || Number(caret[2]) !== Number(current[2]) || Number(caret[3]) <= Number(current[3]))) return;
  throw extensionError(`catalog package is incompatible with VLD ${VERSION}`, 'CATALOG_CORE_INCOMPATIBLE');
}
function payloadSchema(type, text, label) {
  if (type === 'guidance' || type === 'artifact-template') return;
  let parsed; try { parsed = JSON.parse(text); } catch { throw extensionError(`${label} must contain JSON`, 'CATALOG_PAYLOAD_SCHEMA_INVALID'); }
  const errors = type === 'module' ? validateModule(parsed) : type === 'bundle' ? validateBundle(parsed) : type === 'workflow' ? validateWorkflow(parsed) : type === 'export-schema' ? (!object(parsed) ? ['must be an object'] : []) : [];
  if (errors.length) throw extensionError(`${label} schema is invalid: ${errors.join('; ')}`, 'CATALOG_PAYLOAD_SCHEMA_INVALID');
}
function validateManifest(manifest, { root, now }) {
  const errors = [];
  if (!object(manifest)) throw extensionError('catalog package manifest must be an object', 'INVALID_CATALOG_PACKAGE');
  ensureKnown(manifest, new Set(['schemaVersion', 'type', 'name', 'version', 'license', 'coreCompatibility', 'payloads', 'publisher', 'releaseTimestamp', 'replaces', 'revoked', 'capabilities', 'signatures']), 'catalog package', errors);
  if (manifest.schemaVersion !== CATALOG_VERSION || manifest.type !== 'vld-catalog-package') errors.push('unsupported package schema/type');
  if (!ID_PATTERN.test(String(manifest.name ?? '')) || !SEMVER_PATTERN.test(String(manifest.version ?? ''))) errors.push('package name/version is invalid');
  if (typeof manifest.license !== 'string' || !manifest.license.trim() || /[\r\n]/.test(manifest.license)) errors.push('package license is invalid');
  if (typeof manifest.coreCompatibility !== 'string') errors.push('package coreCompatibility is required');
  if (!object(manifest.publisher) || !ID_PATTERN.test(String(manifest.publisher.id ?? '')) || Object.keys(manifest.publisher).some((key) => key !== 'id')) errors.push('package publisher identity is invalid');
  if (typeof manifest.releaseTimestamp !== 'string' || Number.isNaN(new Date(manifest.releaseTimestamp).getTime())) errors.push('package releaseTimestamp is invalid');
  if (manifest.revoked !== false) errors.push('catalog v1 rejects revoked packages');
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length !== 1 || manifest.capabilities[0] !== 'content-only') errors.push('catalog v1 package capabilities must be exactly content-only');
  if (manifest.replaces !== undefined && (!object(manifest.replaces) || !ID_PATTERN.test(String(manifest.replaces.name ?? '')) || !SEMVER_PATTERN.test(String(manifest.replaces.version ?? '')) || Object.keys(manifest.replaces).some((key) => !['name', 'version'].includes(key)))) errors.push('package replacement metadata is invalid');
  if (!Array.isArray(manifest.payloads) || manifest.payloads.length < 1 || manifest.payloads.length > 100) errors.push('package needs a bounded payload list');
  const seen = new Set();
  for (const payload of Array.isArray(manifest.payloads) ? manifest.payloads : []) {
    if (!object(payload)) { errors.push('package payload must be an object'); continue; }
    ensureKnown(payload, new Set(['id', 'type', 'path', 'digest', 'bytes']), 'package payload', errors);
    if (!ID_PATTERN.test(String(payload.id ?? '')) || seen.has(payload.id)) errors.push('package payload ids must be unique lowercase ids');
    seen.add(payload.id);
    const extension = PAYLOAD_TYPES.get(payload.type);
    if (extension === undefined || !SAFE_PATH.test(String(payload.path ?? '')) || !SHA256.test(String(payload.digest ?? '')) || !Number.isSafeInteger(payload.bytes) || payload.bytes < 1 || payload.bytes > MAX_PAYLOAD_BYTES) errors.push(`package payload "${payload.id ?? '?'}" is invalid`);
    else if (extension && !payload.path.endsWith(extension)) errors.push(`package payload "${payload.id}" must use ${extension}`);
    else if (payload.type === 'test-fixture' && !(/\.(?:json|md)$/.test(payload.path))) errors.push(`test fixture "${payload.id}" must be JSON or Markdown`);
  }
  if (errors.length) throw extensionError(`catalog package is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_CATALOG_PACKAGE');
  assertCompatibility(manifest.coreCompatibility); notExpired(root.expiresAt, 'catalog root', now); const signerIds = verifySignatures(manifest, rootKeys(root, 'package'), root.threshold, `catalog package ${manifest.name}`);
  if (!signerIds.has(manifest.publisher.id)) throw extensionError(`catalog package ${manifest.name} publisher identity is not a verified signing key`, 'CATALOG_PUBLISHER_UNTRUSTED');
  return manifest;
}
function loadPackage(rootDir, indexEntry, trust, now) {
  const manifestFile = path.posix.join(indexEntry.path, PACKAGE_FILE); const source = readRegular(rootDir, manifestFile, `catalog package ${indexEntry.name}`);
  if (digest(source.text) !== indexEntry.manifestDigest) throw extensionError(`catalog package ${indexEntry.name} manifest digest differs from signed index`, 'CATALOG_DIGEST_MISMATCH');
  let manifest; try { manifest = JSON.parse(source.text); } catch { throw extensionError(`catalog package ${indexEntry.name} manifest is not JSON`, 'INVALID_CATALOG_PACKAGE'); }
  validateManifest(manifest, { root: trust.root, now });
  if (manifest.name !== indexEntry.name || manifest.version !== indexEntry.version) throw extensionError('catalog package identity differs from signed index', 'CATALOG_IDENTITY_MISMATCH');
  const payloads = [];
  for (const payload of manifest.payloads) {
    const item = readRegular(rootDir, path.posix.join(indexEntry.path, payload.path), `catalog payload ${manifest.name}/${payload.id}`);
    if (item.bytes.length !== payload.bytes || digest(item.bytes.toString('utf8')) !== payload.digest) throw extensionError(`catalog payload ${manifest.name}/${payload.id} digest differs from manifest`, 'CATALOG_DIGEST_MISMATCH');
    payloadSchema(payload.type, item.text, `catalog payload ${manifest.name}/${payload.id}`);
    payloads.push({ ...payload });
  }
  return { name: manifest.name, version: manifest.version, path: indexEntry.path, license: manifest.license, publisher: manifest.publisher, manifestDigest: digest(source.text), canonicalDigest: digest(manifest), coreCompatibility: manifest.coreCompatibility, releaseTimestamp: manifest.releaseTimestamp, capabilities: [...manifest.capabilities], ...(manifest.replaces ? { replaces: { ...manifest.replaces } } : {}), payloads };
}
function loadIndex(rootDir, trust, now) {
  const source = readRegular(rootDir, INDEX_FILE, 'catalog index'); let index;
  try { index = JSON.parse(source.text); } catch { throw extensionError('catalog index is not JSON', 'INVALID_CATALOG_INDEX'); }
  const errors = [];
  if (!object(index)) errors.push('catalog index must be an object');
  ensureKnown(index, new Set(['schemaVersion', 'type', 'catalogId', 'version', 'expiresAt', 'rootVersion', 'packages', 'signatures']), 'catalog index', errors);
  if (index.schemaVersion !== CATALOG_VERSION || index.type !== 'vld-catalog-index' || !ID_PATTERN.test(String(index.catalogId ?? '')) || !Number.isSafeInteger(index.version) || index.version < 1) errors.push('catalog index schema/identity is invalid');
  if (index.rootVersion !== trust.root.version) errors.push('catalog index root version does not match trusted root');
  try { notExpired(index.expiresAt, 'catalog index', now); } catch (error) { errors.push(error.message); }
  if (!Array.isArray(index.packages) || index.packages.length > 100) errors.push('catalog index package list is invalid');
  const names = new Set();
  for (const entry of Array.isArray(index.packages) ? index.packages : []) {
    if (!object(entry) || Object.keys(entry).some((key) => !['name', 'version', 'path', 'manifestDigest', 'revoked'].includes(key)) || !ID_PATTERN.test(String(entry.name ?? '')) || names.has(entry.name) || !SEMVER_PATTERN.test(String(entry.version ?? '')) || !SAFE_PATH.test(String(entry.path ?? '')) || !SHA256.test(String(entry.manifestDigest ?? '')) || entry.revoked !== false) errors.push('catalog index package entry is invalid');
    names.add(entry?.name);
  }
  if (errors.length) throw extensionError(`catalog index is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_CATALOG_INDEX');
  verifySignatures(index, rootKeys(trust.root, 'index'), trust.root.threshold, 'catalog index');
  const packages = index.packages.map((entry) => loadPackage(rootDir, entry, trust, now)).sort((a, b) => a.name.localeCompare(b.name));
  return { index, indexDigest: digest(source.text), canonicalDigest: digest(index), packages };
}
function snapshot(rootDir, id, trust, now) {
  if (!existsSync(rootDir) || lstatSync(rootDir).isSymbolicLink() || !lstatSync(rootDir).isDirectory()) throw extensionError('catalog cache must be a real directory', 'INVALID_CATALOG_CACHE');
  const commit = git(['-C', rootDir, 'rev-parse', 'HEAD']); if (!COMMIT.test(commit)) throw extensionError('catalog did not resolve to a full Git commit', 'GIT_CATALOG_FAILED');
  const loaded = loadIndex(rootDir, trust, now); if (loaded.index.catalogId !== id) throw extensionError(`catalog index id "${loaded.index.catalogId}" does not match requested "${id}"`, 'CATALOG_IDENTITY_MISMATCH');
  return { commit, index: loaded.index, indexDigest: loaded.indexDigest, packages: loaded.packages, snapshotDigest: digest({ commit, rootDigest: trust.digest, indexDigest: loaded.indexDigest, packages: loaded.packages }) };
}
function entry({ id, repository, ref, snapshot: checked, rootDigest, acknowledgedCommit = null }) {
  return { id, repository, ref: ref ?? null, commit: checked.commit, rootDigest, indexDigest: checked.indexDigest, indexVersion: checked.index.version, indexExpiresAt: checked.index.expiresAt, snapshotDigest: checked.snapshotDigest, packages: checked.packages, ...(acknowledgedCommit ? { acknowledgedCommit } : {}) };
}

export function readCatalogState(projectDir = '.') {
  const project = ensureProjectDir(projectDir); const file = statePath(project);
  if (!existsSync(file)) return { project, file, exists: false, state: { schemaVersion: STATE_VERSION, catalogs: [] }, errors: [] };
  let state; try { state = readJson(file); } catch (error) { return { project, file, exists: true, state: null, errors: [`${file}: invalid JSON (${error.message})`] }; }
  const errors = [];
  if (!object(state) || state.schemaVersion !== STATE_VERSION || !Array.isArray(state.catalogs)) errors.push(`${file}: invalid catalog state schema`);
  const seen = new Set();
  for (const item of Array.isArray(state?.catalogs) ? state.catalogs : []) {
    if (!object(item) || !ID_PATTERN.test(String(item.id ?? '')) || seen.has(item.id)) errors.push(`${file}: catalog lock has an invalid/duplicate id`); else seen.add(item.id);
    try { validateRepository(item?.repository); } catch { errors.push(`${file}: catalog ${item?.id ?? '?'} repository is invalid`); }
    if (item?.ref !== null && item?.ref !== undefined && !SAFE_REF.test(String(item.ref))) errors.push(`${file}: catalog ${item?.id ?? '?'} ref is invalid`);
    for (const field of ['commit', 'rootDigest', 'indexDigest', 'snapshotDigest']) if (!((field === 'commit' ? COMMIT : SHA256).test(String(item?.[field] ?? '')))) errors.push(`${file}: catalog ${item?.id ?? '?'} ${field} is invalid`);
    if (!Array.isArray(item?.packages)) errors.push(`${file}: catalog ${item?.id ?? '?'} packages are invalid`);
  }
  return { project, file, exists: true, state, errors };
}
function changes(before, after) {
  const oldPackages = new Map(before.packages.map((item) => [item.name, item])); const nextPackages = new Map(after.packages.map((item) => [item.name, item]));
  return { changed: before.commit !== after.commit || before.rootDigest !== after.rootDigest || before.indexDigest !== after.indexDigest || stableJson(before.packages) !== stableJson(after.packages), commitChanged: before.commit !== after.commit, added: after.packages.filter((item) => !oldPackages.has(item.name)), removed: before.packages.filter((item) => !nextPackages.has(item.name)), changedPackages: after.packages.filter((item) => oldPackages.has(item.name) && stableJson(oldPackages.get(item.name)) !== stableJson(item)) };
}

/** Fetch and fully verify a candidate snapshot before any project lock/cache mutation. */
export function previewCatalogRefresh({ projectDir = '.', id, now } = {}) {
  const loaded = readCatalogState(projectDir); if (loaded.errors.length) throw extensionError(loaded.errors.join('\n'), 'INVALID_CATALOG_STATE'); requireId(id, 'catalog id');
  const current = loaded.state.catalogs.find((item) => item.id === id); if (!current) throw extensionError(`catalog "${id}" is not locked`, 'CATALOG_NOT_FOUND');
  const timestamp = nowIso(now); const trust = trustedRoot(loaded.project, timestamp); if (trust.digest !== current.rootDigest) throw extensionError('catalog lock uses a different trusted root; review/re-add the catalog', 'CATALOG_ROOT_CHANGED');
  const temporary = mkdtempSync(path.join(os.tmpdir(), `vld-catalog-${id}-`));
  try { cloneCatalog(current.repository, current.ref, temporary); const checked = snapshot(temporary, id, trust, timestamp); const next = entry({ id, repository: current.repository, ref: current.ref, snapshot: checked, rootDigest: trust.digest }); return { project: loaded.project, file: loaded.file, current, next, changes: changes(current, next) }; }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function addCatalog({ projectDir = '.', id, repository, ref = null, refresh = false, expectedCommit = null, now } = {}) {
  const project = ensureProjectDir(projectDir); requireId(id, 'catalog id'); repository = validateRepository(repository); const timestamp = nowIso(now);
  if (ref !== null && ref !== undefined && !SAFE_REF.test(String(ref))) throw extensionError('catalog ref must be a safe branch, tag, or commit name', 'INVALID_CATALOG_REF');
  const trust = trustedRoot(project, timestamp); const loaded = readCatalogState(project); if (loaded.errors.length) throw extensionError(loaded.errors.join('\n'), 'INVALID_CATALOG_STATE');
  const prior = loaded.state.catalogs.find((item) => item.id === id); if (prior && !refresh) throw extensionError(`catalog "${id}" is already locked; run vld catalog diff ${id} before refresh`, 'CATALOG_EXISTS');
  if (prior && refresh && !expectedCommit) throw extensionError(`catalog "${id}" needs the exact reviewed commit acknowledgement before refresh`, 'CATALOG_ACKNOWLEDGEMENT_REQUIRED');
  if (expectedCommit !== null && !COMMIT.test(String(expectedCommit))) throw extensionError('catalog acknowledgement must be a full 40-character commit', 'INVALID_CATALOG_ACKNOWLEDGEMENT');
  const root = catalogDir(project); mkdirSync(root, { recursive: true }); const destination = catalogCache(project, id); const temporary = path.join(root, `.${id}.${process.pid}.fetching`); const backup = path.join(root, `.${id}.${process.pid}.backup`);
  if (existsSync(temporary) || existsSync(backup)) throw extensionError('a prior catalog operation did not finish; inspect and remove its temporary directory', 'CATALOG_TEMPORARY_EXISTS');
  let lockWritten = false;
  try {
    cloneCatalog(repository, ref, temporary); const checked = snapshot(temporary, id, trust, timestamp);
    if (expectedCommit && checked.commit !== expectedCommit) throw extensionError(`catalog remote resolved to ${checked.commit}, not acknowledged ${expectedCommit}; run vld catalog diff ${id} again`, 'CATALOG_ACKNOWLEDGEMENT_MISMATCH');
    if (existsSync(destination)) renameSync(destination, backup); renameSync(temporary, destination);
    const catalogs = loaded.state.catalogs.filter((item) => item.id !== id); catalogs.push(entry({ id, repository, ref, snapshot: checked, rootDigest: trust.digest, acknowledgedCommit: prior ? expectedCommit : null })); catalogs.sort((a, b) => a.id.localeCompare(b.id)); writeJsonAtomic(loaded.file, { schemaVersion: STATE_VERSION, catalogs }); lockWritten = true; rmSync(backup, { recursive: true, force: true });
    return { project, file: loaded.file, refreshed: Boolean(prior), catalog: catalogs.find((item) => item.id === id) };
  } catch (error) {
    if (!lockWritten && existsSync(backup)) { rmSync(destination, { recursive: true, force: true }); renameSync(backup, destination); }
    throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function refreshCatalog({ projectDir = '.', id, acknowledge = null, now } = {}) {
  const preview = previewCatalogRefresh({ projectDir, id, now }); if (!preview.changes.changed) return { project: preview.project, file: preview.file, refreshed: false, unchanged: true, catalog: preview.current };
  if (acknowledge !== preview.next.commit) throw extensionError(`review ${preview.next.commit} with vld catalog diff ${id}, then acknowledge that exact commit`, acknowledge ? 'CATALOG_ACKNOWLEDGEMENT_MISMATCH' : 'CATALOG_ACKNOWLEDGEMENT_REQUIRED');
  return addCatalog({ projectDir: preview.project, id, repository: preview.current.repository, ref: preview.current.ref, refresh: true, expectedCommit: acknowledge, now });
}

/** Offline cache verification: no Git network operation occurs here. */
export function catalogStatus(projectDir = '.', id = null, { now } = {}) {
  const loaded = readCatalogState(projectDir); const errors = [...loaded.errors]; const catalogs = []; if (loaded.errors.length) return { ...loaded, ok: false, catalogs, errors };
  let trust; try { trust = trustedRoot(loaded.project, nowIso(now)); } catch (error) { return { ...loaded, ok: false, catalogs, errors: [...errors, error.message] }; }
  for (const locked of loaded.state.catalogs.filter((item) => !id || item.id === id)) {
    const directory = catalogCache(loaded.project, locked.id); const drift = [];
    if (trust.digest !== locked.rootDigest) drift.push('trusted root differs from catalog lock');
    if (!existsSync(directory)) drift.push('cached catalog directory is missing');
    else {
      try { const checked = snapshot(directory, locked.id, trust, nowIso(now)); const reconstructed = entry({ id: locked.id, repository: locked.repository, ref: locked.ref, snapshot: checked, rootDigest: trust.digest, acknowledgedCommit: locked.acknowledgedCommit ?? null }); if (stableJson({ ...reconstructed, acknowledgedCommit: undefined }) !== stableJson({ ...locked, acknowledgedCommit: undefined })) drift.push('verified catalog snapshot differs from lock'); }
      catch (error) { drift.push(error.message); }
    }
    catalogs.push({ ...locked, directory, drift, ok: drift.length === 0 });
  }
  if (id && !catalogs.length) errors.push(`catalog "${id}" is not locked`);
  return { ...loaded, catalogs, errors, ok: errors.length === 0 && catalogs.every((item) => item.ok), trustedRoot: { version: trust.root.version, digest: trust.digest, expiresAt: trust.root.expiresAt, keyIds: trust.root.keys.map((key) => key.id) } };
}
function mkdirOutputParent(project, target) {
  const relative = path.relative(project, path.dirname(target)); let cursor = project;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor)) { const details = lstatSync(cursor); if (details.isSymbolicLink() || !details.isDirectory()) throw extensionError('catalog output may not traverse a symbolic link', 'INVALID_CATALOG_OUTPUT'); }
    else mkdirSync(cursor);
  }
}

function readVerifiedPayload({ projectDir, catalogId, packageName, payloadId, now }) {
  requireId(catalogId, 'catalog id'); requireId(packageName, 'package name'); requireId(payloadId, 'payload id'); const report = catalogStatus(projectDir, catalogId, { now }); if (!report.ok) throw extensionError(`catalog "${catalogId}" is not verified:\n${[...report.errors, ...(report.catalogs[0]?.drift ?? [])].map((item) => `- ${item}`).join('\n')}`, 'CATALOG_NOT_VERIFIED');
  const catalog = report.catalogs[0]; const packageInfo = catalog.packages.find((item) => item.name === packageName); if (!packageInfo) throw extensionError(`catalog package "${packageName}" is not locked`, 'CATALOG_PACKAGE_NOT_FOUND'); const payload = packageInfo.payloads.find((item) => item.id === payloadId); if (!payload) throw extensionError(`catalog payload "${packageName}/${payloadId}" is not locked`, 'CATALOG_PAYLOAD_NOT_FOUND');
  const source = readRegular(catalog.directory, path.posix.join(packageInfo.path, payload.path), `catalog payload ${packageName}/${payloadId}`); if (source.bytes.length !== payload.bytes || digest(source.text) !== payload.digest) throw extensionError('catalog payload changed while being read', 'CATALOG_DIGEST_MISMATCH');
  return { project: report.project, catalog, packageInfo, payload, source };
}
export function copyCatalogPayload({ projectDir = '.', catalogId, packageName, payloadId, out, force = false, now } = {}) {
  if (typeof out !== 'string' || !out) throw extensionError('catalog payload copy requires --out inside the project', 'CATALOG_OUTPUT_REQUIRED'); const loaded = readVerifiedPayload({ projectDir, catalogId, packageName, payloadId, now }); const target = path.resolve(loaded.project, out); const relative = path.relative(loaded.project, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0] === '.vld') throw extensionError('catalog payload output must be a non-state path inside the project', 'INVALID_CATALOG_OUTPUT'); if (path.extname(target) !== path.extname(loaded.payload.path)) throw extensionError('catalog payload output must retain the verified payload extension', 'INVALID_CATALOG_OUTPUT'); if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw extensionError('catalog payload output may not be a symbolic link', 'INVALID_CATALOG_OUTPUT'); if (existsSync(target) && !force) throw extensionError(`${target} exists; pass --force to replace it`, 'CATALOG_OUTPUT_EXISTS');
  mkdirOutputParent(loaded.project, target); copyFileSync(loaded.source.file, target);
  const copies = existsSync(copiesPath(loaded.project)) ? readJson(copiesPath(loaded.project)) : { schemaVersion: 1, copies: [] }; if (!object(copies) || copies.schemaVersion !== 1 || !Array.isArray(copies.copies)) throw extensionError('catalog copy provenance state is invalid', 'INVALID_CATALOG_STATE');
  const provenance = { catalogId, catalogCommit: loaded.catalog.commit, rootDigest: loaded.catalog.rootDigest, packageName, packageVersion: loaded.packageInfo.version, publisher: loaded.packageInfo.publisher.id, payloadId, payloadDigest: loaded.payload.digest, output: relative.split(path.sep).join('/') }; const next = copies.copies.filter((item) => item.output !== provenance.output); next.push(provenance); next.sort((a, b) => a.output.localeCompare(b.output)); writeJsonAtomic(copiesPath(loaded.project), { schemaVersion: 1, copies: next });
  return { ...loaded, output: target, provenance };
}
