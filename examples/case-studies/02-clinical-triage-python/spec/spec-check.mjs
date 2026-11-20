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
 *   - Each `@req REQ-<id>` marker (`REQ-001` or custom `REQ-C01`) pointing at an unknown requirement is an error; repeat the marker to cite more than one requirement on a line.
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
const REQUIRE_REPORT = flag('--require-report');
const JSON_OUT = flag('--json');
// BLK-2 step 1 of the review: the safe path should be the default and the lenient
// one should be chosen. The checker cannot make itself strict by default without
// breaking every team mid-adoption, so what it can do is refuse to be quiet: when
// neither flag is passed it says, once, that this is the lenient mode and how to
// get the strict one. `--local` names that choice explicitly.
const LOCAL = flag('--local');
if (LOCAL && (STRICT || REQUIRE_ASSERTIONS || REQUIRE_REPORT)) {
  console.error('\n✗ --local cannot be combined with --strict, --require-assertions or --require-report: pick one mode.\n');
  process.exit(2);
}
function defaultRepoRoot(packetDir) {
  const cwd = path.resolve(process.cwd());
  const packet = path.resolve(packetDir);
  if (cwd !== packet) return cwd;
  let cursor = packet;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(cursor, '.git'))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return packet;
}

const REPO = path.resolve(option('--repo', defaultRepoRoot(SPEC_DIR)));
// `status: done` in spec.json is a sentence someone typed. `--report` makes it a
// claim about a test run instead: the anchored test name must appear as passed in a
// machine-readable report (node:test TAP, vitest JSON or JUnit XML).
const REPORT = option('--report', option('--results', null));

/**
 * Read what actually passed from a test report.
 *
 * Returns a Map of test name fragments that passed. The three formats are read
 * leniently because the point is "this named test passed in this run", not to
 * reimplement each runner. A file that cannot be parsed is an error, never a pass:
 * an unreadable report is the same as no report.
 */
function readExecutionReport(file) {
  const text = readFileSync(file, 'utf8');
  const passed = new Set();
  const failed = new Set();
  const skipped = new Set();
  const fileLineOutcomes = [];
  const trim = (name) => String(name ?? '').trim().replace(/\s+/g, ' ');
  const normFile = (raw) => String(raw ?? '').trim().replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\.\//, '');
  const record = (bucket, name) => {
    const n = trim(name);
    if (n) bucket.add(n);
  };

  // 1. JUnit XML: <testcase name="…" classname="…" file="…"> with failure/error/skipped children.
  if (/<test(?:suites|suite|case)\b/i.test(text)) {
    for (const match of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi)) {
      const attrs = match[1];
      const body = match[2] ?? '';
      const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
      const className = /\bclassname\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
      const tcFile = /\bfile\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
      const tcLine = Number(/\bline\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? NaN);
      const status = /<(?:failure|error)\b/i.test(body)
        ? 'failed'
        : /<skipped\b/i.test(body)
          ? 'skipped'
          : 'passed';
      const bucket = status === 'passed' ? passed : status === 'failed' ? failed : skipped;
      record(bucket, name);
      if (className) record(bucket, `${className} ${name}`);
      if (tcFile) fileLineOutcomes.push({ file: normFile(tcFile), line: Number.isFinite(tcLine) ? tcLine : null, name: trim(name), status });
    }
    return { passed, failed, skipped, fileLineOutcomes };
  }

  // 2. Go `go test -json` NDJSON event stream.
  if (/^\s*\{.*"Action"\s*:\s*"(?:run|pass|fail|skip)"/m.test(text) && text.includes('\n{')) {
    for (const rawLine of text.split(/\r?\n/)) {
      const s = rawLine.trim();
      if (!s.startsWith('{')) continue;
      try {
        const ev = JSON.parse(s);
        if (!ev.Test || !['pass', 'fail', 'skip'].includes(ev.Action)) continue;
        const bucket = ev.Action === 'pass' ? passed : ev.Action === 'fail' ? failed : skipped;
        record(bucket, ev.Test);
        if (ev.Package) record(bucket, `${ev.Package} ${ev.Test}`);
      } catch { /* skip non-json line */ }
    }
    return { passed, failed, skipped, fileLineOutcomes };
  }

  // 3. JSON: VLD `vld-test-run`, vitest/jest `testResults[].assertionResults[]`, or flat array.
  try {
    const json = JSON.parse(text);
    const collect = (node, suiteFile = null) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach((n) => collect(n, suiteFile)); return; }
      const nextFile = typeof node.file === 'string'
        ? normFile(node.file)
        : (Array.isArray(node.assertionResults) && typeof node.name === 'string' ? normFile(node.name) : suiteFile);
      const name = node.fullName ?? node.title ?? node.name;
      const shortTitle = node.title ?? node.name;
      const state = String(node.status ?? node.state ?? node.outcome ?? '').toLowerCase();
      if (typeof name === 'string' && state && !Array.isArray(node.assertionResults)) {
        let status = null;
        if (['passed', 'pass', 'ok', 'success'].includes(state)) status = 'passed';
        else if (['failed', 'fail', 'error'].includes(state)) status = 'failed';
        else if (['skipped', 'skip', 'pending', 'todo', 'disabled', 'ignored'].includes(state)) status = 'skipped';
        if (status) {
          const bucket = status === 'passed' ? passed : status === 'failed' ? failed : skipped;
          record(bucket, name);
          if (shortTitle && shortTitle !== name) record(bucket, shortTitle);
          const ln = Number(node.line ?? node.location?.line ?? NaN);
          if (nextFile) fileLineOutcomes.push({ file: nextFile, line: Number.isFinite(ln) ? ln : null, name: trim(shortTitle ?? name), status });
        }
      }
      for (const [k, value] of Object.entries(node)) {
        if (k === 'survivors') continue;
        if (value && typeof value === 'object') collect(value, nextFile);
      }
    };
    collect(json);
    return { passed, failed, skipped, fileLineOutcomes };
  } catch {
    // not JSON; fall through to TAP
  }

  // 4. TAP v13/v14 (node:test --test-reporter=tap): NEVER treat `# SKIP` / `# TODO` as passed!
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(ok|not ok)\b\s*\d*\s*(?:-\s*)?(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const isOk = match[2] === 'ok';
    const rawRest = match[3].trim();
    const isSkipOrTodo = /#\s*(?:SKIP|TODO)\b/i.test(rawRest);
    const name = trim(rawRest.replace(/\s*#\s*(?:SKIP|TODO).*$/i, ''));
    let locFile = null;
    let locLine = null;
    let diagType = null;
    if (lines[i + 1]?.trim() === '---' && lines[i + 1].search(/\S/) > indent) {
      let j = i + 2;
      while (j < lines.length && !(lines[j].trim() === '...' && lines[j].search(/\S/) > indent)) {
        const loc = lines[j].trim().match(/^location:\s*['"]?(.+?):(\d+)(?::\d+)?['"]?$/);
        if (loc) { locFile = normFile(loc[1]); locLine = Number(loc[2]); }
        const tp = lines[j].trim().match(/^type:\s*['"]?(\w+)['"]?/);
        if (tp) diagType = tp[1];
        j += 1;
      }
      i = j;
    }
    if (diagType === 'suite') continue;
    const status = isSkipOrTodo ? 'skipped' : isOk ? 'passed' : 'failed';
    const bucket = status === 'passed' ? passed : status === 'failed' ? failed : skipped;
    record(bucket, name);
    if (locFile) fileLineOutcomes.push({ file: locFile, line: locLine, name, status });
  }
  return { passed, failed, skipped, fileLineOutcomes };
}

function matchHitInReport(hit, reqId, rep) {
  const normHitFile = String(hit.file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const filesEq = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  // 1. File + testName match
  if (normHitFile && hit.testName) {
    const byFileAndName = rep.fileLineOutcomes.filter(
      (o) => o.file && filesEq(o.file, normHitFile) && (o.name === hit.testName || o.name.endsWith(` > ${hit.testName}`) || o.name.startsWith(`${hit.testName}[`))
    );
    if (byFileAndName.length > 0) {
      if (byFileAndName.some((o) => o.status === 'failed')) return 'failed';
      if (byFileAndName.every((o) => o.status === 'skipped')) return 'skipped';
      return 'passed';
    }
  }
  // 2. Scoped testName match against failed/skipped/passed sets
  const tName = hit.testName ? String(hit.testName).trim().replace(/\s+/g, ' ') : '';
  const nameIn = (set) => {
    for (const entry of set) {
      if (tName && (entry === tName || entry.endsWith(` > ${tName}`) || entry.endsWith(` ${tName}`) || entry.startsWith(`${tName}[`) || entry.startsWith(`${tName}/`))) {
        return true;
      }
      if (entry.includes(reqId)) return true;
    }
    return false;
  };
  if (nameIn(rep.failed)) return 'failed';
  if (nameIn(rep.passed)) return 'passed';
  if (nameIn(rep.skipped)) return 'skipped';
  return 'not-run';
}

const errors = [];
const notices = [];
const passes = [];

let execReport = null;
if (REPORT) {
  try {
    execReport = readExecutionReport(REPORT);
  } catch (error) {
    console.error(`\n✗ cannot read test report ${REPORT}: ${error.message}\n`);
    process.exit(2);
  }
  if (execReport.passed.size === 0) {
    notices.push(`${REPORT} contains no passing test; every done or required requirement will be reported as unproven`);
  }
} else if (REQUIRE_REPORT) {
  errors.push('--require-report requires --report <test-report-path> so anchored tests are verified against a real test run');
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo'
]);

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\//;
const SUPPRESSED = /@req-ignore/i;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb|rs|exs)$|_spec\.rb$|Tests?\.(java|kt|cs|php)$/;
const CLARIFY_MARKER = /\[(?:CLARIFY|NEEDS CLARIFICATION)(?::[^\]]*)?\]/i;
const ASSERTION_SIGNAL =
  /^[ \t]*assert\s+\S|\b(?:assert\s*!?\s*\(|assert_[a-z0-9_]+\s*!?\s*\(|assert\.[A-Za-z_]\w*\s*\(|assert[A-Z]\w*\s*\(|Assert\.[A-Z]\w*\s*\(|refute(?:_\w+)?\b|expect\s*\(|should\b|require\.[A-Z]\w*\s*\(|t\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)\b|pytest\.raises|raises\s*\(|rejects\b|throws\b)|!==|===|!=|==|<=|>=/m;

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
  /\b(?:test|it|describe)\.(?:skip|todo|only)\s*\(|\bx(?:it|describe|test)\s*\(|@(?:Disabled|Ignore)\b|#\[ignore\b|\bpytest\.mark\.skip\b|\bt\.Skip(?:f|Now)?\s*\(|\bmarkTestSkipped\s*\(/;
const EMPTY_BODY =
  /\b(?:test|it)\s*\(\s*(?:['"`][^'"`]*['"`]|\w+)\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}\s*\)|\b(?:test|it)\s*\([^)]*\bfunction\s*\([^)]*\)\s*\{\s*\}\s*\)|^[ \t]*def\s+test_\w+\s*\([^)]*\):[ \t]*\r?\n([ \t]+)(?:pass|\.\.\.)[ \t]*(?:\r?\n(?![ \t]+\S)|$)|#\[test\]\s*(?:async\s+)?fn\s+\w+\s*\([^)]*\)\s*\{\s*\}|@Test\s*(?:public\s+)?(?:void|fun)\s+\w+\s*\([^)]*\)\s*\{\s*\}|public\s+function\s+test\w+\s*\([^)]*\)(?:\s*:\s*void)?\s*\{\s*\}|\bit\s+['"][^'"]+['"]\s+do\s+end\b/m;
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
    const singleLiteralTruthy =
      matcherArgs.length === 0 &&
      (LITERAL_ONLY.test(received[0]) || /^\[\s*\]$|^\{\s*\}$/.test(received[0])) &&
      /\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeNull|toBeUndefined|toBeTrue|toBeFalse)\s*\($/.test(matcher[0]);
    const selfCompare = matcherArgs.length === 1 && matcherArgs[0] === received[0] && /^[\w.$]+$/.test(received[0]);
    if (bothLiteral || singleLiteralTruthy || selfCompare) found.push(`expect(${received[0]})${matcher[0].trim()}(${matcherArgs.join(', ')})`);
  }
  // Python literal & reflexive assertions: `assert True`, `assert 1 == 1`, `assert x == x`
  for (const match of source.matchAll(/^[ \t]*assert\s+(True|False|-?\d+\s*(?:==|!=)\s*-?\d+|['"][^'"]*['"]\s*==\s*['"][^'"]*['"]|([A-Za-z_][\w.]*)\s*==\s*\2)[ \t]*(?:#.*)?$/gm)) {
    found.push(`assert ${match[1].trim()}`);
  }
  // Go literal & reflexive guards: `if false { t.Fatal(...) }`, `if 1 != 1 { t.Fatal(...) }`, `if x != x { t.Fatal(...) }`
  for (const match of source.matchAll(/\bif\s+(false|true|-?\d+\s*(?:==|!=)\s*-?\d+|([A-Za-z_][\w.]*)\s*(?:==|!=)\s*\2)\s*\{[^}]{0,120}\bt\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)\s*\(/g)) {
    found.push(`if ${match[1].trim()} { t.Fatal(...) }`);
  }
  // Swallowed assertion in empty catch: `try { ...expect/assert... } catch [(e)] {}`
  for (const match of source.matchAll(/\btry\s*\{[^{}]{0,240}\b(?:assert|expect)\b[^{}]{0,240}\}\s*catch(?:\s*\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)?\}/g)) {
    found.push('try { assert/expect } catch {}');
    if (match) break;
  }
  // Rust literal macros: `assert!(true)`, `assert_eq!(1, 1)`
  for (const match of source.matchAll(/\b(assert!\s*\(\s*true\s*\)|assert_eq!\s*\(\s*(-?\d+|true|false|"[^"]*")\s*,\s*\2\s*\))/g)) {
    found.push(match[1].replace(/\s+/g, ' '));
  }
  // JVM / PHP / C# literal assertions: `assertTrue(true)`, `assertEquals(1, 1)`, `$this->assertTrue(true)`, `Assert.True(true)`
  for (const match of source.matchAll(/(?:\$this->|\bAssert\.)?\b(assertTrue|assertSame|assertEquals|True|Equal)\s*\(\s*(true|-?\d+|['"][^'"]*['"])(?:\s*,\s*\2)?\s*\)/g)) {
    const call = match[0].trim();
    if (/True\s*\(\s*true\s*\)$/.test(call) || /,\s*(?:true|-?\d+|['"][^'"]*['"])\s*\)$/.test(call)) found.push(call);
  }
  // Ruby RSpec literal assertions: `expect(true).to eq(true)`, `expect(true).to be(true)`, `expect(1).to eq(1)`
  for (const match of source.matchAll(/\bexpect\s*\(\s*(true|false|nil|-?\d+|['"][^'"]*['"])\s*\)\.to\s+(?:eq|eql|be)\s*\(?\s*\1\s*\)?/g)) {
    found.push(match[0].trim());
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
const JS_TEST_INFRA =
  /^(?:node:(?:test|assert)(?:\/|$)|(?:@jest\/globals|vitest|jest|mocha|chai|ava|tap|uvu|sinon|@testing-library\/[\w-]+|@playwright\/test|playwright|supertest|fast-check)(?:\/|$))/;
const PY_TEST_INFRA =
  /^(?:pytest|_\w*pytest|pytest_\w+|unittest|hypothesis|freezegun|responses|respx|faker|factory|typing|typing_extensions|__future__|dataclasses)(?:\.|$)/;
const RUST_NON_PRODUCT =
  /^(?:std|core|alloc|test|proptest|quickcheck|rstest|pretty_assertions|insta|criterion|mockall|wiremock|serial_test)(?:::|$)/;
const JVM_NON_PRODUCT =
  /^(?:org\.junit|junit|org\.testng|org\.assertj|org\.hamcrest|org\.mockito|io\.mockk|io\.kotest|kotlin\.test|net\.jqwik|java|javax|kotlin|kotlinx\.coroutines\.test)(?:\.|$)/;
const PHP_NON_PRODUCT =
  /^\\?(?:PHPUnit|Pest|Mockery|Prophecy|Faker|Eris|Hamcrest)(?:\\|$)/i;
const RUBY_NON_PRODUCT =
  /^(?:rspec|minitest|test\/unit|spec_helper|rails_helper|test_helper|minitest_helper|webmock|vcr|factory_bot|faker|rantly|json|yaml|time|date|set|ostruct|fileutils|tmpdir|pathname|securerandom)(?:\/|$)/;
const CSHARP_NON_PRODUCT =
  /^(?:System|Xunit|NUnit|Microsoft\.VisualStudio\.TestTools|FluentAssertions|Moq|NSubstitute|FakeItEasy|AutoFixture|FsCheck)(?:\.|$)/;
const GO_NON_PRODUCT =
  /^(?:testing(?:\/\w+)?|fmt|time|os|io|bytes|strings|strconv|context|sync|errors|math|sort|reflect|regexp|path(?:\/filepath)?|encoding\/\w+|net(?:\/http(?:\/httptest)?)?|github\.com\/stretchr\/testify(?:\/[\w-]+)?|pgregory\.net\/rapid)$/;

function jsReachesProduct(source) {
  const pattern = /(?:^\s*import\s[\s\S]*?\bfrom\s+|^\s*import\s+|(?:\brequire|\bimport)\s*\(\s*)['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('/')) return true;
    if (!JS_TEST_INFRA.test(specifier)) return true;
  }
  return false;
}

function pythonReachesProduct(source) {
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const fromMatch = /^from\s+(\.+[\w.]*|[\w.]+)\s+import\s+.+$/.exec(line);
    if (fromMatch) {
      const mod = fromMatch[1];
      if (mod.startsWith('.')) return true;
      if (!PY_TEST_INFRA.test(mod)) return true;
      continue;
    }
    const importMatch = /^import\s+(.+)$/.exec(line);
    if (importMatch) {
      const modules = importMatch[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (modules.some((mod) => !PY_TEST_INFRA.test(mod))) return true;
    }
  }
  return false;
}

function rustReachesProduct(source) {
  for (const match of source.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\S+)?|[a-zA-Z_]\w*(?:::[\w*{},\s]+)?)\s*;/gm)) {
    const target = match[1].trim().replace(/^::/, '');
    if (/^(?:crate|super|self)(?:::|$)/.test(target)) return true;
    const root = target.split('::')[0];
    if (root && !RUST_NON_PRODUCT.test(target) && !RUST_NON_PRODUCT.test(root)) return true;
  }
  for (const match of source.matchAll(/^\s*extern\s+crate\s+([a-zA-Z_]\w*)\s*;/gm)) {
    if (!RUST_NON_PRODUCT.test(match[1])) return true;
  }
  return false;
}

function jvmReachesProduct(source) {
  for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;?/gm)) {
    const target = match[1];
    if (!JVM_NON_PRODUCT.test(target)) return true;
  }
  return false;
}

function phpReachesProduct(source) {
  for (const match of source.matchAll(/^\s*use\s+(?:function\s+|const\s+)?(\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)+)(?:\s+as\s+\w+)?\s*;/gm)) {
    const target = match[1];
    if (!PHP_NON_PRODUCT.test(target)) return true;
  }
  for (const match of source.matchAll(/\b(?:require|require_once|include|include_once)\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/gm)) {
    const target = match[1];
    if (!/vendor\/autoload\.php$/i.test(target) && !/bootstrap/i.test(target)) return true;
  }
  return false;
}

function rubyReachesProduct(source) {
  for (const match of source.matchAll(/^\s*require_relative\s*\(?\s*['"]([^'"]+)['"]\s*\)?/gm)) {
    const target = match[1].replace(/^\.\//, '');
    if (!/^(?:\.\.\/)*(?:spec_helper|rails_helper|test_helper|minitest_helper)(?:\.rb)?$/.test(target)) return true;
  }
  for (const match of source.matchAll(/^\s*require\s*\(?\s*['"]([^'"]+)['"]\s*\)?/gm)) {
    const target = match[1];
    if (target.startsWith('./') || target.startsWith('../')) {
      if (!/(?:spec_helper|rails_helper|test_helper|minitest_helper)(?:\.rb)?$/.test(target)) return true;
      continue;
    }
    if (/^(?:lib|app|config\/environment)\//.test(target)) return true;
    if (!RUBY_NON_PRODUCT.test(target) && target.includes('/')) return true;
  }
  return false;
}

function goReachesProduct(source) {
  // Check explicit imports first (single-line and grouped `import (...)`).
  const imports = [];
  for (const single of source.matchAll(/^\s*import\s+(?:[\w.]+\s+)?["']([^"']+)["']/gm)) imports.push(single[1]);
  for (const block of source.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const line of block[1].matchAll(/["']([^"']+)["']/g)) imports.push(line[1]);
  }
  if (imports.some((spec) => !GO_NON_PRODUCT.test(spec))) return true;
  // A Go test in the same package (`package billing`, not `package billing_test` or
  // `package tests`) has direct access to package symbols without an import line,
  // provided the test body invokes a package-local symbol beyond `t.*` methods.
  const pkg = /^\s*package\s+([A-Za-z_]\w*)/m.exec(source)?.[1];
  if (!pkg || pkg.endsWith('_test') || pkg === 'test' || pkg === 'tests') return false;
  const stripped = source
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|`[^`]*`/g, '""')
    .replace(/\bfunc\s+Test\w*\s*\([^)]*\)/g, '')
    .replace(/\bt\.\w+\s*\(/g, '');
  return /\b[A-Za-z_]\w*\s*\(/.test(stripped) || /\b[A-Za-z_]\w*\s*\{/.test(stripped);
}

function csharpReachesProduct(source) {
  for (const match of source.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm)) {
    if (!CSHARP_NON_PRODUCT.test(match[1])) return true;
  }
  return false;
}

function elixirReachesProduct(source) {
  for (const match of source.matchAll(/^\s*(?:alias|import|use)\s+([A-Z][\w.]*)/gm)) {
    if (!/^ExUnit(?:\.|$)/.test(match[1])) return true;
  }
  return false;
}

const IMPORT_DETECTORS = Object.freeze({
  '.js': jsReachesProduct,
  '.mjs': jsReachesProduct,
  '.cjs': jsReachesProduct,
  '.jsx': jsReachesProduct,
  '.ts': jsReachesProduct,
  '.tsx': jsReachesProduct,
  '.py': pythonReachesProduct,
  '.go': goReachesProduct,
  '.rs': rustReachesProduct,
  '.java': jvmReachesProduct,
  '.kt': jvmReachesProduct,
  '.php': phpReachesProduct,
  '.rb': rubyReachesProduct,
  '.cs': csharpReachesProduct,
  '.exs': elixirReachesProduct
});

/**
 * Does this test file import product code rather than only test infrastructure?
 * Dispatches by file extension so non-quoted import syntaxes (Python, Rust,
 * Java/Kotlin, PHP, C#, Elixir) and Ruby `require_relative` work under
 * `--strict --require-assertions`.
 */
function reachesProduct(source, filePath = '') {
  const ext = path.extname(String(filePath)).toLowerCase();
  const detector = IMPORT_DETECTORS[ext];
  if (detector) return detector(source);
  // Shell / Gherkin feature files do not use module imports; fall back to JS check
  // only for unknown script extensions.
  if (ext === '.sh' || ext === '.feature') return true;
  return jsReachesProduct(source);
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
const ANCHOR_PLACEMENT_MESSAGE = 'put // @req directly above the test that proves it';
const SCOPE_MAX_BODY_LINES = 400;
const PY_TEST_DECL = /^(\s*)(?:async\s+)?def\s+(test[\w]*)\s*\(/;
const RB_TEST_DECL = /^(\s*)(?:(?:it|specify|scenario)\s+(?:['"]([^'"]+)['"]|.*)\s+do\b|def\s+(test_\w+))/;
const EX_TEST_DECL = /^(\s*)test\s+['"]([^'"]+)['"].*\bdo\b/;
const GO_TEST_DECL = /^\s*func\s+((?:Test|Benchmark|Fuzz|Example)[A-Z0-9_]\w*)\s*\(/;
const RUST_ATTR_DECL = /^\s*#\[(?:[\w:]+::)?(?:test|rstest)\b/;
const JVM_ATTR_DECL = /^\s*@(?:Test|ParameterizedTest|RepeatedTest|Property|TestFactory)\b/;
const CS_ATTR_DECL = /^\s*\[(?:Fact|Theory|Test|TestMethod|DataTestMethod)(?:\s*\(|\s*\])/;
const PHP_TEST_DECL = /^\s*(?:public\s+)?function\s+(test\w*)\s*\(/i;
const JS_FN_DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s+(test\w*)\s*\(/;
const JS_LEAF_DECL = /^\s*(?:(?:Deno|Bun)\.)?(?:test|it|specify|scenario)(?:\.(?:only|skip|todo|concurrent|sequential))?(?:\s*\.\s*each\s*\([^)]*\))?\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1)?/;
const JS_SUITE_DECL = /^\s*describe(?:\.(?:only|skip|todo|concurrent|sequential))?(?:\s*\.\s*each\s*\([^)]*\))?\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1)?/;
const RB_SUITE_DECL = /^(\s*)(?:RSpec\.)?(?:describe|context)\b.*\bdo\b/;

function stripCodeLiterals(line, inBlockComment = false) {
  let out = '';
  let block = inBlockComment;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (block) {
      if (ch === '*' && next === '/') { block = false; i += 1; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '*') { block = true; i += 1; continue; }
    if (ch === '/' && next === '/') break;
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    out += ch;
  }
  return { code: out, inBlockComment: block };
}

function detectTestDecl(line, ext, includeSuites = true) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return null;
  if (ext === '.py') {
    if (trimmed.startsWith('#')) return null;
    const m = PY_TEST_DECL.exec(line);
    return m ? { kind: 'python', indent: m[1].length, name: m[2], isSuite: false } : null;
  }
  if (ext === '.rb') {
    if (trimmed.startsWith('#')) return null;
    const m = RB_TEST_DECL.exec(line);
    if (m) return { kind: 'ruby', indent: m[1].length, name: m[2] ?? m[3] ?? null, isSuite: false };
    if (includeSuites) {
      const s = RB_SUITE_DECL.exec(line);
      if (s) return { kind: 'ruby', indent: s[1].length, name: null, isSuite: true };
    }
    return null;
  }
  if (ext === '.exs') {
    if (trimmed.startsWith('#')) return null;
    const m = EX_TEST_DECL.exec(line);
    return m ? { kind: 'ruby', indent: m[1].length, name: m[2] ?? null, isSuite: false } : null;
  }
  if (ext === '.go') {
    const m = GO_TEST_DECL.exec(line);
    return m ? { kind: 'brace', name: m[1], isSuite: false } : null;
  }
  if (ext === '.rs') return RUST_ATTR_DECL.test(line) ? { kind: 'attr-brace', name: null, isSuite: false } : null;
  if (ext === '.java' || ext === '.kt') return JVM_ATTR_DECL.test(line) ? { kind: 'attr-brace', name: null, isSuite: false } : null;
  if (ext === '.cs') return CS_ATTR_DECL.test(line) ? { kind: 'attr-brace', name: null, isSuite: false } : null;
  if (ext === '.php') {
    const m = PHP_TEST_DECL.exec(line);
    if (m) return { kind: 'brace', name: m[1], isSuite: false };
    const pest = JS_LEAF_DECL.exec(line);
    return pest ? { kind: 'js-call', name: pest[2] ?? null, isSuite: false } : null;
  }
  const jsLeaf = JS_LEAF_DECL.exec(line);
  if (jsLeaf) return { kind: 'js-call', name: jsLeaf[2] ?? null, isSuite: false };
  const jsFn = JS_FN_DECL.exec(line);
  if (jsFn) return { kind: 'brace', name: jsFn[1], isSuite: false };
  if (includeSuites) {
    const jsSuite = JS_SUITE_DECL.exec(line);
    if (jsSuite) return { kind: 'js-call', name: jsSuite[2] ?? null, isSuite: true };
  }
  return null;
}

function extractDeclSpan(lines, declLine, decl) {
  const cap = Math.min(lines.length, declLine + SCOPE_MAX_BODY_LINES);
  if (decl.kind === 'python') {
    let end = declLine;
    let parenDepth = 0;
    let sigDone = false;
    let i = declLine;
    for (; i < cap; i += 1) {
      const code = lines[i].replace(/#.*$/, '');
      for (const ch of code) {
        if (ch === '(') parenDepth += 1;
        else if (ch === ')') parenDepth -= 1;
      }
      end = i;
      if (parenDepth <= 0 && /:\s*$/.test(code.trim())) { sigDone = true; i += 1; break; }
    }
    if (!sigDone) i = declLine + 1;
    for (; i < cap; i += 1) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      if (raw.match(/^\s*/)[0].length <= decl.indent) break;
      end = i;
    }
    return { startLine: declLine, endLine: end, name: decl.name };
  }
  if (decl.kind === 'ruby') {
    let end = declLine;
    const endRe = new RegExp(`^\\s{0,${decl.indent}}end\\b`);
    for (let i = declLine + 1; i < cap; i += 1) {
      end = i;
      if (endRe.test(lines[i])) break;
    }
    return { startLine: declLine, endLine: end, name: decl.name };
  }
  let braceDepth = 0;
  let parenDepth = 0;
  let openedBrace = false;
  let openedParen = false;
  let inBlock = false;
  let end = declLine;
  let inferredName = decl.name;
  for (let i = declLine; i < cap; i += 1) {
    const raw = lines[i];
    if (!inferredName && decl.kind === 'attr-brace') {
      const fnMatch = /\b(?:fn|fun|void|Task)\s+([A-Za-z_]\w*)\s*\(/.exec(raw)
        ?? /^\s*(?:public\s+|private\s+|internal\s+)?(?:async\s+)?[\w<>]+\s+([A-Za-z_]\w*)\s*\(/.exec(raw);
      if (fnMatch) inferredName = fnMatch[1];
    }
    const s = stripCodeLiterals(raw, inBlock);
    inBlock = s.inBlockComment;
    for (const ch of s.code) {
      if (ch === '(') { parenDepth += 1; openedParen = true; }
      else if (ch === ')') parenDepth -= 1;
      else if (ch === '{') { braceDepth += 1; openedBrace = true; }
      else if (ch === '}') braceDepth -= 1;
    }
    end = i;
    if (openedBrace && braceDepth <= 0 && (decl.kind !== 'js-call' || parenDepth <= 0)) break;
    if (decl.kind === 'js-call' && openedParen && !openedBrace && parenDepth <= 0) break;
    if (decl.kind === 'attr-brace' && !openedBrace && i > declLine && /=\s*\S/.test(s.code) && parenDepth <= 0) break;
  }
  return { startLine: declLine, endLine: end, name: inferredName };
}

function skipPreambleBlock(lines, idx) {
  const trimmed = lines[idx].trim();
  if (/^(?:export\s+)?import\s/.test(trimmed)) {
    if (trimmed.includes(';') || /\bfrom\s+['"][^'"]+['"]/.test(trimmed) || /^import\s+['"][^'"]+['"]/.test(trimmed)) return idx;
    for (let j = idx; j < Math.min(lines.length, idx + 40); j += 1) {
      if (lines[j].includes(';') || /\bfrom\s+['"][^'"]+['"]/.test(lines[j])) return j;
    }
    return idx;
  }
  if ((/^import\s*\(/.test(trimmed) || /^from\s+[\w.]+\s+import\s*\(/.test(trimmed)) && !trimmed.includes(')')) {
    for (let j = idx + 1; j < Math.min(lines.length, idx + 60); j += 1) {
      if (lines[j].includes(')')) return j;
    }
    return idx;
  }
  if (/^(?:export\s+)?(?:declare\s+)?(?:interface\s+\w+|type\s+\w+\b)/.test(trimmed)) {
    let braceDepth = 0;
    let opened = false;
    let inBlock = false;
    for (let j = idx; j < Math.min(lines.length, idx + 60); j += 1) {
      const s = stripCodeLiterals(lines[j], inBlock);
      inBlock = s.inBlockComment;
      for (const ch of s.code) {
        if (ch === '{') { braceDepth += 1; opened = true; }
        else if (ch === '}') braceDepth -= 1;
      }
      if (opened && braceDepth <= 0) return j;
      if (!opened && s.code.includes(';')) return j;
    }
    return idx;
  }
  if (/^(?:const|let|var)\s+[\s\S]*\brequire\s*\(/.test(trimmed) || (/^(?:const|let|var)\s*\{/.test(trimmed) && !trimmed.includes('='))) {
    let braceDepth = 0;
    let parenDepth = 0;
    let inBlock = false;
    for (let j = idx; j < Math.min(lines.length, idx + 30); j += 1) {
      const s = stripCodeLiterals(lines[j], inBlock);
      inBlock = s.inBlockComment;
      for (const ch of s.code) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth -= 1;
        else if (ch === '(') parenDepth += 1;
        else if (ch === ')') parenDepth -= 1;
      }
      if (braceDepth <= 0 && parenDepth <= 0 && (/\brequire\s*\(/.test(lines[j]) || s.code.includes(';'))) return j;
    }
    return idx;
  }
  return idx;
}

function scopedAssertionFor(source, anchorIndex, filePath = '') {
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  const lines = source.split('\n');
  if (ext === '.sh' || ext === '.feature') {
    const body = lines.slice(anchorIndex, anchorIndex + ASSERTION_FREE_WINDOW).join('\n');
    return { status: 'ok', hasAssertion: ASSERTION_SIGNAL.test(body), testName: null, body };
  }
  // 1. Check enclosing leaf test body.
  for (let i = anchorIndex; i >= Math.max(0, anchorIndex - 160); i -= 1) {
    const decl = detectTestDecl(lines[i], ext, false);
    if (!decl) continue;
    const span = extractDeclSpan(lines, i, decl);
    if (anchorIndex >= span.startLine && anchorIndex <= span.endLine) {
      const body = lines.slice(span.startLine, span.endLine + 1).join('\n');
      return { status: 'ok', hasAssertion: ASSERTION_SIGNAL.test(body), testName: span.name ?? null, body };
    }
    if (span.endLine < anchorIndex) break;
  }
  // 2. Search forward up to 40 lines, ignoring import/type/interface/require blocks.
  const limit = Math.min(lines.length - 1, anchorIndex + ASSERTION_FREE_WINDOW);
  let firstSuite = null;
  let inBlock = false;
  for (let i = anchorIndex; i <= limit; i += 1) {
    const raw = lines[i];
    if (inBlock) {
      if (raw.includes('*/')) inBlock = false;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) { inBlock = true; continue; }
    const skipped = skipPreambleBlock(lines, i);
    if (skipped > i) { i = skipped; continue; }
    if (/^(?:export\s+)?import\s|^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+\w+|^(?:const|let|var)\s+.*\brequire\s*\(/.test(trimmed)) continue;
    if (firstSuite && i > firstSuite.endLine) break;
    const decl = detectTestDecl(raw, ext, true);
    if (!decl) continue;
    if (decl.isSuite) {
      if (!firstSuite) {
        const s = extractDeclSpan(lines, i, decl);
        firstSuite = { span: s, endLine: s.endLine };
      }
      continue;
    }
    const span = extractDeclSpan(lines, i, decl);
    const body = lines.slice(span.startLine, span.endLine + 1).join('\n');
    return { status: 'ok', hasAssertion: ASSERTION_SIGNAL.test(body), testName: span.name ?? null, body };
  }
  if (firstSuite) {
    const body = lines.slice(firstSuite.span.startLine, firstSuite.span.endLine + 1).join('\n');
    return { status: 'ok', hasAssertion: ASSERTION_SIGNAL.test(body), testName: firstSuite.span.name ?? null, body };
  }
  return { status: 'misplaced', hasAssertion: false, testName: null, body: '' };
}

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
    if (stats.isDirectory()) {
      if (full !== REPO && full !== SPEC_DIR && existsSync(path.join(full, 'profile.json')) && (existsSync(path.join(full, 'spec', 'spec.json')) || existsSync(path.join(full, 'specs', 'spec.json')))) continue;
      walk(full, out);
    }
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
  // Requirements whose own anchored test carries no assertion (BLKR-04) or lacks
  // a following test declaration within 40 lines (roadmap P0.3).
  const unprovenIds = new Set();
  const misplacedIds = new Set();
  const sourceLines = source.split('\n');
  for (const [lineIndex, line] of sourceLines.entries()) {
    if (!line.includes('@req')) continue;
    const matches = [...line.matchAll(/@req\s+(REQ-(?:\d{3,}|C\d{2,}))/g)];
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
      let testName = null;
      let scopedBody = '';
      if (isTest) {
        const scoped = scopedAssertionFor(source, lineIndex, file);
        testName = scoped.testName;
        scopedBody = scoped.body;
        if (scoped.status === 'misplaced') misplacedIds.add(id);
        else if (!scoped.hasAssertion) unprovenIds.add(id);
      }
      if (!anchored.has(id)) anchored.set(id, []);
      anchored.get(id).push({ file: rel(file), line: lineIndex + 1, isTest, testName, body: scopedBody });
    }
  }
  if (isTest && fileReqIds.length > 0) {
    const anchoredIds = [...new Set(fileReqIds)].join(', ');
    const problems = [];

    if (misplacedIds.size > 0) {
      problems.push(
        `no test declaration follows ${[...misplacedIds].join(', ')} within 40 lines — ${ANCHOR_PLACEMENT_MESSAGE}`
      );
    }

    // File-level first, then per requirement.
    if (!ASSERTION_SIGNAL.test(source) && misplacedIds.size === 0) {
      problems.push('no assertion in the anchored test');
    } else if (unprovenIds.size === fileReqIds.length && misplacedIds.size === 0) {
      problems.push('no assertion in the anchored test');
    } else if (unprovenIds.size > 0) {
      problems.push(`no assertion in the anchored test for ${[...unprovenIds].join(', ')}`);
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
    // The test must reach product code rather than importing only test libraries.
    const insideOnly = !reachesProduct(source, file);
    if (insideOnly) {
      problems.push('the test does not import product code');
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
        misplacedIds.size > 0 ||
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
  // P2.1: With a test report, verify the anchored test actually ran and passed
  // (and reject failed or skipped anchored tests immediately).
  if (execReport && inTests.length > 0 && (status === 'done' || REQUIRE_REPORT)) {
    const outcomes = inTests.map((hit) => ({ hit, state: matchHitInReport(hit, requirement.id, execReport) }));
    const failedHit = outcomes.find((o) => o.state === 'failed');
    const passedHit = outcomes.find((o) => o.state === 'passed');
    const skippedHit = outcomes.find((o) => o.state === 'skipped');
    if (failedHit) {
      errors.push(
        `${requirement.id} is ${status === 'done' ? 'marked done' : 'required by --require-report'}, but no passing test in ${REPORT} matched its anchor: the anchored test${failedHit.hit.testName ? ` \"${failedHit.hit.testName}\"` : ''} FAILED there`
      );
      continue;
    }
    if (skippedHit && !passedHit) {
      errors.push(
        `${requirement.id} is ${status === 'done' ? 'marked done' : 'required by --require-report'}, but no passing test in ${REPORT} matched its anchor: the anchored test${skippedHit.hit.testName ? ` \"${skippedHit.hit.testName}\"` : ''} was SKIPPED there`
      );
      continue;
    }
    if (!passedHit) {
      errors.push(
        `${requirement.id} is ${status === 'done' ? 'marked done' : 'required by --require-report'}, but no passing test in ${REPORT} matched its anchor. Either the test did not run, it failed, or the status is stale.`
      );
      continue;
    }
  } else if (REQUIRE_REPORT && inTests.length === 0) {
    errors.push(`${requirement.id}: --require-report requires an executed passing test anchor, but none exists`);
    continue;
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
const verificationLevel = failed
  ? 'failed'
  : unproven
    ? 'structurally-valid'
    : execReport
      ? 'executed-verified'
      : REQUIRE_ASSERTIONS
        ? 'static-asserted'
        : 'anchored-only';

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok: !failed,
        verdict,
        verificationLevel,
        errors,
        notices,
        passes,
        stats: {
          requirements: requirements.length,
          automatedTotal,
          anchoredAutomated,
          proven,
          pending,
          scanned,
          suppressed
        }
      },
      null,
      2
    )
  );
  process.exit(failed ? 1 : 0);
}

console.log(
  `\n${verdict} · ${errors.length} error(s) · ${pending} pending · ${proven} of ${automatedTotal} automated requirement(s) ${execReport ? 'executed-passed' : 'proven'}` +
    ` [${verificationLevel}]` +
    (proven === 0 && anchoredAutomated > 0 ? `, ${anchoredAutomated} more anchored but not marked done` : '') +
    (suppressed > 0 ? ` · ${suppressed} ignored` : '') +
    (unproven ? ' — no test carries an anchor yet, so this run is not evidence' : '') +
    (!failed && !unproven && !execReport ? ' (static check — pass --report <path> --require-report to verify test execution)' : '') +
    (notices.length && !failed && !unproven ? ' (pending is expected before implementation; use --strict in release CI)' : '') +
    '\n'
);

process.exit(failed ? 1 : 0);
