/**
 * Continuous specification-to-code drift detection, scheduled workflow
 * scaffolding, and polyglot `semantic-oracles.json` management
 * (ADR 0012, roadmap 3.3).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvidence } from './evidence.mjs';
import { digest, ensureProjectDir, extensionError, stableJson } from './extension-utils.mjs';

const canonicalJson = (value) => `${stableJson(value)}\n`;
import { scanDiffRisks } from './review.mjs';
import { formatAnchorPath, resolveProfileStacks } from './stacks.mjs';
import { verifyPacket } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_TEMPLATE_PATH = path.resolve(HERE, '..', 'templates', 'drift-workflow.yml');

const SOURCE_FILE_RE = /\.(?:m?[jt]sx?|py|go|rs|java|kt|cs|rb|php)$/;
const TEST_FILE_RE = /(?:^|\/)(?:tests?|spec|__tests__)\/|\.(?:test|spec)\.[^/]+$|_test\.(?:go|py|rs)$|Test\.(?:java|kt|php)$|Tests\.cs$/;
const DOC_OR_CONFIG_RE = /^(?:docs\/|specs?\/|\.github\/|\.vld\/|README|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY)/;

/** Per-stack recommended mutation testing runner and configuration file. */
export const STACK_MUTATION_RUNNERS = Object.freeze({
  typescript: { tool: 'StrykerJS', configFile: 'stryker.config.json', command: 'npx stryker run' },
  javascript: { tool: 'StrykerJS', configFile: 'stryker.config.json', command: 'npx stryker run' },
  python: { tool: 'mutmut', configFile: 'pyproject.toml ([tool.mutmut])', command: 'mutmut run' },
  go: { tool: 'gremlins', configFile: '.gremlins.yaml', command: 'gremlins unleash' },
  rust: { tool: 'cargo-mutants', configFile: '.cargo/mutants.toml', command: 'cargo mutants' },
  java: { tool: 'PIT (pitest)', configFile: 'pom.xml (pitest-maven)', command: './mvnw test-compile org.pitest:pitest-maven:mutationCoverage' },
  kotlin: { tool: 'PIT (pitest)', configFile: 'build.gradle.kts (info.solidsoft.pitest)', command: './gradlew pitest' },
  csharp: { tool: 'Stryker.NET', configFile: 'stryker-config.json', command: 'dotnet stryker' },
  ruby: { tool: 'mutant', configFile: '.mutant.yml', command: 'bundle exec mutant run' },
  php: { tool: 'Infection', configFile: 'infection.json5', command: 'vendor/bin/infection' }
});

function safeGitDiff(project, baseRef, headRef) {
  if (!baseRef) return null;
  try {
    const range = headRef ? `${baseRef}..${headRef}` : baseRef;
    return execFileSync('git', ['-C', project, 'diff', '--unified=3', range], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return null;
  }
}

/**
 * Inspect continuous spec/code drift across 5 classes:
 *   1. `unanchored-requirement` / `hollow-test`
 *   2. `orphan-anchor`
 *   3. `weakened-test` / `skipped-test` / `dropped-anchor`
 *   4. `untracked-code-change` (source modified without accompanying test update)
 *   5. `stale-profile` / `missing-semantic-oracle`
 */
export function detectSpecDrift({
  projectDir = '.',
  packetDir = 'specs',
  profileFile = null,
  baseRef = null,
  headRef = 'HEAD',
  requireAssertions = true,
  record = false
} = {}) {
  const project = ensureProjectDir(projectDir);
  const packetAbs = path.resolve(project, packetDir);
  const specFile = path.join(packetAbs, 'spec.json');
  if (!existsSync(specFile)) {
    throw extensionError(`compiled packet missing spec.json: ${specFile}`, 'PACKET_NOT_FOUND');
  }
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const packetDigest = digest(readFileSync(specFile, 'utf8'));
  const findings = [];

  // 1 & 2. Run packet + repository drift verification.
  const verification = verifyPacket(packetAbs, {
    repo: project,
    strict: true,
    requireAssertions
  });
  for (const err of verification.errors ?? []) {
    const kind = /unknown requirement/i.test(err)
      ? 'orphan-anchor'
      : /assertion|hollow|import/i.test(err)
        ? 'hollow-test'
        : 'unanchored-requirement';
    findings.push({ kind, severity: 'high', detail: err });
  }

  // 3 & 4. Inspect Git diff window if supplied.
  const diffText = safeGitDiff(project, baseRef, headRef);
  let diffSummary = null;
  if (diffText !== null) {
    const risks = scanDiffRisks(diffText);
    diffSummary = { changedFiles: risks.changedFiles.length, manifestChanges: risks.manifestChanges };
    for (const w of risks.testWeakening) {
      findings.push({ kind: 'weakened-test', severity: 'high', file: w.file, detail: w.detail });
    }
    for (const s of risks.skippedTests) {
      findings.push({ kind: 'skipped-test', severity: 'high', file: s.file, detail: `skipped/focused test added in ${s.file}: ${s.snippet}` });
    }
    for (const d of risks.droppedAnchors) {
      findings.push({ kind: 'dropped-anchor', severity: 'high', file: d.file, requirement: d.requirement, detail: `${d.file} dropped anchor for ${d.requirement}` });
    }
    const changedSources = risks.changedFiles.filter((f) => SOURCE_FILE_RE.test(f) && !TEST_FILE_RE.test(f) && !DOC_OR_CONFIG_RE.test(f));
    const changedTests = risks.changedFiles.filter((f) => TEST_FILE_RE.test(f));
    if (changedSources.length > 0 && changedTests.length === 0) {
      findings.push({
        kind: 'untracked-code-change',
        severity: 'medium',
        detail: `${changedSources.length} source file(s) changed (${changedSources.slice(0, 3).join(', ')}) without any test update in ${baseRef}..${headRef}`
      });
    }
  }

  // 5a. Profile vs packet drift (idea or name divergence).
  const profCandidate = profileFile ? path.resolve(project, profileFile) : path.join(project, 'profile.json');
  if (existsSync(profCandidate)) {
    try {
      const prof = JSON.parse(readFileSync(profCandidate, 'utf8'));
      if (prof.idea && spec.project?.idea && String(prof.idea).trim() !== String(spec.project.idea).trim()) {
        findings.push({ kind: 'stale-profile', severity: 'high', detail: 'profile.json idea differs from compiled spec.json; recompile the packet' });
      }
      const profRulesCount = Array.isArray(prof.rules) ? prof.rules.filter((r) => typeof r === 'string' || (r && !r.covers && !r.requirement)).length : 0;
      const specCustomCount = (spec.requirements ?? []).filter((r) => /^REQ-C\d{2,}$/.test(r.id)).length;
      if (profRulesCount !== specCustomCount) {
        findings.push({ kind: 'stale-profile', severity: 'high', detail: `profile.json defines ${profRulesCount} custom rule(s) while spec.json contains ${specCustomCount}` });
      }
    } catch {}
  }

  // 5b. Semantic oracles coverage when G3-MUTATION is active.
  const hasMutationGate = (spec.gates ?? []).some((g) => g.id === 'G3-MUTATION');
  const oraclesFile = path.join(project, 'semantic-oracles.json');
  if (hasMutationGate || existsSync(oraclesFile)) {
    const automatedIds = (spec.requirements ?? []).filter((r) => r.verify === 'automated').map((r) => r.id);
    if (!existsSync(oraclesFile)) {
      findings.push({ kind: 'missing-semantic-oracle', severity: 'medium', detail: 'G3-MUTATION is active but semantic-oracles.json is missing' });
    } else {
      try {
        const manifest = JSON.parse(readFileSync(oraclesFile, 'utf8'));
        const mapped = new Map((manifest.oracles ?? []).map((o) => [o.id, o.test]));
        const missing = automatedIds.filter((id) => !mapped.has(id) || !existsSync(path.join(project, mapped.get(id))));
        if (missing.length > 0) {
          findings.push({ kind: 'missing-semantic-oracle', severity: 'high', detail: `semantic-oracles.json missing oracle test(s) for: ${missing.join(', ')}` });
        }
      } catch {
        findings.push({ kind: 'missing-semantic-oracle', severity: 'high', detail: 'semantic-oracles.json is not valid JSON' });
      }
    }
  }

  const blocking = findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
  const reportBody = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    ok: blocking.length === 0,
    clean: findings.length === 0,
    packetDir: path.relative(project, packetAbs).split(path.sep).join('/') || '.',
    packetDigest,
    findingCount: findings.length,
    blockingCount: blocking.length,
    diff: diffSummary,
    findings
  };
  const report = { ...reportBody, driftDigest: digest(reportBody) };

  if (record) {
    appendEvidence({
      projectDir: project,
      kind: 'drift',
      actor: 'system:vld-drift',
      subject: spec.project?.name ?? 'project',
      payload: {
        ok: report.ok,
        clean: report.clean,
        findingCount: report.findingCount,
        blockingCount: report.blockingCount,
        packetDigest,
        driftDigest: report.driftDigest
      }
    });
  }

  return report;
}

/** Generate a stack-aware `semantic-oracles.json` manifest for Tier 3 `G3-MUTATION`. */
export function initSemanticOracles({ projectDir = '.', packetDir = 'specs', force = false } = {}) {
  const project = ensureProjectDir(projectDir);
  const specFile = path.resolve(project, packetDir, 'spec.json');
  if (!existsSync(specFile)) throw extensionError(`spec.json not found: ${specFile}`, 'PACKET_NOT_FOUND');
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const target = path.join(project, 'semantic-oracles.json');
  if (existsSync(target) && !force) {
    throw extensionError('semantic-oracles.json already exists; pass --force to overwrite', 'FILE_EXISTS');
  }
  const stackInfo = resolveProfileStacks(spec.project ?? {});
  const primaryId = stackInfo.primary?.id ?? 'typescript';
  const runner = STACK_MUTATION_RUNNERS[primaryId] ?? STACK_MUTATION_RUNNERS.typescript;
  const automated = (spec.requirements ?? []).filter((r) => r.verify === 'automated');

  const manifest = {
    schemaVersion: 1,
    stack: primaryId,
    mutationRunner: runner,
    oracles: automated.map((req) => {
      const slug = String(req.key ?? req.id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const testPath = formatAnchorPath(stackInfo.primary, `oracle-${slug}`);
      return {
        id: req.id,
        key: req.key ?? null,
        test: testPath.startsWith('tests/') ? testPath.replace(/^tests\//, 'tests/semantic-oracles/') : `tests/semantic-oracles/${path.posix.basename(testPath)}`
      };
    })
  };
  writeFileSync(target, canonicalJson(manifest), 'utf8');
  return { ok: true, file: target, stack: primaryId, mutationRunner: runner, count: manifest.oracles.length, manifest };
}

/** Scaffold a SHA-pinned, read-only GitHub Actions workflow for continuous spec-drift checks. */
export function scaffoldDriftWorkflow({
  projectDir = '.',
  packetDir = 'specs',
  nodeVersion = '22.x',
  cron = '0 6 * * 1',
  outFile = '.github/workflows/vld-drift.yml',
  force = false
} = {}) {
  const project = ensureProjectDir(projectDir);
  if (path.isAbsolute(outFile) || outFile.includes('..')) {
    throw extensionError('workflow output path must stay inside the project', 'INVALID_WORKFLOW_PATH');
  }
  const cleanPacket = String(packetDir).replace(/[^A-Za-z0-9._/-]/g, '');
  const cleanNode = String(nodeVersion).replace(/[^A-Za-z0-9._-]/g, '');
  const cleanCron = String(cron).replace(/[^0-9*,/ -]/g, '');
  const template = readFileSync(WORKFLOW_TEMPLATE_PATH, 'utf8');
  const rendered = template
    .replaceAll('{{PACKET_DIR}}', cleanPacket)
    .replaceAll('{{NODE_VERSION}}', cleanNode)
    .replaceAll('{{CRON_SCHEDULE}}', cleanCron);
  const target = path.resolve(project, outFile);
  if (existsSync(target) && !force) {
    throw extensionError(`${outFile} already exists; pass --force to overwrite`, 'FILE_EXISTS');
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, rendered, 'utf8');
  return { ok: true, file: target, packetDir: cleanPacket };
}
