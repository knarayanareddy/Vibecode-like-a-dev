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
 *   node specs/spec-check.mjs --require-assertions
 *                                          # an anchored test must contain an assertion
 *                                          # that can fail; skipped, literal and empty
 *                                          # tests are rejected
 *   node specs/spec-check.mjs --report test-report.json
 *                                          # `done` means "a test naming this
 *                                          # requirement passed in this run"; reads
 *                                          # TAP, vitest/jest JSON and JUnit XML
 *
 * Rules:
 *   - Every document listed in spec.json must exist.
 *   - Every requirement needs acceptance criteria and a verification method.
 *   - Each `@req REQ-<three-or-more digits>` marker pointing at an unknown requirement is an error; repeat the marker to cite more than one requirement on a line.
 *   - A line marked `@req-ignore` is not an anchor. Use it for fixtures and
 *     examples that quote the marker deliberately; the count is always reported,
 *     so suppression can never be silent. Whole paths can be excluded with
 *     spec.json -> anchors.exclude (glob-ish, "*" allowed).
 *   - A requirement marked "done" without an anchor in a test file is an error.
 *   - An anchored test that is skipped, has an empty body, compares two literals, or
 *     imports nothing is reported; with --require-assertions it is an error. A
 *     skipped or literal test attached to a done requirement is always an error.
 *   - With --report, a done requirement whose named test did not pass is an error.
 *   - A requirement marked "todo" without an anchor is pending: a notice, or an
 *     error under --strict. This lets a packet boot on day one and still ratchet.
 */

import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
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
const REQUIRE_ASSERTIONS = flag('--require-assertions');
const REPO = path.resolve(option('--repo', process.cwd()));
// `status: done` in spec.json is a sentence someone typed. `--report` makes it a
// claim about a test run instead: the anchored test name must appear as passed in a
// machine-readable report (node:test TAP, vitest JSON or JUnit XML).
const REPORT = option('--report', null);

/**
 * Read what actually passed from a test report.
 *
 * Returns a Map of test name fragments that passed. The three formats are read
 * leniently because the point is "this named test passed in this run", not to
 * reimplement each runner. A file that cannot be parsed is an error, never a pass:
 * an unreadable report is the same as no report.
 */
function readPassedTests(file) {
  const text = readFileSync(file, 'utf8');
  const passed = new Set();
  const trim = (name) => String(name).trim().replace(/\s+/g, ' ');

  // JUnit XML: <testcase name="…" classname="…"> with or without a failure child.
  if (/<testsuite\b|<testcase\b/.test(text)) {
    for (const match of text.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = match[1];
      const body = match[2] ?? '';
      if (/<failure\b|<error\b|<skipped\b/.test(body)) continue;
      const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
      const className = /\bclassname\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
      if (name) passed.add(trim(name));
      if (className) passed.add(trim(`${className} ${name ?? ''}`));
    }
    return passed;
  }

  // JSON: vitest/jest `testResults[].assertionResults[]` or a flat array of tests.
  try {
    const json = JSON.parse(text);
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(collect);
      const name = node.fullName ?? node.title ?? node.name;
      const state = node.status ?? node.state ?? node.outcome;
      if (typeof name === 'string' && ['passed', 'pass', 'ok', 'success'].includes(String(state).toLowerCase())) {
        passed.add(trim(name));
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') collect(value);
    };
    collect(json);
    if (passed.size > 0) return passed;
  } catch {
    // not JSON; fall through to TAP
  }

  // TAP (node:test --test-reporter=tap): `ok 12 - suite › test name`
  for (const line of text.split('\n')) {
    const match = /^\s*ok\b\s*\d*\s*(?:-\s*)?(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].replace(/\s*#\s*(?:SKIP|TODO).*$/i, '').trim();
    if (name) passed.add(trim(name));
  }
  return passed;
}

let reportPassed = null;
if (REPORT) {
  try {
    reportPassed = readPassedTests(REPORT);
  } catch (error) {
    console.error(`\n✗ cannot read test report ${REPORT}: ${error.message}\n`);
    process.exit(2);
  }
  // An empty report is not an error here: it is evidence that nothing passed, and
  // each done requirement below then fails on its own line with its own id. Aborting
  // would hide which requirements are unproven.
  if (reportPassed.size === 0) {
    notices.push(`${REPORT} contains no passing test; every done requirement will be reported as unproven`);
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo'
]);

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\//;
const SUPPRESSED = /@req-ignore/i;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb|rs|exs)$|Tests?\.(java|kt|cs|php)$/;
const CLARIFY_MARKER = /\[(?:CLARIFY|NEEDS CLARIFICATION)(?::[^\]]*)?\]/i;
const ASSERTION_SIGNAL =
  /\b(?:assert[A-Za-z0-9_.]*|expect\s*\(|should\b|require\.[A-Z]\w*|t\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)|pytest\.raises|raises\s*\(|rejects\b|throws\b)\b|!==|===|!=|==|<=|>=/;

/**
 * Vacuity rules (BLK-2).
 *
 * A regex for "does the file contain the word expect(" is satisfied by
 * `expect(true).toBe(true)` and by a test that never runs. The drift guard's whole
 * promise is that a done requirement keeps a test that proves it, so the checker has
 * to reject the shapes that prove nothing:
 *
 *   - a test that is skipped, todo'd, x-prefixed or disabled,
 *   - a literal assertion (expect(true), assert True, toBe(3) on a literal),
 *   - an empty test body,
 *   - a test file that imports nothing from outside the test directory, which means
 *     it cannot be exercising the product.
 *
 * These are heuristics, and they are labelled as such in the output: they raise the
 * cost of lying, they do not make lying impossible.
 */
const SKIP_SIGNAL =
  /\b(?:test|it|describe)\.(?:skip|todo|only)\s*\(|\bx(?:it|describe|test)\s*\(|@(?:Disabled|Ignore)\b|\bpytest\.mark\.skip\b|\bt\.Skip(?:f|Now)?\s*\(/;
const EMPTY_BODY =
  /\b(?:test|it)\s*\(\s*(?:['"`][^'"`]*['"`]|\w+)\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}\s*\)|\b(?:test|it)\s*\([^)]*\bfunction\s*\([^)]*\)\s*\{\s*\}\s*\)|def\s+test_\w+\s*\([^)]*\):\s*(?:\n\s*(?:pass|\.\.\.)\s*)?$/m;
// A literal on both sides of an equality assertion: expect(true).toBe(true),
// assertEqual(1, 1), assert 1 == 1.
const LITERAL_PAIR =
  /\bexpect\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|['"`][^'"`]*['"`])\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual|toMatch)\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|['"`][^'"`]*['"`])\s*\)|\bassert(?:Equal|StrictEqual|Equals)?\s*\(\s*(?:true|false|-?\d+(?:\.\d+)?|['"`][^'"`]{0,40}['"`])\s*,\s*(?:true|false|-?\d+(?:\.\d+)?|['"`][^'"`]{0,40}['"`])\s*\)|\bassert\s+(?:True|1|\d+\s*==\s*\d+)\s*(?:$|\n)/m;
// A test file that reaches nothing outside itself cannot be testing the product.
// The signal has to cover every ecosystem the checker accepts: JS/TS imports and
// requires, Python `from x import`, Rust `use`, Go *and* Java/C# `import`, and PHP
// `use`. A Go test in the same package legitimately has no import line at all, so a
// package clause counts as reaching the module under test rather than as a miss.
const IMPORT_SIGNAL =
  /^\s*(?:import\s|const\s+\w+\s*=\s*require\(|from\s+\S+\s+import\s|use\s+\w+|#\[|package\s+\w+)/m;

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
      stats = lstatSync(full);
    } catch {
      continue;
    }
    // Never follow repository links: scans must neither escape their root nor loop.
    if (stats.isSymbolicLink()) continue;
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

// A requirement is one behaviour, with a precondition and a response a machine can
// separate. This mirrors factory/lib/ears.mjs; it is inlined so the guard stays
// dependency-free in the repository it is copied into. Returns null when valid.
const CLAUSE = /^(Where|While|When|If) (.+?)(, then|,)(?=\s*(?:(?:Where|While|When|If)\s|the\s))/i;
const CLAUSE_ORDER = { Where: 0, While: 1, When: 2, If: 3 };
const VAGUE_RESPONSE = ['appropriately', 'as needed', 'as appropriate', 'properly', 'user-friendly', 'robust', 'reasonable', 'etc.', 'and so on', 'try to', 'should', 'may ', 'might', 'could ', 'TBD'];

function earsError(statement) {
  const text = String(statement ?? '').replace(/\s+/g, ' ').trim();
  if (!text.endsWith('.')) return 'it must end with a full stop';
  const parts = text.slice(0, -1).split(' shall ');
  if (parts.length !== 2) return 'it needs exactly one "shall"';
  let rest = parts[0].trim();
  let last = -1;
  for (;;) {
    const match = rest.match(CLAUSE);
    if (!match) break;
    const type = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    if (CLAUSE_ORDER[type] <= last) return 'clauses must be ordered WHERE -> WHILE -> WHEN -> IF,THEN';
    const delim = match[3].toLowerCase();
    if (type === 'If' && delim !== ', then') return 'an "If" clause must be followed by ", then"';
    if (type !== 'If' && delim === ', then') return 'only an "If" clause takes ", then"';
    last = CLAUSE_ORDER[type];
    rest = rest.slice(match[0].length).trim();
  }
  if (!/^the [\w-]+(?: [\w-]+)*$/i.test(rest)) return 'it needs "the <system> shall ..." after the clauses';
  const response = parts[1].trim();
  if (response.length < 12) return 'the response is too short to implement';
  const lower = ` ${response.toLowerCase()} `;
  for (const word of VAGUE_RESPONSE) {
    if (lower.includes(` ${word}`) || lower.includes(`${word} `)) return `the response contains "${word.trim()}", which no test can check`;
  }
  return null;
}

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
  } else if (earsError(requirement.statement)) {
    // Same five shapes the compiler enforces (factory/lib/ears.mjs), inlined because
    // this file is generated into a repository that has no dependency on the tool.
    errors.push(
      `${requirement.id}: statement is not EARS-shaped (${earsError(requirement.statement)}). Use "The <system> shall ...", ` +
        `"When <trigger>, the <system> shall ...", "While <state>, ...", "If <condition>, then ..." or "Where <feature>, ..."`
    );
  }
  if (!Array.isArray(requirement.acceptance) || requirement.acceptance.length === 0) {
    errors.push(`${requirement.id}: no acceptance criteria`);
  }
  const fullReqText = `${requirement.statement ?? ''} ${(requirement.acceptance ?? []).map((a) => (typeof a === 'string' ? a : a?.text ?? '')).join(' ')}`;
  if (CLARIFY_MARKER.test(fullReqText)) {
    const msg = `${requirement.id}: contains unresolved [CLARIFY] marker`;
    if (STRICT) errors.push(msg);
    else notices.push(`${msg} (will fail under --strict)`);
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
const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`);
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
  const fileReqIds = [];
  for (const line of source.split('\n')) {
    if (!line.includes('@req')) continue;
    const matches = [...line.matchAll(/@req\s+(REQ-\d{3,})/g)];
    if (matches.length === 0) continue;
    if (SUPPRESSED.test(line)) {
      suppressed += matches.length;
      continue;
    }
    for (const match of matches) {
      const id = match[1];
      if (!known.has(id)) {
        strayAnchors.push(`${rel(file)} cites unknown requirement ${id}`);
        continue;
      }
      fileReqIds.push(id);
      if (!anchored.has(id)) anchored.set(id, []);
      anchored.get(id).push({ file: rel(file), isTest });
    }
  }
  if (isTest && fileReqIds.length > 0) {
    const anchoredIds = [...new Set(fileReqIds)].join(', ');
    const problems = [];

    if (!ASSERTION_SIGNAL.test(source)) {
      problems.push('no visible assertion');
    }
    // A skipped or disabled test cannot prove anything, so an anchor in one is a
    // claim about a test that will not run.
    if (SKIP_SIGNAL.test(source)) {
      problems.push('a skipped, todo or disabled test carries the anchor');
    }
    if (LITERAL_PAIR.test(source)) {
      problems.push('the assertion compares two literals, so it cannot fail');
    }
    if (EMPTY_BODY.test(source)) {
      problems.push('a test body is empty');
    }
    // The test must reach outside its own directory to be testing the product.
    const insideOnly = !IMPORT_SIGNAL.test(source);
    if (insideOnly) {
      problems.push('the file imports nothing, so it cannot exercise the product');
    }

    if (problems.length > 0) {
      const hollowMsg = `${rel(file)} carries @req anchor(s) (${anchoredIds}) but ${problems.join('; ')}`;
      // Vacuity that makes a shipped claim false is an error even without a flag:
      // a skipped or literal assertion attached to a *done* requirement is the exact
      // failure mode this guard exists to catch. Everything else stays a notice
      // unless --require-assertions is passed.
      const claimed = requirements.some(
        (requirement) => fileReqIds.includes(requirement.id) && String(requirement.status || '').toLowerCase() === 'done'
      );
      // Hard without a flag: a skipped or todo test claiming an anchor, and a literal
      // assertion. Both are a *false* claim — the anchor says this requirement is
      // proven and it demonstrably is not. Those are the two shapes BLK-2 names as
      // must-fail. An empty body and a missing import are weaker evidence of the same
      // problem, so they stay notices unless --require-assertions is passed (or the
      // requirement is claimed done AND the file has no assertion at all).
      const hard =
        REQUIRE_ASSERTIONS ||
        SKIP_SIGNAL.test(source) ||
        LITERAL_PAIR.test(source) ||
        (claimed && !ASSERTION_SIGNAL.test(source));
      if (hard) errors.push(hollowMsg);
      else notices.push(`${hollowMsg} (pass --require-assertions to fail CI on hollow tests)`);
    }
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

  // With a test report, "done" stops being a string somebody typed: the id must be
  // justified by a test that passed in the latest run. Names are matched by the
  // requirement id appearing in the report, which every runner preserves when a
  // project names a test after its requirement (`REQ-004 erases every row`).
  if (status === 'done' && reportPassed) {
    const justified = inTests.some((hit) => {
      for (const name of reportPassed) if (name.includes(requirement.id)) return true;
      return false;
    });
    if (!justified) {
      errors.push(
        `${requirement.id} is marked done, but no passing test in ${REPORT} names it. Either the test did not run, it failed, or the status is stale.`
      );
      continue;
    }
  }

  if (hits.length > 0 && inTests.length === 0) {
    errors.push(`${requirement.id} is anchored only outside tests (${hits.map((hit) => hit.file).join(', ')})`);
  } else if (status === 'done' && inTests.length === 0) {
    errors.push(`${requirement.id} is marked done but no test carries an @req anchor for it`);
  } else if (status !== 'done' && inTests.length === 0) {
    pending += 1;
    notices.push(`${requirement.id} ${requirement.title}: no test anchor yet`);
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
