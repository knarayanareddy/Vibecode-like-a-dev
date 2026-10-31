/**
 * Versioned mission and work-package declarations.
 *
 * This is deliberately the Phase 1 foundation for a future VLD Runtime, not an
 * agent runner. A mission freezes the verified packet, compiler policy and Git
 * target that a later scheduler must honour. It never invokes a model, starts a
 * process, creates a worktree or changes a Git ref.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPolicy } from './planner.mjs';
import {
  digest,
  ensureProjectDir,
  extensionError,
  ID_PATTERN,
  readJson,
  writeJsonAtomic
} from './extension-utils.mjs';
import { verifyPacket } from './verify.mjs';

export const MISSION_SCHEMA_VERSION = 1;
const COMMIT = /^[a-f0-9]{40}$/;
const REQUIREMENT = /^REQ-\d{3}$/;
const SAFE_GIT_REF = /^(?:HEAD|[A-Za-z0-9][A-Za-z0-9._/-]{0,200})$/;
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/*?{}-]{0,240}$/;
const MISSION_FIELDS = new Set(['schemaVersion', 'id', 'title', 'packet', 'target', 'corePolicyDigest', 'workPackages']);
const DEFINITION_FIELDS = new Set(['schemaVersion', 'id', 'title', 'workPackages']);
const PACKAGE_FIELDS = new Set(['id', 'title', 'requirements', 'dependsOn', 'resourceClaims']);

function hasUnsafeText(value) {
  return typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value);
}

function normalizedPath(value) {
  return value.split(path.sep).join('/');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve a user-provided relative path inside a project without accepting a
 * pre-existing symlink component. Mission declarations are reviewable project
 * data, never a way to write outside the project checkout.
 */
export function safeProjectPath(projectDir, relative, label = 'path') {
  const project = ensureProjectDir(projectDir);
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative) || /[\r\n\0]/.test(relative)) {
    throw extensionError(`${label} must be a non-empty relative path inside the project`, 'INVALID_MISSION_PATH');
  }
  const target = path.resolve(project, relative);
  if (!isWithin(project, target)) throw extensionError(`${label} escapes the project`, 'INVALID_MISSION_PATH');

  // Do not follow a pre-existing symlink while deciding where a managed mission
  // file should live. A concurrent hostile local process is outside this CLI's
  // threat model, but an accidental symlink must be refused deterministically.
  let cursor = project;
  for (const segment of path.relative(project, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw extensionError(`${label} contains a symbolic link: ${normalizedPath(path.relative(project, cursor))}`, 'INVALID_MISSION_PATH');
    }
  }
  return target;
}

function packetPath(project, supplied) {
  const resolved = path.resolve(project, supplied ?? 'specs');
  if (!isWithin(project, resolved)) throw extensionError('packet directory escapes the project', 'INVALID_MISSION_PACKET');
  if (!existsSync(resolved)) throw extensionError(`packet directory does not exist: ${resolved}`, 'INVALID_MISSION_PACKET');
  return resolved;
}

function gitCommit(project, ref) {
  if (typeof ref !== 'string' || !SAFE_GIT_REF.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw extensionError('target ref must be HEAD or a safe branch/ref name', 'INVALID_MISSION_TARGET');
  }
  try {
    const commit = execFileSync('git', ['-C', project, 'rev-parse', '--verify', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!COMMIT.test(commit)) throw new Error('did not resolve a full commit');
    return commit;
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').trim();
    throw extensionError(`target ref "${ref}" does not resolve to a commit${detail ? `: ${detail}` : ''}`, 'INVALID_MISSION_TARGET');
  }
}

function packetAuthority(project, supplied, policy) {
  const packet = packetPath(project, supplied);
  const report = verifyPacket(packet, { policy, strict: false });
  if (!report.ok) {
    throw extensionError(`packet is not verified:\n${report.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_MISSION_PACKET');
  }
  const specFile = path.join(packet, 'spec.json');
  let spec;
  try {
    spec = readJson(specFile);
  } catch (error) {
    throw extensionError(`packet spec.json is invalid: ${error.message}`, 'INVALID_MISSION_PACKET');
  }
  const ids = (spec.requirements ?? []).map((requirement) => requirement?.id).filter((id) => REQUIREMENT.test(String(id)));
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw extensionError('packet has no unique requirement ids', 'INVALID_MISSION_PACKET');
  }
  return {
    directory: packet,
    relativePath: normalizedPath(path.relative(project, packet)),
    digest: digest(readFileSync(specFile, 'utf8')),
    requirements: ids.sort()
  };
}

function validateNoUnknownFields(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
}

function validatePackageShape(workPackage, index, errors) {
  const label = `workPackages[${index}]`;
  validateNoUnknownFields(workPackage, PACKAGE_FIELDS, label, errors);
  if (!workPackage || typeof workPackage !== 'object' || Array.isArray(workPackage)) return;
  if (!ID_PATTERN.test(String(workPackage.id ?? ''))) errors.push(`${label}.id must be lowercase kebab-case`);
  if (hasUnsafeText(workPackage.title) || workPackage.title.trim().length < 8) errors.push(`${label}.title must be a one-line string of at least 8 characters`);
  if (!Array.isArray(workPackage.requirements) || workPackage.requirements.length === 0) {
    errors.push(`${label}.requirements must name at least one requirement id`);
  } else {
    const seen = new Set();
    for (const id of workPackage.requirements) {
      if (!REQUIREMENT.test(String(id))) errors.push(`${label}.requirements contains invalid id "${id}"`);
      else if (seen.has(id)) errors.push(`${label}.requirements lists ${id} twice`);
      else seen.add(id);
    }
  }
  if (workPackage.dependsOn !== undefined) {
    if (!Array.isArray(workPackage.dependsOn)) errors.push(`${label}.dependsOn must be a list when provided`);
    else {
      const seen = new Set();
      for (const dependency of workPackage.dependsOn) {
        if (!ID_PATTERN.test(String(dependency ?? ''))) errors.push(`${label}.dependsOn contains an invalid work package id`);
        else if (seen.has(dependency)) errors.push(`${label}.dependsOn lists "${dependency}" twice`);
        else seen.add(dependency);
      }
    }
  }
  if (workPackage.resourceClaims !== undefined) {
    if (!workPackage.resourceClaims || typeof workPackage.resourceClaims !== 'object' || Array.isArray(workPackage.resourceClaims)) {
      errors.push(`${label}.resourceClaims must be an object when provided`);
    } else {
      for (const key of Object.keys(workPackage.resourceClaims)) if (key !== 'paths') errors.push(`${label}.resourceClaims.${key} is not allowed`);
      if (!Array.isArray(workPackage.resourceClaims.paths) || workPackage.resourceClaims.paths.length === 0) {
        errors.push(`${label}.resourceClaims.paths must be a non-empty list when resourceClaims is provided`);
      } else {
        const seen = new Set();
        for (const claim of workPackage.resourceClaims.paths) {
          if (typeof claim !== 'string' || !SAFE_PATH_PATTERN.test(claim)) errors.push(`${label}.resourceClaims.paths contains an unsafe project-relative pattern`);
          else if (seen.has(claim)) errors.push(`${label}.resourceClaims.paths lists "${claim}" twice`);
          else seen.add(claim);
        }
      }
    }
  }
}

function validatePackageGraph(workPackages, errors) {
  const byId = new Map();
  for (const workPackage of workPackages ?? []) {
    if (!ID_PATTERN.test(String(workPackage?.id ?? ''))) continue;
    if (byId.has(workPackage.id)) errors.push(`work package id "${workPackage.id}" repeats`);
    else byId.set(workPackage.id, workPackage);
  }
  for (const workPackage of byId.values()) {
    for (const dependency of workPackage.dependsOn ?? []) {
      if (!byId.has(dependency)) errors.push(`work package "${workPackage.id}" depends on missing package "${dependency}"`);
      if (dependency === workPackage.id) errors.push(`work package "${workPackage.id}" cannot depend on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) {
      errors.push(`work package dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function validatePackageRequirements(workPackages, requirementIds, errors, warnings) {
  const known = new Set(requirementIds);
  const claimed = new Map();
  for (const workPackage of workPackages ?? []) {
    for (const id of workPackage?.requirements ?? []) {
      if (!known.has(id)) errors.push(`work package "${workPackage?.id ?? '?'}" names unknown requirement ${id}`);
      else if (claimed.has(id)) errors.push(`requirement ${id} is assigned to both "${claimed.get(id)}" and "${workPackage?.id ?? '?'}"`);
      else claimed.set(id, workPackage?.id);
    }
  }
  for (const id of requirementIds) if (!claimed.has(id)) warnings.push(`requirement ${id} is not assigned to a work package`);
}

/** Validate editable input before Core adds packet/target/policy authority. */
export function validateMissionDefinition(definition, { requirementIds = null } = {}) {
  const errors = [];
  const warnings = [];
  validateNoUnknownFields(definition, DEFINITION_FIELDS, 'mission definition', errors);
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return { ok: false, errors, warnings };
  if (definition.schemaVersion !== MISSION_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MISSION_SCHEMA_VERSION}`);
  if (!ID_PATTERN.test(String(definition.id ?? ''))) errors.push('id must be lowercase kebab-case');
  if (hasUnsafeText(definition.title) || definition.title.trim().length < 8) errors.push('title must be a one-line string of at least 8 characters');
  if (!Array.isArray(definition.workPackages) || definition.workPackages.length === 0) errors.push('workPackages must be a non-empty list');
  else {
    definition.workPackages.forEach((workPackage, index) => validatePackageShape(workPackage, index, errors));
    validatePackageGraph(definition.workPackages, errors);
    if (requirementIds) validatePackageRequirements(definition.workPackages, requirementIds, errors, warnings);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate a full frozen mission. `packetDir` may override the declared packet
 * only for a caller that has already constrained it inside the same project.
 */
export function validateMission(mission, { projectDir = '.', packetDir = null, policy = loadPolicy() } = {}) {
  const errors = [];
  const warnings = [];
  const passes = [];
  const project = ensureProjectDir(projectDir);
  validateNoUnknownFields(mission, MISSION_FIELDS, 'mission', errors);
  if (!mission || typeof mission !== 'object' || Array.isArray(mission)) return { ok: false, errors, warnings, passes, mission: null };
  if (mission.schemaVersion !== MISSION_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MISSION_SCHEMA_VERSION}`);
  if (!ID_PATTERN.test(String(mission.id ?? ''))) errors.push('id must be lowercase kebab-case');
  if (hasUnsafeText(mission.title) || mission.title.trim().length < 8) errors.push('title must be a one-line string of at least 8 characters');
  if (!mission.packet || typeof mission.packet !== 'object' || Array.isArray(mission.packet)) errors.push('packet must be an object');
  if (!mission.target || typeof mission.target !== 'object' || Array.isArray(mission.target)) errors.push('target must be an object');
  if (!/^[a-f0-9]{64}$/.test(String(mission.corePolicyDigest ?? ''))) errors.push('corePolicyDigest must be a SHA-256 digest');

  let authority = null;
  if (mission.packet && typeof mission.packet === 'object') {
    for (const key of Object.keys(mission.packet)) if (!['path', 'digest'].includes(key)) errors.push(`packet.${key} is not allowed`);
    if (typeof mission.packet.path !== 'string' || !mission.packet.path || path.isAbsolute(mission.packet.path)) errors.push('packet.path must be a non-empty project-relative path');
    if (!/^[a-f0-9]{64}$/.test(String(mission.packet.digest ?? ''))) errors.push('packet.digest must be a SHA-256 digest');
    if (errors.length === 0 || mission.packet.path) {
      try {
        authority = packetAuthority(project, packetDir ?? mission.packet.path, policy);
        if (mission.packet.path !== authority.relativePath) errors.push(`packet.path is "${mission.packet.path}" but resolves to "${authority.relativePath}"`);
        if (mission.packet.digest !== authority.digest) errors.push('packet digest differs from the verified current spec.json');
        else passes.push(`packet digest matches verified ${authority.relativePath}/spec.json`);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  if (mission.target && typeof mission.target === 'object') {
    for (const key of Object.keys(mission.target)) if (!['ref', 'commit'].includes(key)) errors.push(`target.${key} is not allowed`);
    if (typeof mission.target.ref !== 'string' || !SAFE_GIT_REF.test(mission.target.ref) || mission.target.ref.includes('..') || mission.target.ref.startsWith('-')) errors.push('target.ref must be HEAD or a safe branch/ref name');
    if (!COMMIT.test(String(mission.target.commit ?? ''))) errors.push('target.commit must be a full lowercase Git commit');
  }

  if (mission.corePolicyDigest && mission.corePolicyDigest !== digest(policy)) warnings.push('core policy digest differs from the current VLD policy');

  const shape = validateMissionDefinition({
    schemaVersion: mission.schemaVersion,
    id: mission.id,
    title: mission.title,
    workPackages: mission.workPackages
  }, { requirementIds: authority?.requirements ?? null });
  errors.push(...shape.errors);
  warnings.push(...shape.warnings);

  if (authority && shape.ok) {
    const assigned = new Set((mission.workPackages ?? []).flatMap((workPackage) => workPackage.requirements ?? []));
    if (assigned.size === authority.requirements.length && shape.warnings.length === 0) passes.push(`${assigned.size} packet requirement(s) assigned exactly once`);
  }
  return { ok: errors.length === 0, errors, warnings, passes, mission, authority };
}

/** Create a frozen versioned mission only after the packet and target are verified. */
export function createMission({ definition, projectDir = '.', packetDir = 'specs', targetRef = 'HEAD', outFile = null, force = false, policy = loadPolicy() } = {}) {
  const project = ensureProjectDir(projectDir);
  const authority = packetAuthority(project, packetDir, policy);
  const source = validateMissionDefinition(definition, { requirementIds: authority.requirements });
  if (!source.ok) throw extensionError(`mission definition is invalid:\n${source.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_MISSION');
  if (source.warnings.length > 0) {
    throw extensionError(`mission must assign every packet requirement before it can be created:\n${source.warnings.map((warning) => `- ${warning}`).join('\n')}`, 'INCOMPLETE_MISSION');
  }
  const target = { ref: targetRef, commit: gitCommit(project, targetRef) };
  const mission = {
    schemaVersion: MISSION_SCHEMA_VERSION,
    id: definition.id,
    title: definition.title.trim(),
    packet: { path: authority.relativePath, digest: authority.digest },
    target,
    corePolicyDigest: digest(policy),
    workPackages: definition.workPackages.map((workPackage) => ({
      id: workPackage.id,
      title: workPackage.title.trim(),
      requirements: [...workPackage.requirements],
      dependsOn: [...(workPackage.dependsOn ?? [])],
      ...(workPackage.resourceClaims ? { resourceClaims: { paths: [...workPackage.resourceClaims.paths] } } : {})
    }))
  };
  const report = validateMission(mission, { projectDir: project, policy });
  if (!report.ok) throw extensionError(`generated mission is invalid:\n${report.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_MISSION');

  const relativeOut = outFile ?? path.join('missions', mission.id, 'mission.json');
  const file = safeProjectPath(project, relativeOut, 'mission output');
  if (existsSync(file) && !force) throw extensionError(`${file} already exists; refusing to overwrite`, 'MISSION_EXISTS');
  writeJsonAtomic(file, mission);
  return { project, file, mission, digest: digest(mission), warnings: report.warnings, passes: report.passes };
}

export function readMission(file, { projectDir = '.' } = {}) {
  const project = ensureProjectDir(projectDir);
  const resolved = safeProjectPath(project, file, 'mission file');
  if (!existsSync(resolved)) throw extensionError(`mission file does not exist: ${resolved}`, 'MISSION_NOT_FOUND');
  try {
    return { project, file: resolved, mission: readJson(resolved) };
  } catch (error) {
    throw extensionError(`mission file is invalid JSON: ${error.message}`, 'INVALID_MISSION');
  }
}

/** Report staleness without mutating a mission, target ref or packet. */
export function missionStatus({ file, projectDir = '.', policy = loadPolicy() } = {}) {
  const loaded = readMission(file, { projectDir });
  const report = validateMission(loaded.mission, { projectDir: loaded.project, policy });
  const stale = [];
  if (loaded.mission?.target?.ref && SAFE_GIT_REF.test(loaded.mission.target.ref) && !loaded.mission.target.ref.includes('..')) {
    try {
      const current = gitCommit(loaded.project, loaded.mission.target.ref);
      if (current !== loaded.mission.target.commit) stale.push({ kind: 'target', expected: loaded.mission.target.commit, actual: current });
    } catch (error) {
      stale.push({ kind: 'target-unresolved', expected: loaded.mission.target.commit, detail: error.message });
    }
  }
  if (loaded.mission?.corePolicyDigest && loaded.mission.corePolicyDigest !== digest(policy)) stale.push({ kind: 'core-policy' });
  return {
    ok: report.ok && stale.length === 0,
    file: loaded.file,
    mission: loaded.mission,
    stale,
    errors: report.errors,
    warnings: report.warnings,
    passes: report.passes,
    requirements: report.authority ? {
      total: report.authority.requirements.length,
      assigned: new Set((loaded.mission.workPackages ?? []).flatMap((workPackage) => workPackage.requirements ?? [])).size
    } : null
  };
}
