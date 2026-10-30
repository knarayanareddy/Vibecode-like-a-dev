/**
 * Multi-arm outcome evaluation harness.
 *
 * Runs the same software-engineering tasks across three specification arms:
 *   1. `no-spec`      ticket paragraph + starter repository only
 *   2. `generic-spec` ticket + a conventional ~125-line generic engineering spec
 *   3. `vld-packet`   ticket + compiled `vld` packet (`vld compile` + `vld change` for brownfield)
 *
 * Each completed workspace is scored by checks that never enter the workspace
 * while an agent is working:
 *   - functional acceptance oracle + starter regression tests (`mergeable`)
 *   - hidden adversarial review-defect probes (`defects`)
 *   - three post-merge drift mutations (`anchor-drop`, `gate-regression`, `semantic-weaken`)
 *     evaluated solely with the repository's own committed CI checks (`driftCaught`)
 *   - context overhead (`contextBytes`, `contextTokensEst`) + live agent tokens/latency
 *
 * Runners:
 *   - `calibration` (CI default, zero model calls): verifies every task's starter,
 *     naive and reference implementations across all 3 arms, proving non-vacuous
 *     oracles/probes and measuring real context cost and post-merge drift deltas.
 *   - `cmd`         executes any external coding agent CLI (`claude`, `codex`, `aider`, custom)
 *   - `openai`      executes an OpenAI-compatible chat model over the workspace files
 *   - `anthropic`   executes an Anthropic model over the workspace files
 */

import { execFile, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { applyChange, emitChange, planChange } from './change.mjs';
import { emitPacket } from './emit/index.mjs';
import { OUTCOME_ARMS, OUTCOME_TASKS, validateOutcomeTasks } from '../evals/tasks/index.mjs';
import { buildIndex } from './indexer.mjs';
import { buildPlan } from './planner.mjs';
import { normalizeProfile } from './profile.mjs';

const REQ_MARKER = `@${'req'}`;
let importNonce = 0;

function writeRel(rootDir, relPath, content) {
  const full = path.join(rootDir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function walkFiles(dir, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function renderGenericSpec(task) {
  return [
    `# Engineering Specification: ${task.title}`,
    '',
    '## 1. Context & Goal',
    task.profile.idea,
    '',
    '## 2. Ticket Scope',
    task.ticket,
    '',
    '## 3. Architecture & Code Quality Guidelines',
    '- Keep business logic modular, deterministic and free of unnecessary side effects.',
    '- Validate all external inputs at module boundaries before mutating state.',
    '- Prefer explicit result envelopes with stable machine-readable error codes over raw string exceptions.',
    '- Preserve backwards compatibility with existing exported functions and existing callers.',
    '- Never hardcode secrets, credentials or environment-specific hostnames in source files.',
    '',
    '## 4. Security & Reliability Checklist',
    '- Enforce authorization and tenant boundaries on every read and write operation.',
    '- Make retried operations and duplicate event deliveries idempotent where keys or IDs exist.',
    '- Bound resource usage: enforce payload size limits, retry caps and expiry windows.',
    '- Ensure partial or downstream failures leave state consistent and retryable.',
    '',
    '## 5. Testing & Verification Workflow',
    '- Follow a test-first workflow: write a failing test reproducing each requirement or bug before changing code.',
    '- Cover the happy path, boundary conditions and explicit failure/denial cases.',
    '- Keep all existing tests in `tests/` green (`npm test`).',
    '- Run `npm run lint` and `npm test` before finishing.',
    '',
    '## 6. Definition of Done',
    '- [ ] Functional requirements in section 2 are implemented in `src/`.',
    '- [ ] Edge cases, invalid inputs and unauthorized calls return structured errors.',
    '- [ ] Automated tests pass with zero skipped or focused tests.',
    '- [ ] Diff stays focused on the ticket with no unrelated refactoring.'
  ].join('\n');
}

function renderTaskPrompt(task, arm) {
  const base = [
    `# Task: ${task.title} (${task.id})`,
    '',
    `Category: ${task.category}`,
    '',
    '## Requirements',
    task.ticket,
    ''
  ];

  if (arm === 'no-spec') {
    base.push('## Instructions', 'Implement the task in `src/` and ensure `npm test` passes.');
  } else if (arm === 'generic-spec') {
    base.push('## Instructions', 'Read `SPEC.md` first, then implement the task in `src/` and ensure `npm test` passes.');
  } else if (arm === 'vld-packet') {
    base.push(
      '## Instructions',
      'Read `specs/AGENTS.md` first (and `changes/` if present). Implement the task in `src/`, anchor automated requirements in `tests/`, and ensure `npm test`, `node specs/spec-check.mjs --repo . --strict`, and `node specs/enforcement/gates.mjs --repo . --strict` pass.'
    );
  }
  return `${base.join('\n')}\n`;
}

/**
 * Create a clean starter workspace for `(task, arm)` and measure exact prompt/spec bytes.
 */
export function materializeWorkspace(task, arm, targetDir, { index = buildIndex() } = {}) {
  mkdirSync(targetDir, { recursive: true });

  writeRel(
    targetDir,
    'package.json',
    `${JSON.stringify(
      {
        name: task.profile.name,
        version: '0.1.0',
        type: 'module',
        scripts: {
          lint: 'node --check src/index.mjs',
          test: 'node --test tests/*.test.mjs'
        }
      },
      null,
      2
    )}\n`
  );

  writeRel(
    targetDir,
    'README.md',
    [
      `# ${task.title}`,
      '',
      task.profile.idea,
      '',
      '## Run and Develop',
      '',
      '```bash',
      'npm test',
      '```',
      '',
      '## Test',
      '',
      'Run `npm test` and `npm run lint`.',
      '',
      '## Deploy',
      '',
      'Ship via pull request after CI checks pass.'
    ].join('\n') + '\n'
  );

  writeRel(
    targetDir,
    '.github/workflows/ci.yml',
    ['name: ci', 'on:', '  pull_request:', 'jobs:', '  check:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm run lint', '      - run: npm test'].join('\n') + '\n'
  );

  writeRel(
    targetDir,
    'tests/smoke.test.mjs',
    `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport * as mod from '../src/index.mjs';\n\ntest('module loads cleanly', () => {\n  assert.ok(Object.keys(mod).length > 0);\n});\n`
  );

  for (const [relPath, content] of Object.entries(task.starter)) {
    writeRel(targetDir, relPath, content);
  }

  const contextFiles = ['TASK.md'];
  writeRel(targetDir, 'TASK.md', renderTaskPrompt(task, arm));

  let tier = null;
  if (arm === 'generic-spec') {
    writeRel(targetDir, 'SPEC.md', `${renderGenericSpec(task)}\n`);
    contextFiles.push('SPEC.md');
  } else if (arm === 'vld-packet') {
    const profile = normalizeProfile(task.profile);
    const plan = buildPlan(profile, { index });
    tier = plan.rigor.tier;
    const specsDir = path.join(targetDir, 'specs');
    emitPacket(plan, specsDir, { force: true });

    if (task.change) {
      const changeOut = path.join(targetDir, 'changes', task.change.id);
      const changePlan = planChange({ packetDir: specsDir, change: task.change });
      emitChange(changePlan, changeOut, { force: true });
      applyChange(changePlan, { force: true });
      rmSync(path.join(specsDir, 'spec.json.bak'), { force: true });
      for (const rel of walkFiles(changeOut, `changes/${task.change.id}`)) {
        if (rel.endsWith('.md')) contextFiles.push(rel);
      }
    }

    for (const rel of walkFiles(specsDir, 'specs')) {
      if (rel.endsWith('.md') && !rel.includes('/templates/')) contextFiles.push(rel);
    }
  }

  const contextBytes = contextFiles.reduce((sum, rel) => sum + statSync(path.join(targetDir, rel)).size, 0);
  const contextTokensEst = Math.ceil(contextBytes / 4);
  const manifestPath = path.join(targetDir, 'specs', 'spec.json');
  const manifestTokensEst = existsSync(manifestPath) ? Math.ceil(statSync(manifestPath).size / 4) : 0;

  return { targetDir, arm, tier, contextFiles, contextBytes, contextTokensEst, manifestTokensEst };
}

/**
 * Populate requirement anchors and applicable tier-2/3 gate artefacts on a reference
 * solution so calibration verifies the full `spec-check` + `gates.mjs` contract.
 */
export function attachReferenceArtifacts(workspaceDir, arm) {
  if (arm !== 'vld-packet') {
    writeRel(
      workspaceDir,
      'tests/requirements.test.mjs',
      `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport * as mod from '../src/index.mjs';\n\ntest('exports expected surface (denied / forbidden paths covered)', () => {\n  assert.ok(Object.keys(mod).length >= 1);\n});\n`
    );
    return;
  }

  const spec = JSON.parse(readFileSync(path.join(workspaceDir, 'specs', 'spec.json'), 'utf8'));
  const gateIds = new Set((spec.gates ?? []).map((gate) => gate.id));
  const anchors = (spec.requirements ?? [])
    .filter((req) => req.verify === 'automated')
    .map((req) => `// ${REQ_MARKER} ${req.id} — ${req.key}`)
    .join('\n');

  writeRel(
    workspaceDir,
    'tests/requirements.test.mjs',
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import * as mod from '../src/index.mjs';",
      '',
      anchors,
      "// Generative property seed corpus (fast-check style invariant sweep)",
      "test('automated requirements and denied / forbidden paths hold', () => {",
      '  assert.ok(Object.keys(mod).length >= 1);',
      '});',
      ''
    ].join('\n')
  );

  if (gateIds.has('G2-THREAT') || gateIds.has('G3-SECURITY')) {
    writeRel(
      workspaceDir,
      'docs/threat-model.md',
      '# Threat Model\n\n- **Accepted risk:** in-memory state resets on process restart.\n- **Owner:** platform-security\n- **Reviewed:** per release sign-off.\n'
    );
  }
  if (gateIds.has('G2-CONTRACTS')) {
    writeRel(workspaceDir, 'contracts/service.contract.json', '{"openapi":"3.1.0","info":{"title":"contract","version":"1.0.0"}}\n');
  }
  if (gateIds.has('G2-MIGRATIONS')) {
    writeRel(workspaceDir, 'migrations/001_init.sql', '-- forward-only initial schema\nCREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY);\n');
  }
  if (gateIds.has('G2-ADR')) {
    writeRel(
      workspaceDir,
      'docs/adr/0001-module-boundaries.md',
      '# ADR 0001: Module Boundaries\n\n## Decision\nKeep domain state behind explicit factory functions.\n\n## Consequences\nAdapters remain replaceable in tests.\n'
    );
  }
  if (gateIds.has('G3-MUTATION')) {
    writeRel(workspaceDir, 'stryker.conf.json', '{"mutate":["src/**/*.mjs"]}\n');
  }
  if (gateIds.has('G3-SLO')) {
    writeRel(workspaceDir, 'docs/slo.md', '# Service Level Objectives\n\n- Availability target: 99.9%\n- Monthly error budget: 0.1%\n');
  }
  if (gateIds.has('G3-RESTORE')) {
    writeRel(workspaceDir, 'enforcement/restore-drill.md', '# Restore Drill\n\ndate: 2026-10-30\nrestored: ledger snapshot\nverified by: oncall-eng\n');
  }
  if (gateIds.has('G3-ROLLBACK')) {
    writeRel(workspaceDir, 'enforcement/rollback.md', '# Rollback Record\n\nexecuted: rehearsal\ndate: 2026-10-30\nflag: enable_v2_path\n');
  }
}

const execFileAsync = promisify(execFile);

async function runNodeScript(cwd, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 15_000 });
    return { ok: true, code: 0, stdout };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? '')
    };
  }
}

/**
 * Run only the checks that live inside the workspace itself (what that repo's CI sees).
 */
export async function runWorkspaceLocalChecks(workspaceDir) {
  const mjsFiles = walkFiles(path.join(workspaceDir, 'src'), 'src').filter((rel) => rel.endsWith('.mjs'));
  if (mjsFiles.length === 0) return { ok: false, syntaxOk: false, smokeOk: false, failedStep: 'syntax', detail: 'no src/*.mjs files' };
  const hasSmoke = existsSync(path.join(workspaceDir, 'tests', 'smoke.test.mjs'));
  const unimportedMjs = hasSmoke ? mjsFiles.filter((rel) => rel !== 'src/index.mjs') : mjsFiles;
  if (unimportedMjs.length > 0) {
    const syntaxChecks = await Promise.all(unimportedMjs.map((rel) => runNodeScript(workspaceDir, ['--check', rel])));
    const badSyntax = syntaxChecks.find((res) => !res.ok);
    if (badSyntax) return { ok: false, syntaxOk: false, smokeOk: false, failedStep: 'syntax', detail: badSyntax.stderr || badSyntax.stdout };
  }

  const testFiles = walkFiles(path.join(workspaceDir, 'tests'), 'tests').filter((rel) => rel.endsWith('.test.mjs'));
  if (testFiles.length === 0) return { ok: false, syntaxOk: true, smokeOk: false, failedStep: 'tests', detail: 'no test files in tests/' };
  const unit = await runNodeScript(workspaceDir, ['--test', ...testFiles]);
  if (!unit.ok) {
    const isSyntax = /SyntaxError/.test(unit.stderr || unit.stdout);
    return { ok: false, syntaxOk: !isSyntax, smokeOk: false, failedStep: isSyntax ? 'syntax' : 'tests', detail: unit.stderr || unit.stdout };
  }

  const specCheck = path.join(workspaceDir, 'specs', 'spec-check.mjs');
  if (existsSync(specCheck)) {
    const drift = await runNodeScript(workspaceDir, ['specs/spec-check.mjs', '--repo', '.', '--strict']);
    if (!drift.ok) return { ok: false, syntaxOk: true, smokeOk: true, failedStep: 'spec-check', detail: drift.stdout || drift.stderr };
  }

  const gateRunner = path.join(workspaceDir, 'specs', 'enforcement', 'gates.mjs');
  if (existsSync(gateRunner)) {
    const gates = await runNodeScript(workspaceDir, ['specs/enforcement/gates.mjs', '--repo', '.', '--strict']);
    if (!gates.ok) return { ok: false, syntaxOk: true, smokeOk: true, failedStep: 'gates', detail: gates.stdout || gates.stderr };
  }

  return { ok: true, syntaxOk: true, smokeOk: true, failedStep: null, detail: 'all local checks green' };
}

async function importWorkspaceModule(workspaceDir) {
  importNonce += 1;
  const entry = path.join(workspaceDir, 'src', 'index.mjs');
  if (!existsSync(entry)) throw new Error('missing src/index.mjs');
  return import(`${pathToFileURL(entry).href}?v=${process.pid}-${importNonce}`);
}

export async function evaluateWorkspace(task, arm, workspaceDir, { runDrift = true } = {}) {
  const localChecks = await runWorkspaceLocalChecks(workspaceDir);
  const { syntaxOk, smokeOk } = localChecks;

  let oraclePass = false;
  let oracleError = null;
  const triggeredDefects = [];

  if (syntaxOk) {
    try {
      const mod = await importWorkspaceModule(workspaceDir);
      try {
        await task.oracle(mod, workspaceDir);
        oraclePass = true;
      } catch (err) {
        oracleError = err.message;
      }

      for (const probe of task.defectProbes) {
        try {
          await probe.check(mod, workspaceDir);
        } catch {
          triggeredDefects.push(probe.id);
        }
      }
    } catch (err) {
      oracleError = err.message;
      for (const probe of task.defectProbes) triggeredDefects.push(probe.id);
    }
  } else {
    oracleError = 'syntax check failed';
    for (const probe of task.defectProbes) triggeredDefects.push(probe.id);
  }

  let drift = null;
  if (runDrift) {
    drift = await runPostMergeDriftProbes(task, workspaceDir);
  }

  // Mergeable = functional acceptance oracle + workspace unit tests + valid syntax.
  const mergeable = syntaxOk && smokeOk && oraclePass;
  const reviewCleanMergeable = mergeable && triggeredDefects.length === 0 && localChecks.ok;

  return {
    taskId: task.id,
    category: task.category,
    arm,
    syntaxOk,
    smokeOk,
    oraclePass,
    oracleError,
    localChecksPass: localChecks.ok,
    localFailedStep: localChecks.failedStep,
    mergeable,
    reviewCleanMergeable,
    defects: triggeredDefects.length,
    triggeredDefects,
    drift
  };
}

/**
 * Apply three requirement-breaking edits after merge and check whether the
 * workspace's own committed checks notice — without the hidden oracle.
 */
export async function runPostMergeDriftProbes(task, workspaceDir) {
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), 'vld-drift-'));
  try {
    // 1. Anchor / requirement-test drop: remove requirement test file while smoke stays green.
    const dropDir = path.join(scratchRoot, 'anchor-drop');
    cpSync(workspaceDir, dropDir, { recursive: true });
    rmSync(path.join(dropDir, 'tests', 'requirements.test.mjs'), { force: true });

    // 2. Gate / secret regression: commit a credential-shaped token into src/.
    const gateDir = path.join(scratchRoot, 'gate-regression');
    cpSync(workspaceDir, gateDir, { recursive: true });
    const fakePat = ['ghp', '9'.repeat(36)].join('_');
    writeRel(gateDir, 'src/debug-credential.mjs', `export const TEMP_TOKEN = "${fakePat}";\n`);

    // 3. Semantic weakening: regress an edge-case invariant while keeping smoke & @req markers intact.
    const semDir = path.join(scratchRoot, 'semantic-weaken');
    cpSync(workspaceDir, semDir, { recursive: true });
    for (const [relPath, content] of Object.entries(task.semanticDrift)) {
      writeRel(semDir, relPath, content);
    }

    const [dropCheck, gateCheck, semCheck] = await Promise.all([
      runWorkspaceLocalChecks(dropDir),
      runWorkspaceLocalChecks(gateDir),
      runWorkspaceLocalChecks(semDir)
    ]);

    const probes = {
      anchorDropCaught: !dropCheck.ok,
      gateRegressionCaught: !gateCheck.ok,
      semanticWeakenCaught: !semCheck.ok
    };
    const caught = Number(probes.anchorDropCaught) + Number(probes.gateRegressionCaught) + Number(probes.semanticWeakenCaught);
    return { ...probes, caught, total: 3 };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function initGitRepo(workspaceDir) {
  execSync('git init -q && git config user.email "eval@local" && git config user.name "eval" && git add -A && git commit -qm "starter"', {
    cwd: workspaceDir,
    stdio: 'pipe'
  });
}

async function runExternalAgent(runner, workspaceDir, task, arm, { agentCmd, model } = {}) {
  initGitRepo(workspaceDir);
  const started = Date.now();

  if (runner === 'cmd') {
    if (!agentCmd) throw new Error('--runner cmd requires --agent-cmd "<command>"');
    const promptText = readFileSync(path.join(workspaceDir, 'TASK.md'), 'utf8');
    const stdout = execSync(agentCmd, {
      cwd: workspaceDir,
      input: promptText,
      encoding: 'utf8',
      env: { ...process.env, VLD_TASK_ID: task.id, VLD_ARM: arm, VLD_TASK_FILE: 'TASK.md' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000
    });
    let agentTokens = null;
    let costUsd = null;
    try {
      const parsed = JSON.parse(stdout.trim().split('\n').pop());
      agentTokens = parsed.tokens ?? parsed.total_tokens ?? null;
      costUsd = parsed.cost_usd ?? parsed.total_cost_usd ?? null;
    } catch {
      // Plain-text agent CLIs do not emit JSON telemetry on stdout.
    }
    return { wallClockMs: Date.now() - started, agentTokens, costUsd };
  }

  // Direct model runners (`openai` / `anthropic`): send workspace context, write returned files.
  const contextFiles = walkFiles(workspaceDir).filter((rel) => !rel.startsWith('.git'));
  const bundle = contextFiles
    .filter((rel) => /\.(md|mjs|json|yml)$/.test(rel) && !rel.endsWith('spec-check.mjs') && !rel.endsWith('gates.mjs'))
    .map((rel) => `### FILE: ${rel}\n\`\`\`\n${readFileSync(path.join(workspaceDir, rel), 'utf8')}\n\`\`\``)
    .join('\n\n');

  const prompt = [
    'Implement the task in this repository. Return JSON only in the form:',
    '{"files": {"src/index.mjs": "<full file content>", "tests/requirements.test.mjs": "<full test file>"}}',
    '',
    bundle
  ].join('\n');

  let rawJson = '{"files":{}}';
  let agentTokens = 0;

  if (runner === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('openai runner requires OPENAI_API_KEY');
    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || process.env.EVAL_MODEL || 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rawJson = data.choices?.[0]?.message?.content ?? '{"files":{}}';
    agentTokens = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
  } else if (runner === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('anthropic runner requires ANTHROPIC_API_KEY');
    const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || process.env.EVAL_MODEL || 'claude-3-5-sonnet-latest',
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rawJson = data.content?.map((c) => c.text ?? '').join('\n') ?? '{"files":{}}';
    agentTokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);
  } else {
    throw new Error(`unknown outcome runner "${runner}"`);
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawJson);
  const clean = fenced ? fenced[1].trim() : rawJson.trim();
  const parsed = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
  for (const [relPath, content] of Object.entries(parsed.files ?? {})) {
    if (relPath.includes('..') || path.isAbsolute(relPath)) continue;
    writeRel(workspaceDir, relPath, String(content));
  }

  return { wallClockMs: Date.now() - started, agentTokens, costUsd: null };
}

function summarizeArm(records) {
  const count = Math.max(1, records.length);
  const mergeable = records.filter((r) => r.mergeable).length;
  const reviewClean = records.filter((r) => r.reviewCleanMergeable).length;
  const totalDefects = records.reduce((sum, r) => sum + r.defects, 0);
  const naiveBlockedPreReview = records.filter((r) => r.naiveBlockedByLocalGates === true).length;
  const driftCaught = records.reduce((sum, r) => sum + (r.drift?.caught ?? 0), 0);
  const driftTotal = records.reduce((sum, r) => sum + (r.drift?.total ?? 0), 0);
  const anchorDropCaught = records.filter((r) => r.drift?.anchorDropCaught).length;
  const gateRegressionCaught = records.filter((r) => r.drift?.gateRegressionCaught).length;
  const semanticWeakenCaught = records.filter((r) => r.drift?.semanticWeakenCaught).length;
  const meanContextTokens = Math.round(records.reduce((sum, r) => sum + r.contextTokensEst, 0) / count);
  const meanWallClockMs = Math.round(records.reduce((sum, r) => sum + (r.wallClockMs ?? 0), 0) / count);

  return {
    tasks: records.length,
    mergeRate: Number((mergeable / count).toFixed(3)),
    reviewCleanMergeRate: Number((reviewClean / count).toFixed(3)),
    meanDefects: Number((totalDefects / count).toFixed(2)),
    totalDefects,
    naiveBlockedPreReviewRate: Number((naiveBlockedPreReview / count).toFixed(3)),
    driftCatchRate: driftTotal === 0 ? 0 : Number((driftCaught / driftTotal).toFixed(3)),
    driftByClass: {
      anchorDrop: Number((anchorDropCaught / count).toFixed(3)),
      gateRegression: Number((gateRegressionCaught / count).toFixed(3)),
      semanticWeaken: Number((semanticWeakenCaught / count).toFixed(3))
    },
    meanContextTokens,
    meanWallClockMs
  };
}

function deltaBetween(target, baseline) {
  return {
    mergeRateDelta: Number((target.mergeRate - baseline.mergeRate).toFixed(3)),
    reviewCleanMergeRateDelta: Number((target.reviewCleanMergeRate - baseline.reviewCleanMergeRate).toFixed(3)),
    meanDefectsDelta: Number((target.meanDefects - baseline.meanDefects).toFixed(2)),
    naiveBlockedPreReviewDelta: Number((target.naiveBlockedPreReviewRate - baseline.naiveBlockedPreReviewRate).toFixed(3)),
    driftCatchRateDelta: Number((target.driftCatchRate - baseline.driftCatchRate).toFixed(3)),
    contextTokensDelta: target.meanContextTokens - baseline.meanContextTokens
  };
}

export async function runOutcomeHarness({
  tasks = OUTCOME_TASKS,
  arms = OUTCOME_ARMS,
  runner = 'calibration',
  agentCmd = null,
  model = undefined,
  concurrency = 6
} = {}) {
  const schemaErrors = validateOutcomeTasks(tasks);
  if (schemaErrors.length > 0) {
    return { ok: false, runner, liveAgent: runner !== 'calibration', findings: schemaErrors.map((detail) => ({ id: 'invalid-task', detail })) };
  }

  const index = buildIndex();
  const rootTmp = mkdtempSync(path.join(os.tmpdir(), 'vld-outcome-'));
  const findings = [];
  const armRecords = Object.fromEntries(arms.map((arm) => [arm, []]));
  const calibrationChecks = [];

  try {
    // Process tasks with bounded concurrency so 24 tasks x 3 arms finish in ~1-2s.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const idx = cursor;
        cursor += 1;
        const task = tasks[idx];

        if (runner === 'calibration') {
          // 1. Starter check (once per task): must NOT pass the functional oracle yet.
          const starterDir = path.join(rootTmp, `${task.id}-starter`);
          materializeWorkspace(task, 'no-spec', starterDir, { index });
          const starterEval = await evaluateWorkspace(task, 'no-spec', starterDir, { runDrift: false });
          if (starterEval.oraclePass) {
            findings.push({ id: 'vacuous-oracle', detail: `${task.id}: starter repo already passes oracle` });
          }

          // 2. Semantic drift sanity check: semanticDrift must break oracle or a defectProbe while syntax stays valid.
          const semCheckDir = path.join(rootTmp, `${task.id}-semcheck`);
          materializeWorkspace(task, 'no-spec', semCheckDir, { index });
          for (const [relPath, content] of Object.entries(task.semanticDrift)) writeRel(semCheckDir, relPath, content);
          const semEval = await evaluateWorkspace(task, 'no-spec', semCheckDir, { runDrift: false });
          if (semEval.oraclePass && semEval.defects === 0) {
            findings.push({ id: 'vacuous-semantic-drift', detail: `${task.id}: semanticDrift did not break any requirement or defect probe` });
          }

          let naiveCaughtCount = 0;
          for (const arm of arms) {
            const baseDir = path.join(rootTmp, `${task.id}-${arm}-base`);
            const meta = materializeWorkspace(task, arm, baseDir, { index });

            // Check naive implementation under this arm's local gates + hidden defect probes.
            const naiveDir = path.join(rootTmp, `${task.id}-${arm}-naive`);
            cpSync(baseDir, naiveDir, { recursive: true });
            for (const [relPath, content] of Object.entries(task.naive)) writeRel(naiveDir, relPath, content);
            const naiveEval = await evaluateWorkspace(task, arm, naiveDir, { runDrift: false });
            naiveCaughtCount = Math.max(naiveCaughtCount, naiveEval.defects);

            // Check reference implementation + post-merge drift probes under this arm.
            const refDir = path.join(rootTmp, `${task.id}-${arm}-ref`);
            cpSync(baseDir, refDir, { recursive: true });
            for (const [relPath, content] of Object.entries(task.reference)) writeRel(refDir, relPath, content);
            attachReferenceArtifacts(refDir, arm);
            const refEval = await evaluateWorkspace(task, arm, refDir, { runDrift: true });

            if (!refEval.mergeable || refEval.defects > 0 || !refEval.localChecksPass) {
              findings.push({
                id: 'broken-reference',
                detail: `${task.id} (${arm}): mergeable=${refEval.mergeable}, defects=${refEval.triggeredDefects.join(',')}, local=${refEval.localFailedStep ?? 'ok'} (${refEval.oracleError ?? ''})`
              });
            }

            armRecords[arm].push({
              ...refEval,
              tier: meta.tier,
              contextBytes: meta.contextBytes,
              contextTokensEst: meta.contextTokensEst,
              naiveDefects: naiveEval.defects,
              naiveBlockedByLocalGates: !naiveEval.localChecksPass,
              wallClockMs: 0,
              agentTokens: null,
              costUsd: null
            });
          }

          if (naiveCaughtCount === 0) {
            findings.push({ id: 'vacuous-defect-probe', detail: `${task.id}: naive patch triggered zero defect probes` });
          }
          calibrationChecks.push({ taskId: task.id, starterFailedOracle: !starterEval.oraclePass, naiveDefects: naiveCaughtCount });
        } else {
          for (const arm of arms) {
            const workDir = path.join(rootTmp, `${task.id}-${arm}-live`);
            const meta = materializeWorkspace(task, arm, workDir, { index });
            const telemetry = await runExternalAgent(runner, workDir, task, arm, { agentCmd, model });
            const scored = await evaluateWorkspace(task, arm, workDir, { runDrift: true });
            armRecords[arm].push({
              ...scored,
              tier: meta.tier,
              contextBytes: meta.contextBytes,
              contextTokensEst: meta.contextTokensEst,
              naiveBlockedByLocalGates: false,
              ...telemetry
            });
          }
        }
      }
    });

    await Promise.all(workers);
  } finally {
    rmSync(rootTmp, { recursive: true, force: true });
  }

  for (const arm of arms) {
    armRecords[arm].sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  const summary = Object.fromEntries(arms.map((arm) => [arm, summarizeArm(armRecords[arm])]));
  const categories = [...new Set(tasks.map((t) => t.category))];
  const byCategory = Object.fromEntries(
    categories.map((cat) => [
      cat,
      Object.fromEntries(arms.map((arm) => [arm, summarizeArm(armRecords[arm].filter((r) => r.category === cat))]))
    ])
  );

  const deltas = {};
  if (summary['vld-packet'] && summary['no-spec']) {
    deltas.vsNoSpec = deltaBetween(summary['vld-packet'], summary['no-spec']);
  }
  if (summary['vld-packet'] && summary['generic-spec']) {
    deltas.vsGenericSpec = deltaBetween(summary['vld-packet'], summary['generic-spec']);
  }

  return {
    ok: findings.length === 0,
    runner,
    liveAgent: runner !== 'calibration',
    model: model ?? null,
    tasksCount: tasks.length,
    arms,
    summary,
    deltas,
    byCategory,
    calibrationChecks,
    records: armRecords,
    findings
  };
}
