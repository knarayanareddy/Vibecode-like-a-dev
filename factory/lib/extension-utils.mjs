/**
 * Small, dependency-free helpers shared by VLD's optional platform extensions.
 *
 * These extensions deliberately sit outside the compiler's profile -> packet path.
 * Their state is explicit under `.vld/`, versioned, and hash-locked so a project can
 * tell whether a bundled module, adapter or workflow changed underneath it.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Stable serialization makes locks independent of object insertion order. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  const source = typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Writes all managed JSON deterministically, and avoids a partially-written lock
 * file should a process be interrupted. The temporary file never persists after a
 * successful rename.
 */
export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function ensureProjectDir(projectDir) {
  const target = path.resolve(projectDir ?? '.');
  if (!existsSync(target)) {
    const error = new Error(`project directory does not exist: ${target}`);
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }
  return target;
}

function containedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function lstatOrNull(target, label) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw extensionError(`${label} cannot be inspected`, 'UNSAFE_MANAGED_PATH');
  }
}

function realDirectory(target, label) {
  const stats = lstatOrNull(target, label);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw extensionError(`${label} must be an existing real directory`, 'UNSAFE_MANAGED_PATH');
  }
}

/**
 * Resolve a managed relative path without following symlinks below a real root.
 * The caller can use it for an existing file check before a later atomic write.
 */
export function safeManagedFile(root, relative, label = 'managed file') {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  if (typeof relative !== 'string' || !relative || !containedPath(resolvedRoot, candidate) || candidate === resolvedRoot) {
    throw extensionError(`${label} escapes its managed root`, 'UNSAFE_MANAGED_PATH');
  }
  realDirectory(resolvedRoot, 'managed root');
  let cursor = resolvedRoot;
  const parts = path.relative(resolvedRoot, candidate).split(path.sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stats = lstatOrNull(cursor, label);
    // A missing parent ends the inspection: no later descendant can exist yet.
    if (!stats) break;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw extensionError(`${label} has a symbolic-link or non-directory parent`, 'UNSAFE_MANAGED_PATH');
    }
  }
  const destination = lstatOrNull(candidate, label);
  if (destination && (destination.isSymbolicLink() || !destination.isFile())) {
    throw extensionError(`${label} is a symbolic link or is not a regular file`, 'UNSAFE_MANAGED_PATH');
  }
  return candidate;
}

/** Create a managed directory one component at a time without traversing links. */
export function ensureSafeManagedDirectory(root, relative, label = 'managed directory') {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (typeof relative !== 'string' || !containedPath(resolvedRoot, target)) {
    throw extensionError(`${label} escapes its managed root`, 'UNSAFE_MANAGED_PATH');
  }
  realDirectory(resolvedRoot, 'managed root');
  let cursor = resolvedRoot;
  for (const part of path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stats = lstatOrNull(cursor, label);
    if (stats) {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw extensionError(`${label} has a symbolic-link or non-directory parent`, 'UNSAFE_MANAGED_PATH');
      }
      continue;
    }
    try {
      mkdirSync(cursor);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const created = lstatOrNull(cursor, label);
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw extensionError(`${label} was replaced by an unsafe filesystem node`, 'UNSAFE_MANAGED_PATH');
    }
  }
  return target;
}

export function vldDir(projectDir) {
  return path.join(ensureProjectDir(projectDir), '.vld');
}

export function parseIdList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

export function extensionError(message, code = 'INVALID_EXTENSION') {
  const error = new Error(message);
  error.code = code;
  return error;
}
