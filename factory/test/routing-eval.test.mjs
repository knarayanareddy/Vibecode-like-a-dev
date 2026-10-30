/**
 * Routing evaluation tests.
 *
 * The acceptance criterion for item #10 is explicit: labelled prompts -> expected
 * practices, recall >= 0.70, precision >= 0.90, and a change to a practice's
 * description/metadata that breaks routing fails CI.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildIndex } from '../lib/indexer.mjs';
import { buildModelRoutingPrompt, evaluateRouting, loadRoutingSuite, metadataCatalog, parseModelSelection } from '../lib/routing-eval.mjs';

const index = buildIndex();

// @req REQ-005 — routing invariants and CI metadata regressions are pinned by automated tests
test('labelled routing benchmark covers all 34 practices and clears CI precision/recall gates', async () => {
  const suite = loadRoutingSuite();
  assert.ok(suite.cases.length >= 60, 'routing suite should have at least 60 labelled prompts');

  const covered = new Set(suite.cases.flatMap((entry) => entry.expected));
  assert.equal(covered.size, index.primitives.length, 'every practice must have at least one labelled prompt');

  const report = await evaluateRouting({ viaProtocol: true });
  assert.equal(report.ok, true, `routing eval failed: ${JSON.stringify(report.findings)}`);
  assert.ok(report.microRecall >= 0.7, `recall ${report.microRecall} < 0.70`);
  assert.ok(report.microPrecision >= 0.9, `precision ${report.microPrecision} < 0.90`);
  assert.deepEqual(report.zeroRecallPractices, []);
  assert.deepEqual(report.absorbers, []);
  assert.equal(report.counts.negativeClean, report.counts.negativeTotal, 'negative prompts must activate zero practices');
  assert.ok(report.ablation.recallLift >= 0.2, `expected metadata lift >= 20pp, got ${report.ablation.recallLift}`);
});

test('corrupting a practice description or triggers breaks routing and fails the check', async () => {
  const degraded = index.primitives.map((primitive) =>
    primitive.id === 'data.data-lifecycle'
      ? {
          ...primitive,
          title: 'Lifecycle rules',
          summary: 'General notes on managing records over time.',
          triggers: [],
          tags: []
        }
      : primitive
  );

  const report = await evaluateRouting({ primitives: degraded, includeAblation: false });
  assert.equal(report.ok, false, 'breaking a practice description must fail the routing check');
  assert.ok(report.zeroRecallPractices.includes('data.data-lifecycle'));
  assert.ok(report.findings.some((finding) => finding.id === 'practice-never-activated'));
});

test('a broad absorber practice that fires on unrelated prompts fails precision / absorber gates', async () => {
  const noisy = index.primitives.map((primitive) =>
    primitive.id === 'product.product-brief'
      ? {
          ...primitive,
          triggers: ['test', 'database', 'api', 'security', 'deploy', 'ui', 'schema', 'webhook', 'error', 'array', 'number']
        }
      : primitive
  );

  const report = await evaluateRouting({ primitives: noisy, includeAblation: false });
  assert.equal(report.ok, false, 'an absorber skill must fail the routing check');
  assert.ok(
    report.findings.some((finding) => finding.id === 'absorber-practice' || finding.id === 'precision-below-threshold')
  );
});

test('model-in-the-loop cmd driver executes an external model process over stdio and scores fenced JSON', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vld-routing-cmd-'));
  try {
    const stubPath = path.join(tmp, 'stub-model.mjs');
    writeFileSync(
      stubPath,
      [
        "import { readFileSync } from 'node:fs';",
        "const input = JSON.parse(readFileSync(0, 'utf8'));",
        "const p = input.prompt.toLowerCase();",
        "let selected = [];",
        "if (p.includes('gdpr')) selected = ['data.data-lifecycle'];",
        "else if (p.includes('webhook')) selected = ['reliability.idempotency-and-retries'];",
        "process.stdout.write('```json\\n' + JSON.stringify({ selected }) + '\\n```\\n');"
      ].join('\n'),
      'utf8'
    );

    const miniCases = [
      { id: 'c1', kind: 'single', prompt: 'Add GDPR account deletion and export.', expected: ['data.data-lifecycle'] },
      { id: 'c2', kind: 'single', prompt: 'Deduplicate Stripe webhook retries.', expected: ['reliability.idempotency-and-retries'] },
      { id: 'c3', kind: 'negative', prompt: 'Sort an array of integers.', expected: [] }
    ];

    const report = await evaluateRouting({
      driver: 'cmd',
      cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(stubPath)}`,
      cases: miniCases,
      thresholds: { minMicroRecall: 0.7, minMicroPrecision: 0.9, maxFalsePositivesPerPractice: 2, maxZeroRecallPractices: 99 },
      includeAblation: false
    });

    assert.equal(report.liveModel, true);
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.microPrecision, 1);
    assert.equal(report.microRecall, 1);

    const catalog = metadataCatalog(index.primitives.slice(0, 3));
    const rendered = buildModelRoutingPrompt('Add GDPR export', catalog);
    assert.match(rendered, /Catalog:/);
    const parsed = parseModelSelection('Here is my choice:\n```json\n{"selected":["agent.handoff-packet","not.real"]}\n```', new Set(['agent.handoff-packet']));
    assert.deepEqual(parsed.selected, ['agent.handoff-packet']);
    assert.deepEqual(parsed.unknown, ['not.real']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('polysemous "token" in LLM token-spend prompts does not falsely activate frontend.design-system-tokens, and domain-scoped visibility routes to security.authz-model', async () => {
  const report = await evaluateRouting({
    cases: [
      {
        id: 'polysemy-llm-token',
        kind: 'distractor',
        prompt: 'AI receipt extraction pipeline must validate structured JSON output, cap token spend, and never send patient names or IBANs to OpenAI.',
        expected: ['security.threat-model']
      },
      {
        id: 'domain-site-scoping',
        kind: 'colloquial',
        prompt: 'Blinded sponsor auditors can view anonymized trial totals while site coordinators only see patients at their own hospital site.',
        expected: ['security.authz-model']
      }
    ],
    thresholds: { minMicroRecall: 1, minMicroPrecision: 1, maxFalsePositivesPerPractice: 0, maxZeroRecallPractices: 99 },
    includeAblation: false
  });
  assert.equal(report.ok, true, JSON.stringify({ findings: report.findings, results: report.results }));
});

