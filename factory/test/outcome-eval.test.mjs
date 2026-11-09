/**
 * Outcome evaluation harness tests.
 *
 * Verifies the 24-task multi-arm harness across:
 *   1. calibration soundness (starter fails oracle, naive triggers defect probes,
 *      reference passes oracle + all local gates across all 24 tasks x 3 arms)
 *   2. hidden-oracle isolation (an executing agent cannot inspect oracle or defect
 *      probes inside the workspace)
 *   3. live `--runner cmd` execution and paired delta calculation
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OUTCOME_TASKS, validateOutcomeTasks } from '../evals/tasks/index.mjs';
import { evaluateWorkspace, materializeWorkspace, runOutcomeHarness, runWorkspaceLocalChecks, writeModelResponseFiles } from '../lib/outcome-eval.mjs';
import { buildIndex } from '../lib/indexer.mjs';

// @req REQ-002 — end-to-end multi-arm pipeline and verification loop
test('outcome task suite has 24 valid tasks across 5 categories and calibrates across tiers 0-3', async () => {
  assert.equal(OUTCOME_TASKS.length, 24);
  assert.deepEqual(validateOutcomeTasks(OUTCOME_TASKS), []);

  const categories = new Set(OUTCOME_TASKS.map((t) => t.category));
  assert.deepEqual([...categories].sort(), ['brownfield', 'bugfix', 'greenfield', 'refactor', 'systems']);

  // Representative slice spanning all 5 categories and tiers 0, 1, 2, 3 (full 24-task run executes in `npm run eval`).
  const sliceIds = new Set([
    'gf-01-payout-ledger',     // greenfield, tier 3
    'bf-07-board-csv-export',  // brownfield + vld change delta, tier 1
    'bug-15-cursor-pagination',// bugfix, tier 0 single-file sketch
    'bug-16-stale-cache-authz',// bugfix, tier 2
    'ref-17-domain-purity',    // refactor, tier 2
    'pipe-21-checkpoint-shipper' // systems (data-pipeline), tier 1
  ]);
  const slice = OUTCOME_TASKS.filter((t) => sliceIds.has(t.id));

  const report = await runOutcomeHarness({ tasks: slice, runner: 'calibration' });
  assert.equal(report.ok, true, `calibration findings: ${JSON.stringify(report.findings)}`);
  assert.equal(report.liveAgent, false);
  assert.equal(report.tasksCount, 6);

  for (const check of report.calibrationChecks) {
    assert.equal(check.starterFailedOracle, true, `${check.taskId} starter passed oracle`);
    assert.ok(check.naiveDefects >= 1, `${check.taskId} naive triggered no defects`);
  }

  // Context cost grows monotonically: no-spec < generic-spec < vld-packet.
  const noSpec = report.summary['no-spec'];
  const generic = report.summary['generic-spec'];
  const vld = report.summary['vld-packet'];
  assert.ok(noSpec.meanContextTokens < generic.meanContextTokens);
  assert.ok(generic.meanContextTokens < vld.meanContextTokens);

  // Structural/anchor drift and gate regressions are caught in vld-packet and missed without it.
  // The independent evaluator-owned semantic oracle/mutation identity detector
  // catches the controlled co-mutated drift without misreporting local-test coverage.
  assert.equal(noSpec.driftCatchRate, 0);
  assert.equal(generic.driftCatchRate, 0);
  assert.equal(vld.driftByClass.anchorDrop, 1);
  assert.ok(vld.driftByClass.gateRegression > 0.8 && vld.driftByClass.gateRegression < 1, 'tier-0 sketches omit G1-SECRETS by design');
  assert.equal(vld.driftByClass.semanticWeaken, 1, 'the independent semantic detector catches every controlled co-mutated drift');
  assert.equal(vld.driftByClass.semanticWeakenByLocalChecks, 0, 'keep local structural coverage distinct from evaluator-owned detection');
  assert.ok(vld.driftByClass.semanticWeakenByFunctionalOracle > 0, 'task functional or defect oracles catch exercised semantic regressions');
  assert.equal(vld.driftByClass.semanticWeakenByMutationIdentity, 1, 'the identity detector covers every prescribed semantic mutant');
  assert.ok(report.deltas.vsNoSpec.driftCatchRateDelta > 0.5);
  assert.ok(report.deltas.vsGenericSpec.driftCatchRateDelta > 0.5);
});

test('workspace checks and hidden oracles are process-isolated, scrub host secrets, and model edits stay bounded', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-outcome-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = OUTCOME_TASKS.find((entry) => entry.id === 'gf-06-rate-limiter');
  materializeWorkspace(task, 'no-spec', root, { index: buildIndex() });
  for (const [rel, content] of Object.entries(task.reference)) writeFileSync(path.join(root, rel), content);
  const entry = path.join(root, 'src', 'index.mjs');
  writeFileSync(entry, `${readFileSync(entry, 'utf8')}\nif (process.env.PARENT_SECRET) throw new Error('host secret leaked');\nglobalThis.__vld_workspace_imported = true;\n`);

  const previous = process.env.PARENT_SECRET;
  process.env.PARENT_SECRET = 'parent-secret-must-not-reach-child';
  try {
    const result = await evaluateWorkspace(task, 'no-spec', root, { runDrift: false, trustedFixture: true });
    assert.equal(result.oraclePass, true, result.oracleError);
    assert.match(result.permissionBoundary, /^(node-read-only|process-only)$/, 'Node 22.0 lacks the Permission Model; newer supported Node releases add the read-only boundary');
    assert.equal(globalThis.__vld_workspace_imported, undefined, 'workspace code did not execute inside the harness process');
  } finally {
    if (previous === undefined) delete process.env.PARENT_SECRET;
    else process.env.PARENT_SECRET = previous;
  }

  writeModelResponseFiles(root, { 'src/safe-model-edit.mjs': 'export const safe = true;\n' });
  assert.equal(existsSync(path.join(root, 'src', 'safe-model-edit.mjs')), true);
  assert.throws(() => writeModelResponseFiles(root, { '../escaped.mjs': 'nope' }), /invalid output path|escapes/);
  assert.equal(existsSync(path.join(path.dirname(root), 'escaped.mjs')), false);
  assert.throws(() => writeModelResponseFiles(root, { 'src/too-large.mjs': 'x'.repeat(256 * 1024 + 1) }), /per-file limit/);
});

test('the arbitrary command runner requires an explicit unsafe acknowledgement', async () => {
  const report = await runOutcomeHarness({
    tasks: OUTCOME_TASKS.filter((task) => task.id === 'gf-06-rate-limiter'),
    runner: 'cmd',
    agentCmd: 'this command must never run without acknowledgement'
  });
  assert.equal(report.ok, false);
  assert.match(report.findings[0].detail, /same-user command/);
});

test('live cmd agent runner executes inside isolated git workspaces with zero leaked oracle files', async () => {
  if (!process.allowedNodeEnvironmentFlags?.has('--permission')) {
    const report = await runOutcomeHarness({ tasks: OUTCOME_TASKS.slice(0, 1), runner: 'cmd', agentCmd: 'must not execute', unsafeCommandAcknowledged: true });
    assert.equal(report.ok, false);
    assert.equal(report.findings[0].id, 'workspace-sandbox-unavailable');
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vld-outcome-cmd-'));
  try {
    const agentScript = path.join(tmp, 'mock-agent.mjs');
    // The mock agent scans the workspace for any leaked oracle/defect files, then
    // implements a naive solution when no spec is present and a full solution when
    // specs/spec.json names the idempotency and negative-amount requirements.
    const reqTag = '@' + 'req';
    writeFileSync(
      agentScript,
      [
        "import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "function walk(d, acc = []) {",
        "  for (const e of readdirSync(d, { withFileTypes: true })) {",
        "    if (e.name === '.git') continue;",
        "    const p = d + '/' + e.name;",
        "    if (e.isDirectory()) walk(p, acc); else acc.push(p);",
        "  }",
        "  return acc;",
        "}",
        "const files = walk('.');",
        "if (files.some((f) => /oracle|defectProbe/i.test(f))) {",
        "  process.exit(99);",
        "}",
        "const hasPacket = existsSync('specs/spec.json');",
        "if (!hasPacket) {",
        "  writeFileSync('src/index.mjs', `export function createRateLimiter({ limit, windowMs }) {\n  const hits = new Map();\n  return {\n    check(key, nowMs = Date.now(), correlationId = 'req-0') {\n      const list = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);\n      list.push(nowMs);\n      hits.set(key, list);\n      if (list.length > limit) return { allowed: false, error: { code: 'RATE_LIMITED', retryAfterMs: windowMs, correlationId } };\n      return { allowed: true, remaining: limit - list.length, correlationId };\n    }\n  };\n}\n`);",
        "} else {",
        "  const spec = JSON.parse(readFileSync('specs/spec.json', 'utf8'));",
        `  const anchors = spec.requirements.filter((r) => r.verify === 'automated').map((r) => '// ${reqTag} ' + r.id).join('\\n');`,
        "  writeFileSync('src/index.mjs', `export function createRateLimiter({ limit, windowMs }) {\n  const hits = new Map();\n  return {\n    check(key, nowMs = Date.now(), correlationId = 'req-0') {\n      const active = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);\n      if (active.length >= limit) {\n        hits.set(key, active);\n        return { allowed: false, error: { code: 'RATE_LIMITED', retryAfterMs: Math.max(1, windowMs - (nowMs - active[0])), correlationId } };\n      }\n      active.push(nowMs);\n      hits.set(key, active);\n      return { allowed: true, remaining: limit - active.length, correlationId };\n    }\n  };\n}\n`);",
        // The assertion must be able to fail. BLK-1 made a literal-argument
        // assertion a hard error, correctly: it proves nothing. This mock agent
        // stands in for a competent one, so it asserts on the product's behaviour.
        // (The literal form is deliberately not quoted here: the checker is lexical
        // and would read this comment as the very violation it describes.)
        "  writeFileSync('tests/requirements.test.mjs', `import test from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { createRateLimiter } from '../src/index.mjs';\\n${anchors}\\ntest('denied path is covered after the limit', () => { const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }); limiter.check('k', 0); assert.equal(limiter.check('k', 1).allowed, false); });\\n`);",
        "}",
        "process.stdout.write(JSON.stringify({ total_tokens: 420, cost_usd: 0.002 }) + '\\n');"
      ].join('\n'),
      'utf8'
    );

    const singleTask = OUTCOME_TASKS.filter((t) => t.id === 'gf-06-rate-limiter');
    const report = await runOutcomeHarness({
      tasks: singleTask,
      runner: 'cmd',
      agentCmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(agentScript)}`,
      unsafeCommandAcknowledged: true
    });

    assert.equal(report.ok, true);
    assert.equal(report.liveAgent, true);
    assert.equal(report.summary['no-spec'].reviewCleanMergeRate, 0);
    assert.equal(report.summary['vld-packet'].reviewCleanMergeRate, 1);
    assert.equal(report.deltas.vsNoSpec.reviewCleanMergeRateDelta, 1);
    assert.equal(report.records['vld-packet'][0].agentTokens, 420);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test('workspace-controlled tests cannot write outside their temporary root', async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'vld-outcome-escape-'));
  const workspace = path.join(parent, 'workspace'); const sentinel = path.join(parent, 'escaped-by-workspace');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const task = OUTCOME_TASKS.find((entry) => entry.id === 'gf-06-rate-limiter');
  materializeWorkspace(task, 'no-spec', workspace, { index: buildIndex() });
  for (const [rel, content] of Object.entries(task.reference)) writeFileSync(path.join(workspace, rel), content);
  writeFileSync(path.join(workspace, 'tests', 'hostile.test.mjs'), "import { writeFileSync } from 'node:fs'; import test from 'node:test'; test('hostile write', () => writeFileSync('../escaped-by-workspace', 'owned'));\n");
  const result = await runWorkspaceLocalChecks(workspace);
  assert.equal(result.ok, false, 'an escape-write attempt must not be treated as a passing workspace check');
  assert.equal(existsSync(sentinel), false, 'the read-only child process may not create a sibling host file');
});
