#!/usr/bin/env node
/**
 * Routing eval: labelled practitioner prompts -> activated practices, scored on
 * micro-precision and micro-recall against CI thresholds.
 *
 * Modes:
 *   node scripts/eval-routing.mjs                          # deterministic MCP router (CI default)
 *   node scripts/eval-routing.mjs --driver openai          # live OpenAI-compatible model-in-the-loop
 *   node scripts/eval-routing.mjs --driver anthropic       # live Anthropic model-in-the-loop
 *   node scripts/eval-routing.mjs --driver cmd --cmd "..." # any CLI model reading {prompt,catalog} JSON
 *
 * Options:
 *   --model <id>    model identifier for openai / anthropic drivers
 *   --out <file>    write full JSON report to disk
 *   --json          print JSON report to stdout
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateRouting } from '../factory/lib/routing-eval.mjs';

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const option = (flag, fallback = undefined) => {
  const index = argv.indexOf(flag);
  return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1];
};

const driver = option('--driver', 'mcp');
const model = option('--model', undefined);
const cmd = option('--cmd', null);
const outFile = option('--out', null);
const jsonOut = hasFlag('--json');

const report = await evaluateRouting({
  driver,
  model,
  cmd,
  viaProtocol: driver === 'mcp'
});

if (outFile) {
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const driverLabel =
    report.driver === 'mcp'
      ? 'mcp metadata router (deterministic; pass --driver openai|anthropic|cmd for live LLM routing)'
      : `${report.driver}${report.model ? ` (${report.model})` : ''} · live model-in-the-loop`;

  console.log(`routing eval · ${report.casesRun} labelled prompts · ${report.primitivesCount} practices`);
  console.log(`driver            ${driverLabel}\n`);
  console.log(
    `micro-precision   ${(report.microPrecision * 100).toFixed(1)}%   (threshold ${(report.thresholds.minMicroPrecision * 100).toFixed(0)}%, TP ${report.counts.tp}, FP ${report.counts.fp})`
  );
  console.log(
    `micro-recall      ${(report.microRecall * 100).toFixed(1)}%   (threshold ${(report.thresholds.minMicroRecall * 100).toFixed(0)}%, FN ${report.counts.fn})`
  );
  console.log(
    `F1 / exact        ${(report.f1 * 100).toFixed(1)}% F1 · ${(report.exactMatchRate * 100).toFixed(1)}% exact case match · ` +
      `${report.counts.negativeClean}/${report.counts.negativeTotal} negative prompts stayed quiet`
  );
  console.log(
    `coverage          ${report.primitivesCount - report.zeroRecallPractices.length}/${report.primitivesCount} practices activated on their labelled cases · ` +
      `${report.absorbers.length} false-positive absorbers`
  );

  if (report.ablation) {
    console.log(
      `metadata lift     summary + triggers + tags add +${(report.ablation.recallLift * 100).toFixed(1)}pp recall ` +
        `(${(report.ablation.titleOnlyRecall * 100).toFixed(1)}% -> ${(report.microRecall * 100).toFixed(1)}%) and ` +
        `+${(report.ablation.precisionLift * 100).toFixed(1)}pp precision (${(report.ablation.titleOnlyPrecision * 100).toFixed(1)}% -> ${(report.microPrecision * 100).toFixed(1)}%)`
    );
  }

  const imperfect = report.cases.filter((entry) => !entry.exact);
  if (imperfect.length > 0) {
    console.log(`\nnon-exact cases (${imperfect.length}/${report.casesRun})`);
    for (const entry of imperfect.slice(0, 8)) {
      console.log(`  · ${entry.id}: expected [${entry.expected.join(', ')}], got [${entry.selected.join(', ')}]`);
    }
  }

  if (report.ok) {
    console.log('\nPASS · routing meets precision, recall and per-practice coverage thresholds');
  } else {
    console.log('\nFindings');
    for (const finding of report.findings) console.log(`  ✗ ${finding.id}: ${finding.detail}`);
  }
}

process.exitCode = report.ok ? 0 : 1;
