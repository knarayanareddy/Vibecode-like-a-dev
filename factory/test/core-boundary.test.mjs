/**
 * BUG-9: the deterministic compiler and the agent runtime are one package with one
 * prefix, so a compiler user cannot tell that `vld runtime` starts unconfined
 * same-user processes.
 *
 * The audit's suggested fix is two published packages. That is a packaging release,
 * not a patch, and splitting the repository would break the import graph the other
 * 350 tests rely on. What can be pinned now is the property the split would protect:
 * the compiler must not depend on the runtime. If that ever becomes false, the
 * "deterministic core" claim is false too, and this test says so.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');

/** Modules that only exist to run agents, allocate worktrees or serve an API. */
const RUNTIME_MODULES = new Set([
  'runtime.mjs',
  'runtime-agent.mjs',
  'runtime-delivery.mjs',
  'runtime-forge.mjs',
  'runtime-server.mjs',
  'workspaces.mjs',
  'missions.mjs',
  'forge-plan.mjs'
]);

/** Modules that must stay usable with no process, worktree or network authority. */
const CORE_MODULES = new Set([
  'planner.mjs',
  'verify.mjs',
  'emit/index.mjs',
  'emit/docs.mjs',
  'emit/derive.mjs',
  'emit/vocabulary.mjs',
  'profile.mjs',
  'indexer.mjs',
  'predicate.mjs',
  'enforcement.mjs'
]);

function importsOf(file) {
  const target = path.join(LIB, file);
  if (!existsSync(target)) return [];
  const source = readFileSync(target, 'utf8');
  const found = [];
  for (const match of source.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    found.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
  for (const match of source.matchAll(/import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    found.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
  return found;
}

/** Transitively resolve what a module pulls in, inside lib/. */
function closure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dependency of importsOf(file)) {
      if (!seen.has(dependency)) queue.push(dependency);
    }
  }
  return seen;
}

test('no compiler module reaches a runtime module, directly or transitively', () => {
  for (const entry of CORE_MODULES) {
    const reached = [...closure(entry)].filter((file) => RUNTIME_MODULES.has(file));
    assert.deepEqual(reached, [], `${entry} must not depend on the runtime, found: ${reached.join(', ')}`);
  }
});

test('the runtime never claims to be part of the deterministic core', () => {
  for (const file of RUNTIME_MODULES) {
    const source = readFileSync(path.join(LIB, file), 'utf8');
    assert.doesNotMatch(
      source,
      /deterministic core/i,
      `${file} must not describe itself as the deterministic core`
    );
  }
});

test('every runtime command is reachable only through a documented, labelled surface', () => {
  const cli = readFileSync(path.resolve(HERE, '..', 'cli.mjs'), 'utf8');
  // The set the CLI treats as experimental must cover every runtime module family,
  // and both spellings must stay supported (see docs/EXPERIMENTAL.md).
  const block = cli.match(/const EXPERIMENTAL = new Set\(\[([^\]]+)\]\)/);
  assert.ok(block, 'cli.mjs declares the experimental command set');
  const declared = block[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const command of ['runtime', 'workspace', 'mission', 'workflow', 'agent', 'studio']) {
    assert.ok(declared.includes(command), `"${command}" must be declared experimental`);
  }
  assert.match(cli, /vld experimental/, 'the documented spelling exists');
  assert.match(cli, /experimental runtime, not the compiler/, 'the bare spelling labels itself');
});

test('the experimental document states the unconfined-process limit', () => {
  const doc = readFileSync(path.resolve(HERE, '..', '..', 'docs', 'EXPERIMENTAL.md'), 'utf8');
  assert.match(doc, /unconfined same-user host processes/);
  assert.match(doc, /does \*\*not\*\*|do \*\*not\*\*|not a sandbox/i);
});

test('the runtime modules are the size the split is meant to separate', () => {
  // Not a style rule: it is the reminder that this is a lot of code behind a
  // promise it does not make. If the split lands, this test should be deleted.
  const total = readdirSync(LIB)
    .filter((file) => RUNTIME_MODULES.has(file))
    .reduce((sum, file) => sum + readFileSync(path.join(LIB, file), 'utf8').split('\n').length, 0);
  assert.ok(total > 3000, `runtime is ${total} lines; the documented boundary assumed a large body of code`);
});
