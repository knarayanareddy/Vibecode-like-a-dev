/**
 * Roadmap P0.3 — `@req` anchor scoping table-driven test suite.
 *
 * Verifies 10 distinct anchor placements × 4 languages (TypeScript, Python, Go,
 * Rust = 40 cases) across BOTH `vld verify` (`factory/lib/verify.mjs`) and the
 * emitted standalone `specs/spec-check.mjs`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const INDEX = buildIndex();
const TAG = ['@', 'req'].join('');

const PADDING_45 = (comment) => Array.from({ length: 45 }, (_, i) => `${comment} filler line ${i + 1}`).join('\n');

/**
 * 10 canonical placements × 4 languages (ts, py, go, rs).
 * Each entry yields `{ file, source, expectOk, expectPattern }`.
 */
function buildMatrix(reqA, reqB) {
  const ts = [
    {
      name: 'top-of-file-above-named-import',
      file: 'tests/case.test.ts',
      source: `// ${TAG} ${reqA}\nimport assert from 'node:assert/strict';\nimport { compute, helper } from '../src/app.ts';\ntest('computes', () => {\n  assert.equal(compute(2), 4);\n});\n`,
      expectOk: true
    },
    {
      name: 'above-multiline-import-and-export-type',
      file: 'tests/case.test.ts',
      source: `// ${TAG} ${reqA}\nimport {\n  compute,\n  helper\n} from '../src/app.ts';\nexport type Config = {\n  retries: number;\n  nested: { enabled: boolean };\n};\ninterface Runner {\n  run(): number;\n}\nimport assert from 'node:assert/strict';\ntest('after types', () => {\n  assert.equal(compute(3), 6);\n});\n`,
      expectOk: true
    },
    {
      name: 'above-cjs-destructured-require',
      file: 'tests/case.test.js',
      source: `// ${TAG} ${reqA}\nconst { strict: assert } = require('node:assert');\nconst {\n  compute\n} = require('../src/app.js');\ntest('cjs require', () => {\n  assert.equal(compute(5), 10);\n});\n`,
      expectOk: true
    },
    {
      name: 'directly-above-it-inside-describe',
      file: 'tests/case.test.ts',
      source: `import assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\ndescribe('math', () => {\n  // ${TAG} ${reqA}\n  it('doubles value', () => {\n    assert.equal(compute(4), 8);\n  });\n});\n`,
      expectOk: true
    },
    {
      name: 'directly-above-describe-suite',
      file: 'tests/case.test.ts',
      source: `import assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\n// ${TAG} ${reqA}\ndescribe('suite level', () => {\n  it('works', () => {\n    assert.equal(compute(1), 2);\n  });\n});\n`,
      expectOk: true
    },
    {
      name: 'inside-test-body',
      file: 'tests/case.test.ts',
      source: `import assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\ntest('inside body', () => {\n  const out = compute(7);\n  // ${TAG} ${reqA}\n  assert.equal(out, 14);\n});\n`,
      expectOk: true
    },
    {
      name: 'stacked-multi-req-above-single-test',
      file: 'tests/case.test.ts',
      source: `import assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\n// ${TAG} ${reqA}\n// ${TAG} ${reqB}\ntest('covers two reqs', () => {\n  assert.equal(compute(9), 18);\n});\n`,
      expectOk: true
    },
    {
      name: 'expression-bodied-arrow-test',
      file: 'tests/case.test.ts',
      source: `import assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\n// ${TAG} ${reqA}\ntest('concise', () => assert.equal(compute(6), 12));\n`,
      expectOk: true
    },
    {
      name: 'hollow-test-next-to-real-neighbour-rejected',
      file: 'tests/case.test.ts',
      source: `import assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\n// ${TAG} ${reqA}\ntest('hollow', () => {\n  compute(1);\n});\ntest('neighbour', () => {\n  assert.equal(compute(2), 4);\n});\n`,
      expectOk: false,
      expectPattern: /no assertion/
    },
    {
      name: 'no-test-within-40-lines-emits-placement-error',
      file: 'tests/case.test.ts',
      source: `// ${TAG} ${reqA}\nimport assert from 'node:assert/strict';\nimport { compute } from '../src/app.ts';\n${PADDING_45('//')}\ntest('too far', () => {\n  assert.equal(compute(2), 4);\n});\n`,
      expectOk: false,
      expectPattern: /put \/\/ @req directly above the test that proves it/
    }
  ];

  const py = [
    {
      name: 'top-of-file-above-imports',
      file: 'tests/test_case.py',
      source: `# ${TAG} ${reqA}\nfrom app.service import compute\n\ndef test_computes():\n    assert compute(2) == 4\n`,
      expectOk: true
    },
    {
      name: 'above-multiline-from-import',
      file: 'tests/test_case.py',
      source: `# ${TAG} ${reqA}\nfrom app.service import (\n    compute,\n    helper,\n)\n\ndef test_multiline_import():\n    assert compute(3) == 6\n`,
      expectOk: true
    },
    {
      name: 'above-async-def-test',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\n# ${TAG} ${reqA}\nasync def test_async_compute():\n    result = await compute(4)\n    assert result == 8\n`,
      expectOk: true
    },
    {
      name: 'above-class-test-method',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\nclass TestMath:\n    # ${TAG} ${reqA}\n    def test_method(self):\n        assert compute(5) == 10\n`,
      expectOk: true
    },
    {
      name: 'above-pytest-decorator',
      file: 'tests/test_case.py',
      source: `import pytest\nfrom app.service import compute\n\n# ${TAG} ${reqA}\n@pytest.mark.parametrize("x,expected", [(2, 4), (3, 6)])\ndef test_param(x, expected):\n    assert compute(x) == expected\n`,
      expectOk: true
    },
    {
      name: 'inside-def-test-body',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\ndef test_inside():\n    val = compute(7)\n    # ${TAG} ${reqA}\n    assert val == 14\n`,
      expectOk: true
    },
    {
      name: 'stacked-multi-req-above-def',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\n# ${TAG} ${reqA}\n# ${TAG} ${reqB}\ndef test_both():\n    assert compute(8) == 16\n`,
      expectOk: true
    },
    {
      name: 'above-multiline-def-signature',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\n# ${TAG} ${reqA}\ndef test_fixtures(\n    tmp_path,\n    monkeypatch,\n):\n    assert compute(9) == 18\n`,
      expectOk: true
    },
    {
      name: 'hollow-def-before-real-neighbour-rejected',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\n# ${TAG} ${reqA}\ndef test_hollow():\n    compute(1)\n\ndef test_real():\n    assert compute(2) == 4\n`,
      expectOk: false,
      expectPattern: /no assertion/
    },
    {
      name: 'trailing-orphan-anchor-emits-placement-error',
      file: 'tests/test_case.py',
      source: `from app.service import compute\n\ndef test_real():\n    assert compute(2) == 4\n\n# ${TAG} ${reqA}\nCONST = 1\n`,
      expectOk: false,
      expectPattern: /put \/\/ @req directly above the test that proves it/
    }
  ];

  const go = [
    {
      name: 'top-of-file-above-package-and-import',
      file: 'calc_test.go',
      source: `// ${TAG} ${reqA}\npackage calc_test\n\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n\nfunc TestCompute(t *testing.T) {\n\tif calc.Compute(2) != 4 {\n\t\tt.Fatalf("got wrong value")\n\t}\n}\n`,
      expectOk: true
    },
    {
      name: 'between-import-block-and-helper-struct',
      file: 'calc_test.go',
      source: `package calc_test\n\n// ${TAG} ${reqA}\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n\ntype testCase struct {\n\tin  int\n\tout int\n}\n\nfunc TestTable(t *testing.T) {\n\tc := testCase{in: 3, out: 6}\n\tif calc.Compute(c.in) != c.out {\n\t\tt.Errorf("mismatch")\n\t}\n}\n`,
      expectOk: true
    },
    {
      name: 'directly-above-func-Test',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n// ${TAG} ${reqA}\nfunc TestDirect(t *testing.T) {\n\tif calc.Compute(4) != 8 { t.Fatal("bad") }\n}\n`,
      expectOk: true
    },
    {
      name: 'inside-func-Test-body',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\nfunc TestInside(t *testing.T) {\n\t// ${TAG} ${reqA}\n\tgot := calc.Compute(5)\n\tif got != 10 { t.Fatalf("got %d", got) }\n}\n`,
      expectOk: true
    },
    {
      name: 'stacked-multi-req-above-func-Test',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n// ${TAG} ${reqA}\n// ${TAG} ${reqB}\nfunc TestBoth(t *testing.T) {\n\tif calc.Compute(6) != 12 { t.Fatal("bad") }\n}\n`,
      expectOk: true
    },
    {
      name: 'above-func-Fuzz',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n// ${TAG} ${reqA}\nfunc FuzzCompute(f *testing.F) {\n\tif calc.Compute(1) != 2 { f.Fatal("bad") }\n}\n`,
      expectOk: true
    },
    {
      name: 'nested-braces-in-table-driven-test',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n// ${TAG} ${reqA}\nfunc TestNested(t *testing.T) {\n\tcases := []struct{ x, want int }{{1, 2}, {2, 4}}\n\tfor _, tc := range cases {\n\t\tif calc.Compute(tc.x) != tc.want {\n\t\t\tt.Fatalf("bad")\n\t\t}\n\t}\n}\n`,
      expectOk: true
    },
    {
      name: 'brace-inside-string-literal',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n// ${TAG} ${reqA}\nfunc TestStringBrace(t *testing.T) {\n\t_ = "}}}\"\n\tif calc.Compute(2) != 4 { t.Fatalf("bad") }\n}\n`,
      expectOk: true
    },
    {
      name: 'hollow-go-test-next-to-real-rejected',
      file: 'calc_test.go',
      source: `package calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n// ${TAG} ${reqA}\nfunc TestHollow(t *testing.T) {\n\t_ = calc.Compute(1)\n}\nfunc TestReal(t *testing.T) {\n\tif calc.Compute(2) != 4 { t.Fatal("bad") }\n}\n`,
      expectOk: false,
      expectPattern: /no assertion/
    },
    {
      name: 'distant-anchor-over-40-lines-emits-placement-error',
      file: 'calc_test.go',
      source: `// ${TAG} ${reqA}\npackage calc_test\nimport (\n\t"testing"\n\t"example.com/app/calc"\n)\n${PADDING_45('//')}\nfunc TestFar(t *testing.T) {\n\tif calc.Compute(2) != 4 { t.Fatal("bad") }\n}\n`,
      expectOk: false,
      expectPattern: /put \/\/ @req directly above the test that proves it/
    }
  ];

  const rs = [
    {
      name: 'top-of-file-above-braced-use',
      file: 'tests/calc_test.rs',
      source: `// ${TAG} ${reqA}\nuse calc::{compute, helper};\n\n#[test]\nfn computes_double() {\n    assert_eq!(compute(2), 4);\n}\n`,
      expectOk: true
    },
    {
      name: 'above-tokio-async-test',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n// ${TAG} ${reqA}\n#[tokio::test]\nasync fn async_double() {\n    assert_eq!(compute(3).await, 6);\n}\n`,
      expectOk: true
    },
    {
      name: 'above-helper-struct-before-test',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n// ${TAG} ${reqA}\nstruct Fixture {\n    input: i32,\n}\n\n#[test]\nfn with_fixture() {\n    let f = Fixture { input: 4 };\n    assert_eq!(compute(f.input), 8);\n}\n`,
      expectOk: true
    },
    {
      name: 'inside-rust-test-body',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n#[test]\nfn inside_body() {\n    // ${TAG} ${reqA}\n    assert_eq!(compute(5), 10);\n}\n`,
      expectOk: true
    },
    {
      name: 'stacked-multi-req-above-rust-test',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n// ${TAG} ${reqA}\n// ${TAG} ${reqB}\n#[test]\nfn covers_two() {\n    assert_eq!(compute(6), 12);\n}\n`,
      expectOk: true
    },
    {
      name: 'above-should-panic-attribute-stack',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n// ${TAG} ${reqA}\n#[test]\n#[should_panic]\nfn panics_on_overflow() {\n    assert!(compute(-1) >= 0);\n}\n`,
      expectOk: true
    },
    {
      name: 'inside-mod-tests-block',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\nmod suite {\n    use super::*;\n    // ${TAG} ${reqA}\n    #[test]\n    fn nested_mod() {\n        assert_eq!(compute(7), 14);\n    }\n}\n`,
      expectOk: true
    },
    {
      name: 'above-rstest-attribute',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n// ${TAG} ${reqA}\n#[rstest]\nfn param_case() {\n    assert_ne!(compute(8), 0);\n}\n`,
      expectOk: true
    },
    {
      name: 'hollow-rust-test-next-to-real-rejected',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n// ${TAG} ${reqA}\n#[test]\nfn hollow() {\n    let _ = compute(1);\n}\n\n#[test]\nfn real() {\n    assert_eq!(compute(2), 4);\n}\n`,
      expectOk: false,
      expectPattern: /no assertion/
    },
    {
      name: 'no-rust-test-follows-emits-placement-error',
      file: 'tests/calc_test.rs',
      source: `use calc::compute;\n\n#[test]\nfn earlier() {\n    assert_eq!(compute(2), 4);\n}\n\n// ${TAG} ${reqA}\nfn helper_only() -> i32 { compute(1) }\n`,
      expectOk: false,
      expectPattern: /put \/\/ @req directly above the test that proves it/
    }
  ];

  return [
    ...ts.map((c) => ({ lang: 'ts', ...c })),
    ...py.map((c) => ({ lang: 'py', ...c })),
    ...go.map((c) => ({ lang: 'go', ...c })),
    ...rs.map((c) => ({ lang: 'rs', ...c }))
  ];
}

test('P0.3 table-driven anchor scoping passes all 40 cases (10 placements × 4 languages)', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'vld-scope-matrix-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const packetDir = path.join(base, 'packet');
  const profile = normalizeProfile({
    name: 'scope-matrix',
    idea: 'A calculation service for platform teams that doubles incoming quota measurements.',
    kind: 'api',
    stage: 'mvp',
    traits: [],
    risks: {}
  });
  emitPacket(buildPlan(profile, { index: INDEX }), packetDir, { force: true });
  const spec = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  const autoReqs = spec.requirements.filter((r) => r.verify === 'automated').map((r) => r.id);
  assert.ok(autoReqs.length >= 2);
  const [reqA, reqB] = autoReqs;

  const matrix = buildMatrix(reqA, reqB);
  assert.equal(matrix.length, 40, 'exact 10 placements × 4 languages');

  for (const [idx, entry] of matrix.entries()) {
    const repo = path.join(base, `case-${idx}-${entry.lang}`);
    const fullFile = path.join(repo, entry.file);
    mkdirSync(path.dirname(fullFile), { recursive: true });
    writeFileSync(fullFile, entry.source, 'utf8');

    const label = `[${entry.lang}/${entry.name}]`;

    // 1. Standalone generated spec-check.mjs
    const run = spawnSync(
      process.execPath,
      [path.join(packetDir, 'spec-check.mjs'), '--repo', repo, '--require-assertions'],
      { encoding: 'utf8' }
    );
    const out = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status === 0, entry.expectOk, `${label} spec-check mismatch:\n${out}`);
    if (entry.expectPattern) {
      assert.match(out, entry.expectPattern, `${label} spec-check message mismatch:\n${out}`);
    }

    // 2. Core verifyPacket API agrees identically
    const verify = verifyPacket(packetDir, { repo, strict: false, requireAssertions: true });
    assert.equal(verify.ok, entry.expectOk, `${label} verifyPacket mismatch: ${verify.errors.join('; ')}`);
    if (entry.expectPattern) {
      assert.match(verify.errors.join('\n'), entry.expectPattern, `${label} verifyPacket message mismatch`);
    }
  }
});
