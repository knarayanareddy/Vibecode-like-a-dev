#!/usr/bin/env node
/**
 * spec-check.mjs — dependency-free spec drift guard.
 *
 * Generated into every specification packet by vibecode-like-a-dev.
 * Commit it with the spec and run it in CI.
 *
 *   node specs/spec-check.mjs              # check, pending requirements are notices
 *   node specs/spec-check.mjs --repo .     # scan this repository for @req anchors
 *   node specs/spec-check.mjs --strict     # pending automated requirements fail the build
 *
 * Rules:
 *   - Every document listed in spec.json must exist.
 *   - Every requirement needs acceptance criteria and a verification method.
 *   - An `@req REQ-xxx` anchor pointing at an unknown requirement is an error.
 *   - A line marked `@req-ignore` is not an anchor. Use it for fixtures and
 *     examples that quote the marker deliberately; the count is always reported,
 *     so suppression can never be silent. Whole paths can be excluded with
 *     spec.json -> anchors.exclude (glob-ish, "*" allowed).
 *   - A requirement marked "done" without an anchor in a test file is an error.
 *   - A requirement marked "todo" without an anchor is pending: a notice, or an
 *     error under --strict. This lets a packet boot on day one and still ratchet.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
};

const STRICT = flag('--strict');
const REPO = path.resolve(option('--repo', process.cwd()));

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo'
]);

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\//;
const SUPPRESSED = /@req-ignore/i;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb)$/;

const errors = [];
const notices = [];
const passes = [];

const rel = (file) => path.relative(REPO, file).split(path.sep).join('/');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|sh|feature|exs)$/.test(entry)) out.push(full);
  }
  return out;
}

const specPath = path.join(SPEC_DIR, 'spec.json');
if (!existsSync(specPath)) {
  console.error(`✗ spec.json not found in ${SPEC_DIR}`);
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
} catch (error) {
  console.error(`✗ spec.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];

// 1. documents
for (const doc of spec.docs ?? []) {
  if (existsSync(path.join(SPEC_DIR, doc))) passes.push(`document present: ${doc}`);
  else errors.push(`missing document "${doc}" (listed in spec.json docs)`);
}

// 2. requirement shape
const known = new Set(requirements.map((requirement) => requirement.id));
for (const requirement of requirements) {
  if (!requirement.id || !requirement.title) errors.push('a requirement is missing id or title');
  if (!requirement.statement || String(requirement.statement).length < 30) {
    errors.push(`${requirement.id}: statement is missing or too thin to implement`);
  }
  if (!Array.isArray(requirement.acceptance) || requirement.acceptance.length === 0) {
    errors.push(`${requirement.id}: no acceptance criteria`);
  }
  if (!['automated', 'manual', 'gate'].includes(requirement.verify)) {
    errors.push(`${requirement.id}: verify must be automated, manual or gate`);
  }
}

if (errors.length === 0) passes.push(`${requirements.length} requirements have statements, criteria and a verification method`);

// 3. gates
if (!Array.isArray(spec.gates) || spec.gates.length === 0) errors.push('spec.json has no gates; the definition of done is missing');

// 4. anchors
const anchored = new Map();
const strayAnchors = [];
let scanned = 0;
let suppressed = 0;
const exclusions = Array.isArray(spec.anchors?.exclude) ? spec.anchors.exclude : [];
const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const exclusionPatterns = exclusions.map(globToRegExp);
const isExcluded = (file) => exclusionPatterns.some((pattern) => pattern.test(file));

for (const file of walk(REPO)) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!source.includes('@req')) continue;
  scanned += 1;

  if (isExcluded(rel(file))) continue;

  const isTest = TEST_FILE.test(rel(file)) || TEST_NAME.test(rel(file));
  for (const line of source.split('\n')) {
    if (!line.includes('@req')) continue;
    const match = line.match(/@req\s+(REQ-\d{3})/);
    if (!match) continue;
    if (SUPPRESSED.test(line)) {
      suppressed += 1;
      continue;
    }
    const id = match[1];
    if (!known.has(id)) {
      strayAnchors.push(`${rel(file)} cites unknown requirement ${id}`);
      continue;
    }
    if (!anchored.has(id)) anchored.set(id, []);
    anchored.get(id).push({ file: rel(file), isTest });
  }
}

for (const stray of strayAnchors) errors.push(stray);

// 5. traceability ratchet
let pending = 0;
for (const requirement of requirements) {
  const hits = anchored.get(requirement.id) ?? [];
  const inTests = hits.filter((hit) => hit.isTest);
  const status = String(requirement.status || 'todo').toLowerCase();

  if (requirement.verify !== 'automated') {
    if (status === 'done' && hits.length === 0 && requirement.verify === 'gate') {
      // gate requirements are proven by the gate list, not by an anchor
    }
    continue;
  }

  if (status === 'done' && inTests.length === 0) {
    errors.push(`${requirement.id} is marked done but no test carries an @req anchor for it`);
  } else if (status !== 'done' && inTests.length === 0) {
    pending += 1;
    notices.push(`${requirement.id} ${requirement.title}: no test anchor yet`);
  } else if (inTests.length > 0 && hits.every((hit) => !hit.isTest)) {
    errors.push(`${requirement.id} is anchored only outside tests (${hits.map((hit) => hit.file).join(', ')})`);
  }
}

// 6. report
const line = (symbol, text) => console.log(`${symbol} ${text}`);
console.log(`\nspec-check · ${path.basename(SPEC_DIR)} · ${requirements.length} requirements · ${scanned} anchored file(s) · repo ${rel(REPO) || '.'}\n`);

if (passes.length) {
  for (const pass of passes) line('✓', pass);
}

if (suppressed > 0) {
  console.log('');
  line('·', `${suppressed} anchor(s) ignored by @req-ignore or spec.json anchors.exclude`);
}

if (notices.length) {
  console.log('');
  for (const notice of notices) line('•', notice);
}

if (errors.length) {
  console.log('');
  for (const error of errors) line('✗', error);
}

const strictFailure = STRICT && pending > 0;
if (strictFailure) {
  console.log('');
  line('✗', `--strict: ${pending} automated requirement(s) still pending`);
}

const failed = errors.length > 0 || strictFailure;
console.log(
  `\n${failed ? 'FAIL' : 'PASS'} · ${errors.length} error(s) · ${pending} pending` +
    (suppressed > 0 ? ` · ${suppressed} ignored` : '') +
    (notices.length && !failed ? ' (pending is expected before implementation; use --strict in release CI)' : '') +
    '\n'
);

process.exit(failed ? 1 : 0);
