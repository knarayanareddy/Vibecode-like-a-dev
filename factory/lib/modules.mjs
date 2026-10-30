/**
 * Optional VLD capability modules.
 *
 * The compiler deliberately stays small and deterministic. Modules describe
 * opt-in disciplines (product, architecture, delivery, review, QA) without
 * changing profile routing or making every packet carry every method. A project
 * locks the exact builtin manifests it enabled under `.vld/modules.json`.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';
import {
  ID_PATTERN,
  SEMVER_PATTERN,
  digest,
  ensureProjectDir,
  extensionError,
  parseIdList,
  readJson,
  vldDir,
  writeJsonAtomic
} from './extension-utils.mjs';

export const MODULES_DIR = path.join(ROOT, 'factory', 'modules');
const STATE_FILE = 'modules.json';

function modulePath(id) {
  return path.join(MODULES_DIR, `${id}.json`);
}

export function validateModule(module, expectedId = module?.id) {
  const errors = [];
  if (!module || typeof module !== 'object' || Array.isArray(module)) return [`${expectedId ?? 'module'}: module is not an object`];
  if (module.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
  if (!module.id || !ID_PATTERN.test(module.id)) errors.push('id: required, lowercase kebab-case');
  else if (expectedId && module.id !== expectedId) errors.push(`id: "${module.id}" does not match file name "${expectedId}"`);
  if (!SEMVER_PATTERN.test(String(module.version ?? ''))) errors.push('version: required semantic version');
  if (typeof module.title !== 'string' || module.title.trim().length < 3 || /[\r\n]/.test(module.title)) errors.push('title: required one-line string');
  if (typeof module.summary !== 'string' || module.summary.trim().length < 20 || /[\r\n]/.test(module.summary)) errors.push('summary: required one-line string of at least 20 characters');

  for (const field of ['capabilities', 'outputs', 'requires']) {
    if (!Array.isArray(module[field]) || module[field].some((entry) => typeof entry !== 'string' || !entry.trim() || /[\r\n]/.test(entry))) {
      errors.push(`${field}: must be a list of non-empty one-line strings`);
    } else if (new Set(module[field]).size !== module[field].length) {
      errors.push(`${field}: values must not repeat`);
    }
  }
  if (Array.isArray(module.requires) && module.requires.includes(module.id)) errors.push('requires: a module cannot require itself');
  return errors;
}

/** Load and validate the complete builtin module catalogue, including dependencies. */
export function listModules() {
  const errors = [];
  const modules = [];
  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    let module;
    try {
      module = readJson(modulePath(id));
    } catch (error) {
      errors.push(`${entry.name}: invalid JSON (${error.message})`);
      continue;
    }
    const problems = validateModule(module, id);
    errors.push(...problems.map((problem) => `${entry.name}: ${problem}`));
    modules.push({ ...module, digest: digest(module), source: `factory/modules/${entry.name}` });
  }

  const ids = new Set(modules.map((module) => module.id));
  for (const module of modules) {
    for (const dependency of Array.isArray(module.requires) ? module.requires : []) {
      if (!ids.has(dependency)) errors.push(`${module.id}: requires unknown module "${dependency}"`);
    }
  }

  // A dependency cycle makes the supposedly ordered module set non-reproducible.
  const byId = new Map(modules.map((module) => [module.id, module]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) {
      errors.push(`module dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of Array.isArray(byId.get(id)?.requires) ? byId.get(id).requires : []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const module of modules) visit(module.id);

  return { modules, errors };
}

function catalogueOrThrow() {
  const catalogue = listModules();
  if (catalogue.errors.length > 0) throw extensionError(`builtin modules are invalid:\n${catalogue.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_MODULE_CATALOGUE');
  return catalogue.modules;
}

/**
 * Resolve requested modules into dependency-first order. The persisted lock is
 * alphabetic, but this order tells a caller why enabling `review` also enables the
 * lower-level product, architecture and delivery modules.
 */
export function resolveModules(ids) {
  const requested = parseIdList(ids);
  if (requested.length === 0) throw extensionError('provide at least one module id, e.g. `vld module enable product,qa`', 'MODULE_ID_REQUIRED');
  if (new Set(requested).size !== requested.length) throw extensionError('a module id was provided twice', 'DUPLICATE_MODULE_ID');
  const modules = catalogueOrThrow();
  const byId = new Map(modules.map((module) => [module.id, module]));
  const resolved = [];
  const seen = new Set();
  const visit = (id) => {
    const module = byId.get(id);
    if (!module) throw extensionError(`unknown module "${id}". Known: ${[...byId.keys()].join(', ')}`, 'UNKNOWN_MODULE');
    if (seen.has(id)) return;
    seen.add(id);
    for (const dependency of module.requires) visit(dependency);
    resolved.push(module);
  };
  for (const id of requested) visit(id);
  return resolved;
}

function statePath(projectDir) {
  return path.join(vldDir(projectDir), STATE_FILE);
}

export function readModuleState(projectDir = '.') {
  const project = ensureProjectDir(projectDir);
  const file = statePath(project);
  if (!existsSync(file)) return { project, file, state: { schemaVersion: 1, modules: [] }, exists: false, errors: [] };

  let state;
  try {
    state = readJson(file);
  } catch (error) {
    return { project, file, state: null, exists: true, errors: [`${file}: invalid JSON (${error.message})`] };
  }

  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) errors.push(`${file}: state is not an object`);
  if (state?.schemaVersion !== 1) errors.push(`${file}: schemaVersion must be 1`);
  if (!Array.isArray(state?.modules)) errors.push(`${file}: modules must be a list`);
  const seen = new Set();
  for (const entry of Array.isArray(state?.modules) ? state.modules : []) {
    if (!entry || !ID_PATTERN.test(String(entry.id ?? ''))) errors.push(`${file}: module lock has an invalid id`);
    else if (seen.has(entry.id)) errors.push(`${file}: module "${entry.id}" is locked twice`);
    else seen.add(entry.id);
    if (!SEMVER_PATTERN.test(String(entry?.version ?? ''))) errors.push(`${file}: module ${entry?.id ?? '?'} has an invalid version`);
    if (!/^[a-f0-9]{64}$/.test(String(entry?.digest ?? ''))) errors.push(`${file}: module ${entry?.id ?? '?'} has an invalid digest`);
  }
  return { project, file, state, exists: true, errors };
}

/** Check the project lock against the manifests currently shipped by this VLD version. */
export function moduleStatus(projectDir = '.') {
  const loaded = readModuleState(projectDir);
  if (loaded.errors.length > 0) return { ...loaded, ok: false, modules: [], drift: [], errors: loaded.errors };
  const catalogue = listModules();
  const errors = [...catalogue.errors];
  const byId = new Map(catalogue.modules.map((module) => [module.id, module]));
  const drift = [];
  const modules = [];
  for (const lock of loaded.state.modules) {
    const current = byId.get(lock.id);
    if (!current) {
      drift.push({ id: lock.id, reason: 'no longer shipped by this VLD version' });
      continue;
    }
    if (current.version !== lock.version || current.digest !== lock.digest) {
      drift.push({ id: lock.id, reason: `locked ${lock.version}/${lock.digest.slice(0, 12)} differs from shipped ${current.version}/${current.digest.slice(0, 12)}` });
    }
    modules.push({ ...current, locked: lock });
  }
  return { ...loaded, ok: errors.length === 0 && drift.length === 0, modules, drift, errors };
}

/** Enable requested modules plus their dependencies. Existing locks are preserved. */
export function enableModules({ projectDir = '.', ids }) {
  const loaded = readModuleState(projectDir);
  if (loaded.errors.length > 0) throw extensionError(loaded.errors.join('\n'), 'INVALID_MODULE_STATE');
  const requested = resolveModules(ids);
  const byId = new Map(requested.map((module) => [module.id, module]));
  const next = [...loaded.state.modules];
  const added = [];
  const updated = [];
  for (const module of requested) {
    const lock = { id: module.id, version: module.version, digest: module.digest };
    const position = next.findIndex((entry) => entry.id === module.id);
    if (position === -1) {
      next.push(lock);
      added.push(module.id);
    } else if (next[position].version !== lock.version || next[position].digest !== lock.digest) {
      // An explicit enable is the acknowledgement that a team reviewed this
      // manifest update. Without this refresh path lock drift would be permanent.
      next[position] = lock;
      updated.push(module.id);
    }
  }
  next.sort((a, b) => a.id.localeCompare(b.id));
  const state = { schemaVersion: 1, modules: next };
  const previous = JSON.stringify(loaded.state);
  const serialized = JSON.stringify(state);
  if (previous !== serialized || !loaded.exists) writeJsonAtomic(loaded.file, state);
  return {
    project: loaded.project,
    file: loaded.file,
    changed: previous !== serialized || !loaded.exists,
    enabled: requested.map((module) => module.id),
    added,
    updated,
    state,
    requested: byId.size
  };
}

/** A workflow/adapter must not run against a stale or hand-edited module lock. */
export function requireVerifiedModules(projectDir, required = []) {
  const status = moduleStatus(projectDir);
  if (status.errors.length > 0) throw extensionError(status.errors.join('\n'), 'INVALID_MODULE_CATALOGUE');
  if (status.drift.length > 0) {
    throw extensionError(`module lock drift:\n${status.drift.map((entry) => `- ${entry.id}: ${entry.reason}`).join('\n')}\nRe-enable the module after reviewing the update.`, 'MODULE_LOCK_DRIFT');
  }
  const enabled = new Set(status.modules.map((module) => module.id));
  const missing = required.filter((id) => !enabled.has(id));
  if (missing.length > 0) {
    throw extensionError(`workflow requires module${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. Enable with \`vld module enable ${missing.join(',')} --project ${status.project}\`.`, 'MODULE_REQUIRED');
  }
  return status;
}
