/**
 * Bundles are conservative, reviewable shortcuts for common project shapes.
 *
 * A bundle may add explicit risk/trait signals and enable modules, but it never
 * removes a project decision, changes a stage, or silently replaces a scalar
 * constraint. That keeps `vld bundle apply` a policy addition rather than an
 * opaque project rewrite.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';
import { normalizeProfile, validateProfile } from './profile.mjs';
import { enableModules, listModules } from './modules.mjs';
import {
  ID_PATTERN,
  SEMVER_PATTERN,
  ensureProjectDir,
  extensionError,
  readJson,
  writeJsonAtomic
} from './extension-utils.mjs';

export const BUNDLES_DIR = path.join(ROOT, 'factory', 'bundles');

function bundlePath(id) {
  return path.join(BUNDLES_DIR, `${id}.json`);
}

function oneLineList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() && !/[\r\n]/.test(entry));
}

export function validateBundle(bundle, expectedId = bundle?.id) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return [`${expectedId ?? 'bundle'}: bundle is not an object`];
  if (bundle.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
  if (!bundle.id || !ID_PATTERN.test(bundle.id)) errors.push('id: required, lowercase kebab-case');
  else if (expectedId && bundle.id !== expectedId) errors.push(`id: "${bundle.id}" does not match file name "${expectedId}"`);
  if (!SEMVER_PATTERN.test(String(bundle.version ?? ''))) errors.push('version: required semantic version');
  if (typeof bundle.title !== 'string' || bundle.title.trim().length < 3 || /[\r\n]/.test(bundle.title)) errors.push('title: required one-line string');
  if (typeof bundle.summary !== 'string' || bundle.summary.trim().length < 20 || /[\r\n]/.test(bundle.summary)) errors.push('summary: required one-line string of at least 20 characters');
  if (!oneLineList(bundle.modules) || new Set(bundle.modules ?? []).size !== (bundle.modules ?? []).length) errors.push('modules: must be a unique list of module ids');
  if (!oneLineList(bundle.workflows) || new Set(bundle.workflows ?? []).size !== (bundle.workflows ?? []).length) errors.push('workflows: must be a unique list of workflow ids');
  if (!bundle.profile || typeof bundle.profile !== 'object' || Array.isArray(bundle.profile)) {
    errors.push('profile: required object');
  } else {
    const allowed = new Set(['traits', 'risks', 'overlays', 'constraints']);
    for (const key of Object.keys(bundle.profile)) if (!allowed.has(key)) errors.push(`profile.${key}: bundles may only add traits, risks, overlays or constraints`);
    for (const field of ['traits', 'overlays']) {
      if (bundle.profile[field] !== undefined && !oneLineList(bundle.profile[field])) errors.push(`profile.${field}: must be a list of non-empty one-line strings`);
    }
    if (bundle.profile.risks !== undefined) {
      if (!bundle.profile.risks || typeof bundle.profile.risks !== 'object' || Array.isArray(bundle.profile.risks)) errors.push('profile.risks: must be an object');
      for (const [key, value] of Object.entries(bundle.profile.risks ?? {})) if (value !== true) errors.push(`profile.risks.${key}: bundles may only add a true risk signal (never lower risk)`);
    }
    if (bundle.profile.constraints !== undefined && (!bundle.profile.constraints || typeof bundle.profile.constraints !== 'object' || Array.isArray(bundle.profile.constraints))) {
      errors.push('profile.constraints: must be an object');
    }
  }
  return errors;
}

export function listBundles() {
  const bundles = [];
  const errors = [];
  for (const entry of readdirSync(BUNDLES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    try {
      const bundle = readJson(bundlePath(id));
      errors.push(...validateBundle(bundle, id).map((problem) => `${entry.name}: ${problem}`));
      bundles.push(bundle);
    } catch (error) {
      errors.push(`${entry.name}: invalid JSON (${error.message})`);
    }
  }
  const modules = new Set(listModules().modules.map((module) => module.id));
  for (const bundle of bundles) {
    for (const id of Array.isArray(bundle.modules) ? bundle.modules : []) if (!modules.has(id)) errors.push(`${bundle.id}: references unknown module "${id}"`);
  }
  return { bundles, errors };
}

export function getBundle(id) {
  const catalogue = listBundles();
  if (catalogue.errors.length > 0) throw extensionError(`builtin bundles are invalid:\n${catalogue.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_BUNDLE_CATALOGUE');
  const bundle = catalogue.bundles.find((entry) => entry.id === id);
  if (!bundle) throw extensionError(`unknown bundle "${id}". Known: ${catalogue.bundles.map((entry) => entry.id).join(', ')}`, 'UNKNOWN_BUNDLE');
  return bundle;
}

function dedupe(values) {
  return [...new Set(values)];
}

/**
 * Calculate an additive profile patch. It never modifies a true risk to false,
 * removes traits/overlays, or replaces scalar configuration. The final profile
 * validation protects the compiler from a malformed hand-written bundle too.
 */
export function applyBundleToProfile(raw, bundle) {
  const next = JSON.parse(JSON.stringify(raw));
  const changes = { traits: [], risks: [], overlays: [], constraints: [] };
  const patch = bundle.profile ?? {};

  if (patch.traits?.length) {
    const before = Array.isArray(next.traits) ? next.traits : [];
    next.traits = dedupe([...before, ...patch.traits]);
    changes.traits = next.traits.filter((trait) => !before.includes(trait));
  }
  if (patch.overlays?.length) {
    const before = Array.isArray(next.overlays) ? next.overlays : [];
    next.overlays = dedupe([...before, ...patch.overlays]);
    changes.overlays = next.overlays.filter((overlay) => !before.includes(overlay));
  }
  if (patch.risks) {
    next.risks = { ...(next.risks ?? {}) };
    for (const [risk, value] of Object.entries(patch.risks)) {
      if (value === true && next.risks[risk] !== true) {
        next.risks[risk] = true;
        changes.risks.push(risk);
      }
    }
  }
  if (patch.constraints) {
    next.constraints = { ...(next.constraints ?? {}) };
    for (const [key, value] of Object.entries(patch.constraints)) {
      if (next.constraints[key] === undefined) {
        next.constraints[key] = value;
        changes.constraints.push(key);
      } else if (JSON.stringify(next.constraints[key]) !== JSON.stringify(value)) {
        throw extensionError(`bundle "${bundle.id}" would replace constraints.${key}. Bundles only add an absent scalar constraint; set it explicitly in the profile instead.`, 'BUNDLE_CONFLICT');
      }
    }
  }

  const validation = validateProfile(normalizeProfile(next));
  if (validation.length > 0) {
    throw extensionError(`bundle "${bundle.id}" does not produce a valid profile:\n${validation.map((error) => `- ${error}`).join('\n')}`, 'INVALID_BUNDLE_PROFILE');
  }
  return { profile: next, changes };
}

export function applyBundle({ id, profilePath, projectDir = '.', dryRun = false }) {
  const project = ensureProjectDir(projectDir);
  const bundle = getBundle(id);
  const file = path.resolve(profilePath ?? path.join(project, 'profile.json'));
  if (!existsSync(file)) throw extensionError(`profile does not exist: ${file}`, 'PROFILE_NOT_FOUND');

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw extensionError(`could not read profile at ${file}: ${error.message}`, 'INVALID_PROFILE');
  }
  const result = applyBundleToProfile(raw, bundle);
  const before = JSON.stringify(raw);
  const after = JSON.stringify(result.profile);
  const changed = before !== after;
  let modules = null;
  if (!dryRun) {
    if (changed) writeJsonAtomic(file, result.profile);
    modules = enableModules({ projectDir: project, ids: bundle.modules });
  }
  return {
    bundle,
    project,
    profilePath: file,
    changed,
    changes: result.changes,
    modules,
    workflows: bundle.workflows,
    profile: result.profile,
    dryRun
  };
}
