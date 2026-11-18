/**
 * Go `go/parser` + `go/ast` non-tautological assertion analyzer (roadmap P2.2).
 *
 * When the `go` toolchain is available (and child-process spawning is allowed),
 * compiles a tiny zero-dependency stdlib Go AST analyzer once per process and
 * inspects `func Test*(t *testing.T)` declarations directly via `go/ast`.
 * Falls back cleanly to a deterministic zero-dependency Go structural analyzer
 * when `go` is unavailable or `process.permission` restricts subprocesses.
 *
 * Catches:
 *   - `no-assertion`: empty `func TestX(t *testing.T) {}` or `t.Log(...)` only
 *   - `literal-tautology`: `if false { t.Fatal() }`, `if 1 != 1 { t.Fatal() }`,
 *     `assert.True(t, true)`, `require.Equal(t, 1, 1)`, `assert.NotEqual(t, 1, 2)`
 *   - `constant-binding-tautology`: `x := 42; if x != 42 { t.Fatal() }`
 *   - `reflexive-comparison`: `if x != x { t.Fatal() }`, `assert.Equal(t, x, x)`
 *   - `unreachable-assertion`: assertion after unconditional `return` or `t.Skip(...)`
 *   - `uncoupled-assertion`: test checks only hardcoded local values and never calls
 *     any function/method outside `testing.T` / `assert` / `require`
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GO_HELPER_SOURCE = `package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io"
	"os"
	"strings"
)

type Finding struct {
	Reason string \`json:"reason"\`
	Detail string \`json:"detail"\`
}

type Result struct {
	Valid            bool      \`json:"valid"\`
	GenuineCount     int       \`json:"genuineCount"\`
	TautologyCount   int       \`json:"tautologyCount"\`
	SwallowedCount   int       \`json:"swallowedCount"\`
	UnreachableCount int       \`json:"unreachableCount"\`
	SubjectCoupled   bool      \`json:"subjectCoupled"\`
	Findings         []Finding \`json:"findings"\`
	Engine           string    \`json:"engine"\`
}

type Input struct {
	FileSource string \`json:"fileSource"\`
	ScopeBody  string \`json:"scopeBody"\`
	StartLine  int    \`json:"startLine"\`
}

func nodeText(fset *token.FileSet, n ast.Node) string {
	var buf bytes.Buffer
	_ = format.Node(&buf, fset, n)
	return strings.TrimSpace(buf.String())
}

func isConstExpr(n ast.Expr, consts map[string]bool) bool {
	if n == nil {
		return false
	}
	switch e := n.(type) {
	case *ast.BasicLit:
		return true
	case *ast.Ident:
		if e.Name == "true" || e.Name == "false" || e.Name == "nil" || e.Name == "iota" {
			return true
		}
		return consts[e.Name]
	case *ast.ParenExpr:
		return isConstExpr(e.X, consts)
	case *ast.UnaryExpr:
		return isConstExpr(e.X, consts)
	case *ast.BinaryExpr:
		return isConstExpr(e.X, consts) && isConstExpr(e.Y, consts)
	case *ast.CompositeLit:
		for _, el := range e.Elts {
			if kv, ok := el.(*ast.KeyValueExpr); ok {
				if !isConstExpr(kv.Value, consts) {
					return false
				}
			} else if !isConstExpr(el, consts) {
				return false
			}
		}
		return true
	case *ast.CallExpr:
		if id, ok := e.Fun.(*ast.Ident); ok && (id.Name == "len" || id.Name == "cap" || id.Name == "string" || id.Name == "int" || id.Name == "float64") {
			for _, a := range e.Args {
				if !isConstExpr(a, consts) {
					return false
				}
			}
			return true
		}
	}
	return false
}

func isReflexive(fset *token.FileSet, e ast.Expr) bool {
	bin, ok := e.(*ast.BinaryExpr)
	if !ok {
		return false
	}
	switch bin.Op {
	case token.EQL, token.NEQ, token.LSS, token.GTR, token.LEQ, token.GEQ:
		return nodeText(fset, bin.X) == nodeText(fset, bin.Y)
	}
	return false
}

func isTFailMethod(name string) bool {
	switch name {
	case "Error", "Errorf", "Fatal", "Fatalf", "Fail", "FailNow":
		return true
	}
	return false
}

func blockHasTFail(b *ast.BlockStmt, tParam string) bool {
	if b == nil {
		return false
	}
	found := false
	ast.Inspect(b, func(n ast.Node) bool {
		c, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if sel, ok := c.Fun.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == tParam && isTFailMethod(sel.Sel.Name) {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

func main() {
	raw, _ := io.ReadAll(os.Stdin)
	var in Input
	_ = json.Unmarshal(raw, &in)

	src := in.FileSource
	targetLine := in.StartLine
	if strings.TrimSpace(src) == "" {
		src = "package testpkg\\n" + in.ScopeBody
		targetLine = 2
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "test.go", src, 0)
	if err != nil && strings.TrimSpace(in.ScopeBody) != "" {
		fset = token.NewFileSet()
		file, err = parser.ParseFile(fset, "test.go", "package testpkg\\n"+in.ScopeBody, 0)
		targetLine = 2
	}
	res := Result{Findings: []Finding{}, Engine: "go-ast"}
	if err != nil || file == nil {
		res.Findings = append(res.Findings, Finding{Reason: "parse-error", Detail: "Go parser could not parse test"})
		out, _ := json.Marshal(res)
		os.Stdout.Write(out)
		return
	}

	var target *ast.FuncDecl
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		ln := fset.Position(fn.Pos()).Line
		isTestFn := strings.HasPrefix(fn.Name.Name, "Test") || strings.HasPrefix(fn.Name.Name, "Fuzz") || strings.HasPrefix(fn.Name.Name, "Benchmark") || strings.HasPrefix(fn.Name.Name, "Example")
		if ln == targetLine || target == nil && isTestFn {
			target = fn
			if ln == targetLine {
				break
			}
		}
	}
	if target == nil || target.Body == nil {
		res.Findings = append(res.Findings, Finding{Reason: "no-assertion", Detail: "no Go Test function found"})
		out, _ := json.Marshal(res)
		os.Stdout.Write(out)
		return
	}

	tParam := "t"
	if target.Type.Params != nil && len(target.Type.Params.List) > 0 && len(target.Type.Params.List[0].Names) > 0 {
		tParam = target.Type.Params.List[0].Names[0].Name
	}

	consts := map[string]bool{}
	builtins := map[string]bool{"len": true, "cap": true, "make": true, "new": true, "append": true, "copy": true, "delete": true, "string": true, "int": true, "int64": true, "float64": true, "bool": true}

	checkCoupling := func(n ast.Node) {
		if n == nil {
			return
		}
		ast.Inspect(n, func(sub ast.Node) bool {
			c, ok := sub.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch fn := c.Fun.(type) {
			case *ast.Ident:
				if !builtins[fn.Name] {
					res.SubjectCoupled = true
				}
			case *ast.SelectorExpr:
				if id, ok := fn.X.(*ast.Ident); ok {
					if id.Name == tParam || id.Name == "assert" || id.Name == "require" || id.Name == "fmt" {
						return true
					}
				}
				res.SubjectCoupled = true
			default:
				res.SubjectCoupled = true
			}
			return true
		})
	}

	var walkStmts func(stmts []ast.Stmt, dead bool, top bool)
	walkStmts = func(stmts []ast.Stmt, dead bool, top bool) {
		isDead := dead
		for _, st := range stmts {
			switch s := st.(type) {
			case *ast.ReturnStmt:
				checkCoupling(s)
				if top {
					isDead = true
				}
			case *ast.AssignStmt:
				for i, lhs := range s.Lhs {
					id, ok := lhs.(*ast.Ident)
					if !ok || id.Name == "_" {
						continue
					}
					var rhs ast.Expr
					if i < len(s.Rhs) {
						rhs = s.Rhs[i]
					} else if len(s.Rhs) == 1 {
						rhs = s.Rhs[0]
					}
					checkCoupling(rhs)
					if len(s.Rhs) == len(s.Lhs) && isConstExpr(rhs, consts) {
						consts[id.Name] = true
					} else {
						delete(consts, id.Name)
					}
				}
			case *ast.DeclStmt:
				if gd, ok := s.Decl.(*ast.GenDecl); ok {
					for _, sp := range gd.Specs {
						if vs, ok := sp.(*ast.ValueSpec); ok {
							for i, id := range vs.Names {
								if i < len(vs.Values) {
									checkCoupling(vs.Values[i])
									if isConstExpr(vs.Values[i], consts) {
										consts[id.Name] = true
									}
								}
							}
						}
					}
				}
			case *ast.IfStmt:
				if s.Init != nil {
					walkStmts([]ast.Stmt{s.Init}, isDead, false)
				}
				checkCoupling(s.Cond)
				if blockHasTFail(s.Body, tParam) {
					if isDead {
						res.UnreachableCount++
						res.Findings = append(res.Findings, Finding{Reason: "unreachable-assertion", Detail: "failure check after return/skip"})
					} else if isReflexive(fset, s.Cond) {
						res.TautologyCount++
						res.Findings = append(res.Findings, Finding{Reason: "reflexive-comparison", Detail: "if compares expression to itself"})
					} else if isConstExpr(s.Cond, consts) {
						res.TautologyCount++
						res.Findings = append(res.Findings, Finding{Reason: "literal-tautology", Detail: "if guard on t.Fatal/t.Error evaluates a constant"})
					} else {
						res.GenuineCount++
					}
				} else {
					walkStmts(s.Body.List, isDead, false)
				}
				if s.Else != nil {
					if eb, ok := s.Else.(*ast.BlockStmt); ok {
						walkStmts(eb.List, isDead, false)
					} else {
						walkStmts([]ast.Stmt{s.Else}, isDead, false)
					}
				}
			case *ast.ForStmt:
				checkCoupling(s.Cond)
				walkStmts(s.Body.List, isDead, false)
			case *ast.RangeStmt:
				checkCoupling(s.X)
				walkStmts(s.Body.List, isDead, false)
			case *ast.ExprStmt:
				c, ok := s.X.(*ast.CallExpr)
				if !ok {
					continue
				}
				if sel, ok := c.Fun.(*ast.SelectorExpr); ok {
					if id, ok := sel.X.(*ast.Ident); ok {
						// t.Skip marks rest unreachable
						if id.Name == tParam && (sel.Sel.Name == "Skip" || sel.Sel.Name == "SkipNow" || sel.Sel.Name == "Skipf") {
							if top {
								isDead = true
							}
							continue
						}
						// t.Run / f.Fuzz subtest
						if id.Name == tParam && (sel.Sel.Name == "Run" || sel.Sel.Name == "Fuzz") && len(c.Args) >= 1 {
							lastArg := c.Args[len(c.Args)-1]
							if fnLit, ok := lastArg.(*ast.FuncLit); ok && fnLit.Body != nil {
								origT := tParam
								if fnLit.Type.Params != nil && len(fnLit.Type.Params.List) > 0 && len(fnLit.Type.Params.List[0].Names) > 0 {
									tParam = fnLit.Type.Params.List[0].Names[0].Name
								}
								walkStmts(fnLit.Body.List, isDead, true)
								tParam = origT
							}
							continue
						}
						// testify assert.* / require.*
						if id.Name == "assert" || id.Name == "require" {
							m := sel.Sel.Name
							args := c.Args
							// Skip leading t parameter
							if len(args) > 0 {
								if aid, ok := args[0].(*ast.Ident); ok && aid.Name == tParam {
									args = args[1:]
								}
							}
							for _, a := range args {
								checkCoupling(a)
							}
							if isDead {
								res.UnreachableCount++
								res.Findings = append(res.Findings, Finding{Reason: "unreachable-assertion", Detail: id.Name + "." + m + " is unreachable"})
							} else if (m == "Equal" || m == "EqualValues" || m == "Exactly" || m == "Same" || m == "JSONEq") && len(args) >= 2 {
								if nodeText(fset, args[0]) == nodeText(fset, args[1]) {
									res.TautologyCount++
									res.Findings = append(res.Findings, Finding{Reason: "reflexive-comparison", Detail: id.Name + "." + m + " compares identical expression"})
								} else if isConstExpr(args[0], consts) && isConstExpr(args[1], consts) {
									res.TautologyCount++
									res.Findings = append(res.Findings, Finding{Reason: "literal-tautology", Detail: id.Name + "." + m + " compares constants"})
								} else {
									res.GenuineCount++
								}
							} else if len(args) >= 1 && allConst(args, consts) {
								res.TautologyCount++
								res.Findings = append(res.Findings, Finding{Reason: "literal-tautology", Detail: id.Name + "." + m + " checks only constants"})
							} else {
								res.GenuineCount++
							}
							continue
						}
					}
				}
				checkCoupling(c)
			default:
				checkCoupling(s)
			}
		}
	}

	walkStmts(target.Body.List, false, true)
	if res.GenuineCount == 0 && len(res.Findings) == 0 {
		res.Findings = append(res.Findings, Finding{Reason: "no-assertion", Detail: "Go test contains no assertion or t.Error/t.Fatal check"})
	} else if res.GenuineCount > 0 && !res.SubjectCoupled {
		res.Findings = append(res.Findings, Finding{Reason: "uncoupled-assertion", Detail: "Go test never invokes any function or method under test"})
	}
	res.Valid = res.GenuineCount > 0 && res.SubjectCoupled
	out, _ := json.Marshal(res)
	os.Stdout.Write(out)
}

func allConst(args []ast.Expr, consts map[string]bool) bool {
	limit := len(args)
	if limit > 2 {
		limit = 2
	}
	for i := 0; i < limit; i++ {
		if !isConstExpr(args[i], consts) {
			return false
		}
	}
	return true
}
`;

let cachedGoBinary = undefined;
let cachedGoDir = null;

function ensureGoHelperBinary() {
  if (cachedGoBinary !== undefined) return cachedGoBinary;
  if (process.permission) {
    cachedGoBinary = null;
    return null;
  }
  try {
    const probe = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (probe.status !== 0) {
      cachedGoBinary = null;
      return null;
    }
    const dir = path.join(os.tmpdir(), `vld-go-ast-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const srcPath = path.join(dir, 'main.go');
    const binName = process.platform === 'win32' ? 'go-ast-check.exe' : 'go-ast-check';
    const binPath = path.join(dir, binName);
    writeFileSync(srcPath, GO_HELPER_SOURCE, 'utf8');
    const built = spawnSync('go', ['build', '-o', binPath, srcPath], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (built.status === 0 && existsSync(binPath)) {
      cachedGoBinary = binPath;
      cachedGoDir = dir;
      process.once('exit', () => {
        try { if (cachedGoDir) rmSync(cachedGoDir, { recursive: true, force: true }); } catch { /* ignore */ }
      });
      return binPath;
    }
  } catch {
    // fall through to zero-dep Go analyzer
  }
  cachedGoBinary = null;
  return null;
}

const GO_CONST_LIT = /^(?:true|false|nil|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|`[^`]*`|'[^']*')$/;

/** Zero-dependency structural Go analyzer (used when `go` toolchain is not installed). */
export function analyzeGoFallback(scopeBody) {
  const src = String(scopeBody ?? '');
  const lines = src.split(/\r?\n/);
  const headerParam = (lines[0] ?? '').match(/\bfunc\s+\w+\s*\(\s*([A-Za-z_]\w*)\s+\*testing\.[TFBM]\b/);
  const tName = headerParam ? headerParam[1] : 't';
  // `func TestX(t *testing.T) { ... }` on one line puts the whole body on line 0;
  // strip the declaration through its opening brace so single-line tests (common in
  // generated semantic oracles) are analyzed too.
  if (/^\s*func\s/.test(lines[0] ?? '')) {
    const open = lines[0].indexOf('{');
    lines[0] = open === -1 ? '' : lines[0].slice(open + 1);
  }
  const tSkipRe = new RegExp(`^(?:return\\b|${tName}\\.Skip(?:Now|f)?\\s*\\()`);
  const tFailRe = new RegExp(`\\b(?:${tName}|t)\\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\\s*\\(`);
  const tfCallRe = new RegExp(`^(?:assert|require)\\.([A-Za-z]+)\\s*\\(\\s*(?:${tName}|t)\\s*,\\s*(.+)\\)$`);
  const nonHelperCallRe = new RegExp(`\\b(?!${tName}\\.|t\\.|fmt\\.)(?:[A-Za-z_]\\w*\\.)?[A-Za-z_]\\w*\\s*\\(`);
  const consts = new Set();
  let genuine = 0;
  let tautologies = 0;
  let unreachable = 0;
  let coupled = false;
  let dead = false;
  const findings = [];

  const isConstToken = (raw) => {
    const s = String(raw ?? '').trim();
    return GO_CONST_LIT.test(s) || consts.has(s);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const clean = lines[i].replace(/\/\/.*$/, '').trim();
    if (!clean || clean === '{' || clean === '}') continue;
    if (tSkipRe.test(clean)) {
      dead = true;
      continue;
    }
    // Short var decl `x := 42` vs `x := Compute(1)`
    const assign = clean.match(/^([A-Za-z_]\w*)\s*:=\s*(.+)$/);
    if (assign) {
      const [, name, rhs] = assign;
      if (isConstToken(rhs)) {
        consts.add(name);
      } else {
        consts.delete(name);
        if (/\b[A-Za-z_]\w*\s*\(/.test(rhs) && !/^(?:len|cap|make|new|append|string|int|float64)\s*\(/.test(rhs)) {
          coupled = true;
        }
      }
      continue;
    }
    // `if <cond> { t.Fatal... }` (single-line or lookahead 3 lines)
    const ifMatch = clean.match(/^if\s+(.+?)\s*\{(.*)$/);
    if (ifMatch) {
      let cond = ifMatch[1].trim();
      if (cond.includes(';')) {
        const parts = cond.split(';');
        if (/\b[A-Za-z_]\w*\s*\(/.test(parts[0])) coupled = true;
        cond = parts[parts.length - 1].trim();
      }
      const window = [ifMatch[2], lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
      if (tFailRe.test(window)) {
        const cmp = cond.match(/^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
        if (dead) {
          unreachable += 1;
          findings.push({ reason: 'unreachable-assertion', detail: 'if check after return/skip' });
        } else if (isConstToken(cond)) {
          tautologies += 1;
          findings.push({ reason: 'literal-tautology', detail: `if ${cond} evaluates a constant` });
        } else if (cmp && cmp[1].trim() === cmp[3].trim()) {
          tautologies += 1;
          findings.push({ reason: 'reflexive-comparison', detail: `if ${cond} compares identical expression` });
        } else if (cmp && isConstToken(cmp[1]) && isConstToken(cmp[3])) {
          tautologies += 1;
          findings.push({ reason: 'literal-tautology', detail: `if ${cond} compares only constants` });
        } else {
          if (/\b[A-Za-z_]\w*\s*\(/.test(cond)) coupled = true;
          genuine += 1;
        }
        continue;
      }
    }
    // Testify `assert.X(t, a, b)` / `require.X(t, a, b)`
    const tf = clean.match(tfCallRe);
    if (tf) {
      const [, method, rest] = tf;
      const parts = rest.split(',').map((p) => p.trim());
      if (dead) {
        unreachable += 1;
        findings.push({ reason: 'unreachable-assertion', detail: `${method} after return/skip` });
      } else if (['Equal', 'EqualValues', 'Same', 'Exactly'].includes(method) && parts.length >= 2 && parts[0] === parts[1]) {
        tautologies += 1;
        findings.push({ reason: 'reflexive-comparison', detail: `${method} compares identical expression` });
      } else if (parts.slice(0, Math.min(2, parts.length)).every(isConstToken)) {
        tautologies += 1;
        findings.push({ reason: 'literal-tautology', detail: `${method} checks only constants` });
      } else {
        if (parts.some((p) => /\b[A-Za-z_]\w*\s*\(/.test(p))) coupled = true;
        genuine += 1;
      }
      continue;
    }
    // Subject call outside `t.*` / `fmt.*`
    if (nonHelperCallRe.test(clean)) {
      coupled = true;
    }
  }

  if (genuine === 0 && findings.length === 0) {
    findings.push({ reason: 'no-assertion', detail: 'Go test contains no assertion or t.Fatal/t.Error check' });
  } else if (genuine > 0 && !coupled) {
    findings.push({ reason: 'uncoupled-assertion', detail: 'Go test never invokes any function under test' });
  }

  return {
    valid: genuine > 0 && coupled,
    genuineCount: genuine,
    tautologyCount: tautologies,
    swallowedCount: 0,
    unreachableCount: unreachable,
    subjectCoupled: coupled,
    findings,
    engine: 'go-fallback'
  };
}

export function analyzeGoTestScope(scopeBody, { fileSource = '', startLine = 1, preferFallback = false } = {}) {
  if (!preferFallback) {
    const bin = ensureGoHelperBinary();
    if (bin) {
      try {
        const res = spawnSync(bin, [], {
          input: JSON.stringify({ fileSource, scopeBody, startLine }),
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        if (res.status === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (!parsed.findings?.some((f) => f.reason === 'parse-error')) {
            return parsed;
          }
        }
      } catch {
        // fall back
      }
    }
  }
  return analyzeGoFallback(scopeBody);
}
