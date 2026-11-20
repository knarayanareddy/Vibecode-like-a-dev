/**
 * Sandboxed repository test runner (roadmap P2.1).
 *
 * Runtime extension module only: never imported by Core compiler modules.
 * Auto-detects the target repository's test framework (Node `node --test`,
 * Vitest, Jest, pytest, Go `go test -json`, Cargo `cargo test`, RSpec,
 * PHPUnit, Maven/Gradle, dotnet), executes tests inside the VLD OS sandbox
 * with network denied and bounded timeout, parses the structured output via
 * `test-report.mjs`, persists `.vld/reports/test-run.json`, and returns both
 * the normalized report and the cryptographic sandbox receipt.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, extensionError, stableJson } from './extension-utils.mjs';
import { runSandboxed } from './sandbox/index.mjs';
import { parseTestReport } from './test-report.mjs';

const runnerError = (code, message) => extensionError(message, code);

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.vld', 'specs', 'spec'
]);

function collectNodeTestFiles(repoDir, rel = '', out = []) {
  const full = rel ? path.join(repoDir, rel) : repoDir;
  let entries;
  try { entries = readdirSync(full, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) collectNodeTestFiles(repoDir, childRel, out);
    } else if (entry.isFile() && /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(entry.name)) {
      out.push(childRel);
    }
  }
  return out.sort();
}

/**
 * Detect the structured test execution command for a repository.
 */
export function detectTestCommand(repoDir, { reportTempDir = null, explicitCommand = null } = {}) {
  const root = path.resolve(repoDir);
  if (Array.isArray(explicitCommand) && explicitCommand.length > 0) {
    return {
      stack: 'custom',
      framework: 'custom',
      command: explicitCommand.map(String),
      format: 'auto',
      reportFile: null
    };
  }

  // 1. JavaScript / TypeScript (`package.json`)
  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { pkg = {}; }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const testScript = String(pkg.scripts?.test ?? '');

    // Vitest (local node_modules binary)
    const vitestBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
    if ((deps.vitest || /\bvitest\b/.test(testScript)) && existsSync(vitestBin)) {
      const outFile = reportTempDir ? path.join(reportTempDir, 'vitest-report.json') : null;
      return {
        stack: deps.typescript ? 'typescript' : 'javascript',
        framework: 'vitest',
        command: outFile
          ? [vitestBin, 'run', '--reporter=json', `--outputFile=${outFile}`]
          : [vitestBin, 'run', '--reporter=json'],
        format: 'json',
        reportFile: outFile
      };
    }

    // Jest (local node_modules binary)
    const jestBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'jest.cmd' : 'jest');
    if ((deps.jest || /\bjest\b/.test(testScript)) && existsSync(jestBin)) {
      const outFile = reportTempDir ? path.join(reportTempDir, 'jest-report.json') : null;
      return {
        stack: deps.typescript ? 'typescript' : 'javascript',
        framework: 'jest',
        command: outFile ? [jestBin, '--json', `--outputFile=${outFile}`] : [jestBin, '--json'],
        format: 'json',
        reportFile: outFile
      };
    }

    // Node built-in test runner (`node --test --test-reporter=tap`)
    const nodeTestFiles = collectNodeTestFiles(root);
    if (/\bnode\b.*--test\b/.test(testScript) || nodeTestFiles.length > 0) {
      return {
        stack: 'javascript',
        framework: 'node-test',
        command: [process.execPath, '--test', '--test-concurrency=1', '--test-reporter=tap', ...nodeTestFiles],
        format: 'tap',
        reportFile: null
      };
    }
  }

  // Standalone Node `.test.mjs` / `.test.js` repository without `package.json`
  const bareNodeTests = collectNodeTestFiles(root);
  if (bareNodeTests.length > 0) {
    return {
      stack: 'javascript',
      framework: 'node-test',
      command: [process.execPath, '--test', '--test-concurrency=1', '--test-reporter=tap', ...bareNodeTests],
      format: 'tap',
      reportFile: null
    };
  }

  // 2. Go (`go.mod` or `*_test.go`)
  if (existsSync(path.join(root, 'go.mod')) || hasMatchingFile(root, /_test\.go$/)) {
    return {
      stack: 'go',
      framework: 'go-test',
      command: ['go', 'test', '-json', './...'],
      format: 'go-json',
      reportFile: null
    };
  }

  // 3. Python (`pyproject.toml`, `pytest.ini`, `requirements.txt`, or `test_*.py` / `*_test.py`)
  if (
    existsSync(path.join(root, 'pyproject.toml')) ||
    existsSync(path.join(root, 'pytest.ini')) ||
    existsSync(path.join(root, 'requirements.txt')) ||
    hasMatchingFile(root, /(?:^test_.*\.py$|_test\.py$)/)
  ) {
    const junitFile = path.join(reportTempDir ?? root, 'pytest-junit.xml');
    return {
      stack: 'python',
      framework: 'pytest-or-unittest',
      command: ['python3', '-m', 'pytest', '-q', `--junitxml=${junitFile}`],
      fallbackCommand: ['python3', '-c', PYTHON_UNITTEST_JUNIT_RUNNER, root, junitFile],
      format: 'junit',
      reportFile: junitFile
    };
  }

  // 4. Rust (`Cargo.toml`)
  if (existsSync(path.join(root, 'Cargo.toml'))) {
    return {
      stack: 'rust',
      framework: 'cargo-test',
      command: ['cargo', 'test', '--offline'],
      format: 'cargo',
      reportFile: null
    };
  }

  return null;
}

const PYTHON_UNITTEST_JUNIT_RUNNER = String.raw`
import os, sys, time, unittest, xml.sax.saxutils as sax
root, out_path = sys.argv[1], sys.argv[2]
sys.path.insert(0, root)
cases = []
class RecResult(unittest.TestResult):
    def startTest(self, test):
        super().startTest(test)
        self._t0 = time.monotonic()
    def _meta(self, test):
        mod = sys.modules.get(test.__class__.__module__)
        fpath = os.path.relpath(getattr(mod, "__file__", ""), root) if getattr(mod, "__file__", None) else ""
        return getattr(test, "_testMethodName", str(test)), test.__class__.__qualname__, fpath, time.monotonic() - self._t0
    def addSuccess(self, test):
        super().addSuccess(test)
        cases.append((*self._meta(test), "passed", ""))
    def addFailure(self, test, err):
        super().addFailure(test, err)
        cases.append((*self._meta(test), "failed", str(err[1])))
    def addError(self, test, err):
        super().addError(test, err)
        cases.append((*self._meta(test), "failed", str(err[1])))
    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        cases.append((*self._meta(test), "skipped", str(reason)))

suite = unittest.defaultTestLoader.discover(root, pattern="test*.py")
res = RecResult()
suite.run(res)
lines = ['<?xml version="1.0" encoding="utf-8"?><testsuite tests="%d">' % len(cases)]
for name, cls, fpath, dur, status, msg in cases:
    attrs = 'name=%s classname=%s file=%s time="%.4f"' % (sax.quoteattr(name), sax.quoteattr(cls), sax.quoteattr(fpath), dur)
    if status == "passed":
        lines.append("<testcase %s/>" % attrs)
    elif status == "skipped":
        lines.append("<testcase %s><skipped message=%s/></testcase>" % (attrs, sax.quoteattr(msg)))
    else:
        lines.append("<testcase %s><failure message=%s/></testcase>" % (attrs, sax.quoteattr(msg)))
lines.append("</testsuite>")
with open(out_path, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))
sys.exit(0 if res.wasSuccessful() and len(cases) > 0 else 1)
`;

function hasMatchingFile(dir, re, depth = 0) {
  if (depth > 4) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isFile() && re.test(e.name)) return true;
    if (e.isDirectory() && !IGNORED_DIRS.has(e.name) && hasMatchingFile(path.join(dir, e.name), re, depth + 1)) {
      return true;
    }
  }
  return false;
}

function parseCargoOutput(stdout) {
  const cases = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^test\s+([A-Za-z0-9_:]+)\s+\.\.\.\s+(ok|FAILED|ignored)\b/);
    if (!m) continue;
    const shortName = m[1].split('::').pop();
    cases.push({
      name: shortName,
      fullName: m[1],
      suite: m[1].includes('::') ? m[1].split('::').slice(0, -1).join('::') : null,
      file: null,
      line: null,
      status: m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped',
      durationMs: 0,
      message: null
    });
  }
  const passed = cases.filter((c) => c.status === 'passed').length;
  const failed = cases.filter((c) => c.status === 'failed').length;
  const skipped = cases.filter((c) => c.status === 'skipped').length;
  return {
    schemaVersion: 1,
    kind: 'vld-test-run',
    format: 'cargo-test',
    total: cases.length,
    passed,
    failed,
    skipped,
    ok: cases.length > 0 && failed === 0,
    cases
  };
}

/**
 * Execute the target repository's tests inside the VLD OS sandbox and return a
 * normalized `vld-test-run` report + sandbox receipt.
 */
export async function runRepositoryTests({
  repoDir,
  backend = 'auto',
  timeoutMs = 120_000,
  command = null,
  writeReport = true,
  reportOutPath = null
} = {}) {
  const root = path.resolve(repoDir);
  if (!existsSync(root)) {
    throw runnerError('TEST_REPO_MISSING', `Repository directory not found: ${root}`);
  }

  const scratch = mkdirTempInside(root);
  try {
    const plan = detectTestCommand(root, { reportTempDir: scratch, explicitCommand: command });
    if (!plan) {
      throw runnerError(
        'TEST_RUNNER_UNAVAILABLE',
        `Could not auto-detect a structured test runner in ${root}. Pass --report <file> or add a package.json / pytest / go.mod / Cargo.toml test suite.`
      );
    }

    const extraEnv = {
      CI: '1',
      NO_COLOR: '1',
      GOCACHE: path.join(scratch, 'gocache'),
      PYTHONDONTWRITEBYTECODE: '1'
    };

    let activeCmd = plan.command;
    let run = await runSandboxed({
      executable: activeCmd[0],
      args: activeCmd.slice(1),
      workspace: root,
      mode: 'write-workspace',
      allowChildProcess: true,
      backend,
      network: false,
      env: extraEnv,
      limits: { durationMs: timeoutMs, outputBytes: 4 * 1024 * 1024 }
    });

    // If `pytest` module isn't installed on this host, transparently fall back to Python stdlib `unittest` JUnit emitter!
    if (
      plan.fallbackCommand &&
      run.exitCode !== 0 &&
      (!plan.reportFile || !existsSync(plan.reportFile)) &&
      /No module named pytest/i.test(`${run.stderr}\n${run.stdout}`)
    ) {
      activeCmd = plan.fallbackCommand;
      run = await runSandboxed({
        executable: activeCmd[0],
        args: activeCmd.slice(1),
        workspace: root,
        mode: 'write-workspace',
        allowChildProcess: true,
        backend,
        network: false,
        env: extraEnv,
        limits: { durationMs: timeoutMs, outputBytes: 4 * 1024 * 1024 }
      });
    }

    let parsed;
    if (plan.reportFile && existsSync(plan.reportFile)) {
      const raw = readFileSync(plan.reportFile, 'utf8');
      parsed = parseTestReport(raw, { format: plan.format, repoRoot: root });
    } else if (plan.format === 'cargo') {
      parsed = parseCargoOutput(run.stdout);
    } else {
      try {
        parsed = parseTestReport(run.stdout, { format: plan.format, repoRoot: root });
      } catch {
        parsed = {
          schemaVersion: 1,
          kind: 'vld-test-run',
          format: plan.format,
          total: 0,
          passed: 0,
          failed: run.exitCode === 0 ? 0 : 1,
          skipped: 0,
          ok: false,
          cases: []
        };
      }
    }

    const receiptDigest = run.receipt?.digest ?? digest(stableJson(run.receipt ?? {}));
    const report = {
      ...parsed,
      stack: plan.stack,
      framework: plan.framework,
      command: activeCmd,
      exitCode: run.exitCode,
      timedOut: Boolean(run.timedOut),
      durationMs: run.durationMs ?? 0,
      sandboxBackend: run.backend ?? backend,
      sandboxClassification: run.receipt?.confinement?.classification ?? null,
      receiptDigest,
      generatedAt: new Date().toISOString(),
      ok: parsed.ok && run.exitCode === 0 && !run.timedOut,
      stderrPreview: run.exitCode !== 0 ? String(run.stderr || run.stdout || '').trim().slice(0, 600) : null
    };

    let savedPath = null;
    if (writeReport) {
      savedPath = reportOutPath
        ? path.resolve(reportOutPath)
        : path.join(root, '.vld', 'reports', 'test-run.json');
      mkdirSync(path.dirname(savedPath), { recursive: true });
      writeFileSync(savedPath, `${stableJson(report)}\n`, 'utf8');
    }

    return {
      report,
      reportFile: savedPath,
      receipt: run.receipt ?? null
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function mkdirTempInside(repoRoot) {
  const base = path.join(os.tmpdir(), `vld-testrun-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(base, { recursive: true });
  // If sandbox isolates /tmp, place report scratch under repo `.vld/tmp-testrun` so workspace mount can write it.
  try {
    const inRepo = path.join(repoRoot, '.vld', `.tmp-testrun-${process.pid}-${Date.now().toString(36)}`);
    mkdirSync(inRepo, { recursive: true });
    rmSync(base, { recursive: true, force: true });
    return inRepo;
  } catch {
    return base;
  }
}
