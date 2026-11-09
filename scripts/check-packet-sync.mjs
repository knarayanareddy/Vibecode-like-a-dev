#!/usr/bin/env node
/**
 * Regenerate committed packets into a temporary directory and compare every
 * regular file recursively. This is the one packet-sync authority used locally
 * and in CI; nested enforcement assets are as reviewable as top-level Markdown.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const PAIRS = {
  self: { profile: 'profile.json', packet: 'specs' },
  example: { profile: 'examples/retro-board/profile.json', packet: 'examples/retro-board/spec' }
};

function regularFiles(root, prefix = '') {
  const out = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(root, entry.name);
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) throw new Error(`packet contains symbolic link: ${rel}`);
    if (stats.isDirectory()) for (const [nested, bytes] of regularFiles(file, rel)) out.set(nested, bytes);
    else if (stats.isFile()) out.set(rel, readFileSync(file));
  }
  return out;
}

export function comparePacketTrees(generated, committed) {
  const expected = regularFiles(generated); const actual = regularFiles(committed);
  const names = new Set([...expected.keys(), ...actual.keys()]);
  const differences = [];
  for (const name of [...names].sort()) {
    if (!expected.has(name)) differences.push(`${name}: unexpected committed file`);
    else if (!actual.has(name)) differences.push(`${name}: missing committed file`);
    else if (!expected.get(name).equals(actual.get(name))) differences.push(`${name}: content differs`);
  }
  return differences;
}

export function assertPacketSync({ profile, packet, root = ROOT }) {
  // A packet names the directory it lives in (BUG-5), so the generated text
  // depends on the output path. Compile into a throwaway root at the *same*
  // relative destination, otherwise the committed packet can never match: it
  // embeds `specs/...` while the temp compile embedded `/tmp/...`.
  const staging = mkdtempSync(path.join(os.tmpdir(), 'vld-packet-sync-'));
  const destination = path.join(staging, packet);
  mkdirSync(destination, { recursive: true });
  try {
    execFileSync(process.execPath, [path.join(root, 'factory', 'cli.mjs'), 'compile', profile, '-o', destination, '--packet-dir', packet, '--force'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const differences = comparePacketTrees(destination, path.resolve(root, packet));
    return { profile, packet, differences };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv.includes('--self') ? ['self'] : process.argv.includes('--example') ? ['example'] : Object.keys(PAIRS);
  let failed = false;
  for (const name of selected) {
    const result = assertPacketSync(PAIRS[name]);
    if (result.differences.length) {
      failed = true;
      console.error(`✗ ${result.packet} is stale; regenerate from ${result.profile}:`);
      for (const detail of result.differences) console.error(`  - ${detail}`);
    } else console.log(`✓ ${result.packet} is recursively in sync with ${result.profile}`);
  }
  process.exitCode = failed ? 1 : 0;
}
