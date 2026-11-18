/**
 * Multi-language `@req` anchor-to-test scope resolver (roadmap P0.3).
 *
 * Shared by `factory/lib/verify.mjs` and mirrored in `factory/templates/spec-check.mjs`.
 * Pure, deterministic, zero external or runtime dependencies.
 *
 * Rules:
 *   1. If the anchor sits on or inside an active leaf test body (`test(`, `it(`,
 *      `def test_`, `func Test`, `#[test]`, `@Test`, `[Fact]`, `public function test`,
 *      Ruby `it ... do`), scope is that leaf test's body.
 *   2. Otherwise search forward up to 40 lines, skipping `import`, `export type`,
 *      `type ... = {`, `interface`, `require(`, comments and blank lines, to find
 *      the next test declaration (`test(`, `it(`, `describe(`, `def test_`,
 *      `func Test`, `#[test]`, `@Test`, `[Fact]`, `[Theory]`, etc.) and extract its
 *      full body from the declaration's opening delimiter.
 *   3. If no declaration follows within 40 lines, return `status: 'misplaced'`
 *      with message: `put // @req directly above the test that proves it`.
 */

import path from 'node:path';

export const ANCHOR_SEARCH_LIMIT = 40;
export const ANCHOR_PLACEMENT_MESSAGE = 'put // @req directly above the test that proves it';
const MAX_BODY_LINES = 400;

/** Classify test file language from extension for AST assertion analysis (P2.2). */
export function detectTestLanguage(filePath = '') {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].includes(ext)) return 'js';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.cs') return 'csharp';
  if (ext === '.rb') return 'ruby';
  if (ext === '.php') return 'php';
  if (ext === '.exs' || ext === '.ex') return 'elixir';
  if (ext === '.sh' || ext === '.bash') return 'shell';
  return 'other';
}

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

/** Strip single-line comments and string literal contents so brace/paren counts stay accurate. */
function stripStringsAndComments(line, inBlockComment = false) {
  let out = '';
  let block = inBlockComment;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (block) {
      if (ch === '*' && next === '/') {
        block = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '*') {
      block = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return { code: out, inBlockComment: block };
}

function detectDeclaration(line, ext, { includeSuites = true } = {}) {
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
  if (ext === '.rs') {
    if (RUST_ATTR_DECL.test(line)) return { kind: 'attr-brace', lang: 'rust', name: null, isSuite: false };
    return null;
  }
  if (ext === '.java' || ext === '.kt') {
    if (JVM_ATTR_DECL.test(line)) return { kind: 'attr-brace', lang: 'jvm', name: null, isSuite: false };
    return null;
  }
  if (ext === '.cs') {
    if (CS_ATTR_DECL.test(line)) return { kind: 'attr-brace', lang: 'csharp', name: null, isSuite: false };
    return null;
  }
  if (ext === '.php') {
    const m = PHP_TEST_DECL.exec(line);
    if (m) return { kind: 'brace', name: m[1], isSuite: false };
    const pest = JS_LEAF_DECL.exec(line);
    if (pest) return { kind: 'js-call', name: pest[2] ?? null, isSuite: false };
    return null;
  }

  // JS / TS / generic fallback (also supports polyglot patterns when ext is omitted)
  const jsLeaf = JS_LEAF_DECL.exec(line);
  if (jsLeaf) return { kind: 'js-call', name: jsLeaf[2] ?? null, isSuite: false };
  const jsFn = JS_FN_DECL.exec(line);
  if (jsFn) return { kind: 'brace', name: jsFn[1], isSuite: false };
  if (includeSuites) {
    const jsSuite = JS_SUITE_DECL.exec(line);
    if (jsSuite) return { kind: 'js-call', name: jsSuite[2] ?? null, isSuite: true };
  }
  if (!ext) {
    const py = PY_TEST_DECL.exec(line);
    if (py) return { kind: 'python', indent: py[1].length, name: py[2], isSuite: false };
    const go = GO_TEST_DECL.exec(line);
    if (go) return { kind: 'brace', name: go[1], isSuite: false };
    if (RUST_ATTR_DECL.test(line)) return { kind: 'attr-brace', lang: 'rust', name: null, isSuite: false };
    if (JVM_ATTR_DECL.test(line)) return { kind: 'attr-brace', lang: 'jvm', name: null, isSuite: false };
    if (CS_ATTR_DECL.test(line)) return { kind: 'attr-brace', lang: 'csharp', name: null, isSuite: false };
    const php = PHP_TEST_DECL.exec(line);
    if (php) return { kind: 'brace', name: php[1], isSuite: false };
    const rb = RB_TEST_DECL.exec(line);
    if (rb) return { kind: 'ruby', indent: rb[1].length, name: rb[2] ?? rb[3] ?? null, isSuite: false };
  }
  return null;
}

/** Extract `[startLine, endLine]` and text for a recognized test declaration. */
function extractDeclarationSpan(lines, declLine, decl) {
  const cap = Math.min(lines.length, declLine + MAX_BODY_LINES);

  if (decl.kind === 'python') {
    let end = declLine;
    // Handle multi-line parameter list `def test_foo(\n  a,\n  b\n):`
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
      if (parenDepth <= 0 && /:\s*$/.test(code.trim())) {
        sigDone = true;
        i += 1;
        break;
      }
    }
    if (!sigDone) i = declLine + 1;
    for (; i < cap; i += 1) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      const indent = raw.match(/^\s*/)[0].length;
      if (indent <= decl.indent) break;
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

  // Brace-delimited (`brace`, `attr-brace`, `js-call`)
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
    const stripped = stripStringsAndComments(raw, inBlock);
    inBlock = stripped.inBlockComment;
    for (const ch of stripped.code) {
      if (ch === '(') {
        parenDepth += 1;
        openedParen = true;
      } else if (ch === ')') {
        parenDepth -= 1;
      } else if (ch === '{') {
        braceDepth += 1;
        openedBrace = true;
      } else if (ch === '}') {
        braceDepth -= 1;
      }
    }
    end = i;
    if (openedBrace && braceDepth <= 0 && (decl.kind !== 'js-call' || parenDepth <= 0)) break;
    // Expression-bodied arrow test: `test('x', () => assert.equal(add(1, 2), 3));`
    if (decl.kind === 'js-call' && openedParen && !openedBrace && parenDepth <= 0) break;
    // Kotlin expression-bodied test: `@Test fun adds() = assertEquals(3, add(1, 2))`
    if (decl.kind === 'attr-brace' && !openedBrace && i > declLine && /=\s*\S/.test(stripped.code) && parenDepth <= 0) break;
  }

  return { startLine: declLine, endLine: end, name: inferredName };
}

/**
 * Determine how many lines to skip when the scanner encounters an `import`,
 * `export type`, `type ... = {`, `interface`, or `require(` block while searching
 * forward from an anchor to the next test declaration.
 */
function skipNonTestConstruct(lines, idx) {
  const line = lines[idx];
  const trimmed = line.trim();

  // `import ...` (single-line or multi-line `import {\n a,\n b\n} from 'x'`)
  if (/^(?:export\s+)?import\s/.test(trimmed)) {
    if (trimmed.includes(';') || /\bfrom\s+['"][^'"]+['"]/.test(trimmed) || /^import\s+['"][^'"]+['"]/.test(trimmed)) {
      return idx;
    }
    let inBlock = false;
    for (let j = idx; j < Math.min(lines.length, idx + 40); j += 1) {
      const s = stripStringsAndComments(lines[j], inBlock);
      inBlock = s.inBlockComment;
      if (lines[j].includes(';') || /\bfrom\s+['"][^'"]+['"]/.test(lines[j])) return j;
    }
    return idx;
  }

  // Go multi-line `import (\n ...\n)`
  if (/^import\s*\(/.test(trimmed) && !trimmed.includes(')')) {
    for (let j = idx + 1; j < Math.min(lines.length, idx + 60); j += 1) {
      if (lines[j].includes(')')) return j;
    }
    return idx;
  }

  // Python multi-line `from pkg import (\n a,\n b\n)`
  if (/^from\s+[\w.]+\s+import\s*\(/.test(trimmed) && !trimmed.includes(')')) {
    for (let j = idx + 1; j < Math.min(lines.length, idx + 40); j += 1) {
      if (lines[j].includes(')')) return j;
    }
    return idx;
  }

  // TS `export type`, `type Foo = ...`, `export interface`, `interface Foo { ... }`
  if (/^(?:export\s+)?(?:declare\s+)?(?:interface\s+\w+|type\s+\w+\b)/.test(trimmed)) {
    let braceDepth = 0;
    let opened = false;
    let inBlock = false;
    for (let j = idx; j < Math.min(lines.length, idx + 60); j += 1) {
      const s = stripStringsAndComments(lines[j], inBlock);
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

  // CJS `const { a, b } = require('...')`
  if (/^(?:const|let|var)\s+[\s\S]*\brequire\s*\(/.test(trimmed) || (/^(?:const|let|var)\s*\{/.test(trimmed) && !trimmed.includes('='))) {
    let braceDepth = 0;
    let parenDepth = 0;
    let inBlock = false;
    for (let j = idx; j < Math.min(lines.length, idx + 30); j += 1) {
      const s = stripStringsAndComments(lines[j], inBlock);
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

/** Check whether `anchorIndex` falls inside the body of a preceding leaf test declaration. */
function findEnclosingLeafTest(lines, anchorIndex, ext) {
  const start = Math.max(0, anchorIndex - 160);
  for (let i = anchorIndex; i >= start; i -= 1) {
    const decl = detectDeclaration(lines[i], ext, { includeSuites: false });
    if (!decl) continue;
    const span = extractDeclarationSpan(lines, i, decl);
    if (anchorIndex >= span.startLine && anchorIndex <= span.endLine) {
      return span;
    }
    // Once we cross a completed earlier sibling test, no earlier leaf test can enclose anchorIndex.
    if (span.endLine < anchorIndex) break;
  }
  return null;
}

/**
 * Resolve the test block scoped to an `@req` marker at `anchorIndex` (0-based).
 *
 * Returns:
 *   - `{ status: 'ok', startLine, endLine, testName, body }` when bound to a test
 *   - `{ status: 'misplaced', startLine: anchorIndex, endLine: anchorIndex, testName: null, body: '', message }`
 *     when no enclosing leaf test and no following test declaration exists within 40 lines.
 */
export function resolveAnchorScope(source, anchorIndex, filePath = '') {
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';
  const lines = source.split('\n');

  if (ext === '.sh' || ext === '.feature') {
    return {
      status: 'ok',
      startLine: anchorIndex,
      endLine: Math.min(lines.length - 1, anchorIndex + ANCHOR_SEARCH_LIMIT),
      testName: null,
      body: lines.slice(anchorIndex, anchorIndex + ANCHOR_SEARCH_LIMIT).join('\n')
    };
  }

  // 1. Anchor on or inside a leaf test declaration (`test('...', () => { // @req ... })`).
  const enclosing = findEnclosingLeafTest(lines, anchorIndex, ext);
  if (enclosing) {
    return {
      status: 'ok',
      startLine: enclosing.startLine,
      endLine: enclosing.endLine,
      testName: enclosing.name ?? null,
      body: lines.slice(enclosing.startLine, enclosing.endLine + 1).join('\n')
    };
  }

  // 2. Search forward up to ANCHOR_SEARCH_LIMIT (40) lines, skipping imports/types/interfaces/requires.
  const limit = Math.min(lines.length - 1, anchorIndex + ANCHOR_SEARCH_LIMIT);
  let firstSuite = null;
  let inBlockComment = false;
  for (let i = anchorIndex; i <= limit; i += 1) {
    const raw = lines[i];
    if (inBlockComment) {
      if (raw.includes('*/')) inBlockComment = false;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true;
      continue;
    }

    const skippedTo = skipNonTestConstruct(lines, i);
    if (skippedTo > i) {
      i = skippedTo;
      continue;
    }
    if (/^(?:export\s+)?import\s|^(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+\w+|^(?:const|let|var)\s+.*\brequire\s*\(/.test(trimmed)) {
      continue;
    }

    if (firstSuite && i > firstSuite.endLine) {
      break;
    }
    const decl = detectDeclaration(raw, ext, { includeSuites: true });
    if (!decl) continue;
    if (decl.isSuite) {
      if (!firstSuite) {
        const suiteSpan = extractDeclarationSpan(lines, i, decl);
        firstSuite = { line: i, decl, span: suiteSpan, endLine: suiteSpan.endLine };
      }
      continue;
    }
    const span = extractDeclarationSpan(lines, i, decl);
    return {
      status: 'ok',
      startLine: span.startLine,
      endLine: span.endLine,
      testName: span.name ?? null,
      body: lines.slice(span.startLine, span.endLine + 1).join('\n')
    };
  }

  if (firstSuite) {
    const span = firstSuite.span;
    return {
      status: 'ok',
      startLine: span.startLine,
      endLine: span.endLine,
      testName: span.name ?? null,
      body: lines.slice(span.startLine, span.endLine + 1).join('\n')
    };
  }

  return {
    status: 'misplaced',
    startLine: anchorIndex,
    endLine: anchorIndex,
    testName: null,
    body: '',
    message: ANCHOR_PLACEMENT_MESSAGE
  };
}
