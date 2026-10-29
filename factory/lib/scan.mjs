/**
 * Repository scanning helpers.
 *
 * Adoption has to run on real repositories, including large ones, without
 * becoming slow or surprising. So scanning is bounded, ignores the usual
 * noise, and records every observation with the file that produced it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo',
  '.cache', '.parcel-cache', 'Pods', '.gradle', '.idea', '.vscode'
]);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|ex|exs|swift|dart|sql|vue|svelte)$/;

export function readText(file, limit = 200_000) {
  try {
    const stats = statSync(file);
    if (stats.size > limit) return readFileSync(file, 'utf8').slice(0, limit);
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Walk a repository once.
 * Returns names (for presence checks) and source files (for bounded content scans).
 */
export function scanRepo(root, { maxFiles = 20_000, maxSourceFiles = 600 } = {}) {
  const files = [];
  const dirs = new Set();
  let truncated = false;

  const walk = (dir) => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.add(path.relative(root, full).split(path.sep).join('/'));
        walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };

  walk(root);

  const all = new Set(files);
  const dirSet = dirs;
  const sourceFiles = files.filter((file) => SOURCE_FILE.test(file));
  const contentSample = sourceFiles.slice(0, maxSourceFiles);

  return {
    root,
    files: all,
    dirs: dirSet,
    sourceFiles,
    contentSample,
    truncated,
    has: (relativePath) => all.has(relativePath),
    hasDir: (relativeDir) => dirSet.has(relativeDir) || [...dirSet].some((dir) => dir.startsWith(`${relativeDir}/`)),
    filesMatching: (pattern) => files.filter((file) => pattern.test(file)),
    contents: (relativePath) => readText(path.join(root, relativePath))
  };
}

/** Read a JSON file from the scan root, or null. */
export function readJsonFile(scan, relativePath) {
  if (!scan.has(relativePath)) return null;
  try {
    return JSON.parse(scan.contents(relativePath));
  } catch {
    return null;
  }
}
