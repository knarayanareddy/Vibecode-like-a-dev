#!/usr/bin/env node
/**
 * Business-rule extraction benchmark (roadmap 1.5, F-04).
 *
 * Scores `ownRulesFor` across the 50-item labelled corpus in
 * `factory/evals/rules-corpus.json`, checking compound-clause splitting,
 * normative-cue recall and non-rule framing precision against ratcheted CI floors.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownRulesFor } from '../factory/lib/emit/derive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.resolve(HERE, '..', 'factory', 'evals', 'rules-corpus.json');
const jsonOut = process.argv.includes('--json');

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));

let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;
const misses = [];

for (const item of corpus.items) {
  const extracted = ownRulesFor({ idea: item.text });
  const expected = item.expectRules;
  const got = extracted.length;

  if (expected === 0) {
    if (got === 0) {
      tn += 1;
    } else {
      fp += got;
      misses.push({ id: item.id, kind: 'false-positive', expected, got, text: item.text, extracted });
    }
  } else {
    const matched = Math.min(expected, got);
    tp += matched;
    if (got < expected) {
      fn += expected - got;
      misses.push({ id: item.id, kind: 'false-negative', expected, got, text: item.text, extracted });
    } else if (got > expected) {
      fp += got - expected;
      misses.push({ id: item.id, kind: 'over-split', expected, got, text: item.text, extracted });
    }
  }
}

const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const f1 = recall + precision === 0 ? 0 : (2 * precision * recall) / (precision + recall);
const ok = recall >= corpus.thresholds.minRecall && precision >= corpus.thresholds.minPrecision;

const report = {
  items: corpus.items.length,
  counts: { tp, fp, fn, tn },
  recall: Number(recall.toFixed(4)),
  precision: Number(precision.toFixed(4)),
  f1: Number(f1.toFixed(4)),
  thresholds: corpus.thresholds,
  misses,
  ok
};

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`rules eval · ${report.items} labelled items (TP ${tp}, FP ${fp}, FN ${fn}, TN ${tn})`);
  console.log(`recall      ${(recall * 100).toFixed(1)}%  (threshold ${(corpus.thresholds.minRecall * 100).toFixed(0)}%)`);
  console.log(`precision   ${(precision * 100).toFixed(1)}%  (threshold ${(corpus.thresholds.minPrecision * 100).toFixed(0)}%)`);
  console.log(`F1          ${(f1 * 100).toFixed(1)}%`);
  if (misses.length > 0) {
    console.log('\nmisses:');
    for (const m of misses) console.log(`  · ${m.id} (${m.kind}, expected ${m.expected}, got ${m.got}): ${m.text}`);
  }
  console.log(ok ? '\n✓ rule extraction meets recall and precision thresholds' : '\n✗ rule extraction below threshold');
}

process.exit(ok ? 0 : 1);
