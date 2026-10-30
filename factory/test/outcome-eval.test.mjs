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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OUTCOME_TASKS, validateOutcomeTasks } from '../evals/tasks/index.mjs';
import { runOutcomeHarness } from '../lib/outcome-eval.mjs';

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

  // Structural/anchor drift and gate regressions are caught in vld-packet and missed without it,
  // while co-mutated semantic weakening (keeping @req comments intact) is caught by neither.
  assert.equal(noSpec.driftCatchRate, 0);
  assert.equal(generic.driftCatchRate, 0);
  assert.equal(vld.driftByClass.anchorDrop, 1);
  assert.ok(vld.driftByClass.gateRegression > 0.8 && vld.driftByClass.gateRegression < 1, 'tier-0 sketches omit G1-SECRETS by design');
  assert.equal(vld.driftByClass.semanticWeaken, 0, 'anchor checks alone must not pretend to catch semantic weakening');
  assert.ok(report.deltas.vsNoSpec.driftCatchRateDelta > 0.5);
  assert.ok(report.deltas.vsGenericSpec.driftCatchRateDelta > 0.5);
});

test('live cmd agent runner executes inside isolated git workspaces with zero leaked oracle files', async () => {
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
        "  writeFileSync('tests/requirements.test.mjs', `import test from 'node:test';\\nimport assert from 'node:assert/strict';\\n${anchors}\\ntest('denied path covered', () => { assert.ok(true); });\\n`);",
        "}",
        "process.stdout.write(JSON.stringify({ total_tokens: 420, cost_usd: 0.002 }) + '\\n');"
      ].join('\n'),
      'utf8'
    );

    const singleTask = OUTCOME_TASKS.filter((t) => t.id === 'gf-06-rate-limiter');
    const report = await runOutcomeHarness({
      tasks: singleTask,
      runner: 'cmd',
      agentCmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(agentScript)}`
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
