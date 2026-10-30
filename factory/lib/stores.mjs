/**
 * Git-backed, read-only shared stores for optional VLD delivery assets.
 *
 * A store is an explicitly fetched snapshot, never input to the deterministic
 * profile -> packet compiler. Its manifest and every declared asset are hashed
 * into .vld/stores.json so a team can review, pin and detect local drift.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, ensureProjectDir, extensionError, ID_PATTERN, readJson, stableJson, vldDir, writeJsonAtomic } from './extension-utils.mjs';

const STATE_VERSION = 1;
const STORE_VERSION = 1;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_REF = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
const ASSET_KINDS = new Set(['artifact-template', 'guidance']);
const ARTIFACT_TYPES = new Set(['product-brief', 'architecture-decision', 'delivery-plan', 'review-brief', 'qa-plan']);
const SAFE_ASSET = /^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,240}$/;

function stateFile(project) { return path.join(vldDir(project), 'stores.json'); }
function storesDir(project) { return path.join(vldDir(project), 'stores'); }
function storeDir(project, id) { return path.join(storesDir(project), id); }
function requireId(id, label = 'store id') {
  if (!ID_PATTERN.test(String(id ?? ''))) throw extensionError(`${label} must be lowercase kebab-case`, 'INVALID_STORE_ID');
  return id;
}
function cloneError(error) { return String(error?.stderr || error?.message || error).trim(); }
function git(args, options = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
  } catch (error) {
    throw extensionError(`git ${args[0]} failed: ${cloneError(error)}`, 'GIT_STORE_FAILED');
  }
}

/** Reject option injection, control characters, and URLs that cannot be git remotes. */
export function validateRepository(repository) {
  if (typeof repository !== 'string' || !repository.trim()) throw extensionError('store repository is required', 'STORE_REPOSITORY_REQUIRED');
  const value = repository.trim();
  if (value.startsWith('-') || /[\r\n\0]/.test(value)) throw extensionError('store repository is not a safe Git URL', 'INVALID_STORE_REPOSITORY');
  if (/^git@[a-zA-Z0-9.-]+:[^\s:]+$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw extensionError('store repository must be an https, ssh, file, or git@ URL', 'INVALID_STORE_REPOSITORY'); }
  if (!['https:', 'ssh:', 'file:'].includes(url.protocol) || (url.protocol !== 'file:' && !url.hostname) || url.username || url.password) {
    throw extensionError('store repository must be a credential-free https, ssh, file, or git@ URL', 'INVALID_STORE_REPOSITORY');
  }
  return value;
}
function assetPath(root, relative) {
  if (typeof relative !== 'string' || !SAFE_ASSET.test(relative)) throw extensionError(`asset file "${relative}" is not a safe relative path`, 'INVALID_STORE_MANIFEST');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw extensionError(`asset file "${relative}" escapes the store`, 'INVALID_STORE_MANIFEST');
  return resolved;
}

/** Validate a manifest and return only data safe to record in a project lock. */
export function readStoreManifest(root, expectedId = null) {
  const file = path.join(root, 'vld-store.json');
  if (!existsSync(file)) throw extensionError('store has no vld-store.json manifest', 'INVALID_STORE_MANIFEST');
  let manifest;
  try { manifest = readJson(file); } catch (error) { throw extensionError(`store manifest is invalid JSON: ${error.message}`, 'INVALID_STORE_MANIFEST'); }
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) errors.push('store manifest must be an object');
  if (manifest?.schemaVersion !== STORE_VERSION) errors.push(`store manifest schemaVersion must be ${STORE_VERSION}`);
  if (!ID_PATTERN.test(String(manifest?.id ?? ''))) errors.push('store manifest id must be lowercase kebab-case');
  if (expectedId && manifest?.id !== expectedId) errors.push(`store manifest id "${manifest?.id}" does not match requested store "${expectedId}"`);
  if (typeof manifest?.title !== 'string' || manifest.title.trim().length < 3) errors.push('store manifest title must be at least 3 characters');
  if (!Array.isArray(manifest?.assets)) errors.push('store manifest assets must be a list');
  const seen = new Set();
  const assets = [];
  for (const asset of Array.isArray(manifest?.assets) ? manifest.assets : []) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) { errors.push('every store asset must be an object'); continue; }
    if (!ID_PATTERN.test(String(asset.id ?? ''))) { errors.push('store asset id must be lowercase kebab-case'); continue; }
    if (seen.has(asset.id)) { errors.push(`store asset "${asset.id}" is listed twice`); continue; }
    seen.add(asset.id);
    if (!ASSET_KINDS.has(asset.kind)) { errors.push(`store asset "${asset.id}" has an unsupported kind`); continue; }
    if (asset.kind === 'artifact-template' && !ARTIFACT_TYPES.has(asset.artifact)) {
      errors.push(`artifact template "${asset.id}" must declare a supported artifact type`); continue;
    }
    try {
      const target = assetPath(root, asset.file);
      if (!target.endsWith('.md')) { errors.push(`store asset "${asset.id}" must be a Markdown file`); continue; }
      if (!existsSync(target)) { errors.push(`store asset "${asset.id}" is missing ${asset.file}`); continue; }
      if (!lstatSync(target).isFile()) { errors.push(`store asset "${asset.id}" must be a regular file`); continue; }
      assets.push({ id: asset.id, kind: asset.kind, file: asset.file, digest: digest(readFileSync(target, 'utf8')), ...(asset.kind === 'artifact-template' ? { artifact: asset.artifact } : {}) });
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw extensionError(`invalid store manifest:\n${errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_STORE_MANIFEST');
  return { manifest: { schemaVersion: STORE_VERSION, id: manifest.id, title: manifest.title.trim(), assets }, manifestDigest: digest(readFileSync(file, 'utf8')) };
}

export function readStoreState(projectDir = '.') {
  const project = ensureProjectDir(projectDir);
  const file = stateFile(project);
  if (!existsSync(file)) return { project, file, exists: false, state: { schemaVersion: STATE_VERSION, stores: [] }, errors: [] };
  let state;
  try { state = readJson(file); } catch (error) { return { project, file, exists: true, state: null, errors: [`${file}: invalid JSON (${error.message})`] }; }
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) errors.push(`${file}: state is not an object`);
  if (state?.schemaVersion !== STATE_VERSION) errors.push(`${file}: schemaVersion must be ${STATE_VERSION}`);
  if (!Array.isArray(state?.stores)) errors.push(`${file}: stores must be a list`);
  const seen = new Set();
  for (const store of Array.isArray(state?.stores) ? state.stores : []) {
    if (!store || !ID_PATTERN.test(String(store.id ?? ''))) errors.push(`${file}: store has an invalid id`);
    else if (seen.has(store.id)) errors.push(`${file}: store "${store.id}" is locked twice`);
    else seen.add(store.id);
    try { validateRepository(store?.repository); } catch { errors.push(`${file}: store ${store?.id ?? '?'} has an invalid repository`); }
    if (store?.ref !== null && store?.ref !== undefined && !SAFE_REF.test(String(store.ref))) errors.push(`${file}: store ${store?.id ?? '?'} has an invalid ref`);
    if (!COMMIT.test(String(store?.commit ?? ''))) errors.push(`${file}: store ${store?.id ?? '?'} has an invalid commit`);
    if (!/^[a-f0-9]{64}$/.test(String(store?.snapshotDigest ?? ''))) errors.push(`${file}: store ${store?.id ?? '?'} has an invalid snapshot digest`);
    if (store?.acknowledgedCommit !== undefined && (!COMMIT.test(String(store.acknowledgedCommit)) || store.acknowledgedCommit !== store.commit)) {
      errors.push(`${file}: store ${store?.id ?? '?'} has an invalid refresh acknowledgement`);
    }
  }
  return { project, file, exists: true, state, errors };
}

function snapshot(root, id) {
  const commit = git(['-C', root, 'rev-parse', 'HEAD']);
  if (!COMMIT.test(commit)) throw extensionError('store did not resolve to a full Git commit', 'GIT_STORE_FAILED');
  const { manifest, manifestDigest } = readStoreManifest(root, id);
  return { commit, manifest, manifestDigest, snapshotDigest: digest({ commit, manifestDigest, assets: manifest.assets }) };
}
function cloneStore({ repository, ref, destination }) {
  const args = ['clone', '--no-tags', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push('--', repository, destination);
  git(args);
}
function stateEntry({ id, repository, ref, snapshot: checked, acknowledgedCommit = null }) {
  return {
    id,
    repository,
    ref: ref ?? null,
    commit: checked.commit,
    manifestDigest: checked.manifestDigest,
    snapshotDigest: checked.snapshotDigest,
    title: checked.manifest.title,
    assets: checked.manifest.assets,
    ...(acknowledgedCommit ? { acknowledgedCommit } : {})
  };
}

function assetChanges(previous = [], next = []) {
  const before = new Map(previous.map((asset) => [asset.id, asset]));
  const after = new Map(next.map((asset) => [asset.id, asset]));
  const added = next.filter((asset) => !before.has(asset.id));
  const removed = previous.filter((asset) => !after.has(asset.id));
  const changed = [];
  for (const asset of next) {
    const old = before.get(asset.id);
    if (!old || stableJson(old) === stableJson(asset)) continue;
    const fields = ['kind', 'artifact', 'file', 'digest'].filter((field) => old[field] !== asset[field]);
    changed.push({ id: asset.id, fields, before: old, after: asset });
  }
  return { added, removed, changed };
}

function describeRefresh(current, next) {
  const assets = assetChanges(current.assets, next.assets);
  const metadata = ['title', 'manifestDigest', 'snapshotDigest'].filter((field) => current[field] !== next[field]);
  return {
    changed: current.commit !== next.commit || metadata.length > 0 || assets.added.length > 0 || assets.removed.length > 0 || assets.changed.length > 0,
    commitChanged: current.commit !== next.commit,
    metadata,
    assets
  };
}

/** Fetch and validate a candidate snapshot in an OS temporary directory. No project state changes. */
export function previewStoreRefresh({ projectDir = '.', id }) {
  const loaded = readStoreState(projectDir);
  if (loaded.errors.length) throw extensionError(loaded.errors.join('\n'), 'INVALID_STORE_STATE');
  requireId(id);
  const current = loaded.state.stores.find((entry) => entry.id === id);
  if (!current) throw extensionError(`store "${id}" is not locked`, 'STORE_NOT_FOUND');
  const temporary = mkdtempSync(path.join(os.tmpdir(), `vld-store-${id}-`));
  try {
    cloneStore({ repository: current.repository, ref: current.ref, destination: temporary });
    const checked = snapshot(temporary, id);
    const next = stateEntry({ id, repository: current.repository, ref: current.ref, snapshot: checked });
    return { project: loaded.project, file: loaded.file, current, next, changes: describeRefresh(current, next) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Fetch a new immutable snapshot. Public refreshes provide an exact reviewed commit. */
export function addStore({ projectDir = '.', id, repository, ref = null, refresh = false, expectedCommit = null }) {
  const project = ensureProjectDir(projectDir); requireId(id); repository = validateRepository(repository);
  if (ref !== null && ref !== undefined && !SAFE_REF.test(String(ref))) throw extensionError('store ref must be a safe branch, tag, or commit name', 'INVALID_STORE_REF');
  const loaded = readStoreState(project);
  if (loaded.errors.length) throw extensionError(loaded.errors.join('\n'), 'INVALID_STORE_STATE');
  const prior = loaded.state.stores.find((store) => store.id === id);
  if (prior && !refresh) throw extensionError(`store "${id}" is already locked; run "vld store diff ${id}" before a reviewed refresh`, 'STORE_EXISTS');
  if (prior && refresh && !expectedCommit) {
    throw extensionError(`store "${id}" needs the exact reviewed commit acknowledgement before refresh`, 'STORE_ACKNOWLEDGEMENT_REQUIRED');
  }
  if (expectedCommit !== null && !COMMIT.test(String(expectedCommit))) {
    throw extensionError('store refresh acknowledgement must be the full 40-character commit shown by "vld store diff"', 'INVALID_STORE_ACKNOWLEDGEMENT');
  }
  const root = storesDir(project); mkdirSync(root, { recursive: true });
  const destination = storeDir(project, id);
  const temporary = path.join(root, `.${id}.${process.pid}.fetching`);
  const backup = path.join(root, `.${id}.${process.pid}.backup`);
  if (existsSync(temporary) || existsSync(backup)) throw extensionError('a previous store update did not finish; remove its temporary directory after inspection', 'STORE_TEMPORARY_EXISTS');
  let lockWritten = false;
  try {
    cloneStore({ repository, ref, destination: temporary });
    const checked = snapshot(temporary, id);
    if (expectedCommit && checked.commit !== expectedCommit) {
      throw extensionError(`store remote resolved to ${checked.commit}, not acknowledged ${expectedCommit}; run "vld store diff ${id}" again and review the new snapshot`, 'STORE_ACKNOWLEDGEMENT_MISMATCH');
    }
    if (existsSync(destination)) renameSync(destination, backup);
    renameSync(temporary, destination);
    const next = loaded.state.stores.filter((store) => store.id !== id);
    next.push(stateEntry({ id, repository, ref, snapshot: checked, acknowledgedCommit: prior ? expectedCommit : null }));
    next.sort((a, b) => a.id.localeCompare(b.id));
    writeJsonAtomic(loaded.file, { schemaVersion: STATE_VERSION, stores: next });
    lockWritten = true;
    rmSync(backup, { recursive: true, force: true });
    return { project, file: loaded.file, refreshed: Boolean(prior), store: next.find((entry) => entry.id === id) };
  } catch (error) {
    if (!lockWritten && existsSync(backup)) {
      rmSync(destination, { recursive: true, force: true });
      renameSync(backup, destination);
    }
    throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function refreshStore({ projectDir = '.', id, acknowledge = null }) {
  const preview = previewStoreRefresh({ projectDir, id });
  if (!preview.changes.changed) {
    return { project: preview.project, file: preview.file, refreshed: false, unchanged: true, store: preview.current };
  }
  if (!acknowledge) {
    throw extensionError(`review ${preview.next.commit} with "vld store diff ${id}", then rerun with --acknowledge ${preview.next.commit}`, 'STORE_ACKNOWLEDGEMENT_REQUIRED');
  }
  if (acknowledge !== preview.next.commit) {
    throw extensionError(`acknowledgement ${acknowledge} does not match previewed commit ${preview.next.commit}; rerun "vld store diff ${id}" and acknowledge that exact commit`, 'STORE_ACKNOWLEDGEMENT_MISMATCH');
  }
  return addStore({
    projectDir: preview.project,
    id,
    repository: preview.current.repository,
    ref: preview.current.ref,
    refresh: true,
    expectedCommit: acknowledge
  });
}

/** Inspect only the locally pinned snapshot: this never contacts a remote. */
export function storeStatus(projectDir = '.', id = null) {
  const loaded = readStoreState(projectDir);
  const errors = [...loaded.errors];
  const stores = [];
  if (loaded.errors.length) return { ...loaded, ok: false, stores, errors };
  for (const locked of loaded.state.stores.filter((entry) => !id || entry.id === id)) {
    const root = storeDir(loaded.project, locked.id); const drift = [];
    if (!existsSync(root)) drift.push('cached store directory is missing');
    else {
      try {
        const checked = snapshot(root, locked.id);
        if (checked.commit !== locked.commit) drift.push(`cached commit ${checked.commit.slice(0, 12)} differs from locked ${locked.commit.slice(0, 12)}`);
        if (checked.manifestDigest !== locked.manifestDigest) drift.push('manifest content differs from lock');
        if (stableJson(checked.manifest.assets) !== stableJson(locked.assets ?? [])) drift.push('locked asset declarations differ from the manifest');
        if (checked.snapshotDigest !== locked.snapshotDigest) drift.push('declared asset content differs from lock');
      } catch (error) { drift.push(error.message); }
    }
    stores.push({ ...locked, directory: root, drift, ok: drift.length === 0 });
  }
  if (id && !stores.length) errors.push(`store "${id}" is not locked`);
  return { ...loaded, stores, errors, ok: errors.length === 0 && stores.every((store) => store.ok) };
}

/** Read a declared asset only when the cached snapshot still matches its committed lock. */
export function readStoreAsset({ projectDir = '.', storeId, assetId, kind = null }) {
  const project = ensureProjectDir(projectDir); requireId(storeId); requireId(assetId, 'asset id');
  const report = storeStatus(project, storeId);
  if (!report.ok) throw extensionError(`store "${storeId}" is not verified:\n${[...report.errors, ...(report.stores[0]?.drift ?? [])].map((entry) => `- ${entry}`).join('\n')}`, 'STORE_NOT_VERIFIED');
  const store = report.stores[0];
  const asset = store.assets.find((entry) => entry.id === assetId);
  if (!asset) throw extensionError(`store "${storeId}" has no asset "${assetId}"`, 'STORE_ASSET_NOT_FOUND');
  if (kind && asset.kind !== kind) throw extensionError(`store asset "${storeId}/${assetId}" is ${asset.kind}, not ${kind}`, 'STORE_ASSET_KIND_MISMATCH');
  const file = assetPath(store.directory, asset.file);
  const content = readFileSync(file, 'utf8');
  if (digest(content) !== asset.digest) throw extensionError(`store asset "${storeId}/${assetId}" changed while being read`, 'STORE_ASSET_DRIFT');
  return { project, store: { id: store.id, commit: store.commit, title: store.title }, asset, file, content };
}

/** Copy a verified advisory asset into the project; never let a store write project state. */
export function copyStoreAsset({ projectDir = '.', storeId, assetId, out = null, force = false }) {
  const loaded = readStoreAsset({ projectDir, storeId, assetId });
  const target = path.resolve(loaded.project, out ?? path.join('docs', 'shared', storeId, `${assetId}.md`));
  const relative = path.relative(loaded.project, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0] === '.vld') {
    throw extensionError('store asset output must be a non-state path inside the project', 'INVALID_STORE_OUTPUT');
  }
  if (!target.endsWith('.md')) throw extensionError('store asset output must be a Markdown file', 'INVALID_STORE_OUTPUT');
  if (existsSync(target) && !force) throw extensionError(`${target} exists; pass --force to replace it`, 'STORE_ASSET_EXISTS');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, loaded.content, 'utf8');
  return { ...loaded, output: target };
}

/** Create an authoring skeleton. Git initialization and publication are deliberate user actions. */
export function initStore({ directory, id = null, title = null, force = false }) {
  if (!directory) throw extensionError('store directory is required', 'STORE_DIRECTORY_REQUIRED');
  const root = path.resolve(directory); const inferred = id ?? path.basename(root); requireId(inferred);
  const manifestFile = path.join(root, 'vld-store.json');
  if (existsSync(manifestFile) && !force) throw extensionError(`${manifestFile} exists; pass --force to replace it`, 'STORE_MANIFEST_EXISTS');
  mkdirSync(root, { recursive: true });
  const manifest = { schemaVersion: STORE_VERSION, id: inferred, title: title ?? `${inferred} shared delivery store`, assets: [] };
  writeJsonAtomic(manifestFile, manifest);
  const readme = path.join(root, 'README.md');
  if (!existsSync(readme) || force) writeFileSync(readme, `# ${manifest.title}\n\nA versioned VLD shared store. Add reviewed text assets, list them in \`vld-store.json\`, commit with Git, then let consuming projects run \`vld store add ${inferred} <repository>\`.\n\nStores distribute advisory templates and guidance only. They do not alter VLD's deterministic compiler or execute commands.\n`, 'utf8');
  return { directory: root, manifest: manifestFile, manifest };
}
