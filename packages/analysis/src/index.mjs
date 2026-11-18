/**
 * `@vld/analysis` — AST-based non-tautological assertion and test-coupling
 * analyzer for vibecode-like-a-dev (roadmap P2.2).
 *
 * Dispatches by language:
 *   - JS / TS (`javascript`, `typescript`): zero-dep recursive-descent AST analyzer
 *   - Python (`python`): stdlib `ast` module analyzer (with zero-dep fallback)
 *   - Go (`go`): stdlib `go/parser` + `go/ast` helper (with zero-dep fallback)
 *   - Rust / Java / Kotlin / C# / Ruby / PHP / Elixir / Shell: semantic non-tautology analyzer
 */

import { analyzeGoTestScope } from './go-ast.mjs';
import { analyzeJsTestScope } from './js-ast.mjs';
import { analyzePythonTestScope } from './python-ast.mjs';

export { analyzeJsTestScope } from './js-ast.mjs';
export { analyzePythonTestScope } from './python-ast.mjs';
export { analyzeGoTestScope, analyzeGoFallback } from './go-ast.mjs';

const POLYGLOT_ASSERT_PATTERNS = [
  // Rust
  { re: /\bassert_eq!\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'eq' },
  { re: /\bassert_ne!\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'neq' },
  { re: /\bassert!\s*\(\s*([^,)]+)/g, kind: 'truthy' },
  // Java / Kotlin JUnit & AssertJ
  { re: /\bassertEquals\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'eq' },
  { re: /\bassertNotEquals\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'neq' },
  { re: /\bassertTrue\s*\(\s*([^,)]+)/g, kind: 'truthy' },
  { re: /\bassertFalse\s*\(\s*([^,)]+)/g, kind: 'truthy' },
  { re: /\bassertNotNull\s*\(\s*([^,)]+)/g, kind: 'truthy' },
  { re: /\bassertThrows\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'throws' },
  { re: /\bassertThat\s*\(\s*([^)]+)\s*\)\s*\.\s*isEqualTo\s*\(\s*([^)]+)\s*\)/g, kind: 'eq' },
  // C# xUnit / NUnit
  { re: /\bAssert\.(?:Equal|AreEqual|Same)\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'eq' },
  { re: /\bAssert\.(?:True|IsTrue|False|IsFalse|NotNull|IsNotNull)\s*\(\s*([^,)]+)/g, kind: 'truthy' },
  { re: /\bAssert\.Throws(?:Async)?<[^>]+>\s*\(\s*([^)]+)/g, kind: 'throws' },
  // PHP PHPUnit
  { re: /\$this->assert(?:Same|Equals)\s*\(\s*([^,]+)\s*,\s*([^,)]+)/g, kind: 'eq' },
  { re: /\$this->assert(?:True|False|NotNull|NotEmpty)\s*\(\s*([^,)]+)/g, kind: 'truthy' },
  // Ruby RSpec / Minitest
  { re: /\bexpect\s*\(\s*([^)]+)\s*\)\.to\s+(?:eq|eql|be)\s*\(?\s*([^\s)]+)/g, kind: 'eq' },
  { re: /\bassert_equal\s*\(?\s*([^,\s]+)\s*,\s*([^\s)]+)/g, kind: 'eq' },
  // Generic fallback (`should`, `verify(`, `expectException`, Gherkin `Then `)
  { re: /\b(?:expectException|verify\s*\(|assert_raise)/g, kind: 'generic' },
  { re: /^\s*Then\s+\S+/gm, kind: 'generic' }
];

const SIMPLE_LIT = /^(?:true|false|True|False|null|nil|None|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;

export function analyzePolyglotTestScope(scopeBody, { language = 'other' } = {}) {
  const src = String(scopeBody ?? '');
  let genuine = 0;
  let tautologies = 0;
  const findings = [];

  for (const { re, kind } of POLYGLOT_ASSERT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (kind === 'eq') {
        const a = m[1].trim();
        const b = m[2].trim();
        if (a === b) {
          tautologies += 1;
          findings.push({ reason: 'reflexive-comparison', detail: `assertion compares identical expression (${a})` });
        } else if (SIMPLE_LIT.test(a) && SIMPLE_LIT.test(b)) {
          tautologies += 1;
          findings.push({ reason: 'literal-tautology', detail: `assertion compares two literals (${a}, ${b})` });
        } else {
          genuine += 1;
        }
      } else if (kind === 'neq') {
        const a = m[1].trim();
        const b = m[2].trim();
        if (SIMPLE_LIT.test(a) && SIMPLE_LIT.test(b)) {
          tautologies += 1;
          findings.push({ reason: 'literal-tautology', detail: `inequality compares two literals (${a}, ${b})` });
        } else {
          genuine += 1;
        }
      } else if (kind === 'truthy') {
        const a = m[1].trim();
        const eq = a.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
        if (SIMPLE_LIT.test(a)) {
          tautologies += 1;
          findings.push({ reason: 'literal-tautology', detail: `assertion evaluates literal (${a})` });
        } else if (eq && eq[1].trim() === eq[3].trim()) {
          tautologies += 1;
          findings.push({ reason: 'reflexive-comparison', detail: `assertion compares identical expression (${a})` });
        } else if (eq && SIMPLE_LIT.test(eq[1].trim()) && SIMPLE_LIT.test(eq[3].trim())) {
          tautologies += 1;
          findings.push({ reason: 'literal-tautology', detail: `assertion compares two literals (${a})` });
        } else {
          genuine += 1;
        }
      } else {
        genuine += 1;
      }
    }
  }

  if (language === 'shell') {
    if (/\[\s+[^\]]+\s+\]|\btest\s+-\w/.test(src)) genuine += 1;
  }

  if (genuine === 0 && findings.length === 0) {
    findings.push({ reason: 'no-assertion', detail: `${language} test contains no recognized assertion` });
  }
  return {
    valid: genuine > 0,
    genuineCount: genuine,
    tautologyCount: tautologies,
    swallowedCount: 0,
    unreachableCount: 0,
    subjectCoupled: genuine > 0,
    findings,
    engine: `polyglot-${language}`
  };
}

/**
 * Analyze a single scoped test function for genuine, reachable, non-tautological,
 * subject-coupled assertions.
 *
 * @param {object} opts
 * @param {string} opts.language   Language id from `detectTestLanguage(relPath)`.
 * @param {string} opts.scopeBody  Source text of the test scope (`startLine..endLine`).
 * @param {string} [opts.fileSource] Full file text (used for import & AST line resolution).
 * @param {number} [opts.startLine]  1-based declaration line of the test function.
 */
export function analyzeScopedAssertion({ language, scopeBody, fileSource = '', startLine = 1 }) {
  if (language === 'js') {
    return { ...analyzeJsTestScope(scopeBody, { fileSource }), engine: 'js-ast' };
  }
  if (language === 'python') {
    return analyzePythonTestScope(scopeBody, { fileSource, startLine });
  }
  if (language === 'go') {
    return analyzeGoTestScope(scopeBody, { fileSource, startLine });
  }
  return analyzePolyglotTestScope(scopeBody, { language });
}
