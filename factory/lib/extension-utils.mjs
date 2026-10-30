/**
 * Small, dependency-free helpers shared by VLD's optional platform extensions.
 *
 * These extensions deliberately sit outside the compiler's profile -> packet path.
 * Their state is explicit under `.vld/`, versioned, and hash-locked so a project can
 * tell whether a bundled module, adapter or workflow changed underneath it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
