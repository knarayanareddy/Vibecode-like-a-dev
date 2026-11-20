#!/usr/bin/env node
/**
 * Roadmap P1.1 — Risk & Regulatory Regime Scanner Evaluator.
 *
 * Evaluates `scanAllIdeaCues` against `examples/risk-corpus.json` (>= 80 labelled
 * ideas across all 7 risk flags and all 10 regulatory regimes). Reports per-flag
 * and per-regime TP/FP/FN, recall, precision and F1, and exits non-zero whenever
 * any risk flag or regime falls below the configured recall (>= 0.90) or
 * precision (>= 0.80) floor.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGULATIONS, RISK_FLAGS } from '../factory/lib/profile.mjs';
import { scanAllIdeaCues } from '../factory/lib/risk-hints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CORPUS = path.join(ROOT, 'examples', 'risk-corpus.json');

function computeMetric(tp, fp, fn) {
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    fn,
    recall: Number(recall.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    f1: Number(f1.toFixed(4))
  };
}

export function evaluateRiskScanner({
  corpusPath = DEFAULT_CORPUS,
  minRecall = null,
  minPrecision = null
} = {}) {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const recallFloor = minRecall ?? corpus.thresholds?.minRecall ?? 0.9;
  const precisionFloor = minPrecision ?? corpus.thresholds?.minPrecision ?? 0.8;
  const cases = corpus.cases ?? [];

  const flagStats = Object.fromEntries(RISK_FLAGS.map((f) => [f, { tp: 0, fp: 0, fn: 0, misses: [], falsePositives: [] }]));
  const regimeStats = Object.fromEntries(REGULATIONS.map((r) => [r, { tp: 0, fp: 0, fn: 0, misses: [], falsePositives: [] }]));

  for (const item of cases) {
    const expectedFlags = new Set(item.risks ?? []);
    const expectedRegimes = new Set(item.regimes ?? []);
    const scan = scanAllIdeaCues(item.idea);
    const actualFlags = new Set(scan.risks.map((r) => r.flag));
    const actualRegimes = new Set(scan.regimes.map((r) => r.regime));

    for (const flag of RISK_FLAGS) {
      const want = expectedFlags.has(flag);
      const got = actualFlags.has(flag);
      if (want && got) flagStats[flag].tp += 1;
      else if (!want && got) {
        flagStats[flag].fp += 1;
        flagStats[flag].falsePositives.push(item.id);
      } else if (want && !got) {
        flagStats[flag].fn += 1;
        flagStats[flag].misses.push(item.id);
      }
    }

    for (const regime of REGULATIONS) {
      const want = expectedRegimes.has(regime);
      const got = actualRegimes.has(regime);
      if (want && got) regimeStats[regime].tp += 1;
      else if (!want && got) {
        regimeStats[regime].fp += 1;
        regimeStats[regime].falsePositives.push(item.id);
      } else if (want && !got) {
        regimeStats[regime].fn += 1;
        regimeStats[regime].misses.push(item.id);
      }
    }
  }

  const perFlag = {};
  const perRegime = {};
  const failures = [];

  let macroFlagRecall = 0;
  let macroFlagPrecision = 0;
  for (const flag of RISK_FLAGS) {
    const raw = flagStats[flag];
    const m = computeMetric(raw.tp, raw.fp, raw.fn);
    perFlag[flag] = { ...m, misses: raw.misses, falsePositives: raw.falsePositives };
    macroFlagRecall += m.recall;
    macroFlagPrecision += m.precision;
    if (m.recall < recallFloor) {
      failures.push(`risk flag "${flag}" recall ${m.recall} < ${recallFloor} (missed: ${raw.misses.join(', ')})`);
    }
    if (m.precision < precisionFloor) {
      failures.push(`risk flag "${flag}" precision ${m.precision} < ${precisionFloor} (fp: ${raw.falsePositives.join(', ')})`);
    }
  }

  const coreRegimes = ['coppa', 'gdpr', 'hipaa', 'pci-dss', 'ccpa', 'ferpa', 'soc2', 'sox', 'dora', 'eu-ai-act'];
  for (const regime of REGULATIONS) {
    const raw = regimeStats[regime];
    const m = computeMetric(raw.tp, raw.fp, raw.fn);
    perRegime[regime] = { ...m, misses: raw.misses, falsePositives: raw.falsePositives };
    if (coreRegimes.includes(regime)) {
      if (m.recall < recallFloor) {
        failures.push(`regime "${regime}" recall ${m.recall} < ${recallFloor} (missed: ${raw.misses.join(', ')})`);
      }
      if (m.precision < precisionFloor) {
        failures.push(`regime "${regime}" precision ${m.precision} < ${precisionFloor} (fp: ${raw.falsePositives.join(', ')})`);
      }
    }
  }

  if (cases.length < 80) {
    failures.push(`corpus size ${cases.length} < 80 required`);
  }

  return {
    ok: failures.length === 0,
    corpusSize: cases.length,
    thresholds: { minRecall: recallFloor, minPrecision: precisionFloor },
    macro: {
      recall: Number((macroFlagRecall / RISK_FLAGS.length).toFixed(4)),
      precision: Number((macroFlagPrecision / RISK_FLAGS.length).toFixed(4))
    },
    perFlag,
    perRegime,
    failures
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const corpusIdx = args.indexOf('--corpus');
  const corpusPath = corpusIdx !== -1 ? path.resolve(args[corpusIdx + 1]) : DEFAULT_CORPUS;
  const report = evaluateRiskScanner({ corpusPath });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nrisk-scanner eval · ${report.corpusSize} ideas · floors recall>=${report.thresholds.minRecall} precision>=${report.thresholds.minPrecision}\n`);
    console.log('  Risk flags:');
    for (const [flag, m] of Object.entries(report.perFlag)) {
      console.log(
        `    ${flag.padEnd(18)} recall=${m.recall.toFixed(3)}  precision=${m.precision.toFixed(3)}  f1=${m.f1.toFixed(3)}  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`
      );
    }
    console.log('\n  Regulatory regimes:');
    for (const [regime, m] of Object.entries(report.perRegime)) {
      console.log(
        `    ${regime.padEnd(18)} recall=${m.recall.toFixed(3)}  precision=${m.precision.toFixed(3)}  f1=${m.f1.toFixed(3)}  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`
      );
    }
    if (report.failures.length > 0) {
      console.error('\n  Failures:');
      for (const f of report.failures) console.error(`    ✗ ${f}`);
    }
    console.log(`\n${report.ok ? 'PASS' : 'FAIL'} · macro recall=${report.macro.recall.toFixed(3)} · macro precision=${report.macro.precision.toFixed(3)}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}
