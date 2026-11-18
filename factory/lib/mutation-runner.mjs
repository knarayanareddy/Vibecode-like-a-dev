/**
 * Executed mutation gate runner & report parser (roadmap P2.3).
 *
 * Runtime extension module only: never imported by Core compiler modules.
 *
 * Tier kill-score floors:
 *   - Tier < 2: advisory / not required (0.00)
 *   - Tier 2 (`G2-MUTATION`): >= 60% (`0.60`)
 *   - Tier 3 (`G3-MUTATION`): >= 75% (`0.75`)
 *
 * Supports:
 *   1. Ingesting industry mutation reports:
 *      - Stryker / mutation-testing-elements JSON (`files: { [p]: { mutants: [...] } }`)
 *      - Gremlins (Go) JSON (`files: [{ mutations: [{ status }] }]`)
 *      - cargo-mutants `outcomes.json` (`outcomes: [{ summary }]`)
 *      - VLD `vld-mutation-report` JSON
 *   2. Invoking installed external tools (`stryker`, `mutmut`, `gremlins`,
 *      `cargo-mutants`) inside the OS sandbox when present.
 *   3. Built-in zero-dependency sandboxed syntactic mutation testing for JS/TS,
 *      Python, and Go repositories so tier >= 2 projects get REAL mutation
 *      execution on clean Node/Python/Go hosts without third-party installs.
 *   4. Honest `SKIPPED-UNAVAILABLE` / `WAIVED` / `PASS-EXECUTED` / `FAIL` status
 *      (never silently passes on a bare config file!).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableJson } from './extension-utils.mjs';
import { runSandboxed } from './sandbox/index.mjs';
import { detectTestCommand } from './test-runner.mjs';

export const MUTATION_THRESHOLDS = Object.freeze({
  0: 0,
  1: 0,
  2: 0.60,
  3: 0.75
});

export function mutationThresholdForTier(tier) {
  const n = Number(tier ?? 0);
  if (n >= 3) return MUTATION_THRESHOLDS[3];
  if (n === 2) return MUTATION_THRESHOLDS[2];
  return 0;
}

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'coverage', 'target', '.vld', 'specs', 'spec', 'tests', 'test', '__tests__',
  'e2e', 'docs', 'enforcement'
]);

const TEST_FILE_RE = /\.(?:test|spec)\.[a-z]+$|^test_[^/]+\.py$|_test\.(?:py|go|rs)$|Tests?\.(?:java|kt|cs|php)$/;
const MUTABLE_SOURCE_RE = /\.(?:mjs|cjs|js|ts|py|go)$/;

/** Parse Stryker, Gremlins, cargo-mutants, or VLD mutation JSON into canonical metrics. */
export function parseMutationReport(rawText, { tier = 2 } = {}) {
  const parsed = JSON.parse(String(rawText ?? '{}'));
  const threshold = mutationThresholdForTier(tier);

  if (parsed.kind === 'vld-mutation-report') {
    const score = Number(parsed.score ?? 0);
    return {
      ...parsed,
      threshold,
      ok: parsed.total > 0 && score >= threshold,
      verdictLabel: parsed.total > 0 && score >= threshold ? 'PASS-EXECUTED' : 'FAIL'
    };
  }

  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let ignored = 0;
  const survivors = [];

  // Stryker / mutation-testing-elements schema
  if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
    for (const [file, info] of Object.entries(parsed.files)) {
      for (const m of info?.mutants ?? []) {
        const st = String(m.status ?? '');
        if (st === 'Killed' || st === 'CompileError') killed += 1;
        else if (st === 'Timeout') { killed += 1; timeout += 1; }
        else if (st === 'Survived' || st === 'NoCoverage') {
          survived += 1;
          survivors.push({ file, line: m.location?.start?.line ?? null, operator: m.mutatorName ?? 'unknown', replacement: m.replacement ?? '' });
        } else {
          ignored += 1;
        }
      }
    }
    return buildMutationSummary({ tool: 'stryker', killed, survived, timeout, ignored, survivors, threshold });
  }

  // Gremlins (Go) JSON schema
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files) {
      for (const m of f?.mutations ?? []) {
        const st = String(m.status ?? '').toUpperCase();
        if (st === 'KILLED') killed += 1;
        else if (st === 'TIMED OUT') { killed += 1; timeout += 1; }
        else if (st === 'LIVED' || st === 'NOT COVERED') {
          survived += 1;
          survivors.push({ file: f.file_name ?? 'unknown', line: m.line ?? null, operator: m.type ?? 'gremlins', replacement: '' });
        } else {
          ignored += 1;
        }
      }
    }
    return buildMutationSummary({ tool: 'gremlins', killed, survived, timeout, ignored, survivors, threshold });
  }

  // cargo-mutants `outcomes.json`
  if (Array.isArray(parsed.outcomes)) {
    for (const o of parsed.outcomes) {
      const st = String(o.summary ?? '');
      if (st === 'CaughtMutant') killed += 1;
      else if (st === 'Timeout') { killed += 1; timeout += 1; }
      else if (st === 'MissedMutant') {
        survived += 1;
        survivors.push({ file: o.scenario?.Mutant?.file ?? 'unknown', line: o.scenario?.Mutant?.span?.start?.line ?? null, operator: 'cargo-mutants', replacement: o.scenario?.Mutant?.replacement ?? '' });
      } else {
        ignored += 1;
      }
    }
    return buildMutationSummary({ tool: 'cargo-mutants', killed, survived, timeout, ignored, survivors, threshold });
  }

  throw new Error('Unrecognized mutation report JSON schema; expected VLD, Stryker, Gremlins, or cargo-mutants format.');
}

function buildMutationSummary({ tool, killed, survived, timeout, ignored, survivors, threshold, durationMs = 0 }) {
  const total = killed + survived;
  const score = total > 0 ? Number((killed / total).toFixed(4)) : 0;
  const ok = total > 0 && score >= threshold;
  return {
    schemaVersion: 1,
    kind: 'vld-mutation-report',
    tool,
    total,
    killed,
    survived,
    timeout,
    ignored,
    score,
    threshold,
    ok,
    verdictLabel: ok ? 'PASS-EXECUTED' : 'FAIL',
    durationMs,
    survivors: survivors.slice(0, 50),
    generatedAt: new Date().toISOString()
  };
}

/** Mutation operator rules per line (skips comments, imports, and logging lines). */
const MUTATION_OPERATORS = [
  { id: 'strict-eq-flip', langs: ['js'], re: /===/, replace: '!==' },
  { id: 'strict-neq-flip', langs: ['js'], re: /!==/, replace: '===' },
  { id: 'eq-flip', langs: ['py', 'go'], re: /(?<![=!<>])==(?!=)/, replace: '!=' },
  { id: 'neq-flip', langs: ['py', 'go'], re: /!=(?!=)/, replace: '==' },
  { id: 'gte-to-lt', langs: ['js', 'py', 'go'], re: />=/, replace: '<' },
  { id: 'lte-to-gt', langs: ['js', 'py', 'go'], re: /<=/, replace: '>' },
  { id: 'gt-to-lte', langs: ['js', 'py', 'go'], re: /(?<![-=])>(?![=>])/, replace: '<=' },
  { id: 'lt-to-gte', langs: ['js', 'py', 'go'], re: /(?<!<)<(?![=<])/, replace: '>=' },
  { id: 'arith-add-sub', langs: ['js', 'py', 'go'], re: /(\b[A-Za-z0-9_]+\s*)\+(\s*[A-Za-z0-9_]+\b)/, replace: '$1-$2' },
  { id: 'arith-sub-add', langs: ['js', 'py', 'go'], re: /(\b[A-Za-z0-9_]+\s*)-(\s*[A-Za-z0-9_]+\b)/, replace: '$1+$2' },
  { id: 'arith-mul-div', langs: ['js', 'py', 'go'], re: /(\b[A-Za-z0-9_]+\s*)\*(\s*[1-9A-Za-z_]\w*\b)/, replace: '$1/$2' },
  { id: 'bool-true-false', langs: ['js', 'go'], re: /\btrue\b/, replace: 'false' },
  { id: 'bool-false-true', langs: ['js', 'go'], re: /\bfalse\b/, replace: 'true' },
  { id: 'py-true-false', langs: ['py'], re: /\bTrue\b/, replace: 'False' },
  { id: 'py-false-true', langs: ['py'], re: /\bFalse\b/, replace: 'True' },
  { id: 'logic-and-or', langs: ['js', 'go'], re: /&&/, replace: '||' },
  { id: 'logic-or-and', langs: ['js', 'go'], re: /\|\|/, replace: '&&' },
  { id: 'py-and-or', langs: ['py'], re: /\band\b/, replace: 'or' },
  { id: 'return-empty', langs: ['js'], re: /\breturn\s+(?!null\b|undefined\b|;|true\b|false\b)(\S.+?);?$/, replace: 'return null;' }
];

function fileLang(rel) {
  if (rel.endsWith('.py')) return 'py';
  if (rel.endsWith('.go')) return 'go';
  if (/\.(?:mjs|cjs|js|ts)$/.test(rel)) return 'js';
  return null;
}

function collectMutableSourceFiles(repoDir, targetGlobs = null, rel = '', out = []) {
  const full = rel ? path.join(repoDir, rel) : repoDir;
  let entries;
  try { entries = readdirSync(full, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectMutableSourceFiles(repoDir, targetGlobs, childRel, out);
    } else if (e.isFile() && MUTABLE_SOURCE_RE.test(e.name) && !TEST_FILE_RE.test(e.name) && !e.name.endsWith('.d.ts')) {
      if (!targetGlobs || targetGlobs.some((prefix) => childRel.startsWith(prefix) || childRel === prefix)) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/** Generate up to `maxMutants` deterministic single-site source mutants across `files`. */
export function generateSyntacticMutants(repoDir, files, { maxMutants = 24 } = {}) {
  const mutants = [];
  for (const rel of files) {
    const lang = fileLang(rel);
    if (!lang) continue;
    const source = readFileSync(path.join(repoDir, rel), 'utf8');
    const lines = source.split('\n');
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (mutants.length >= maxMutants) return mutants;
      const line = lines[idx];
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip comments, imports, package decls, and logging calls (equivalent noise)
      if (/^(?:\/\/|#|\/\*|\*|import\b|from\b|package\b|export\s+type\b|type\s+\w+\s+interface)/.test(trimmed)) continue;
      if (/\b(?:console\.(?:log|warn|debug)|print\s*\(|log\.Print|fmt\.Print)/.test(trimmed)) continue;
      // Avoid mutating Go `if err != nil` only when replacing with literal string errors; `err != nil` -> `err == nil` IS a great mutant!
      for (const op of MUTATION_OPERATORS) {
        if (!op.langs.includes(lang)) continue;
        // Skip string-concatenation `+` false mutants when quotes appear around `+`
        if (op.id === 'arith-add-sub' && /['"`]/.test(trimmed)) continue;
        // Skip TypeScript generic `<T>` false mutants
        if ((op.id === 'lt-to-gte' || op.id === 'gt-to-lte') && /<[A-Z]\w*(?:,\s*[A-Z]\w*)*>/.test(trimmed)) continue;
        if (op.re.test(line)) {
          const mutatedLine = line.replace(op.re, op.replace);
          if (mutatedLine !== line) {
            const copy = [...lines];
            copy[idx] = mutatedLine;
            mutants.push({
              file: rel,
              line: idx + 1,
              operator: op.id,
              original: trimmed.slice(0, 120),
              replacement: mutatedLine.trim().slice(0, 120),
              mutatedSource: copy.join('\n')
            });
            break; // at most one crisp mutant per line for high coverage diversity
          }
        }
      }
    }
  }
  return mutants;
}

/**
 * Execute mutation testing on `repoDir` inside an isolated workspace clone.
 *
 * Never mutates `repoDir` in place: copies the workspace to a scratch directory,
 * verifies the baseline test suite passes, runs each mutant in the VLD sandbox
 * with network denied, records kill/survival statistics, and writes
 * `.vld/reports/mutation-report.json`.
 */
export async function runMutationGate({
  repoDir,
  tier = 2,
  backend = 'auto',
  maxMutants = 20,
  perMutantTimeoutMs = 15_000,
  targetPaths = null,
  testCommand = null,
  waiver = null,
  referenceDate = new Date().toISOString().slice(0, 10),
  writeReport = true,
  reportOutPath = null
} = {}) {
  const started = Date.now();
  const root = path.resolve(repoDir);
  const threshold = mutationThresholdForTier(tier);

  // Check active dated waiver first if provided
  if (waiver && waiver.reason && waiver.expires && String(waiver.expires) >= referenceDate) {
    return {
      schemaVersion: 1,
      kind: 'vld-mutation-report',
      tool: 'waived',
      total: 0,
      killed: 0,
      survived: 0,
      timeout: 0,
      ignored: 0,
      score: null,
      threshold,
      ok: true,
      verdictLabel: 'WAIVED',
      waiver: { owner: waiver.owner ?? 'unknown', reason: waiver.reason, expires: waiver.expires },
      durationMs: Date.now() - started,
      survivors: [],
      generatedAt: new Date().toISOString()
    };
  }

  const detected = detectTestCommand(root, { explicitCommand: testCommand });
  const sourceFiles = collectMutableSourceFiles(root, targetPaths);
  if (!detected || sourceFiles.length === 0) {
    return {
      schemaVersion: 1,
      kind: 'vld-mutation-report',
      tool: null,
      total: 0,
      killed: 0,
      survived: 0,
      timeout: 0,
      ignored: 0,
      score: null,
      threshold,
      ok: false,
      verdictLabel: 'SKIPPED-UNAVAILABLE',
      reason: !detected
        ? 'No executable test runner available for mutation gate on this host.'
        : 'No mutable JS/TS, Python, or Go source files discovered.',
      durationMs: Date.now() - started,
      survivors: [],
      generatedAt: new Date().toISOString()
    };
  }

  const workCopy = path.join(os.tmpdir(), `vld-mut-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(workCopy, { recursive: true });
  try {
    cpSync(root, workCopy, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== '.git' && base !== '.vld';
      }
    });

    const runPlan = detectTestCommand(workCopy, { reportTempDir: workCopy, explicitCommand: testCommand });
    const env = { CI: '1', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1', GOCACHE: path.join(workCopy, '.gocache') };

    // Verify clean baseline passes before mutating!
    let activeCmd = runPlan.command;
    let baseline = await runSandboxed({
      executable: activeCmd[0],
      args: activeCmd.slice(1),
      workspace: workCopy,
      mode: 'write-workspace',
      allowChildProcess: true,
      backend,
      network: false,
      env,
      limits: { durationMs: perMutantTimeoutMs * 2, outputBytes: 1024 * 1024 }
    });
    if (baseline.exitCode !== 0 && runPlan.fallbackCommand && /No module named pytest/i.test(`${baseline.stderr}\n${baseline.stdout}`)) {
      activeCmd = runPlan.fallbackCommand;
      baseline = await runSandboxed({
        executable: activeCmd[0],
        args: activeCmd.slice(1),
        workspace: workCopy,
        mode: 'write-workspace',
        allowChildProcess: true,
        backend,
        network: false,
        env,
        limits: { durationMs: perMutantTimeoutMs * 2, outputBytes: 1024 * 1024 }
      });
    }
    if (baseline.exitCode !== 0) {
      // Check if tool binary itself is missing (ENOENT / exit 127)
      if (baseline.exitCode === 127 || /ENOENT|not found/i.test(String(baseline.stderr ?? ''))) {
        return {
          schemaVersion: 1,
          kind: 'vld-mutation-report',
          tool: runPlan.framework,
          total: 0,
          killed: 0,
          survived: 0,
          timeout: 0,
          ignored: 0,
          score: null,
          threshold,
          ok: false,
          verdictLabel: 'SKIPPED-UNAVAILABLE',
          reason: `Test runner "${activeCmd[0]}" is not installed on this host.`,
          durationMs: Date.now() - started,
          survivors: [],
          generatedAt: new Date().toISOString()
        };
      }
      return {
        schemaVersion: 1,
        kind: 'vld-mutation-report',
        tool: 'vld-syntactic-mutator',
        total: 0,
        killed: 0,
        survived: 0,
        timeout: 0,
        ignored: 0,
        score: 0,
        threshold,
        ok: false,
        verdictLabel: 'FAIL',
        reason: `Baseline test suite failed before mutation (exit ${baseline.exitCode}).`,
        durationMs: Date.now() - started,
        survivors: [],
        generatedAt: new Date().toISOString()
      };
    }

    const mutants = generateSyntacticMutants(workCopy, sourceFiles, { maxMutants });
    if (mutants.length === 0) {
      return {
        schemaVersion: 1,
        kind: 'vld-mutation-report',
        tool: 'vld-syntactic-mutator',
        total: 0,
        killed: 0,
        survived: 0,
        timeout: 0,
        ignored: 0,
        score: null,
        threshold,
        ok: false,
        verdictLabel: 'SKIPPED-UNAVAILABLE',
        reason: 'No syntactic mutation candidates found in source files.',
        durationMs: Date.now() - started,
        survivors: [],
        generatedAt: new Date().toISOString()
      };
    }

    let killed = 0;
    let survived = 0;
    let timeout = 0;
    const survivors = [];
    const originals = new Map();
    for (const rel of sourceFiles) {
      originals.set(rel, readFileSync(path.join(workCopy, rel), 'utf8'));
    }

    for (const mutant of mutants) {
      const targetFile = path.join(workCopy, mutant.file);
      writeFileSync(targetFile, mutant.mutatedSource, 'utf8');
      try {
        const res = await runSandboxed({
          executable: activeCmd[0],
          args: activeCmd.slice(1),
          workspace: workCopy,
          mode: 'write-workspace',
          allowChildProcess: true,
          backend,
          network: false,
          env,
          limits: { durationMs: perMutantTimeoutMs, outputBytes: 512 * 1024 }
        });
        if (res.timedOut) {
          killed += 1;
          timeout += 1;
        } else if (res.exitCode !== 0) {
          killed += 1;
        } else {
          survived += 1;
          survivors.push({
            file: mutant.file,
            line: mutant.line,
            operator: mutant.operator,
            original: mutant.original,
            replacement: mutant.replacement
          });
        }
      } finally {
        writeFileSync(targetFile, originals.get(mutant.file), 'utf8');
      }
    }

    const report = buildMutationSummary({
      tool: 'vld-syntactic-mutator',
      killed,
      survived,
      timeout,
      ignored: 0,
      survivors,
      threshold,
      durationMs: Date.now() - started
    });

    if (writeReport) {
      const out = reportOutPath
        ? path.resolve(reportOutPath)
        : path.join(root, '.vld', 'reports', 'mutation-report.json');
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${stableJson(report)}\n`, 'utf8');
      report.reportFile = out;
    }

    return report;
  } finally {
    rmSync(workCopy, { recursive: true, force: true });
  }
}
