#!/usr/bin/env node
/**
 * spec-check.mjs — dependency-free spec drift guard.
 *
 * Generated into every specification packet by vibecode-like-a-dev.
 * Commit it with the spec and run it in CI.
 *
 *   node specs/spec-check.mjs              # check, pending requirements are notices
 *   node specs/spec-check.mjs --repo .     # scan this repository for @req anchors
 *   node specs/spec-check.mjs --local      # name the lenient mode explicitly
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
// BLK-2 step 1 of the review: the safe path should be the default and the lenient
// one should be chosen. The checker cannot make itself strict by default without
// breaking every team mid-adoption, so what it can do is refuse to be quiet: when
// neither flag is passed it says, once, that this is the lenient mode and how to
// get the strict one. `--local` names that choice explicitly.
const LOCAL = flag('--local');
if (LOCAL && (STRICT || REQUIRE_ASSERTIONS)) {
  console.error('\n✗ --local cannot be combined with --strict or --require-assertions: pick one mode.\n');
  process.exit(2);
}
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
//
// This used to be one regex per call style, and every style it did not name was a
// hole: `assert.equal(1, 1)` — the exact idiom this repository's own tests use —
// passed, because the pattern matched `assert(...)` and never `assert.<method>(`.
// The check is now structural: read the argument list, and call it vacuous when
// every argument is a literal, or when it compares a name against itself. That
// covers node:assert, chai, assert.* and expect().<matcher> in one rule.
const LITERAL_ONLY = /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|['"`][^'"`]*['"`])$/;

/** The text between the parenthesis at openIndex and its match, quote-aware. */
function balancedArguments(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const character = text[i];
    if (quote) {
      if (character === '\\') i += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** Split an argument list on top-level commas, ignoring commas inside literals. */
function splitArguments(argumentText) {
  const args = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < argumentText.length; i += 1) {
    const character = argumentText[i];
    if (quote) {
      current += character;
      if (character === '\\') {
        current += argumentText[i + 1] ?? '';
        i += 1;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

const ASSERTION_CALL =
  /\b(?:assert(?:\.(?:ok|equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|isTrue|isFalse|isOk))?|assertEqual|assertStrictEqual|assertDeepEqual)\s*\(/g;
const EXPECT_CALL = /\bexpect\s*\(/g;
const MATCHER_CALL = /\.\s*(?:toBe|toEqual|toStrictEqual|toMatch|toBeDefined|toBeTruthy)\s*\(/;

/**
 * Assertions that cannot fail, with a snippet naming the call.
 *
 * Heuristic, and labelled as one: a literal argument is a strong signal, not a
 * proof, and an assertion built from a constant is a defect in the test rather
 * than in the product.
 */
function vacuousAssertions(source) {
  const found = [];
  for (const match of source.matchAll(ASSERTION_CALL)) {
    const openIndex = match.index + match[0].length - 1;
    const args = splitArguments(balancedArguments(source, openIndex) ?? '');
    if (args.length === 0) continue;
    const allLiteral = args.every((argument) => LITERAL_ONLY.test(argument));
    const selfCompare = args.length === 2 && args[0] === args[1] && /^[\w.$]+$/.test(args[0]);
    if (allLiteral || selfCompare) found.push(match[0].replace(/\s*\($/, '') + `(${args.join(', ')})`);
  }
  for (const match of source.matchAll(EXPECT_CALL)) {
    const openIndex = match.index + match[0].length - 1;
    const received = splitArguments(balancedArguments(source, openIndex) ?? '');
    const afterIndex = openIndex + (balancedArguments(source, openIndex) ?? '').length + 2;
    const tail = source.slice(afterIndex, afterIndex + 120);
    const matcher = MATCHER_CALL.exec(tail);
    if (!matcher) continue;
    const matcherArgs = splitArguments(balancedArguments(tail, matcher.index + matcher[0].length - 1) ?? '');
    if (received.length !== 1) continue;
    const bothLiteral = LITERAL_ONLY.test(received[0]) && matcherArgs.length > 0 && matcherArgs.every((argument) => LITERAL_ONLY.test(argument));
    const selfCompare = matcherArgs.length === 1 && matcherArgs[0] === received[0] && /^[\w.$]+$/.test(received[0]);
    // `toBeDefined()` takes no argument and is not vacuous by itself; it is only a
    // weak assertion, which this rule does not try to grade.
    if (bothLiteral || selfCompare) found.push(`expect(${received[0]})${matcher[0].trim()}(${matcherArgs.join(', ')})`);
  }
  return [...new Set(found)];
}
// A test file that reaches nothing outside itself cannot be testing the product.
// The signal has to cover every ecosystem the checker accepts: JS/TS imports and
// requires, Python `from x import`, Rust `use`, Go *and* Java/C# `import`, and PHP
// `use`. A Go test in the same package legitimately has no import line at all, so a
// package clause counts as reaching the module under test rather than as a miss.
// Test infrastructure is not the product. `import { test } from 'node:test'`
// satisfied the old signal, so the "imports nothing" rule never fired for any file
// that looked like a real test.
// No trailing \\b: `node:assert/strict` continues with `/`, which is not a word
// character, so a word boundary never matched there.
const TEST_INFRASTRUCTURE =
  /^(?:node:(?:test|assert)(?:\/|$)|(?:@jest\/globals|vitest|jest|mocha|chai|ava|tap|uvu|sinon|@testing-library\/[\w-]+|supertest|pytest|unittest|hypothesis)(?:\/|$))/;
const IMPORT_SPECIFIER = /(?:^\s*import\s[^'"]*?from\s+|require\s*\(\s*|^\s*from\s+|^\s*import\s+)['"]([^'"]+)['"]/gm;

/**
 * Does this file import anything that is not test tooling?
 *
 * A relative or aliased import reaches the product by definition. A bare package
 * counts unless it is a test framework, so a test that imports only `node:test`
 * and `node:assert` is still "imports nothing" — which is the truth the rule is
 * trying to express.
 */
function reachesProduct(source) {
  // A Go test lives in the same package as the code under test and legitimately has
  // no import line at all. The package clause is the declaration that this file
  // belongs to the product's own module, so it counts as reaching it.
  if (/^\s*package\s+\w+/m.test(source)) return true;
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('/')) return true;
    if (!TEST_INFRASTRUCTURE.test(specifier)) return true;
  }
  return false;
}

/**
 * Which anchored requirements in one test file are *not* proven by their own test.
 *
 * `ASSERTION_SIGNAL.test(source)` answers "does this file contain an assertion",
 * which is satisfied by a single real test anywhere in it. An agent can then add
 * empty-bodied tests, one per requirement, and every one of them reads as proven
 * because a neighbour asserted something. The signal has to be per requirement.
 *
 * A requirement is proven when an assertion appears in the test that carries its
 * anchor, measured as the span from the anchor to the end of that test:
 *
 *   - JS/TS arrow or function tests: from the anchor to the closing of the block
 *     whose brace depth first returns to zero.
 *   - Python: from the anchor to the next line at the same or lower indent.
 *   - Anything else (Go, Java, Rust, Ruby): a fixed window of following lines.
 *
 * Files whose anchors are not individually provable are not "hollow" by default:
 * a single test may legitimately carry several anchors, and the assertions after
 * the first one cover all of them. So the fallback is the file-level signal —
 * this narrows a false pass, it does not invent a failure.
 */
const ASSERTION_FREE_WINDOW = 40;

function scopedAssertionFor(source, anchorIndex) {
  const lines = source.split('\n');
  const anchor = lines[anchorIndex];
  const first = (anchor ?? '').trim();
  // A comment holding the anchor for a test that follows on later lines: start the
  // search there. An anchor inside code (an array of ids) starts at its own line.
  let start = anchorIndex;
  const window = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < Math.min(lines.length, start + ASSERTION_FREE_WINDOW); i += 1) {
    const line = lines[i];
    window.push(line);
    for (const character of line) {
      if (character === '{') {
        depth += 1;
        opened = true;
      } else if (character === '}') {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) break;
  }
  const text = window.join('\n');
  if (ASSERTION_SIGNAL.test(text)) return true;

  // Python: a def body ends at the next line indented no deeper than the `def`.
  const pyAnchor = lines.slice(anchorIndex, Math.min(lines.length, anchorIndex + 3)).findIndex((line) => /^\s*def\s+\w+\s*\(/.test(line));
  if (pyAnchor !== -1) {
    const defIndex = anchorIndex + pyAnchor;
    const indent = lines[defIndex].match(/^\s*/)[0].length;
    const body = [lines[defIndex]];
    for (let i = defIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() !== '' && line.match(/^\s*/)[0].length <= indent) break;
      body.push(line);
    }
    return ASSERTION_SIGNAL.test(body.join('\n'));
  }
  return false;
}

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
  // Requirements whose own anchored test carries no assertion (BLKR-04).
  const unprovenIds = new Set();
  const sourceLines = source.split('\n');
  for (const [lineIndex, line] of sourceLines.entries()) {
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
      // Remember the line so the assertion can be scoped to *this* anchor's test
      // rather than to the file as a whole.
      if (isTest && !scopedAssertionFor(source, lineIndex)) unprovenIds.add(id);
      if (!anchored.has(id)) anchored.set(id, []);
      anchored.get(id).push({ file: rel(file), isTest });
    }
  }
  if (isTest && fileReqIds.length > 0) {
    const anchoredIds = [...new Set(fileReqIds)].join(', ');
    const problems = [];

    // File-level first (unchanged for files whose anchors cannot be scoped), then
    // per requirement. A single asserted test must not vouch for a neighbour that
    // asserts nothing, which is the false pass this used to allow.
    if (!ASSERTION_SIGNAL.test(source)) {
      problems.push('no visible assertion');
    } else if (unprovenIds.size === fileReqIds.length) {
      problems.push('no visible assertion');
    } else if (unprovenIds.size > 0) {
      problems.push(`no visible assertion in the anchored test for ${[...unprovenIds].join(', ')}`);
    }
    // A skipped or disabled test cannot prove anything, so an anchor in one is a
    // claim about a test that will not run.
    if (SKIP_SIGNAL.test(source)) {
      problems.push('a skipped, todo or disabled test carries the anchor');
    }
    // Name the call, not just the category: an agent that reads "compares two
    // literals" still has to find which line, and the line is the thing to fix.
    const vacuous = vacuousAssertions(source);
    if (vacuous.length > 0) {
      problems.push(`the assertion \`${vacuous[0]}\` cannot fail${vacuous.length > 1 ? ` (and ${vacuous.length - 1} more like it)` : ''}`);
    }
    if (EMPTY_BODY.test(source)) {
      problems.push('a test body is empty');
    }
    // The test must reach outside its own directory to be testing the product.
    const insideOnly = !reachesProduct(source);
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
        vacuous.length > 0 ||
        (claimed && !ASSERTION_SIGNAL.test(source));
      if (hard) errors.push(hollowMsg);
      else notices.push(`${hollowMsg} (pass --require-assertions to fail CI on hollow tests)`);
    }
  }
}

for (const stray of strayAnchors) errors.push(stray);

// 5. traceability ratchet
let pending = 0;
// Counted separately from errors: a run that proves nothing is not a failure in
// lenient mode, but calling it PASS is what makes a green log lie.
let proven = 0;
let automatedTotal = 0;
let anchoredAutomated = 0;
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

  automatedTotal += 1;
  // "Proven" means the requirement is *claimed* done and a test carries its anchor.
  // A requirement that is anchored but still `todo` is work in progress, not
  // evidence, which is why --strict fails on it.
  if (status === 'done' && inTests.length > 0) proven += 1;
  // Anchored requirements count separately: they are the machine-checkable part of
  // the packet, and a packet can be entirely anchored while still unclaimed.
  if (inTests.length > 0) anchoredAutomated += 1;

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
// Lenient is the absence of both flags, so it is reported as a mode rather than
// left implicit: a green run that proves nothing is the complaint this fix answers.
if (!STRICT && !REQUIRE_ASSERTIONS) {
  console.log(
    `\n· lenient mode (${LOCAL ? '--local' : 'no flags'}): pending requirements and hollow tests are notices. CI should run --strict --require-assertions.`
  );
}
// Three outcomes, not two. "PASS" on a packet where no requirement is proven is
// the one word a reader skims and a CI log keeps, so it gets its own verdict.
// A packet with no anchored requirements at all has no evidence. One that is fully
// anchored but not yet claimed `done` is a different state: the tests exist, the
// claim does not, and saying "nothing is proven" there would be false.
const noEvidence = automatedTotal > 0 && anchoredAutomated === 0;
const unproven = !failed && noEvidence;
const verdict = failed ? 'FAIL' : unproven ? 'NOT VERIFIED' : 'PASS';
console.log(
  `\n${verdict} · ${errors.length} error(s) · ${pending} pending · ${proven} of ${automatedTotal} automated requirement(s) proven` +
    (proven === 0 && anchoredAutomated > 0 ? `, ${anchoredAutomated} more anchored but not marked done` : '') +
    (suppressed > 0 ? ` · ${suppressed} ignored` : '') +
    (unproven ? ' — no test carries an anchor yet, so this run is not evidence' : '') +
    (notices.length && !failed && !unproven ? ' (pending is expected before implementation; use --strict in release CI)' : '') +
    '\n'
);

process.exit(failed ? 1 : 0);
