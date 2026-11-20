/**
 * Wave 3 (Roadmap P2.1–P2.5) regression suite:
 *   - P2.1: Executed test verification (`vld verify --run`, `--report`, `--require-report`)
 *           across Node TAP, Vitest/Jest JSON, JUnit XML, and Go `go test -json`;
 *           catches failing tests, skipped/todo tests, and unexecuted anchors.
 *   - P2.2: `@vld/analysis` AST non-tautological assertion checker across JS/TS,
 *           Python (`ast`), Go (`go/ast` + fallback), and Rust — catches Adversarial
 *           Test F (`expect(true).toBe(true)`, `assert.equal(1, 1)`, `assert True`,
 *           `assert 1 == 1`, `assert x == x`, constant bindings, `if false { t.Fatal() }`,
 *           swallowed `try/catch`, unreachable assertions, and zero-subject-coupled tests)
 *           with zero false positives on real assertions.
 *   - P2.3: Executed mutation gate (`G2-MUTATION` >= 60%, `G3-MUTATION` >= 75%)
 *           plus Stryker / Gremlins / cargo-mutants parsers, `SKIPPED-UNAVAILABLE`,
 *           and dated waiver handling.
 *   - P2.4: Executed `G0-RUN`, `G0-CHECK`, and `G0-SMOKE` (including live HTTP 500
 *           rejection vs HTTP 200 pass, failing lint, and `--static-only` warning).
 *   - P2.5: Honest verdict vocabulary (`anchored-only`, `static-asserted`,
 *           `executed-verified`, `mutation-verified`, `PASS-EXECUTED`, `PASS-STATIC`,
 *           `SKIPPED-UNAVAILABLE`, `SKIPPED-STATIC-ONLY`, `WAIVED`) and `summary.mjs`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeGoFallback,
  analyzeGoTestScope,
  analyzeJsTestScope,
  analyzePolyglotTestScope,
  analyzePythonTestScope
} from '../../packages/analysis/src/index.mjs';
import { parseMutationReport, runMutationGate } from '../lib/mutation-runner.mjs';
import { parseTestReport } from '../lib/test-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
const REQ_TAG = ['@', 'req'].join('');

function createMiniPacketProject(dir, { tier = 1 } = {}) {
  const profilePath = path.join(dir, 'profile.json');
  const isTier2 = tier === 2;
  const isTier3 = tier >= 3;
  const profile = {
    name: 'quota-calc',
    idea: 'A deterministic quota calculator utility for engineering leads estimating sprint capacities from velocity logs.',
    kind: 'cli',
    stage: isTier2 || isTier3 ? 'production' : 'mvp',
    users: { scale: isTier3 ? 'large' : isTier2 ? 'medium' : 'small' },
    domain: { entity: 'quota', actors: ['lead'] },
    traits: [],
    risks: {
      pii: false,
      payments: false,
      regulated: false,
      multiTenant: Boolean(isTier2 || isTier3),
      destructiveWrites: Boolean(isTier3),
      publicFacing: Boolean(isTier3),
      integrations: Boolean(isTier2 || isTier3)
    },
    constraints: { team: 2, weeks: 4, stack: 'javascript', mustUse: [] }
  };
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const out = spawnSync(process.execPath, [CLI, 'compile', profilePath, '-o', path.join(dir, 'specs'), '--force'], {
    encoding: 'utf8'
  });
  assert.equal(out.status, 0, out.stderr);
  const spec = JSON.parse(readFileSync(path.join(dir, 'specs', 'spec.json'), 'utf8'));
  const autoIds = spec.requirements.filter((r) => r.verify === 'automated').map((r) => r.id);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'quota-calc',
      version: '1.0.0',
      type: 'module',
      bin: { 'quota-calc': './src/calc.mjs' },
      scripts: {
        test: 'node --test tests/*.test.mjs',
        lint: 'node --check src/calc.mjs',
        smoke: 'node src/calc.mjs --version'
      }
    }, null, 2)
  );
  writeFileSync(
    path.join(dir, 'README.md'),
    '# quota-calc\n\n## Run\n\n```bash\nnode src/calc.mjs --version\n```\n\n## Test\n\n```bash\nnpm test\n```\n\n## Release\n\nTagged releases.\n'
  );
  mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    path.join(dir, '.github', 'workflows', 'ci.yml'),
    'name: ci\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint && npm test\n'
  );
  writeFileSync(
    path.join(dir, 'src', 'calc.mjs'),
    `#!/usr/bin/env node
export function computeQuota(velocity, days, reserve) {
  if (velocity <= 0 || days <= 0) {
    return 0;
  }
  const gross = velocity * days;
  if (reserve >= gross) {
    return 0;
  }
  return gross - reserve;
}
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
}
`
  );
  return { spec, autoIds };
}

test('P2.2 AST assertion analyzer rejects Adversarial Test F tautologies across JS/TS, Python, Go, and Rust, and accepts real tests', () => {
  // JS/TS tautologies (must ALL fail!)
  const jsBadCases = [
    ['empty body', "test('x', () => {})"],
    ['expect(true).toBe(true) [Test F]', "test('x', () => expect(true).toBe(true))"],
    ['assert.equal(1, 1)', "test('x', () => { assert.equal(1, 1); })"],
    ['assert.strictEqual(2 + 2, 4)', "test('x', () => { assert.strictEqual(2 + 2, 4); })"],
    ['assert.ok(true)', "test('x', () => { assert.ok(true); })"],
    ['assert(x === x) reflexive', "import { fn } from '../src/a.mjs';\ntest('x', () => { const x = fn(); assert(x === x); })"],
    ['expect(a.b).toBe(a.b) reflexive', "import { fn } from '../src/a.mjs';\ntest('x', () => { const a = fn(); expect(a.b).toBe(a.b); })"],
    ['const folded local', "test('x', () => { const x = 42; expect(x).toBe(42); })"],
    ['expect([]).toBeTruthy()', "test('x', () => { expect([]).toBeTruthy(); })"],
    ['expect({}).toBeDefined()', "test('x', () => { expect({}).toBeDefined(); })"],
    ['tautological disjunction', "import { fn } from '../src/a.mjs';\ntest('x', () => { const v = fn(); assert.ok(v || !v); })"],
    ['swallowed try/catch', "import { fn } from '../src/a.mjs';\ntest('x', () => { try { assert.equal(fn(), 99); } catch {} })"],
    ['unreachable after return', "import { fn } from '../src/a.mjs';\ntest('x', () => { return; assert.equal(fn(), 99); })"],
    ['inline throw toThrow', "test('x', () => { expect(() => { throw new Error('x'); }).toThrow(); })"],
    ['zero subject coupling', "test('x', () => { const arr = [1, 2]; arr.push(3); assert.equal(arr.length, 3); })"]
  ];
  for (const [label, code] of jsBadCases) {
    const scopeLine = code.includes('\n') ? code.split('\n').slice(1).join('\n') : code;
    const res = analyzeJsTestScope(scopeLine, { fileSource: code });
    assert.equal(res.valid, false, `JS case [${label}] must be rejected, got: ${JSON.stringify(res)}`);
  }

  // JS/TS genuine subject-coupled tests (must ALL pass!)
  const jsGood = "import { computeQuota } from '../src/calc.mjs';\ntest('computes net quota', () => { const r = computeQuota(5, 4, 3); assert.equal(r, 17); });";
  const jsGoodRes = analyzeJsTestScope(jsGood.split('\n')[1], { fileSource: jsGood });
  assert.equal(jsGoodRes.valid, true, JSON.stringify(jsGoodRes));
  assert.equal(jsGoodRes.subjectCoupled, true);

  // Python stdlib `ast` tautologies vs genuine assertions
  const pyBadCases = [
    ['assert True', 'def test_a():\n    assert True\n'],
    ['assert 1 == 1', 'def test_b():\n    assert 1 == 1\n'],
    ['assert x == x', 'from app import calc\ndef test_c():\n    x = calc(3)\n    assert x == x\n'],
    ['constant folded local', 'def test_d():\n    x = 10\n    assert x == 10\n'],
    ['self.assertEqual(1, 1)', 'def test_e(self):\n    self.assertEqual(1, 1)\n'],
    ['swallowed except pass', 'from app import calc\ndef test_f():\n    try:\n        assert calc(1) == 2\n    except Exception:\n        pass\n'],
    ['after return', 'from app import calc\ndef test_g():\n    return\n    assert calc(1) == 2\n']
  ];
  for (const [label, src] of pyBadCases) {
    const startLine = src.startsWith('from ') ? 2 : 1;
    const body = src.split('\n').slice(startLine - 1).join('\n');
    const res = analyzePythonTestScope(body, { fileSource: src, startLine });
    assert.equal(res.valid, false, `Python case [${label}] must be rejected, got: ${JSON.stringify(res)}`);
  }
  const pyGood = 'from app import compute_quota\ndef test_quota():\n    assert compute_quota(5, 4, 3) == 17\n';
  assert.equal(analyzePythonTestScope('def test_quota():\n    assert compute_quota(5, 4, 3) == 17\n', { fileSource: pyGood, startLine: 2 }).valid, true);

  // Go (`go/ast` + fallback) tautologies vs genuine assertions
  const goBadCases = [
    ['empty', 'func TestEmpty(t *testing.T) {\n}\n'],
    ['if false t.Fatal', 'func TestFalse(t *testing.T) {\n\tif false {\n\t\tt.Fatal("never")\n\t}\n}\n'],
    ['if 1 != 1 t.Fatal', 'func TestLit(t *testing.T) {\n\tif 1 != 1 {\n\t\tt.Fatal("never")\n\t}\n}\n'],
    ['if x != x reflexive', 'func TestRefl(t *testing.T) {\n\tx := Compute(2)\n\tif x != x {\n\t\tt.Fatal("never")\n\t}\n}\n'],
    ['const local', 'func TestConst(t *testing.T) {\n\tx := 7\n\tif x != 7 {\n\t\tt.Fatal("never")\n\t}\n}\n'],
    ['assert.True(t, true)', 'func TestTestify(t *testing.T) {\n\tassert.True(t, true)\n}\n']
  ];
  for (const [label, body] of goBadCases) {
    const full = `package calc\nimport "testing"\n${body}`;
    assert.equal(analyzeGoTestScope(body, { fileSource: full, startLine: 3 }).valid, false, `Go AST [${label}] must fail`);
    assert.equal(analyzeGoFallback(body).valid, false, `Go fallback [${label}] must fail`);
  }
  const goGoodBody = 'func TestQuota(t *testing.T) {\n\tgot := ComputeQuota(5, 4, 3)\n\tif got != 17 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n';
  assert.equal(analyzeGoTestScope(goGoodBody, { fileSource: `package calc\nimport "testing"\n${goGoodBody}`, startLine: 3 }).valid, true);

  // Rust polyglot tautologies vs genuine
  assert.equal(analyzePolyglotTestScope('#[test]\nfn t() { assert_eq!(1, 1); }', { language: 'rust' }).valid, false);
  assert.equal(analyzePolyglotTestScope('#[test]\nfn t() { assert_eq!(compute(2), 4); }', { language: 'rust' }).valid, true);
});

test('P2.1 & P2.5 vld verify --run / --report / --require-report catches failed, skipped, tautological & unrun tests and emits honest verdicts', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-exec-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { autoIds } = createMiniPacketProject(dir, { tier: 1 });
  const anchorsComment = autoIds.map((id) => `// ${REQ_TAG} ${id}`).join('\n');

  // 1. Adversarial Test F: `expect(true).toBe(true)` passes runtime but MUST FAIL `vld verify --require-assertions` AND `vld verify --run`!
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { computeQuota } from '../src/calc.mjs';

${anchorsComment}
test('tautological fake test', () => {
  assert.equal(1, 1);
});
`
  );
  const tautCheck = spawnSync(
    process.execPath,
    [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--require-assertions', '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(tautCheck.status, 1);
  const tautReport = JSON.parse(tautCheck.stdout);
  assert.equal(tautReport.verdict, 'failed');
  assert.ok(tautReport.errors.some((e) => /tautological/i.test(e)), JSON.stringify(tautReport.errors));

  // 2. Skipped test (`test.skip`) carrying `@req` MUST FAIL `vld verify --run`!
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { computeQuota } from '../src/calc.mjs';

${anchorsComment}
test('quota calculation works', { skip: 'temporarily disabled' }, () => {
  assert.equal(computeQuota(5, 4, 3), 17);
});
`
  );
  const skipRun = spawnSync(
    process.execPath,
    [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--run', '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(skipRun.status, 1);
  const skipJson = JSON.parse(skipRun.stdout);
  assert.equal(skipJson.verdict, 'failed');
  assert.ok(skipJson.errors.some((e) => /SKIPPED/i.test(e)), JSON.stringify(skipJson.errors));

  // 3. Failing test (`assert.equal(computeQuota(5, 4, 3), 999)`) passes static check (`static-asserted`), FAILS `--run`!
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { computeQuota } from '../src/calc.mjs';

${anchorsComment}
test('quota calculation works', () => {
  assert.equal(computeQuota(5, 4, 3), 999);
});
`
  );
  const staticOnly = JSON.parse(
    spawnSync(process.execPath, [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--require-assertions', '--json'], { encoding: 'utf8' }).stdout
  );
  assert.equal(staticOnly.ok, true);
  assert.equal(staticOnly.verdict, 'static-asserted', 'static run honestly labels itself static-asserted, NOT executed-verified');

  const failRun = spawnSync(process.execPath, [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--run', '--json'], { encoding: 'utf8' });
  assert.equal(failRun.status, 1);
  const failJson = JSON.parse(failRun.stdout);
  assert.equal(failJson.verdict, 'failed');
  assert.ok(failJson.errors.some((e) => /FAILED/i.test(e)));

  // 4. Genuine passing test -> `vld verify --run` succeeds with `verdict === 'executed-verified'`!
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { computeQuota } from '../src/calc.mjs';

${anchorsComment}
test('quota calculation works', () => {
  assert.equal(computeQuota(5, 4, 3), 17);
  assert.equal(computeQuota(0, 4, 3), 0);
  assert.equal(computeQuota(5, 0, 3), 0);
  assert.equal(computeQuota(2, 3, 6), 0);
});
`
  );
  const passRun = spawnSync(process.execPath, [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--run', '--json'], { encoding: 'utf8' });
  assert.equal(passRun.status, 0, passRun.stderr || passRun.stdout);
  const passJson = JSON.parse(passRun.stdout);
  assert.equal(passJson.verdict, 'executed-verified');
  assert.ok(passJson.requirementVerdicts.filter((r) => r.verify === 'automated').every((r) => r.status === 'executed-passed'));

  // 5. Offline `--report` parsers: JUnit XML, Vitest/Jest JSON, and Go `go test -json`!
  const junit = parseTestReport(
    '<testsuite tests="3"><testcase name="quota calculation works" file="tests/calc.test.mjs" time="0.01"/><testcase name="t_skip" file="tests/s.py"><skipped message="wip"/></testcase><testcase name="t_fail" file="tests/f.py"><failure message="boom"/></testcase></testsuite>'
  );
  assert.equal(junit.passed, 1);
  assert.equal(junit.skipped, 1);
  assert.equal(junit.failed, 1);

  const goNdjson = parseTestReport(
    [
      '{"Action":"run","Package":"example/calc","Test":"TestQuota"}',
      '{"Action":"pass","Package":"example/calc","Test":"TestQuota","Elapsed":0.02}',
      '{"Action":"skip","Package":"example/calc","Test":"TestSkipped","Elapsed":0.0}'
    ].join('\n')
  );
  assert.equal(goNdjson.passed, 1);
  assert.equal(goNdjson.skipped, 1);

  const vitestJson = parseTestReport(
    JSON.stringify({
      testResults: [{
        name: 'tests/calc.test.mjs',
        assertionResults: [
          { title: 'quota calculation works', status: 'passed', duration: 4 },
          { title: 'pending case', status: 'todo' }
        ]
      }]
    })
  );
  assert.equal(vitestJson.passed, 1);
  assert.equal(vitestJson.skipped, 1);

  // `--require-report` without `--report` fails!
  const missingRep = spawnSync(
    process.execPath,
    [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--require-report', '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(missingRep.status, 1);
});

test('P2.3 executed mutation gate enforces >= 60% at tier 2 and >= 75% at tier 3, catches weak suites, and parses Stryker/Gremlins/cargo-mutants', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-mutation-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { autoIds } = createMiniPacketProject(dir, { tier: 2 });
  const anchorsComment = autoIds.map((id) => `// ${REQ_TAG} ${id}`).join('\n');

  // 1. Weak test that ignores return values -> mutants survive -> mutation gate FAILS!
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { computeQuota } from '../src/calc.mjs';

${anchorsComment}
test('weak type-only test', () => {
  const res = computeQuota(5, 4, 3);
  assert.equal(typeof res, 'number');
});
`
  );
  const weakMut = await runMutationGate({ repoDir: dir, tier: 2, writeReport: true });
  assert.equal(weakMut.ok, false, `weak suite must fail mutation gate: ${JSON.stringify(weakMut)}`);
  assert.equal(weakMut.verdictLabel, 'FAIL');
  assert.ok(weakMut.score < 0.6);

  // 2. Thorough domain boundary tests -> kills >= 75% of mutants -> passes BOTH tier 2 (60%) and tier 3 (75%)!
  writeFileSync(
    path.join(dir, 'tests', 'calc.test.mjs'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { computeQuota } from '../src/calc.mjs';

${anchorsComment}
test('thorough quota boundary tests', () => {
  assert.equal(computeQuota(5, 4, 3), 17);
  assert.equal(computeQuota(0, 4, 1), 0);
  assert.equal(computeQuota(-2, 4, 1), 0);
  assert.equal(computeQuota(5, 0, 1), 0);
  assert.equal(computeQuota(5, -1, 1), 0);
  assert.equal(computeQuota(3, 4, 12), 0);
  assert.equal(computeQuota(3, 4, 15), 0);
  assert.equal(computeQuota(3, 4, 11), 1);
});
`
  );
  const strongMut = await runMutationGate({ repoDir: dir, tier: 3, writeReport: true });
  assert.equal(strongMut.ok, true, `strong suite must pass tier-3 75% mutation floor: ${JSON.stringify(strongMut)}`);
  assert.equal(strongMut.verdictLabel, 'PASS-EXECUTED');
  assert.ok(strongMut.score >= 0.75, `expected score >= 0.75, got ${strongMut.score}`);

  // Full CLI `vld verify --run --mutation` achieves top `mutation-verified` verdict!
  const fullVerify = spawnSync(
    process.execPath,
    [CLI, 'verify', path.join(dir, 'specs'), '--repo', dir, '--run', '--mutation', '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(fullVerify.status, 0, fullVerify.stderr || fullVerify.stdout);
  assert.equal(JSON.parse(fullVerify.stdout).verdict, 'mutation-verified');

  // External mutation report parsers (Stryker, Gremlins, cargo-mutants) + dated waiver
  const stryker = parseMutationReport(
    JSON.stringify({
      files: {
        'src/a.ts': {
          mutants: [
            { status: 'Killed', mutatorName: 'ArithmeticOperator' },
            { status: 'Killed', mutatorName: 'EqualityOperator' },
            { status: 'Timeout', mutatorName: 'ConditionalExpression' },
            { status: 'Survived', mutatorName: 'BooleanLiteral', location: { start: { line: 9 } } }
          ]
        }
      }
    }),
    { tier: 3 }
  );
  assert.equal(stryker.score, 0.75);
  assert.equal(stryker.ok, true);

  const gremlins = parseMutationReport(
    JSON.stringify({ files: [{ file_name: 'calc.go', mutations: [{ status: 'KILLED' }, { status: 'LIVED' }] }] }),
    { tier: 2 }
  );
  assert.equal(gremlins.score, 0.5);
  assert.equal(gremlins.ok, false);

  const cargoMut = parseMutationReport(
    JSON.stringify({ outcomes: [{ summary: 'CaughtMutant' }, { summary: 'CaughtMutant' }, { summary: 'MissedMutant' }] }),
    { tier: 2 }
  );
  assert.equal(cargoMut.ok, true);

  const waived = await runMutationGate({
    repoDir: dir,
    tier: 3,
    waiver: { owner: '@sec', reason: 'Legacy adapter migrated next sprint', expires: '2027-01-01' },
    referenceDate: '2026-11-16'
  });
  assert.equal(waived.verdictLabel, 'WAIVED');
  assert.equal(waived.ok, true);
});

test('P2.4 & P2.5 executed G0-RUN, G0-CHECK, G0-SMOKE catch HTTP 500 & lint breaks, support --static-only, and render honest summary.mjs', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vld-exec-gates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createMiniPacketProject(dir, { tier: 1 });
  const gatesMjs = path.join(dir, 'specs', 'enforcement', 'gates.mjs');
  const summaryMjs = path.join(dir, 'specs', 'enforcement', 'summary.mjs');

  // Create a smoke test file so static G0-SMOKE precondition also passes.
  writeFileSync(path.join(dir, 'tests', 'app.smoke.test.mjs'), "import test from 'node:test';\ntest('smoke', () => {});\n");

  // Pick a free ephemeral loopback port for HTTP health-probe test!
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

  // 1. Server returning HTTP 500 on `/health` -> `G0-SMOKE` MUST FAIL!
  const srvScript = path.join(dir, 'src', 'server.mjs');
  writeFileSync(
    srvScript,
    `import http from 'node:http';
const code = Number(process.argv[2] || 200);
http.createServer((_req, res) => { res.writeHead(code); res.end('status'); }).listen(${port}, '127.0.0.1');
`
  );
  mkdirSync(path.join(dir, '.vld'), { recursive: true });
  writeFileSync(
    path.join(dir, '.vld', 'smoke.json'),
    JSON.stringify({ command: [process.execPath, srvScript, '500'], healthUrl: `http://127.0.0.1:${port}/health`, expectStatus: 200, timeoutMs: 4000 })
  );

  const failSmoke = JSON.parse(spawnSync(process.execPath, [gatesMjs, '--repo', dir, '--phase', '0', '--json'], { encoding: 'utf8' }).stdout);
  const smokeRow500 = failSmoke.results.find((r) => r.id === 'G0-SMOKE');
  assert.equal(smokeRow500.status, 'fail');
  assert.equal(smokeRow500.verdictLabel, 'FAIL');
  assert.match(smokeRow500.detail, /HTTP 500/);

  // 2. `--static-only` skips execution, prints honest `STATIC-ONLY` verdict & `SKIPPED-STATIC-ONLY` labels!
  const staticGates = JSON.parse(
    spawnSync(process.execPath, [gatesMjs, '--repo', dir, '--phase', '0', '--static-only', '--json'], { encoding: 'utf8' }).stdout
  );
  assert.equal(staticGates.mode, 'static-only');
  assert.equal(staticGates.verdict, 'STATIC-ONLY');
  assert.equal(staticGates.results.find((r) => r.id === 'G0-SMOKE').verdictLabel, 'SKIPPED-STATIC-ONLY');

  // 3. Fix server to return HTTP 200 -> `G0-RUN`, `G0-CHECK`, and `G0-SMOKE` ALL report `PASS-EXECUTED`!
  writeFileSync(
    path.join(dir, '.vld', 'smoke.json'),
    JSON.stringify({ command: [process.execPath, srvScript, '200'], healthUrl: `http://127.0.0.1:${port}/health`, expectStatus: 200, timeoutMs: 4000 })
  );
  const reportFile = path.join(dir, 'gates-report.json');
  const passOut = spawnSync(process.execPath, [gatesMjs, '--repo', dir, '--phase', '0', '--json'], { encoding: 'utf8' });
  assert.equal(passOut.status, 0, passOut.stderr || passOut.stdout);
  writeFileSync(reportFile, passOut.stdout);
  const passGates = JSON.parse(passOut.stdout);
  for (const id of ['G0-RUN', 'G0-CHECK', 'G0-SMOKE']) {
    const row = passGates.results.find((r) => r.id === id);
    assert.equal(row.verdictLabel, 'PASS-EXECUTED', `${id} must be PASS-EXECUTED, got ${JSON.stringify(row)}`);
    assert.equal(row.mode, 'executed');
  }

  // 4. `summary.mjs` renders honest `PASS-EXECUTED` and `--static-only` Markdown tables!
  const md = spawnSync(process.execPath, [summaryMjs, reportFile], { encoding: 'utf8' }).stdout;
  assert.match(md, /### Specification enforcement — EXECUTED-PASS/);
  assert.match(md, /\| `G0-SMOKE` \| ✅ PASS-EXECUTED \|/);

  const staticReportFile = path.join(dir, 'static-report.json');
  writeFileSync(staticReportFile, JSON.stringify(staticGates, null, 2));
  const staticMd = spawnSync(process.execPath, [summaryMjs, staticReportFile], { encoding: 'utf8' }).stdout;
  assert.match(staticMd, /### Specification enforcement — STATIC-ONLY/);
  assert.match(staticMd, /SKIPPED-STATIC-ONLY/);
  assert.match(staticMd, /`--static-only`/);
});
