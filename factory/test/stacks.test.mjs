/**
 * Roadmap 1.7 (F-09, F-14) and 0.3 (F-12):
 * - Data-driven stack profiles for 10 ecosystems with discoverable anchors
 * - Multi-service constraints.stack maps and full-stack FastAPI adoption
 * - Relocatable packet commands, compile CI command output, once-per-session runtime notice
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adoptRepo } from '../lib/adopt.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { loadProfile, normalizeProfile, validateProfile } from '../lib/profile.mjs';
import { getStackProfile, isAnchorDiscoverable, loadStacks } from '../lib/stacks.mjs';
import { verifyPacket } from '../lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'cli.mjs');
const INDEX = buildIndex();

const EXPECTED_STACKS = [
  ['typescript', /^tests\/[a-z0-9-]+\.test\.ts$/, '// @req REQ-xxx', 'Stryker', 'fast-check', 'npm test'],
  ['javascript', /^tests\/[a-z0-9-]+\.test\.js$/, '// @req REQ-xxx', 'Stryker', 'fast-check', 'npm test'],
  ['python', /^tests\/test_[a-z0-9_]+\.py$/, '# @req REQ-xxx', 'mutmut', 'hypothesis', 'pytest'],
  ['go', /^[a-z0-9_]+_test\.go$/, '// @req REQ-xxx', 'go-mutesting', 'rapid', 'go test ./...'],
  ['rust', /^tests\/[a-z0-9_]+\.rs$/, '// @req REQ-xxx', 'cargo-mutants', 'proptest', 'cargo test'],
  ['java', /^src\/test\/java\/[A-Z][A-Za-z0-9]*Test\.java$/, '// @req REQ-xxx', 'PIT', 'jqwik', './mvnw test'],
  ['kotlin', /^src\/test\/kotlin\/[A-Z][A-Za-z0-9]*Test\.kt$/, '// @req REQ-xxx', 'PIT', 'jqwik', './gradlew test'],
  ['ruby', /^spec\/[a-z0-9_]+_spec\.rb$/, '# @req REQ-xxx', 'mutant', 'rantly', 'bundle exec rspec'],
  ['php', /^tests\/[A-Z][A-Za-z0-9]*Test\.php$/, '// @req REQ-xxx', 'Infection', 'eris', 'vendor/bin/phpunit'],
  ['csharp', /^tests\/[A-Z][A-Za-z0-9]*Tests\.cs$/, '// @req REQ-xxx', 'Stryker.NET', 'FsCheck', 'dotnet test']
];

test('all 10 built-in stacks emit idiomatic, runner-discoverable anchors without choose-runner fallbacks', (t) => {
  const stacks = loadStacks();
  assert.equal(stacks.size, 10);

  for (const [id, anchorRe, syntax, mutationTool, propertyLib, testCmd] of EXPECTED_STACKS) {
    const stackProfile = getStackProfile(id);
    assert.ok(stackProfile, `missing stack profile ${id}`);
    assert.equal(stackProfile.mutation.tool, mutationTool);
    assert.equal(stackProfile.propertyLibrary, propertyLib);
    assert.ok(stackProfile.commands.lint && stackProfile.commands.typecheck && stackProfile.commands.test);

    const root = mkdtempSync(path.join(os.tmpdir(), `vld-stack-${id}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outDir = path.join(root, 'specs');
    const profile = normalizeProfile({
      name: `svc-${id}`,
      idea: 'A production billing service that reconciles settled invoices across customer tenants.',
      kind: 'api',
      stage: 'production',
      traits: ['auth', 'payments', 'persistence'],
      risks: { payments: true, pii: true, multiTenant: true, regulated: true },
      regulation: ['pci-dss'],
      constraints: { stack: id }
    });
    emitPacket(buildPlan(profile, { index: INDEX }), outDir);

    const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
    assert.equal(spec.anchorConvention.syntax, syntax, `${id} anchor syntax`);
    const automated = spec.requirements.filter((req) => req.verify === 'automated');
    assert.ok(automated.length > 0);
    for (const req of automated) {
      assert.match(req.anchor, anchorRe, `${id} anchor pattern mismatch: ${req.anchor}`);
      assert.equal(isAnchorDiscoverable(stackProfile, req.anchor), true, `${id} anchor not matched by default glob: ${req.anchor}`);
      assert.doesNotMatch(req.anchor, /choose-runner/);
    }

    const agents = readFileSync(path.join(outDir, 'AGENTS.md'), 'utf8');
    const verification = readFileSync(path.join(outDir, '05-verification.md'), 'utf8');
    assert.ok(agents.includes(testCmd), `${id} AGENTS.md should include ${testCmd}`);
    assert.doesNotMatch(agents, /no built-in profile|choose-runner/);
    assert.ok(verification.includes(mutationTool), `${id} verification should name ${mutationTool}`);
    assert.ok(verification.includes(propertyLib), `${id} verification should name ${propertyLib}`);
    if (id === 'rust') {
      assert.match(agents, /cargo clippy/);
      assert.match(agents, /cargo test/);
      assert.match(verification, /\/\/ @req REQ-\d{3,}/);
    }
    assert.equal(verifyPacket(outDir).ok, true);
  }
});

test('adopting a full-stack FastAPI layout yields { backend: "python", frontend: "typescript" } and emits per-service command blocks', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'vld-fastapi-fullstack-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(path.join(repo, 'backend', 'app', 'tests'), { recursive: true });
  mkdirSync(path.join(repo, 'frontend', 'src'), { recursive: true });
  writeFileSync(
    path.join(repo, 'backend', 'pyproject.toml'),
    [
      '[project]',
      'name = "app"',
      'version = "0.1.0"',
      'dependencies = ["fastapi>=0.114.2", "sqlmodel>=0.0.21", "alembic>=1.12.1", "pyjwt>=2.8.0"]',
      '[tool.uv]',
      'dev-dependencies = ["pytest>=8.0.0", "mypy>=1.8.0", "ruff>=0.2.0"]'
    ].join('\n')
  );
  writeFileSync(path.join(repo, 'backend', 'app', 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
  writeFileSync(path.join(repo, 'backend', 'app', 'tests', 'test_main.py'), 'from app.main import app\ndef test_ok():\n    assert app is not None\n');
  writeFileSync(
    path.join(repo, 'frontend', 'package.json'),
    JSON.stringify({
      name: 'frontend',
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { typescript: '^5.6.2', vite: '^5.4.8', '@playwright/test': '^1.48.0' }
    }, null, 2)
  );
  writeFileSync(path.join(repo, 'frontend', 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
  writeFileSync(path.join(repo, 'frontend', 'src', 'main.tsx'), 'export const App = () => null;\n');

  const adopted = adoptRepo(repo, {
    name: 'fullstack-fastapi',
    idea: 'A full-stack project template managing team items with a FastAPI backend and React frontend.'
  });
  assert.deepEqual(adopted.profile.constraints.stack, {
    backend: 'python',
    frontend: 'typescript'
  });
  assert.deepEqual(validateProfile(adopted.profile), []);

  const outDir = path.join(repo, 'specs');
  emitPacket(buildPlan(adopted.profile, { index: INDEX }), outDir);
  const agents = readFileSync(path.join(outDir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\(cd backend && ruff check \. && mypy \. && pytest\)/);
  assert.match(agents, /\(cd frontend && npm run lint && npm run typecheck && npm test\)/);

  const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
  const backendAnchor = spec.requirements.find((r) => r.verify === 'automated' && r.area !== 'frontend')?.anchor;
  const frontendAnchor = spec.requirements.find((r) => r.verify === 'automated' && r.area === 'frontend')?.anchor;
  assert.match(backendAnchor, /^backend\/tests\/test_[a-z0-9_]+\.py$/);
  assert.match(frontendAnchor, /^frontend\/tests\/[a-z0-9-]+\.test\.ts$/);
  assert.equal(isAnchorDiscoverable(getStackProfile('python'), backendAnchor, { servicePrefix: 'backend' }), true);
  assert.equal(isAnchorDiscoverable(getStackProfile('typescript'), frontendAnchor, { servicePrefix: 'frontend' }), true);
  assert.equal(verifyPacket(outDir).ok, true);
});

test('copying a compiled packet to a new directory keeps every AGENTS.md check command working, and compile prints CI command', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-relocate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileFile = path.join(root, 'profile.json');
  writeFileSync(
    profileFile,
    JSON.stringify({
      name: 'relocate-check',
      idea: 'A weekly standup digest service that collects short team updates before noon.',
      kind: 'api',
      stage: 'mvp',
      traits: ['auth', 'persistence'],
      risks: { pii: true },
      constraints: { stack: 'python' }
    }, null, 2)
  );

  const initialDir = path.join(root, 'out-initial');
  const compileRun = spawnSync(process.execPath, [CLI, 'compile', profileFile, '-o', initialDir], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.equal(compileRun.status, 0, compileRun.stderr);
  assert.match(
    compileRun.stdout,
    /CI gate: node out-initial\/spec-check\.mjs --repo \. --strict --require-assertions && node out-initial\/enforcement\/gates\.mjs --repo \. --strict/
  );

  // Copy packet into a different repo under an arbitrary nested folder name.
  const targetRepo = path.join(root, 'target-app');
  const movedDir = path.join(targetRepo, 'docs', 'custom-specs');
  mkdirSync(path.join(targetRepo, '.git'), { recursive: true });
  mkdirSync(path.join(targetRepo, '.github', 'workflows'), { recursive: true });
  mkdirSync(path.join(targetRepo, 'tests'), { recursive: true });
  mkdirSync(path.dirname(movedDir), { recursive: true });
  writeFileSync(
    path.join(targetRepo, 'README.md'),
    '# App\n\n## Run\n\n```bash\npytest\n```\n\n## Test\n\nRun `pytest`.\n\n## Deploy\n\nDeploy via CI.\n\n## Known limitations\n\nMVP scope.\n'
  );
  writeFileSync(
    path.join(targetRepo, '.github', 'workflows', 'ci.yml'),
    'name: ci\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ruff check .\n      - run: pytest\n'
  );
  writeFileSync(path.join(targetRepo, 'tests', 'test_smoke.py'), 'from app import run\ndef test_smoke():\n    assert run() == 0\n');
  cpSync(initialDir, movedDir, { recursive: true });
  rmSync(initialDir, { recursive: true, force: true });

  const agents = readFileSync(path.join(movedDir, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /out-initial/, 'moved packet must not hold stale compile directory path');

  const nodeCommands = agents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node '));
  assert.ok(nodeCommands.length >= 2, 'AGENTS.md lists spec-check and gates commands');
  for (const cmd of nodeCommands) {
    const parts = cmd.split(/\s+/).slice(1);
    const run = spawnSync(process.execPath, parts, { cwd: movedDir, encoding: 'utf8' });
    assert.equal(run.status, 0, `command "${cmd}" failed after relocation:\n${run.stdout}\n${run.stderr}`);
  }
});

test('experimental runtime notice prints once per session rather than on every invocation', () => {
  const sessionId = `test-session-${process.pid}-${Date.now()}`;
  const env = { ...process.env, VLD_SESSION_ID: sessionId };
  const first = spawnSync(process.execPath, [CLI, 'agent', 'list'], { encoding: 'utf8', env });
  const second = spawnSync(process.execPath, [CLI, 'agent', 'list'], { encoding: 'utf8', env });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.match(first.stderr, /experimental runtime, not the compiler/);
  assert.equal(second.stderr.trim(), '', 'second call in same session should suppress repeated notice');
});
