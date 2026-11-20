/**
 * Zero-dependency JS/TS lexer and recursive-descent AST assertion analyzer (P2.2).
 *
 * Inspects a single anchored test function body (plus file-level imports/helpers)
 * and proves whether the test contains at least one REACHABLE, UNSWALLOWED,
 * NON-TAUTOLOGICAL assertion coupled to a non-test computation or imported symbol.
 *
 * Catches:
 *   - `no-assertion`: empty body or logging only
 *   - `literal-tautology`: `expect(true).toBe(true)`, `assert.equal(1, 1)`,
 *     `assert.ok(true)`, `assert(2 + 2 === 4)`, `expect([1]).toEqual([1])`,
 *     `expect({}).toBeDefined()`, `assert.notEqual(1, 2)`
 *   - `constant-binding-tautology`: `const x = 42; expect(x).toBe(42)`
 *   - `reflexive-comparison`: `expect(x).toBe(x)`, `assert.strictEqual(a.b, a.b)`,
 *     `assert(x === x)`
 *   - `tautological-boolean`: `assert(x || !x)`, `expect(typeof x === 'string' || typeof x !== 'string').toBe(true)`
 *   - `always-truthy`: `expect([]).toBeTruthy()`, `expect({}).toBeTruthy()`, `assert.ok({})`
 *   - `swallowed-assertion`: assertion inside `try { ... } catch { /* empty *\/ }`
 *   - `unreachable-assertion`: assertion placed after unconditional `return` or `throw`
 *   - `uncoupled-assertion`: test manipulates only local literal values and never
 *     calls or reads any imported/subject symbol, process, filesystem, or helper
 */

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'async', 'await', 'return', 'throw',
  'try', 'catch', 'finally', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'default', 'new', 'typeof', 'instanceof', 'in', 'of', 'void',
  'delete', 'true', 'false', 'null', 'undefined', 'import', 'from', 'export',
  'class', 'extends', 'as', 'satisfies', 'type', 'interface'
]);

const TEST_ONLY_IDENTIFIERS = new Set([
  'assert', 'expect', 'chai', 'should', 'sinon', 'vi', 'jest',
  'test', 'it', 'describe', 'context', 'suite', 'before', 'after',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 't',
  'console', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt',
  'Array', 'Object', 'Set', 'Map', 'WeakSet', 'WeakMap', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'null', 'NaN', 'Infinity'
]);

const EQUALITY_MATCHERS = new Set([
  'toBe', 'toEqual', 'toStrictEqual', 'eql', 'equal', 'equals', 'eq',
  'strictEqual', 'deepEqual', 'deepStrictEqual'
]);
const INEQUALITY_MATCHERS = new Set([
  'notEqual', 'notStrictEqual', 'notDeepEqual', 'notDeepStrictEqual'
]);
const TRUTHY_MATCHERS = new Set(['toBeTruthy', 'toBeTrue', 'ok']);
const FALSY_MATCHERS = new Set(['toBeFalsy', 'toBeFalse', 'toBeNull', 'toBeUndefined', 'toBeNaN']);
const DEFINED_MATCHERS = new Set(['toBeDefined', 'toExist']);
const THROW_MATCHERS = new Set(['toThrow', 'toThrowError', 'throws', 'rejects', 'doesNotThrow', 'doesNotReject']);
const RELATIONAL_MATCHERS = new Set([
  'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual',
  'toBeCloseTo'
]);
const CONTAIN_MATCHERS = new Set([
  'toContain', 'toContainEqual', 'toMatch', 'toMatchObject', 'toHaveProperty',
  'toHaveLength', 'toHaveBeenCalled', 'toHaveBeenCalledTimes', 'toHaveBeenCalledWith',
  'toHaveReturned', 'toHaveReturnedWith', 'toHaveStatus', 'match', 'doesNotMatch',
  'include', 'includes', 'contain', 'contains'
]);
const ASSERT_METHODS = new Set([
  'ok', 'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual',
  'notEqual', 'notStrictEqual', 'notDeepEqual', 'notDeepStrictEqual',
  'match', 'doesNotMatch', 'throws', 'rejects', 'doesNotThrow', 'doesNotReject',
  'fail', 'ifError', 'isTrue', 'isFalse', 'isNull', 'isNotNull', 'isDefined', 'include'
]);

/** Tokenize JS/TS source into flat tokens with line numbers. */
export function tokenizeJs(source) {
  const tokens = [];
  const src = String(source ?? '');
  const len = src.length;
  let i = 0;
  let line = 1;
  let prev = null;

  const push = (type, value, tokLine = line) => {
    const tok = { type, value, line: tokLine };
    tokens.push(tok);
    prev = tok;
  };

  const canStartRegex = () => {
    if (!prev) return true;
    if (prev.type === 'punc') {
      return ![']', ')', '}'].includes(prev.value);
    }
    if (prev.type === 'op') return true;
    if (prev.type === 'kw') {
      return ['return', 'throw', 'case', 'in', 'of', 'typeof', 'instanceof', 'void', 'delete', 'new', 'await'].includes(prev.value);
    }
    return false;
  };

  while (i < len) {
    const ch = src[i];
    if (ch === '\n') { line += 1; i += 1; continue; }
    if (ch === '\r' || ch === ' ' || ch === '\t' || ch === '\f') { i += 1; continue; }

    // Line comment
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < len && src[i] !== '\n') i += 1;
      continue;
    }
    // Block comment
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    // String literal
    if (ch === '\'' || ch === '"') {
      const startLine = line;
      const quote = ch;
      let val = '';
      i += 1;
      while (i < len && src[i] !== quote) {
        if (src[i] === '\\') {
          const next = src[i + 1] ?? '';
          if (next === 'n') val += '\n';
          else if (next === 't') val += '\t';
          else if (next === 'r') val += '\r';
          else val += next;
          if (next === '\n') line += 1;
          i += 2;
          continue;
        }
        if (src[i] === '\n') line += 1;
        val += src[i];
        i += 1;
      }
      i += 1;
      push('str', val, startLine);
      continue;
    }
    // Template literal (tracks whether any `${...}` interpolation references dynamic expressions)
    if (ch === '`') {
      const startLine = line;
      let val = '';
      let hasExpr = false;
      const exprSources = [];
      i += 1;
      while (i < len && src[i] !== '`') {
        if (src[i] === '\\') {
          val += src[i + 1] ?? '';
          if (src[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          hasExpr = true;
          i += 2;
          let depth = 1;
          let inner = '';
          while (i < len && depth > 0) {
            if (src[i] === '\n') line += 1;
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
              depth -= 1;
              if (depth === 0) { i += 1; break; }
            }
            inner += src[i];
            i += 1;
          }
          exprSources.push(inner);
          val += `\${${inner}}`;
          continue;
        }
        if (src[i] === '\n') line += 1;
        val += src[i];
        i += 1;
      }
      i += 1;
      const tok = { type: hasExpr ? 'tpl' : 'str', value: val, exprSources, line: startLine };
      tokens.push(tok);
      prev = tok;
      continue;
    }
    // Regex literal
    if (ch === '/' && src[i + 1] !== '=' && canStartRegex()) {
      const startLine = line;
      let raw = '/';
      let inClass = false;
      let j = i + 1;
      let valid = false;
      while (j < len) {
        const c = src[j];
        if (c === '\n') break;
        if (c === '\\') { raw += c + (src[j + 1] ?? ''); j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          raw += '/';
          j += 1;
          while (j < len && /[a-z]/i.test(src[j])) { raw += src[j]; j += 1; }
          valid = true;
          break;
        }
        raw += c;
        j += 1;
      }
      if (valid) {
        i = j;
        push('regex', raw, startLine);
        continue;
      }
    }
    // Number literal
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let raw = '';
      while (i < len && /[0-9a-fA-FxXoObBn_.]/.test(src[i])) {
        if (src[i] !== '_') raw += src[i];
        i += 1;
      }
      if ((src[i - 1] === 'e' || src[i - 1] === 'E') && (src[i] === '+' || src[i] === '-')) {
        raw += src[i++];
        while (i < len && /[0-9_]/.test(src[i])) {
          if (src[i] !== '_') raw += src[i];
          i += 1;
        }
      }
      const num = raw.endsWith('n') ? Number(raw.slice(0, -1)) : Number(raw);
      push('num', num);
      continue;
    }
    // Identifier / keyword
    if (/[A-Za-z_$]/.test(ch)) {
      let id = '';
      while (i < len && /[A-Za-z0-9_$]/.test(src[i])) {
        id += src[i];
        i += 1;
      }
      push(KEYWORDS.has(id) ? 'kw' : 'id', id);
      continue;
    }
    // Multi-char operators
    const three = src.slice(i, i + 3);
    if (['===', '!==', '...', '>>>', '&&=', '||=', '??=', '**='].includes(three)) {
      push('op', three);
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '??', '=>', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**'].includes(two)) {
      push('op', two);
      i += 2;
      continue;
    }
    if ('(){}[].,;:'.includes(ch)) {
      push('punc', ch);
      i += 1;
      continue;
    }
    push('op', ch);
    i += 1;
  }
  return tokens;
}

/** Extract top-level imported symbol names and locally declared helper names from a JS/TS file. */
export function collectFileImports(fileSource) {
  const imported = new Set();
  const src = String(fileSource ?? '');
  // ESM: import foo, { bar as baz, qux } from '...'; import * as ns from '...'
  const importRe = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[2];
    if (/^(?:node:test|vitest|jest|@jest\/|chai|mocha|sinon)(?:\/|$)/.test(spec)) continue;
    if (spec === 'node:assert' || spec === 'node:assert/strict' || spec === 'assert') continue;
    const clause = m[1].replace(/\btype\s+/g, '');
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) imported.add(ns[1]);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const alias = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
        imported.add(alias ? alias[1] : trimmed.split(/\s+/)[0]);
      }
    }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim();
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) imported.add(def);
  }
  // CJS: const { a, b } = require('...') or const foo = require('...')
  const reqRe = /\b(?:const|let|var)\s+(\{[^}]+\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(src)) !== null) {
    const spec = m[2];
    if (/^(?:node:test|vitest|jest|chai|mocha|node:assert|assert)/.test(spec)) continue;
    const lhs = m[1].trim();
    if (lhs.startsWith('{')) {
      for (const part of lhs.slice(1, -1).split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const colon = seg.split(':').map((s) => s.trim());
        imported.add((colon[1] || colon[0]).split('=')[0].trim());
      }
    } else {
      imported.add(lhs);
    }
  }
  return imported;
}

/** Parse simple recursive-descent expression AST nodes from token stream. */
class ExprParser {
  constructor(tokens, start = 0, end = tokens.length) {
    this.tokens = tokens;
    this.pos = start;
    this.end = end;
  }

  peek(offset = 0) {
    const idx = this.pos + offset;
    return idx < this.end ? this.tokens[idx] : null;
  }

  next() {
    return this.pos < this.end ? this.tokens[this.pos++] : null;
  }

  match(type, value) {
    const t = this.peek();
    if (!t || t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    this.pos += 1;
    return true;
  }

  parseExpression() {
    return this.parseConditional();
  }

  parseConditional() {
    const test = this.parseNullish();
    if (this.match('op', '?')) {
      const consequent = this.parseExpression();
      this.match('punc', ':');
      const alternate = this.parseExpression();
      return { kind: 'Conditional', test, consequent, alternate };
    }
    return test;
  }

  parseNullish() {
    let left = this.parseLogicalOr();
    while (this.peek()?.type === 'op' && this.peek().value === '??') {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseLogicalOr() };
    }
    return left;
  }

  parseLogicalOr() {
    let left = this.parseLogicalAnd();
    while (this.peek()?.type === 'op' && this.peek().value === '||') {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseLogicalAnd() };
    }
    return left;
  }

  parseLogicalAnd() {
    let left = this.parseEquality();
    while (this.peek()?.type === 'op' && this.peek().value === '&&') {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseEquality() };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseRelational();
    while (this.peek()?.type === 'op' && ['===', '!==', '==', '!='].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseRelational() };
    }
    return left;
  }

  parseRelational() {
    let left = this.parseAdditive();
    while (
      (this.peek()?.type === 'op' && ['<', '>', '<=', '>='].includes(this.peek().value)) ||
      (this.peek()?.type === 'kw' && ['instanceof', 'in'].includes(this.peek().value))
    ) {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek()?.type === 'op' && ['+', '-'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.peek()?.type === 'op' && ['*', '/', '%', '**'].includes(this.peek().value)) {
      const op = this.next().value;
      left = { kind: 'Binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t?.type === 'kw' && ['await', 'typeof', 'void', 'delete'].includes(t.value)) {
      this.next();
      const arg = this.parseUnary();
      if (t.value === 'await') return { kind: 'Await', arg };
      return { kind: 'Unary', op: t.value, arg };
    }
    if (t?.type === 'op' && ['!', '+', '-', '~'].includes(t.value)) {
      this.next();
      return { kind: 'Unary', op: t.value, arg: this.parseUnary() };
    }
    if (t?.type === 'kw' && t.value === 'new') {
      this.next();
      const callee = this.parseMemberOnly();
      let args = [];
      if (this.peek()?.type === 'punc' && this.peek().value === '(') {
        args = this.parseArgList();
      }
      return { kind: 'New', callee, args };
    }
    return this.parsePostfix();
  }

  parseMemberOnly() {
    let node = this.parsePrimary();
    while (this.pos < this.end) {
      if (this.match('punc', '.') || this.match('op', '?.')) {
        const prop = this.next();
        if (prop) node = { kind: 'Member', object: node, property: String(prop.value), computed: false };
      } else {
        break;
      }
    }
    return node;
  }

  parseArgList() {
    const args = [];
    this.match('punc', '(');
    while (this.pos < this.end && !(this.peek()?.type === 'punc' && this.peek().value === ')')) {
      if (this.match('op', '...')) {
        args.push({ kind: 'Spread', arg: this.parseExpression() });
      } else {
        args.push(this.parseExpression());
      }
      if (!this.match('punc', ',')) break;
    }
    this.match('punc', ')');
    return args;
  }

  skipTypeAssertion() {
    // Handle TS `as Foo<Bar>` / `satisfies Foo`
    while (this.peek()?.type === 'kw' && (this.peek().value === 'as' || this.peek().value === 'satisfies')) {
      this.next();
      if (this.peek()?.type === 'kw' && this.peek().value === 'const') {
        this.next();
        continue;
      }
      // Consume type name + optional generic `<...>` + array `[]`
      if (this.peek()?.type === 'id' || this.peek()?.type === 'kw') {
        this.next();
        while (this.match('punc', '.')) {
          if (this.peek()) this.next();
        }
        if (this.peek()?.type === 'op' && this.peek().value === '<') {
          let depth = 0;
          while (this.pos < this.end) {
            const tk = this.next();
            if (tk.value === '<') depth += 1;
            else if (tk.value === '>') {
              depth -= 1;
              if (depth <= 0) break;
            }
          }
        }
        while (this.peek()?.type === 'punc' && this.peek().value === '[' && this.peek(1)?.value === ']') {
          this.pos += 2;
        }
      } else if (this.peek()?.type === 'punc' && this.peek().value === '{') {
        this.skipBalanced('{', '}');
      }
    }
  }

  skipBalanced(open, close) {
    let depth = 0;
    const start = this.pos;
    while (this.pos < this.end) {
      const tk = this.next();
      if (tk.type === 'punc' && tk.value === open) depth += 1;
      else if (tk.type === 'punc' && tk.value === close) {
        depth -= 1;
        if (depth <= 0) break;
      }
    }
    return this.tokens.slice(start + 1, Math.max(start + 1, this.pos - 1));
  }

  parsePostfix() {
    let node = this.parsePrimary();
    while (this.pos < this.end) {
      const t = this.peek();
      // TS non-null postfix `x!.y` or `x!()`
      if (t?.type === 'op' && t.value === '!' && ['.', '(', '[', '?.'].includes(this.peek(1)?.value)) {
        this.next();
        continue;
      }
      if (t?.type === 'punc' && t.value === '.') {
        this.next();
        const prop = this.next();
        if (!prop) break;
        node = { kind: 'Member', object: node, property: String(prop.value), computed: false };
      } else if (t?.type === 'op' && t.value === '?.') {
        this.next();
        if (this.peek()?.type === 'punc' && this.peek().value === '(') {
          node = { kind: 'Call', callee: node, args: this.parseArgList() };
        } else if (this.peek()?.type === 'punc' && this.peek().value === '[') {
          this.next();
          const idx = this.parseExpression();
          this.match('punc', ']');
          node = { kind: 'Member', object: node, property: idx, computed: true };
        } else {
          const prop = this.next();
          if (!prop) break;
          node = { kind: 'Member', object: node, property: String(prop.value), computed: false };
        }
      } else if (t?.type === 'punc' && t.value === '[') {
        this.next();
        const idx = this.parseExpression();
        this.match('punc', ']');
        node = { kind: 'Member', object: node, property: idx, computed: true };
      } else if (t?.type === 'punc' && t.value === '(') {
        const args = this.parseArgList();
        node = { kind: 'Call', callee: node, args };
      } else if (t?.type === 'kw' && (t.value === 'as' || t.value === 'satisfies')) {
        this.skipTypeAssertion();
      } else {
        break;
      }
    }
    return node;
  }

  parsePrimary() {
    const t = this.peek();
    if (!t) return { kind: 'Unknown' };
    if (t.type === 'num') { this.next(); return { kind: 'Literal', value: t.value, litType: 'number' }; }
    if (t.type === 'str') { this.next(); return { kind: 'Literal', value: t.value, litType: 'string' }; }
    if (t.type === 'regex') { this.next(); return { kind: 'Literal', value: t.value, litType: 'regex' }; }
    if (t.type === 'tpl') {
      this.next();
      return { kind: 'Template', raw: t.value, exprSources: t.exprSources ?? [] };
    }
    if (t.type === 'kw') {
      if (t.value === 'true') { this.next(); return { kind: 'Literal', value: true, litType: 'boolean' }; }
      if (t.value === 'false') { this.next(); return { kind: 'Literal', value: false, litType: 'boolean' }; }
      if (t.value === 'null') { this.next(); return { kind: 'Literal', value: null, litType: 'null' }; }
      if (t.value === 'undefined') { this.next(); return { kind: 'Literal', value: undefined, litType: 'undefined' }; }
      if (t.value === 'async' && (this.peek(1)?.value === '(' || this.peek(1)?.value === 'function' || this.peek(1)?.type === 'id')) {
        this.next();
        return this.parseFunctionOrArrow(true);
      }
      if (t.value === 'function') {
        return this.parseFunctionOrArrow(false);
      }
    }
    if (t.type === 'id') {
      if (this.peek(1)?.type === 'op' && this.peek(1).value === '=>') {
        const param = this.next().value;
        this.next(); // =>
        return this.parseArrowBody([param]);
      }
      this.next();
      return { kind: 'Id', name: t.value };
    }
    if (t.type === 'punc' && t.value === '(') {
      // Check if arrow function `(...) => ...`
      const save = this.pos;
      const inner = this.skipBalanced('(', ')');
      if (this.peek()?.type === 'op' && this.peek().value === '=>') {
        this.next();
        const params = inner.filter((tk) => tk.type === 'id').map((tk) => tk.value);
        return this.parseArrowBody(params);
      }
      this.pos = save + 1;
      const expr = this.parseExpression();
      this.match('punc', ')');
      return expr;
    }
    if (t.type === 'punc' && t.value === '[') {
      this.next();
      const elements = [];
      while (this.pos < this.end && !(this.peek()?.type === 'punc' && this.peek().value === ']')) {
        if (this.match('op', '...')) elements.push({ kind: 'Spread', arg: this.parseExpression() });
        else elements.push(this.parseExpression());
        if (!this.match('punc', ',')) break;
      }
      this.match('punc', ']');
      return { kind: 'Array', elements };
    }
    if (t.type === 'punc' && t.value === '{') {
      this.next();
      const props = [];
      while (this.pos < this.end && !(this.peek()?.type === 'punc' && this.peek().value === '}')) {
        if (this.match('op', '...')) {
          props.push({ spread: true, value: this.parseExpression() });
        } else {
          const keyTok = this.next();
          if (!keyTok) break;
          const key = String(keyTok.value);
          if (this.match('punc', ':')) {
            props.push({ key, value: this.parseExpression() });
          } else if (this.peek()?.type === 'punc' && this.peek().value === '(') {
            this.skipBalanced('(', ')');
            if (this.peek()?.type === 'punc' && this.peek().value === '{') this.skipBalanced('{', '}');
            props.push({ key, value: { kind: 'Function', bodyTokens: [] } });
          } else {
            props.push({ key, value: { kind: 'Id', name: key } });
          }
        }
        if (!this.match('punc', ',')) break;
      }
      this.match('punc', '}');
      return { kind: 'Object', props };
    }
    this.next();
    return { kind: 'Unknown' };
  }

  parseFunctionOrArrow(isAsync) {
    if (this.peek()?.value === 'function') {
      this.next();
      if (this.peek()?.type === 'id') this.next();
      if (this.peek()?.value === '(') this.skipBalanced('(', ')');
      const bodyTokens = this.peek()?.value === '{' ? this.skipBalanced('{', '}') : [];
      return { kind: 'Function', async: isAsync, bodyTokens };
    }
    if (this.peek()?.type === 'id') {
      const param = this.next().value;
      this.match('op', '=>');
      return this.parseArrowBody([param]);
    }
    if (this.peek()?.value === '(') {
      const inner = this.skipBalanced('(', ')');
      this.match('op', '=>');
      return this.parseArrowBody(inner.filter((tk) => tk.type === 'id').map((tk) => tk.value));
    }
    return { kind: 'Unknown' };
  }

  parseArrowBody(params) {
    if (this.peek()?.type === 'punc' && this.peek().value === '{') {
      const bodyTokens = this.skipBalanced('{', '}');
      return { kind: 'Function', params, bodyTokens };
    }
    const expr = this.parseExpression();
    return { kind: 'Function', params, exprBody: expr };
  }
}

/** Canonical structural signature of an AST node for reflexive comparison detection (`a.b === a.b`). */
function exprKey(node) {
  if (!node) return null;
  switch (node.kind) {
    case 'Literal': return `lit:${node.litType}:${String(node.value)}`;
    case 'Id': return `id:${node.name}`;
    case 'Member':
      return node.computed
        ? `mem:${exprKey(node.object)}[${exprKey(node.property)}]`
        : `mem:${exprKey(node.object)}.${node.property}`;
    case 'Unary': return `un:${node.op}(${exprKey(node.arg)})`;
    case 'Binary': return `bin:${node.op}(${exprKey(node.left)},${exprKey(node.right)})`;
    case 'Array': return `arr:[${node.elements.map(exprKey).join(',')}]`;
    case 'Object':
      return `obj:{${node.props.map((p) => (p.spread ? `...${exprKey(p.value)}` : `${p.key}:${exprKey(p.value)}`)).sort().join(',')}}`;
    default: return null;
  }
}

/** Attempt constant-folding an AST expression given known constant local bindings. */
function evalConst(node, constEnv) {
  if (!node) return { known: false };
  if (node.kind === 'Literal') {
    return { known: true, value: node.value, litType: node.litType };
  }
  if (node.kind === 'Id') {
    if (constEnv.has(node.name)) return constEnv.get(node.name);
    return { known: false };
  }
  if (node.kind === 'Array') {
    const vals = [];
    for (const el of node.elements) {
      if (el.kind === 'Spread') return { known: false };
      const c = evalConst(el, constEnv);
      if (!c.known) return { known: false };
      vals.push(c.value);
    }
    return { known: true, value: vals, litType: 'array' };
  }
  if (node.kind === 'Object') {
    const obj = {};
    for (const p of node.props) {
      if (p.spread) return { known: false };
      const c = evalConst(p.value, constEnv);
      if (!c.known) return { known: false };
      obj[p.key] = c.value;
    }
    return { known: true, value: obj, litType: 'object' };
  }
  if (node.kind === 'Member' && !node.computed) {
    const obj = evalConst(node.object, constEnv);
    if (obj.known && obj.value !== null && obj.value !== undefined) {
      if (node.property === 'length' && (typeof obj.value === 'string' || Array.isArray(obj.value))) {
        return { known: true, value: obj.value.length, litType: 'number' };
      }
      if (obj.litType === 'object' && Object.prototype.hasOwnProperty.call(obj.value, node.property)) {
        return { known: true, value: obj.value[node.property], litType: typeof obj.value[node.property] };
      }
    }
    return { known: false };
  }
  if (node.kind === 'Unary') {
    const inner = evalConst(node.arg, constEnv);
    if (!inner.known) return { known: false };
    switch (node.op) {
      case '!': return { known: true, value: !inner.value, litType: 'boolean' };
      case '-': return { known: true, value: -inner.value, litType: 'number' };
      case '+': return { known: true, value: +inner.value, litType: 'number' };
      case 'typeof': return { known: true, value: typeof inner.value, litType: 'string' };
      case 'void': return { known: true, value: undefined, litType: 'undefined' };
      default: return { known: false };
    }
  }
  if (node.kind === 'Binary') {
    // Check `x || !x` and `a === b || a !== b` tautologies even when `x` is dynamic!
    if (node.op === '||') {
      if (isComplementaryPair(node.left, node.right)) {
        return { known: true, value: true, litType: 'boolean', tautologicalDisjunction: true };
      }
    }
    if (node.op === '&&') {
      if (isComplementaryPair(node.left, node.right)) {
        return { known: true, value: false, litType: 'boolean', tautologicalConjunction: true };
      }
    }
    if (['===', '==', '!==', '!='].includes(node.op)) {
      const lk = exprKey(node.left);
      const rk = exprKey(node.right);
      if (lk && rk && lk === rk) {
        const isEq = node.op === '===' || node.op === '==';
        return { known: true, value: isEq, litType: 'boolean', reflexive: true };
      }
    }
    const l = evalConst(node.left, constEnv);
    const r = evalConst(node.right, constEnv);
    if (!l.known || !r.known) return { known: false };
    switch (node.op) {
      case '+': return { known: true, value: l.value + r.value, litType: typeof (l.value + r.value) };
      case '-': return { known: true, value: l.value - r.value, litType: 'number' };
      case '*': return { known: true, value: l.value * r.value, litType: 'number' };
      case '/': return { known: true, value: l.value / r.value, litType: 'number' };
      case '%': return { known: true, value: l.value % r.value, litType: 'number' };
      case '**': return { known: true, value: l.value ** r.value, litType: 'number' };
      case '===': return { known: true, value: l.value === r.value, litType: 'boolean' };
      case '!==': return { known: true, value: l.value !== r.value, litType: 'boolean' };
      case '==': return { known: true, value: l.value == r.value, litType: 'boolean' };
      case '!=': return { known: true, value: l.value != r.value, litType: 'boolean' };
      case '<': return { known: true, value: l.value < r.value, litType: 'boolean' };
      case '<=': return { known: true, value: l.value <= r.value, litType: 'boolean' };
      case '>': return { known: true, value: l.value > r.value, litType: 'boolean' };
      case '>=': return { known: true, value: l.value >= r.value, litType: 'boolean' };
      case '&&': return { known: true, value: l.value && r.value, litType: 'boolean' };
      case '||': return { known: true, value: l.value || r.value, litType: 'boolean' };
      case '??': return { known: true, value: l.value ?? r.value, litType: typeof (l.value ?? r.value) };
      default: return { known: false };
    }
  }
  return { known: false };
}

function isComplementaryPair(a, b) {
  if (!a || !b) return false;
  if (b.kind === 'Unary' && b.op === '!' && exprKey(a) && exprKey(a) === exprKey(b.arg)) return true;
  if (a.kind === 'Unary' && a.op === '!' && exprKey(b) && exprKey(b) === exprKey(a.arg)) return true;
  if (a.kind === 'Binary' && b.kind === 'Binary') {
    const opp = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
    if (opp[a.op] === b.op && exprKey(a.left) && exprKey(a.left) === exprKey(b.left) && exprKey(a.right) === exprKey(b.right)) {
      return true;
    }
  }
  return false;
}

/** True if node is statically guaranteed non-nullish / truthy object literal (e.g. `[]`, `{}`, `new ...` literal). */
function isAlwaysTruthyContainer(node) {
  return node?.kind === 'Array' || node?.kind === 'Object' || node?.kind === 'Function';
}

/** Check whether an AST node contains any non-trivial call / constructor / non-test identifier reference. */
function exprCallsSubject(node, localLiterals) {
  if (!node) return false;
  switch (node.kind) {
    case 'Call': {
      const root = rootId(node.callee);
      if (root && !TEST_ONLY_IDENTIFIERS.has(root) && !localLiterals.has(root)) return true;
      // Method on array/object literal like `[1, 2].map(...)` does not count,
      // while `client.get('/x')` or `JSON.parse(raw)` on dynamic data does.
      if (root === 'JSON') return node.args.some((a) => exprCallsSubject(a, localLiterals));
      return exprCallsSubject(node.callee, localLiterals) || node.args.some((a) => exprCallsSubject(a, localLiterals));
    }
    case 'New': {
      const root = rootId(node.callee);
      if (root && !TEST_ONLY_IDENTIFIERS.has(root)) return true;
      return node.args.some((a) => exprCallsSubject(a, localLiterals));
    }
    case 'Await': return exprCallsSubject(node.arg, localLiterals);
    case 'Id': return !TEST_ONLY_IDENTIFIERS.has(node.name) && !localLiterals.has(node.name);
    case 'Member':
      return exprCallsSubject(node.object, localLiterals) ||
        (node.computed ? exprCallsSubject(node.property, localLiterals) : false);
    case 'Unary': return exprCallsSubject(node.arg, localLiterals);
    case 'Binary': return exprCallsSubject(node.left, localLiterals) || exprCallsSubject(node.right, localLiterals);
    case 'Conditional':
      return exprCallsSubject(node.test, localLiterals) ||
        exprCallsSubject(node.consequent, localLiterals) ||
        exprCallsSubject(node.alternate, localLiterals);
    case 'Array': return node.elements.some((e) => exprCallsSubject(e, localLiterals));
    case 'Object': return node.props.some((p) => exprCallsSubject(p.value, localLiterals));
    case 'Spread': return exprCallsSubject(node.arg, localLiterals);
    case 'Template': return (node.exprSources ?? []).length > 0;
    case 'Function':
      if (node.exprBody) return exprCallsSubject(node.exprBody, localLiterals);
      if (node.bodyTokens?.length) {
        return node.bodyTokens.some((tk) => tk.type === 'id' && !TEST_ONLY_IDENTIFIERS.has(tk.value) && !localLiterals.has(tk.value));
      }
      return false;
    default: return false;
  }
}

function rootId(node) {
  let cur = node;
  while (cur?.kind === 'Member') cur = cur.object;
  return cur?.kind === 'Id' ? cur.name : null;
}

/** Inspect an `expect(actual)[.not|.resolves|.rejects].matcher(expected)` call node. */
function unwrapExpectChain(callNode) {
  // Walk back along Member/Call chain to find `expect(actual)`
  const modifiers = [];
  let matcher = null;
  let matcherArgs = [];
  if (callNode.kind === 'Call' && callNode.callee?.kind === 'Member' && !callNode.callee.computed) {
    matcher = callNode.callee.property;
    matcherArgs = callNode.args ?? [];
    let cur = callNode.callee.object;
    while (cur?.kind === 'Member' && !cur.computed) {
      modifiers.unshift(cur.property);
      cur = cur.object;
    }
    if (cur?.kind === 'Call' && cur.callee?.kind === 'Id' && cur.callee.name === 'expect') {
      return {
        style: 'expect',
        actual: cur.args[0] ?? null,
        modifiers,
        negated: modifiers.includes('not'),
        matcher,
        expected: matcherArgs[0] ?? null,
        matcherArgs
      };
    }
  }
  // `assert(expr)` or `assert.<method>(a, b)`
  if (callNode.kind === 'Call') {
    if (callNode.callee?.kind === 'Id' && callNode.callee.name === 'assert') {
      return {
        style: 'assert',
        method: 'ok',
        actual: callNode.args[0] ?? null,
        expected: null,
        args: callNode.args
      };
    }
    if (
      callNode.callee?.kind === 'Member' &&
      !callNode.callee.computed &&
      callNode.callee.object?.kind === 'Id' &&
      callNode.callee.object.name === 'assert' &&
      ASSERT_METHODS.has(callNode.callee.property)
    ) {
      return {
        style: 'assert',
        method: callNode.callee.property,
        actual: callNode.args[0] ?? null,
        expected: callNode.args[1] ?? null,
        args: callNode.args
      };
    }
  }
  return null;
}

/** Classify a parsed assertion descriptor as genuine or tautological. */
function classifyAssertion(desc, constEnv) {
  if (desc.style === 'expect') {
    const { actual, expected, matcher, negated, modifiers } = desc;
    // Promise modifiers `.rejects.toThrow(...)` / `.resolves.toBe(...)`
    if (THROW_MATCHERS.has(matcher) || modifiers.includes('rejects')) {
      if (!actual) return { ok: false, reason: 'literal-tautology', detail: `expect().${matcher}() has no target` };
      // `expect(() => {}).not.toThrow()` — empty function!
      if (actual.kind === 'Function' && !actual.exprBody && (!actual.bodyTokens || actual.bodyTokens.length === 0)) {
        return { ok: false, reason: 'literal-tautology', detail: `expect(() => {}).${negated ? 'not.' : ''}${matcher}() checks an empty closure` };
      }
      // `expect(() => { throw new Error('x'); }).toThrow()` — literal self-throw with zero calls!
      if (actual.kind === 'Function' && actual.bodyTokens?.length && !negated) {
        const hasNonErrorCall = actual.bodyTokens.some(
          (tk, idx) => tk.type === 'id' && !TEST_ONLY_IDENTIFIERS.has(tk.value) && (actual.bodyTokens[idx + 1]?.value === '(' || actual.bodyTokens[idx + 1]?.value === '.')
        );
        const startsWithThrow = actual.bodyTokens[0]?.type === 'kw' && actual.bodyTokens[0].value === 'throw';
        if (startsWithThrow && !hasNonErrorCall) {
          return { ok: false, reason: 'literal-tautology', detail: 'expect(() => { throw new Error() }).toThrow() only catches its own inline throw' };
        }
      }
      return { ok: true, coupled: exprCallsSubject(actual, constEnv) };
    }

    const actConst = evalConst(actual, constEnv);
    const expConst = expected ? evalConst(expected, constEnv) : { known: false };

    if (EQUALITY_MATCHERS.has(matcher)) {
      const ak = exprKey(actual);
      const ek = exprKey(expected);
      if (!negated && ak && ek && ak === ek) {
        return { ok: false, reason: 'reflexive-comparison', detail: `expect(x).${matcher}(x) compares identical expression (${ak})` };
      }
      if (actConst.known && (expConst.known || !expected)) {
        const reason = actual?.kind === 'Id' ? 'constant-binding-tautology' : actConst.tautologicalDisjunction ? 'tautological-boolean' : actConst.reflexive ? 'reflexive-comparison' : 'literal-tautology';
        return { ok: false, reason, detail: `expect(<constant>).${negated ? 'not.' : ''}${matcher}(<constant>) observes only hardcoded literals` };
      }
      if (isAlwaysTruthyContainer(actual) && isAlwaysTruthyContainer(expected)) {
        return { ok: false, reason: 'literal-tautology', detail: `expect(<literal>).${matcher}(<literal>) compares inline literals` };
      }
      return { ok: true, coupled: exprCallsSubject(actual, constEnv) || exprCallsSubject(expected, constEnv) };
    }

    if (TRUTHY_MATCHERS.has(matcher) || FALSY_MATCHERS.has(matcher) || DEFINED_MATCHERS.has(matcher)) {
      if (actConst.known) {
        const reason = actConst.tautologicalDisjunction ? 'tautological-boolean' : actConst.reflexive ? 'reflexive-comparison' : actual?.kind === 'Id' ? 'constant-binding-tautology' : 'literal-tautology';
        return { ok: false, reason, detail: `expect(<constant>).${negated ? 'not.' : ''}${matcher}() evaluates a constant expression` };
      }
      if (!negated && (TRUTHY_MATCHERS.has(matcher) || DEFINED_MATCHERS.has(matcher)) && isAlwaysTruthyContainer(actual)) {
        return { ok: false, reason: 'always-truthy', detail: `expect(<container literal>).${matcher}() is unconditionally true` };
      }
      if (!negated && DEFINED_MATCHERS.has(matcher) && actual?.kind === 'Unary' && actual.op === 'typeof') {
        return { ok: false, reason: 'always-truthy', detail: `expect(typeof x).${matcher}() is always true` };
      }
      return { ok: true, coupled: exprCallsSubject(actual, constEnv) };
    }

    if (RELATIONAL_MATCHERS.has(matcher) || CONTAIN_MATCHERS.has(matcher)) {
      if (actConst.known && (!expected || expConst.known)) {
        return { ok: false, reason: 'literal-tautology', detail: `expect(<constant>).${matcher}(<constant>) tests only literals` };
      }
      return { ok: true, coupled: exprCallsSubject(actual, constEnv) || exprCallsSubject(expected, constEnv) };
    }

    // Custom matcher: still reject `expect(true).anything()` / `expect(1).foo(1)` when all constant
    if (actConst.known && (!expected || expConst.known)) {
      return { ok: false, reason: 'literal-tautology', detail: `expect(<constant>).${matcher}() has no dynamic input` };
    }
    return { ok: true, coupled: exprCallsSubject(actual, constEnv) };
  }

  // `node:assert` style
  const { method, actual, expected } = desc;
  if (method === 'fail') {
    // `assert.fail(...)` inside a conditional branch is a real assertion guard!
    return { ok: true, coupled: true, isFailGuard: true };
  }
  if (THROW_MATCHERS.has(method)) {
    if (!actual) return { ok: false, reason: 'literal-tautology', detail: `assert.${method}() has no target` };
    if (actual.kind === 'Function' && !actual.exprBody && (!actual.bodyTokens || actual.bodyTokens.length === 0)) {
      return { ok: false, reason: 'literal-tautology', detail: `assert.${method}(() => {}) checks an empty function` };
    }
    if (actual.kind === 'Function' && actual.bodyTokens?.length && (method === 'throws' || method === 'rejects')) {
      const hasNonErrorCall = actual.bodyTokens.some(
        (tk, idx) => tk.type === 'id' && !TEST_ONLY_IDENTIFIERS.has(tk.value) && (actual.bodyTokens[idx + 1]?.value === '(' || actual.bodyTokens[idx + 1]?.value === '.')
      );
      if (actual.bodyTokens[0]?.value === 'throw' && !hasNonErrorCall) {
        return { ok: false, reason: 'literal-tautology', detail: `assert.${method}(() => { throw ... }) only catches its own inline throw` };
      }
    }
    return { ok: true, coupled: exprCallsSubject(actual, constEnv) };
  }

  const actConst = evalConst(actual, constEnv);
  const expConst = expected ? evalConst(expected, constEnv) : { known: false };

  if (EQUALITY_MATCHERS.has(method)) {
    const ak = exprKey(actual);
    const ek = exprKey(expected);
    if (ak && ek && ak === ek) {
      return { ok: false, reason: 'reflexive-comparison', detail: `assert.${method}(x, x) compares identical expression (${ak})` };
    }
    if (actConst.known && expConst.known) {
      const reason = (actual?.kind === 'Id' || expected?.kind === 'Id') ? 'constant-binding-tautology' : 'literal-tautology';
      return { ok: false, reason, detail: `assert.${method}(<constant>, <constant>) compares only constant values` };
    }
    return { ok: true, coupled: exprCallsSubject(actual, constEnv) || exprCallsSubject(expected, constEnv) };
  }

  if (INEQUALITY_MATCHERS.has(method)) {
    if (actConst.known && expConst.known) {
      return { ok: false, reason: 'literal-tautology', detail: `assert.${method}(<constant>, <constant>) compares only constant values` };
    }
    return { ok: true, coupled: exprCallsSubject(actual, constEnv) || exprCallsSubject(expected, constEnv) };
  }

  if (method === 'ok' || method === 'isTrue' || method === 'isFalse' || method === 'isDefined' || method === 'isNotNull') {
    if (!actual || actConst.known) {
      const reason = actConst.reflexive
        ? 'reflexive-comparison'
        : actConst.tautologicalDisjunction
          ? 'tautological-boolean'
          : actual?.kind === 'Id'
            ? 'constant-binding-tautology'
            : 'literal-tautology';
      return { ok: false, reason, detail: `assert.${method}(<constant>) is statically determined` };
    }
    if (method !== 'isFalse' && isAlwaysTruthyContainer(actual)) {
      return { ok: false, reason: 'always-truthy', detail: `assert.${method}(<container literal>) is unconditionally truthy` };
    }
    return { ok: true, coupled: exprCallsSubject(actual, constEnv) };
  }

  if (actConst.known && (!expected || expConst.known)) {
    return { ok: false, reason: 'literal-tautology', detail: `assert.${method}(<constant>) tests only constant literals` };
  }
  return { ok: true, coupled: exprCallsSubject(actual, constEnv) || exprCallsSubject(expected, constEnv) };
}

/** Extract the body token slice of the test callback starting at the first callback `{` or `=>`. */
function extractCallbackBodyTokens(scopeTokens) {
  // Find test/it registration call `test('name', [opts,] [async] (...) => { ... })`
  // or `function testFoo() { ... }`.
  for (let i = 0; i < scopeTokens.length; i += 1) {
    const tk = scopeTokens[i];
    if (tk.type === 'op' && tk.value === '=>') {
      if (scopeTokens[i + 1]?.type === 'punc' && scopeTokens[i + 1].value === '{') {
        return sliceBraceBlock(scopeTokens, i + 1);
      }
      // Concise arrow body `test('x', () => expect(true).toBe(true))`
      let end = scopeTokens.length;
      if (scopeTokens[end - 1]?.value === ';') end -= 1;
      if (scopeTokens[end - 1]?.value === ')') end -= 1;
      return scopeTokens.slice(i + 1, end);
    }
    if (tk.type === 'kw' && tk.value === 'function' && i > 0) {
      // `test('x', function () { ... })`
      let j = i + 1;
      while (j < scopeTokens.length && scopeTokens[j].value !== '{') j += 1;
      if (j < scopeTokens.length) return sliceBraceBlock(scopeTokens, j);
    }
  }
  // Named `function testFoo() { ... }`
  const firstBrace = scopeTokens.findIndex((t) => t.type === 'punc' && t.value === '{');
  if (firstBrace >= 0) return sliceBraceBlock(scopeTokens, firstBrace);
  return scopeTokens;
}

function sliceBraceBlock(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    if (tokens[i].type === 'punc' && tokens[i].value === '{') depth += 1;
    else if (tokens[i].type === 'punc' && tokens[i].value === '}') {
      depth -= 1;
      if (depth === 0) return tokens.slice(openIdx + 1, i);
    }
  }
  return tokens.slice(openIdx + 1);
}

/**
 * Analyze a JS/TS test scope body for genuine, reachable, subject-coupled assertions.
 *
 * @param {string} scopeBody   Source slice of the test function (lines startLine..endLine).
 * @param {object} [opts]
 * @param {string} [opts.fileSource] Full test file source (for import resolution).
 * @returns {{
 *   valid: boolean,
 *   genuineCount: number,
 *   tautologyCount: number,
 *   swallowedCount: number,
 *   unreachableCount: number,
 *   subjectCoupled: boolean,
 *   findings: Array<{ reason: string, detail: string }>
 * }}
 */
export function analyzeJsTestScope(scopeBody, { fileSource = '' } = {}) {
  const imported = collectFileImports(fileSource);
  const scopeTokens = tokenizeJs(scopeBody);
  const bodyTokens = extractCallbackBodyTokens(scopeTokens);

  const constEnv = new Map();
  const mutablePoisoned = new Set();
  const assertions = [];
  const findings = [];
  let hasExternalAction = false;

  // Walk statements in a block tracking reachability, try/empty-catch swallowing, and local bindings.
  function walkBlock(tokens, { inSwallowedTry = false, conditional = false } = {}) {
    let i = 0;
    let unreachable = false;

    while (i < tokens.length) {
      const tk = tokens[i];
      if (!tk) break;
      if (tk.type === 'punc' && (tk.value === ';' || tk.value === ',')) { i += 1; continue; }

      // Track unconditional `return` / `throw` (at non-conditional block level)
      if (!conditional && tk.type === 'kw' && (tk.value === 'return' || tk.value === 'throw')) {
        i += 1;
        // Parse the returned/thrown expression too (e.g. `return expect(fn()).resolves.toBe(1)`)
        const stmtEnd = findStatementEnd(tokens, i);
        scanExpressionSlice(tokens.slice(i, stmtEnd), { unreachable, inSwallowedTry, conditional });
        unreachable = true;
        i = stmtEnd + 1;
        continue;
      }

      // `try { ... } catch [(e)] { ... } [finally { ... }]`
      if (tk.type === 'kw' && tk.value === 'try' && tokens[i + 1]?.value === '{') {
        const tryInner = sliceBraceBlock(tokens, i + 1);
        let nextIdx = i + 3 + tryInner.length;
        let catchSwallows = false;
        let catchInner = null;
        if (tokens[nextIdx]?.type === 'kw' && tokens[nextIdx].value === 'catch') {
          let cIdx = nextIdx + 1;
          if (tokens[cIdx]?.value === '(') {
            const p = new ExprParser(tokens, cIdx, tokens.length);
            p.skipBalanced('(', ')');
            cIdx = p.pos;
          }
          if (tokens[cIdx]?.value === '{') {
            catchInner = sliceBraceBlock(tokens, cIdx);
            nextIdx = cIdx + 1 + catchInner.length + 1;
            // Empty catch (or comment/console-only catch) without throw/assert swallows assertions!
            const catchRethrowsOrAsserts = catchInner.some(
              (ct) => (ct.type === 'kw' && ct.value === 'throw') || (ct.type === 'id' && (ct.value === 'assert' || ct.value === 'expect'))
            );
            if (!catchRethrowsOrAsserts) catchSwallows = true;
          }
        }
        walkBlock(tryInner, { inSwallowedTry: inSwallowedTry || catchSwallows, conditional: true });
        if (catchInner) walkBlock(catchInner, { inSwallowedTry, conditional: true });
        if (tokens[nextIdx]?.type === 'kw' && tokens[nextIdx].value === 'finally' && tokens[nextIdx + 1]?.value === '{') {
          const finInner = sliceBraceBlock(tokens, nextIdx + 1);
          walkBlock(finInner, { inSwallowedTry, conditional });
          nextIdx = nextIdx + 2 + finInner.length;
        }
        i = nextIdx;
        continue;
      }

      // `if (cond) { ... } [else ...]`
      if (tk.type === 'kw' && tk.value === 'if' && tokens[i + 1]?.value === '(') {
        const p = new ExprParser(tokens, i + 1, tokens.length);
        const condTokens = p.skipBalanced('(', ')');
        const condExpr = new ExprParser(condTokens).parseExpression();
        const condConst = evalConst(condExpr, constEnv);
        if (exprCallsSubject(condExpr, constEnv)) hasExternalAction = true;
        let cur = p.pos;
        const deadThen = condConst.known && !condConst.value;
        if (tokens[cur]?.value === '{') {
          const thenInner = sliceBraceBlock(tokens, cur);
          if (deadThen) {
            // Assertions inside `if (false) { assert... }` are unreachable!
            const before = assertions.length;
            walkBlock(thenInner, { inSwallowedTry, conditional: true });
            for (let k = before; k < assertions.length; k += 1) {
              assertions[k].unreachable = true;
              findings.push({ reason: 'unreachable-assertion', detail: 'assertion is inside a statically false branch' });
            }
          } else {
            walkBlock(thenInner, { inSwallowedTry, conditional: true });
          }
          cur = cur + 1 + thenInner.length + 1;
        } else {
          const stmtEnd = findStatementEnd(tokens, cur);
          scanExpressionSlice(tokens.slice(cur, stmtEnd), { unreachable: unreachable || deadThen, inSwallowedTry, conditional: true });
          cur = stmtEnd + 1;
        }
        if (tokens[cur]?.type === 'kw' && tokens[cur].value === 'else') {
          cur += 1;
          if (tokens[cur]?.value === '{') {
            const elseInner = sliceBraceBlock(tokens, cur);
            walkBlock(elseInner, { inSwallowedTry, conditional: true });
            cur = cur + 1 + elseInner.length + 1;
          } else {
            i = cur;
            continue;
          }
        }
        i = cur;
        continue;
      }

      // Loops `for` / `while`
      if (tk.type === 'kw' && (tk.value === 'for' || tk.value === 'while')) {
        let cur = i + 1;
        if (tokens[cur]?.type === 'kw' && tokens[cur].value === 'await') cur += 1;
        if (tokens[cur]?.value === '(') {
          const p = new ExprParser(tokens, cur, tokens.length);
          const header = p.skipBalanced('(', ')');
          // Check loop iterable for dynamic subject call; guard `while (false)` / `for (const x of [])`
          const deadLoop =
            (tk.value === 'while' && header.length === 1 && header[0].value === 'false') ||
            (header.some((h) => h.value === 'of') &&
              header[header.length - 2]?.value === '[' &&
              header[header.length - 1]?.value === ']');
          if (header.some((h) => h.type === 'id' && !TEST_ONLY_IDENTIFIERS.has(h.value) && !constEnv.has(h.value))) {
            hasExternalAction = true;
          }
          cur = p.pos;
          if (tokens[cur]?.value === '{') {
            const loopBody = sliceBraceBlock(tokens, cur);
            // Any variable mutated inside a loop is no longer statically constant.
            invalidateAssignedIds(loopBody);
            const before = assertions.length;
            walkBlock(loopBody, { inSwallowedTry, conditional: true });
            if (deadLoop) {
              for (let k = before; k < assertions.length; k += 1) {
                assertions[k].unreachable = true;
                findings.push({ reason: 'unreachable-assertion', detail: 'assertion is inside a zero-iteration loop' });
              }
            }
            i = cur + 1 + loopBody.length + 1;
            continue;
          }
        }
      }

      // Variable declaration `const/let/var name [: Type] = expr`
      if (tk.type === 'kw' && (tk.value === 'const' || tk.value === 'let' || tk.value === 'var')) {
        const kind = tk.value;
        const stmtEnd = findStatementEnd(tokens, i + 1);
        const declTokens = tokens.slice(i + 1, stmtEnd);
        const eqIdx = findTopLevelOp(declTokens, '=');
        if (eqIdx > 0 && declTokens[0]?.type === 'id') {
          const varName = declTokens[0].value;
          const rhsTokens = declTokens.slice(eqIdx + 1);
          const rhsExpr = new ExprParser(rhsTokens).parseExpression();
          scanAstForCallsAndAssertions(rhsExpr, { unreachable, inSwallowedTry });
          const folded = evalConst(rhsExpr, constEnv);
          if (folded.known && !mutablePoisoned.has(varName)) {
            constEnv.set(varName, { ...folded, mutable: kind !== 'const' });
          } else {
            constEnv.delete(varName);
          }
        } else if (eqIdx > 0) {
          const rhsExpr = new ExprParser(declTokens.slice(eqIdx + 1)).parseExpression();
          scanAstForCallsAndAssertions(rhsExpr, { unreachable, inSwallowedTry });
        }
        i = stmtEnd + 1;
        continue;
      }

      // Nested function / helper declaration — skip registration as top-level assertion,
      // unless it is a nested `await t.test(...)` subtest callback.
      if (tk.type === 'kw' && tk.value === 'function' && tokens[i + 1]?.type === 'id') {
        let cur = i + 2;
        if (tokens[cur]?.value === '(') {
          const p = new ExprParser(tokens, cur, tokens.length);
          p.skipBalanced('(', ')');
          cur = p.pos;
        }
        if (tokens[cur]?.value === '{') {
          const fnBody = sliceBraceBlock(tokens, cur);
          i = cur + 1 + fnBody.length + 1;
          continue;
        }
      }

      // Standalone block `{ ... }`
      if (tk.type === 'punc' && tk.value === '{') {
        const inner = sliceBraceBlock(tokens, i);
        walkBlock(inner, { inSwallowedTry, conditional });
        i = i + 1 + inner.length + 1;
        continue;
      }

      // Assignment/mutation to existing constEnv variable (`x = fn()`, `arr.push(...)`, `count++`)
      if (tk.type === 'id' && constEnv.has(tk.value)) {
        const nxt = tokens[i + 1];
        if (nxt?.type === 'op' && ['=', '+=', '-=', '*=', '/=', '++', '--'].includes(nxt.value)) {
          constEnv.delete(tk.value);
          mutablePoisoned.add(tk.value);
        } else if (nxt?.value === '.' && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'add', 'delete'].includes(tokens[i + 2]?.value)) {
          // Mutating a purely local literal array (`const a = [1]; a.push(2)`) — check if argument is constant!
          const stmtEnd = findStatementEnd(tokens, i);
          const expr = new ExprParser(tokens.slice(i, stmtEnd)).parseExpression();
          const allConstArgs = expr.kind === 'Call' && expr.args.every((a) => evalConst(a, constEnv).known);
          if (allConstArgs && nxt.value === '.' && tokens[i + 2]?.value === 'push') {
            const cur = constEnv.get(tk.value);
            if (cur?.litType === 'array') {
              constEnv.set(tk.value, {
                known: true,
                litType: 'array',
                value: [...cur.value, ...expr.args.map((a) => evalConst(a, constEnv).value)]
              });
              i = stmtEnd + 1;
              continue;
            }
          }
          constEnv.delete(tk.value);
        }
      }

      // Ordinary expression statement
      const stmtEnd = findStatementEnd(tokens, i);
      scanExpressionSlice(tokens.slice(i, Math.max(i + 1, stmtEnd)), { unreachable, inSwallowedTry, conditional });
      i = Math.max(i + 1, stmtEnd + 1);
    }
  }

  function invalidateAssignedIds(tokens) {
    for (let j = 0; j < tokens.length - 1; j += 1) {
      if (tokens[j].type === 'id' && tokens[j + 1].type === 'op' && ['=', '+=', '-=', '*=', '/=', '++', '--'].includes(tokens[j + 1].value)) {
        constEnv.delete(tokens[j].value);
        mutablePoisoned.add(tokens[j].value);
      }
    }
  }

  function findTopLevelOp(tokens, opVal) {
    let depth = 0;
    for (let j = 0; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.type === 'punc' && '([{'.includes(t.value)) depth += 1;
      else if (t.type === 'punc' && ')]}'.includes(t.value)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && t.type === 'op' && t.value === opVal) return j;
    }
    return -1;
  }

  function findStatementEnd(tokens, start) {
    let depth = 0;
    for (let j = start; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.type === 'punc' && '([{'.includes(t.value)) depth += 1;
      else if (t.type === 'punc' && ')]}'.includes(t.value)) depth = Math.max(0, depth - 1);
      else if (depth === 0 && t.type === 'punc' && t.value === ';') return j;
      else if (depth === 0 && j > start && tokens[j].line > tokens[j - 1].line) {
        const prev = tokens[j - 1];
        const contPrev = prev.type === 'op' || (prev.type === 'punc' && ['.', ',', '('].includes(prev.value)) || (prev.type === 'kw' && ['await', 'return', 'throw', 'new', 'typeof'].includes(prev.value));
        const contCur = (t.type === 'punc' && ['.', '[', '('].includes(t.value)) || (t.type === 'op' && ['?.', '||', '&&', '??', '?', ':', '+', '-', '===', '!==', '==', '!='].includes(t.value));
        if (!contPrev && !contCur) return j;
      }
    }
    return tokens.length;
  }

  function scanExpressionSlice(slice, ctx) {
    if (slice.length === 0) return;
    const parser = new ExprParser(slice);
    while (parser.pos < parser.end) {
      const before = parser.pos;
      const expr = parser.parseExpression();
      scanAstForCallsAndAssertions(expr, ctx);
      if (parser.pos === before) parser.pos += 1;
    }
  }

  function scanAstForCallsAndAssertions(node, ctx) {
    if (!node) return;
    if (node.kind === 'Await') {
      scanAstForCallsAndAssertions(node.arg, ctx);
      return;
    }
    if (node.kind === 'Call') {
      const desc = unwrapExpectChain(node);
      if (desc) {
        if (ctx.unreachable) {
          assertions.push({ ok: false, unreachable: true });
          findings.push({ reason: 'unreachable-assertion', detail: 'assertion is unreachable (after return/throw)' });
          return;
        }
        if (ctx.inSwallowedTry) {
          assertions.push({ ok: false, swallowed: true });
          findings.push({ reason: 'swallowed-assertion', detail: 'assertion is inside a try block with an empty catch' });
          return;
        }
        const verdict = classifyAssertion(desc, constEnv);
        if (!verdict.ok) {
          assertions.push({ ok: false, tautology: true });
          findings.push({ reason: verdict.reason, detail: verdict.detail });
        } else {
          // Inspect callback bodies passed to `assert.throws(() => fn())` for subject calls too.
          if (verdict.coupled) hasExternalAction = true;
          assertions.push({ ok: true, coupled: verdict.coupled });
        }
        return;
      }

      // Nested `t.test('sub', async () => { ... })` subtest
      if (
        node.callee?.kind === 'Member' &&
        node.callee.object?.kind === 'Id' &&
        node.callee.object.name === 't' &&
        node.callee.property === 'test'
      ) {
        const cb = node.args.find((a) => a.kind === 'Function');
        if (cb?.bodyTokens) walkBlock(cb.bodyTokens, ctx);
        else if (cb?.exprBody) scanAstForCallsAndAssertions(cb.exprBody, ctx);
        return;
      }

      // Non-test call marks test as exercising external/subject logic!
      const root = rootId(node.callee);
      if (root && (imported.has(root) || (!TEST_ONLY_IDENTIFIERS.has(root) && !constEnv.has(root)))) {
        hasExternalAction = true;
      }
      scanAstForCallsAndAssertions(node.callee, ctx);
      for (const arg of node.args) {
        if (arg.kind === 'Function' && arg.bodyTokens && ['all', 'allSettled', 'forEach', 'map', 'some', 'every', 'filter'].includes(node.callee?.property)) {
          walkBlock(arg.bodyTokens, { ...ctx, conditional: true });
        } else {
          scanAstForCallsAndAssertions(arg, ctx);
        }
      }
      return;
    }
    if (node.kind === 'New') {
      const root = rootId(node.callee);
      if (root && !TEST_ONLY_IDENTIFIERS.has(root)) hasExternalAction = true;
      for (const arg of node.args) scanAstForCallsAndAssertions(arg, ctx);
      return;
    }
    if (node.kind === 'Binary') {
      scanAstForCallsAndAssertions(node.left, ctx);
      scanAstForCallsAndAssertions(node.right, ctx);
    } else if (node.kind === 'Unary' || node.kind === 'Spread') {
      scanAstForCallsAndAssertions(node.arg, ctx);
    } else if (node.kind === 'Conditional') {
      scanAstForCallsAndAssertions(node.test, ctx);
      scanAstForCallsAndAssertions(node.consequent, ctx);
      scanAstForCallsAndAssertions(node.alternate, ctx);
    } else if (node.kind === 'Member') {
      const root = rootId(node);
      if (root && imported.has(root)) hasExternalAction = true;
      scanAstForCallsAndAssertions(node.object, ctx);
      if (node.computed) scanAstForCallsAndAssertions(node.property, ctx);
    } else if (node.kind === 'Array') {
      for (const el of node.elements) scanAstForCallsAndAssertions(el, ctx);
    } else if (node.kind === 'Object') {
      for (const p of node.props) scanAstForCallsAndAssertions(p.value, ctx);
    }
  }

  walkBlock(bodyTokens);

  // Also credit direct references to imported module constants/objects inside bodyTokens.
  if (!hasExternalAction && imported.size > 0) {
    hasExternalAction = bodyTokens.some((tk) => tk.type === 'id' && imported.has(tk.value));
  }

  const genuine = assertions.filter((a) => a.ok);
  const tautologyCount = assertions.filter((a) => a.tautology).length;
  const swallowedCount = assertions.filter((a) => a.swallowed).length;
  const unreachableCount = assertions.filter((a) => a.unreachable).length;
  const subjectCoupled = hasExternalAction || genuine.some((g) => g.coupled);

  if (genuine.length === 0 && findings.length === 0) {
    findings.push({ reason: 'no-assertion', detail: 'test body contains no assertion call' });
  } else if (genuine.length > 0 && !subjectCoupled) {
    findings.push({
      reason: 'uncoupled-assertion',
      detail: 'assertions never observe any imported symbol, helper call, or system-under-test operation'
    });
  }

  return {
    valid: genuine.length > 0 && subjectCoupled,
    genuineCount: genuine.length,
    tautologyCount,
    swallowedCount,
    unreachableCount,
    subjectCoupled,
    findings
  };
}
