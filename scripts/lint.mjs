#!/usr/bin/env node
/**
 * Dependency-free lint.
 *
 * The gate `G0-CHECK` asks that a lint or typecheck step runs on every pull request.
 * A repository this small does not need ESLint, but "no lint at all" is how a syntax
 * error and a stray `debugger` reach main. So: parse every module, validate every
 * shipped JSON, and refuse committed debris.
 *
 *   node scripts/lint.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'specs']);
const problems = [];
let modules = 0;
let json = 0;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');

  if (/\.(mjs|cjs|js)$/.test(file)) {
    modules += 1;
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      problems.push(`${rel}: does not parse\n${String(error.stderr ?? error.message).trim()}`);
    }
    const text = readFileSync(file, 'utf8');
    if (/^\s*debugger;?\s*$/m.test(text)) problems.push(`${rel}: committed debugger statement`);
    if (/\b(?:describe|it|test)\.only\(/.test(text)) problems.push(`${rel}: focused test (.only) would skip the rest of the suite`);
    if (/console\.log\(.*(?:TODO|FIXME)/.test(text)) problems.push(`${rel}: debug log left behind`);
    continue;
  }

  if (file.endsWith('.json')) {
    json += 1;
    try {
      JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${rel}: invalid JSON (${error.message})`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`\nFAIL · ${problems.length} problem(s) in ${modules} modules and ${json} JSON files\n`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${modules} modules parse, ${json} JSON files valid, no committed debris`);
}
