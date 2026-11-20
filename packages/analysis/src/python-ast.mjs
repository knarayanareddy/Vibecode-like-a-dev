/**
 * Python stdlib `ast`-based non-tautological assertion analyzer (roadmap P2.2).
 *
 * Uses Python 3's built-in `ast` module via a direct-argv subprocess (no shell,
 * no third-party pip packages) to inspect Python test functions for:
 *   - empty / assertion-free tests (`pass`, `print(...)`)
 *   - literal tautologies (`assert True`, `assert 1 == 1`, `assert 2 + 2 == 4`,
 *     `assert [1] == [1]`, `self.assertTrue(True)`, `self.assertEqual(1, 1)`)
 *   - constant-folded local variable tautologies (`x = 5; assert x == 5`)
 *   - reflexive self-comparisons (`assert x == x`, `self.assertEqual(a.b, a.b)`)
 *   - always-truthy container literals (`assert [1]`, `assert {"a": 1}`)
 *   - tautological disjunctions (`assert x or not x`)
 *   - swallowed assertions (`try: assert fn() == 1 except Exception: pass`)
 *   - unreachable assertions (after `return`/`raise` or under `if False:`)
 *   - uncoupled assertions (zero calls or references to any module/function under test)
 *
 * Falls back cleanly to a zero-dependency structural analyzer if `python3` is not
 * present on `PATH`.
 */

import { spawnSync } from 'node:child_process';

const PYTHON_AST_SCRIPT = String.raw`
import ast, json, sys

EQUALITY_METHODS = {"assertEqual", "assertEquals", "assertListEqual", "assertDictEqual", "assertSetEqual", "assertTupleEqual", "assertAlmostEqual", "assertIs"}
INEQUALITY_METHODS = {"assertNotEqual", "assertIsNot"}
TRUTHY_METHODS = {"assertTrue", "assertIsNotNone"}
FALSY_METHODS = {"assertFalse", "assertIsNone"}
RAISES_METHODS = {"assertRaises", "assertRaisesRegex"}
OTHER_ASSERT_METHODS = {"assertIn", "assertNotIn", "assertGreater", "assertGreaterEqual", "assertLess", "assertLessEqual", "assertRegex", "assertNotRegex", "assertCountEqual"}
BUILTIN_ONLY = {"len", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "range", "enumerate", "zip", "sorted", "reversed", "min", "max", "sum", "abs", "round", "print", "type", "isinstance", "hasattr", "getattr", "Exception", "ValueError", "TypeError", "RuntimeError", "KeyError", "AssertionError"}

def is_const(node, env):
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.Name):
        return node.id in env
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(is_const(e, env) for e in node.elts)
    if isinstance(node, ast.Dict):
        return all((k is None or is_const(k, env)) and is_const(v, env) for k, v in zip(node.keys, node.values))
    if isinstance(node, ast.UnaryOp):
        return is_const(node.operand, env)
    if isinstance(node, ast.BinOp):
        return is_const(node.left, env) and is_const(node.right, env)
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.Or) and len(node.values) == 2:
            a, b = node.values
            if isinstance(b, ast.UnaryOp) and isinstance(b.op, ast.Not) and ast.dump(a) == ast.dump(b.operand):
                return True
            if isinstance(a, ast.UnaryOp) and isinstance(a.op, ast.Not) and ast.dump(b) == ast.dump(a.operand):
                return True
        return all(is_const(v, env) for v in node.values)
    if isinstance(node, ast.Compare):
        if len(node.ops) == 1 and len(node.comparators) == 1:
            if ast.dump(node.left) == ast.dump(node.comparators[0]):
                return True
        return is_const(node.left, env) and all(is_const(c, env) for c in node.comparators)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"len", "str", "int", "float", "bool", "abs", "sum", "min", "max", "sorted"}:
        return all(is_const(a, env) for a in node.args) and not node.keywords
    return False

def is_reflexive_compare(node):
    return (
        isinstance(node, ast.Compare)
        and len(node.ops) == 1
        and len(node.comparators) == 1
        and ast.dump(node.left) == ast.dump(node.comparators[0])
    )

def has_subject_ref(node, env, params):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            if isinstance(sub.func, ast.Name):
                if sub.func.id not in BUILTIN_ONLY and sub.func.id not in {"pytest"}:
                    return True
            elif isinstance(sub.func, ast.Attribute):
                root = sub.func.value
                while isinstance(root, ast.Attribute):
                    root = root.value
                if isinstance(root, ast.Name) and root.id == "self" and sub.func.attr.startswith("assert"):
                    continue
                if isinstance(root, ast.Name) and root.id == "pytest":
                    continue
                if isinstance(root, ast.Name) and root.id in env:
                    continue
                return True
        elif isinstance(sub, ast.Name) and sub.id not in BUILTIN_ONLY and sub.id not in env and sub.id not in {"self", "cls", "pytest", "unittest"}:
            if sub.id in params or True:
                return True
    return False

def analyze_fn(fn, imported):
    env = set()
    params = {a.arg for a in fn.args.args if a.arg not in {"self", "cls"}}
    genuine = 0
    tautologies = 0
    swallowed = 0
    unreachable = 0
    coupled = bool(params)
    findings = []

    def check_calls_for_coupling(node):
        nonlocal coupled
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                if isinstance(sub.func, ast.Name) and sub.func.id not in BUILTIN_ONLY and sub.func.id != "pytest":
                    coupled = True
                elif isinstance(sub.func, ast.Attribute):
                    root = sub.func.value
                    while isinstance(root, ast.Attribute):
                        root = root.value
                    if isinstance(root, ast.Name) and root.id == "self" and sub.func.attr.startswith("assert"):
                        continue
                    if isinstance(root, ast.Name) and root.id == "pytest":
                        continue
                    if isinstance(root, ast.Name) and root.id in env:
                        continue
                    coupled = True
            elif isinstance(sub, ast.Name) and sub.id in imported:
                coupled = True

    def record(ok, reason=None, detail=None, is_unreach=False, is_swallow=False, expr_coupled=False):
        nonlocal genuine, tautologies, swallowed, unreachable, coupled
        if is_unreach:
            unreachable += 1
            findings.append({"reason": "unreachable-assertion", "detail": detail or "assertion is unreachable"})
        elif is_swallow:
            swallowed += 1
            findings.append({"reason": "swallowed-assertion", "detail": detail or "assertion swallowed by bare/empty except"})
        elif not ok:
            tautologies += 1
            findings.append({"reason": reason or "literal-tautology", "detail": detail or "tautological assertion"})
        else:
            genuine += 1
            if expr_coupled:
                coupled = True

    def walk_stmts(stmts, in_swallow=False, is_dead=False, top_level=False):
        dead = is_dead
        for st in stmts:
            if isinstance(st, (ast.Return, ast.Raise)):
                check_calls_for_coupling(st)
                if top_level:
                    dead = True
                continue
            if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
                name = st.targets[0].id
                check_calls_for_coupling(st.value)
                if is_const(st.value, env):
                    env.add(name)
                else:
                    env.discard(name)
                continue
            if isinstance(st, ast.AugAssign) and isinstance(st.target, ast.Name):
                check_calls_for_coupling(st.value)
                if not (st.target.id in env and is_const(st.value, env)):
                    env.discard(st.target.id)
                continue
            if isinstance(st, ast.Assert):
                t = st.test
                if dead:
                    record(False, is_unreach=True)
                elif in_swallow:
                    record(False, is_swallow=True)
                elif is_reflexive_compare(t):
                    record(False, "reflexive-comparison", "assert compares expression to itself")
                elif is_const(t, env):
                    r = "constant-binding-tautology" if any(isinstance(n, ast.Name) and n.id in env for n in ast.walk(t)) else "literal-tautology"
                    record(False, r, "assert evaluates a constant expression")
                elif isinstance(t, (ast.List, ast.Dict, ast.Set, ast.Tuple)) and len(getattr(t, "elts", getattr(t, "keys", []))) > 0:
                    record(False, "always-truthy", "assert on non-empty container literal is always true")
                else:
                    check_calls_for_coupling(t)
                    record(True, expr_coupled=has_subject_ref(t, env, params))
                continue
            if isinstance(st, ast.With):
                # pytest.raises(...) or self.assertRaises(...)
                is_raises = False
                for item in st.items:
                    ce = item.context_expr
                    if isinstance(ce, ast.Call) and isinstance(ce.func, ast.Attribute) and ce.func.attr in ("raises", "assertRaises", "assertRaisesRegex"):
                        is_raises = True
                if is_raises:
                    only_inline_raise = len(st.body) == 1 and isinstance(st.body[0], ast.Raise)
                    if dead:
                        record(False, is_unreach=True)
                    elif in_swallow:
                        record(False, is_swallow=True)
                    elif not st.body or (len(st.body) == 1 and isinstance(st.body[0], ast.Pass)) or only_inline_raise:
                        record(False, "literal-tautology", "pytest.raises/assertRaises block only raises inline literal")
                    else:
                        for sub in st.body:
                            check_calls_for_coupling(sub)
                        record(True, expr_coupled=coupled)
                else:
                    for item in st.items:
                        check_calls_for_coupling(item.context_expr)
                    walk_stmts(st.body, in_swallow=in_swallow, is_dead=dead)
                continue
            if isinstance(st, ast.Try):
                swallows = False
                for h in st.handlers:
                    has_reraise_or_assert = any(
                        isinstance(n, (ast.Raise, ast.Assert))
                        or (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and (n.func.attr.startswith("assert") or n.func.attr == "fail"))
                        for n in ast.walk(h)
                    )
                    if not has_reraise_or_assert:
                        swallows = True
                walk_stmts(st.body, in_swallow=in_swallow or swallows, is_dead=dead)
                for h in st.handlers:
                    walk_stmts(h.body, in_swallow=in_swallow, is_dead=dead)
                walk_stmts(st.orelse, in_swallow=in_swallow, is_dead=dead)
                walk_stmts(st.finalbody, in_swallow=in_swallow, is_dead=dead)
                continue
            if isinstance(st, ast.If):
                check_calls_for_coupling(st.test)
                dead_then = isinstance(st.test, ast.Constant) and not bool(st.test.value)
                dead_else = isinstance(st.test, ast.Constant) and bool(st.test.value)
                walk_stmts(st.body, in_swallow=in_swallow, is_dead=dead or dead_then)
                walk_stmts(st.orelse, in_swallow=in_swallow, is_dead=dead or dead_else)
                continue
            if isinstance(st, (ast.For, ast.AsyncFor, ast.While)):
                dead_loop = False
                if isinstance(st, ast.While) and isinstance(st.test, ast.Constant) and not bool(st.test.value):
                    dead_loop = True
                if isinstance(st, (ast.For, ast.AsyncFor)):
                    check_calls_for_coupling(st.iter)
                    if isinstance(st.iter, (ast.List, ast.Tuple, ast.Set)) and len(st.iter.elts) == 0:
                        dead_loop = True
                walk_stmts(st.body, in_swallow=in_swallow, is_dead=dead or dead_loop)
                continue
            if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call):
                call = st.value
                if isinstance(call.func, ast.Attribute):
                    m = call.func.attr
                    args = call.args
                    if m in EQUALITY_METHODS and len(args) >= 2:
                        if dead: record(False, is_unreach=True)
                        elif in_swallow: record(False, is_swallow=True)
                        elif ast.dump(args[0]) == ast.dump(args[1]):
                            record(False, "reflexive-comparison", f"{m}(x, x) compares identical expression")
                        elif is_const(args[0], env) and is_const(args[1], env):
                            record(False, "literal-tautology", f"{m} compares two constants")
                        else:
                            check_calls_for_coupling(call)
                            record(True, expr_coupled=True)
                        continue
                    if m in INEQUALITY_METHODS and len(args) >= 2:
                        if dead: record(False, is_unreach=True)
                        elif in_swallow: record(False, is_swallow=True)
                        elif is_const(args[0], env) and is_const(args[1], env):
                            record(False, "literal-tautology", f"{m} compares two constants")
                        else:
                            check_calls_for_coupling(call)
                            record(True, expr_coupled=True)
                        continue
                    if (m in TRUTHY_METHODS or m in FALSY_METHODS) and len(args) >= 1:
                        if dead: record(False, is_unreach=True)
                        elif in_swallow: record(False, is_swallow=True)
                        elif is_const(args[0], env):
                            record(False, "literal-tautology", f"{m} evaluates a constant")
                        else:
                            check_calls_for_coupling(call)
                            record(True, expr_coupled=True)
                        continue
                    if m in RAISES_METHODS:
                        if dead: record(False, is_unreach=True)
                        elif in_swallow: record(False, is_swallow=True)
                        elif len(args) >= 2:
                            check_calls_for_coupling(call)
                            record(True, expr_coupled=True)
                        else:
                            record(False, "literal-tautology", f"{m} called without target callable")
                        continue
                    if m in OTHER_ASSERT_METHODS and len(args) >= 2:
                        if dead: record(False, is_unreach=True)
                        elif in_swallow: record(False, is_swallow=True)
                        elif all(is_const(a, env) for a in args[:2]):
                            record(False, "literal-tautology", f"{m} compares only constants")
                        else:
                            check_calls_for_coupling(call)
                            record(True, expr_coupled=True)
                        continue
                    if m == "fail":
                        if dead: record(False, is_unreach=True)
                        elif in_swallow: record(False, is_swallow=True)
                        else: record(True, expr_coupled=coupled)
                        continue
                check_calls_for_coupling(call)
                continue
            check_calls_for_coupling(st)

    walk_stmts(fn.body, top_level=True)
    if genuine == 0 and not findings:
        findings.append({"reason": "no-assertion", "detail": "Python test contains no assertion"})
    elif genuine > 0 and not coupled:
        findings.append({"reason": "uncoupled-assertion", "detail": "Python test asserts only on local constants without invoking any module or function under test"})
    return {
        "valid": genuine > 0 and coupled,
        "genuineCount": genuine,
        "tautologyCount": tautologies,
        "swallowedCount": swallowed,
        "unreachableCount": unreachable,
        "subjectCoupled": coupled,
        "findings": findings,
        "engine": "python-ast"
    }

payload = json.loads(sys.stdin.read())
file_src = payload.get("fileSource") or ""
scope_src = payload.get("scopeBody") or ""
start_line = payload.get("startLine") or 1

imported = set()
try:
    ftree = ast.parse(file_src)
    for node in ast.walk(ftree):
        if isinstance(node, ast.Import):
            for al in node.names:
                name = al.asname or al.name.split(".")[0]
                if name not in {"pytest", "unittest"}:
                    imported.add(name)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod not in {"pytest", "unittest"}:
                for al in node.names:
                    imported.add(al.asname or al.name)
except Exception:
    ftree = None

target_fn = None
if ftree is not None:
    for node in ast.walk(ftree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno == start_line:
            target_fn = node
            break

if target_fn is None:
    import textwrap
    dedented = textwrap.dedent(scope_src)
    stree = ast.parse(dedented)
    for node in stree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            target_fn = node
            break

if target_fn is None:
    print(json.dumps({"valid": False, "genuineCount": 0, "tautologyCount": 0, "swallowedCount": 0, "unreachableCount": 0, "subjectCoupled": False, "findings": [{"reason": "no-assertion", "detail": "no Python test function parsed"}], "engine": "python-ast"}))
else:
    print(json.dumps(analyze_fn(target_fn, imported)))
`;

let cachedPythonBin = undefined;
function findPython() {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  for (const bin of ['python3', 'python']) {
    try {
      const res = spawnSync(bin, ['-c', 'import ast; print(1)'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (res.status === 0 && res.stdout.trim() === '1') {
        cachedPythonBin = bin;
        return bin;
      }
    } catch {
      // try next candidate
    }
  }
  cachedPythonBin = null;
  return null;
}

/** Fallback zero-dependency Python analyzer used only when `python3` is not installed. */
function analyzePythonFallback(scopeBody) {
  const lines = String(scopeBody ?? '').split(/\r?\n/).slice(1);
  let genuine = 0;
  let tautologies = 0;
  const findings = [];
  let coupled = false;
  let dead = false;

  for (const raw of lines) {
    const trimmed = raw.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    if (/^(?:return|raise)\b/.test(trimmed)) { dead = true; continue; }
    if (/^assert\b/.test(trimmed)) {
      const expr = trimmed.replace(/^assert\s+/, '').split(',')[0].trim();
      if (dead) {
        findings.push({ reason: 'unreachable-assertion', detail: 'assertion after return/raise' });
        continue;
      }
      const eq = expr.match(/^(.+?)\s*(==|!=|is)\s*(.+)$/);
      if (/^(?:True|False|\d+|['"][^'"]*['"]|\[\s*.+\s*\]|\{\s*.+\s*\})$/.test(expr)) {
        tautologies += 1;
        findings.push({ reason: 'literal-tautology', detail: `tautological ${trimmed}` });
      } else if (eq && eq[1].trim() === eq[3].trim()) {
        tautologies += 1;
        findings.push({ reason: 'reflexive-comparison', detail: `reflexive ${trimmed}` });
      } else if (eq && /^(?:True|False|None|-?\d+|['"][^'"]*['"])$/.test(eq[1].trim()) && /^(?:True|False|None|-?\d+|['"][^'"]*['"])$/.test(eq[3].trim())) {
        tautologies += 1;
        findings.push({ reason: 'literal-tautology', detail: `literal comparison ${trimmed}` });
      } else {
        genuine += 1;
        coupled = true;
      }
    } else if (/\b[A-Za-z_]\w*\s*\(/.test(trimmed) && !/^print\s*\(/.test(trimmed)) {
      coupled = true;
    }
  }
  if (genuine === 0 && findings.length === 0) {
    findings.push({ reason: 'no-assertion', detail: 'Python test contains no assertion' });
  }
  return {
    valid: genuine > 0 && coupled,
    genuineCount: genuine,
    tautologyCount: tautologies,
    swallowedCount: 0,
    unreachableCount: 0,
    subjectCoupled: coupled,
    findings,
    engine: 'python-fallback'
  };
}

export function analyzePythonTestScope(scopeBody, { fileSource = '', startLine = 1 } = {}) {
  const py = findPython();
  if (!py) return analyzePythonFallback(scopeBody);
  try {
    const res = spawnSync(py, ['-c', PYTHON_AST_SCRIPT], {
      input: JSON.stringify({ fileSource, scopeBody, startLine }),
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (res.status === 0 && res.stdout.trim()) {
      return JSON.parse(res.stdout.trim());
    }
  } catch {
    // fall through
  }
  return analyzePythonFallback(scopeBody);
}
