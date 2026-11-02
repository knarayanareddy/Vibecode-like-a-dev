/**
 * Small, dependency-free helpers shared by VLD's optional platform extensions.
 *
 * These extensions deliberately sit outside the compiler's profile -> packet path.
 * Their state is explicit under `.vld/`, versioned, and hash-locked so a project can
 * tell whether a bundled module, adapter or workflow changed underneath it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  // Catalog metadata promises Git-blob-byte binding. Do not decode a Buffer to
  // UTF-8 first: distinct invalid byte sequences can decode to the same U+FFFD.
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return createHash('sha256').update(value).digest('hex');
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

/**
 * Canonicalize only the OS-selected temporary-directory anchor. On macOS `/var`
 * can be a system alias for `/private/var`; callers still validate every requested
 * descendant with lstat, so this never treats a caller-created link as trusted.
 */
export function canonicalTemporaryPath(value) {
  let resolved = path.resolve(value);
  const temporary = path.resolve(os.tmpdir());
  if (containedPath(temporary, resolved)) {
    try { resolved = path.resolve(realpathSync(temporary), path.relative(temporary, resolved)); } catch {}
  }
  return resolved;
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
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(lexicalRoot, relative);
  if (typeof relative !== 'string' || !relative || !containedPath(lexicalRoot, lexicalCandidate) || lexicalCandidate === lexicalRoot) {
    throw extensionError(`${label} escapes its managed root`, 'UNSAFE_MANAGED_PATH');
  }
  const resolvedRoot = canonicalTemporaryPath(lexicalRoot);
  const candidate = canonicalTemporaryPath(lexicalCandidate);
  if (!containedPath(resolvedRoot, candidate) || candidate === resolvedRoot) {
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
  return lexicalCandidate;
}

/** Create a managed directory one component at a time without traversing links. */
export function ensureSafeManagedDirectory(root, relative, label = 'managed directory') {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, relative);
  if (typeof relative !== 'string' || !containedPath(lexicalRoot, lexicalTarget)) {
    throw extensionError(`${label} escapes its managed root`, 'UNSAFE_MANAGED_PATH');
  }
  const resolvedRoot = canonicalTemporaryPath(lexicalRoot);
  const target = canonicalTemporaryPath(lexicalTarget);
  if (!containedPath(resolvedRoot, target)) {
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
  return lexicalTarget;
}

/**
 * Resolve a managed directory without creating it. Existing components,
 * including the final destination, must be real directories rather than links.
 * This is used before directory promotion/backup operations where a final
 * symlink must never be treated as an ordinary cache directory.
 */
export function safeManagedDirectory(root, relative = '', label = 'managed directory') {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(lexicalRoot, relative);
  if (typeof relative !== 'string' || !containedPath(lexicalRoot, lexicalTarget)) {
    throw extensionError(`${label} escapes its managed root`, 'UNSAFE_MANAGED_PATH');
  }
  const resolvedRoot = canonicalTemporaryPath(lexicalRoot);
  const target = canonicalTemporaryPath(lexicalTarget);
  if (!containedPath(resolvedRoot, target)) {
    throw extensionError(`${label} escapes its managed root`, 'UNSAFE_MANAGED_PATH');
  }
  realDirectory(resolvedRoot, 'managed root');
  let cursor = resolvedRoot;
  for (const part of path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stats = lstatOrNull(cursor, label);
    // A missing directory ends the walk: no descendant can exist below it.
    if (!stats) break;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw extensionError(`${label} has a symbolic-link or non-directory component`, 'UNSAFE_MANAGED_PATH');
    }
  }
  return lexicalTarget;
}

/**
 * Atomically replace a managed regular file without ever following an existing
 * final symlink. Parents are created/checked one component at a time, and the
 * temporary sibling is renamed into place only after its complete content exists.
 */
export function writeManagedFileAtomic(root, relative, content, { overwrite = true, mode = 0o600, label = 'managed file' } = {}) {
  const parent = path.dirname(relative);
  ensureSafeManagedDirectory(root, parent === '.' ? '' : parent, `${label} parent`);
  const target = safeManagedFile(root, relative, label);
  if (!overwrite) {
    if (existsSync(target)) throw extensionError(`${label} already exists`, 'MANAGED_FILE_EXISTS');
    // There is no portable rename-no-replace primitive in Node. O_EXCL gives the
    // non-destructive mode its required race resistance and refuses a final link
    // inserted after the lstat above. Atomic replacement is used for overwrites.
    try {
      writeFileSync(target, content, { encoding: 'utf8', flag: 'wx', mode });
    } catch (error) {
      if (error?.code === 'EEXIST') throw extensionError(`${label} already exists`, 'MANAGED_FILE_EXISTS');
      throw error;
    }
    return target;
  }
  const temporaryRelative = path.join(parent === '.' ? '' : parent, `.${path.basename(relative)}.${process.pid}.${randomUUID()}.tmp`);
  const temporary = safeManagedFile(root, temporaryRelative, `${label} temporary`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    // `rename` replaces a final link rather than dereferencing it. Parent links
    // were rejected above; a final replacement is therefore contained in root.
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

/** Serialize JSON through the same checked final-destination write path. */
export function writeManagedJsonAtomic(root, relative, value, options = {}) {
  return writeManagedFileAtomic(root, relative, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Safely write an explicitly requested absolute/relative output path. The
 * filesystem root is the containment anchor so every existing component is
 * inspected and any missing parent is created without traversing a link.
 */
export function writeAbsoluteManagedFileAtomic(file, content, options = {}) {
  const target = path.resolve(file);
  const root = path.parse(target).root;
  return writeManagedFileAtomic(root, path.relative(root, target), content, options);
}

export function vldDir(projectDir) {
  return path.join(ensureProjectDir(projectDir), '.vld');
}

export function parseIdList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

/**
 * Bound diagnostics from a subprocess or remote transport before they can cross a
 * normal user-facing boundary. Keep the class in normal output; only `--debug`
 * may display this scrubbed detail. This is a redactor, not an authority claim.
 */
export function safeExternalDiagnostic(error, { maxBytes = 500 } = {}) {
  const raw = String(error?.stderr || error?.message || error || 'unknown external failure');
  return raw
    .replace(/[\r\n\0]+/g, ' ')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1')
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_\-]+\b/g, '[REDACTED]')
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(?:[A-Z]:\\|\/)(?:[^\s:'"\\]+[\\/])*[^\s:'"\\]*/g, '<path>')
    .trim()
    .slice(0, maxBytes);
}

/** Attach bounded redacted detail for an explicit local CLI --debug request. */
export function externalOperationError(operation, error, code = 'EXTERNAL_OPERATION_FAILED') {
  const wrapped = extensionError(`${operation} failed; re-run with --debug for bounded redacted detail`, code);
  wrapped.debug = safeExternalDiagnostic(error);
  return wrapped;
}

export function extensionError(message, code = 'INVALID_EXTENSION') {
  const error = new Error(message);
  error.code = code;
  return error;
}
