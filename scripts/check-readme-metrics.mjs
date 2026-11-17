#!/usr/bin/env node
/**
 * CI guardrail verifying `README.md` conciseness (<=150 lines) and ensuring
 * every benchmark / catalog figure in `README.md` matches the committed ground
 * truth in `primitives/index.json`, `factory/stacks/`, `factory/overlays/`,
 * `examples/ideas/expected.json`, `factory/evals/tasks/`, and
 * `docs/results/calibration-34.json` (roadmap 0.4 & 4.3).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTCOME_TASKS } from '../factory/evals/tasks/index.mjs';
import { REGULATIONS } from '../factory/lib/profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_README_LINES = 150;

const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const lineCount = readme.split('\n').length - (readme.endsWith('\n') ? 1 : 0);
const index = JSON.parse(readFileSync(path.join(ROOT, 'primitives', 'index.json'), 'utf8'));
const stacksCount = readdirSync(path.join(ROOT, 'factory', 'stacks')).filter((f) => f.endsWith('.json')).length;
const overlaysCount = REGULATIONS.length;
const expectedIdeas = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'ideas', 'expected.json'), 'utf8'));
const ideasCount = Object.keys(expectedIdeas.ideas ?? expectedIdeas).length;
const calibration = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'results', 'calibration-34.json'), 'utf8'));
const vldSummary = calibration.summary['vld-packet'];
const driftPct = `${(vldSummary.driftCatchRate * 100).toFixed(1)}%`;
const ciLow = `${(vldSummary.driftCatchRateCI95[0] * 100).toFixed(1)}%`;
const ciHigh = `${(vldSummary.driftCatchRateCI95[1] * 100).toFixed(1)}%`;

const errors = [];

if (lineCount > MAX_README_LINES) {
  errors.push(`README.md is ${lineCount} lines (budget <= ${MAX_README_LINES})`);
}

const requiredFacts = [
  { label: 'primitive count', needle: `${index.primitives.length} primitives` },
  { label: 'stack profile count', needle: `${stacksCount} language stacks` },
  { label: 'regulatory overlay count', needle: `${overlaysCount} regulatory overlays` },
  { label: 'stress-test corpus size', needle: `${ideasCount} product ideas` },
  { label: 'outcome task count', needle: `${OUTCOME_TASKS.length} tasks` },
  { label: 'drift catch rate', needle: driftPct },
  { label: 'drift 95% CI', needle: `${ciLow}–${ciHigh}` }
];

for (const fact of requiredFacts) {
  if (!readme.includes(fact.needle)) {
    errors.push(`README.md missing or stale ${fact.label}: expected exact text "${fact.needle}"`);
  }
}

// Guard against conflating calibration results with live LLM claims.
if (/live[-\s]model\s+merge\s+rate:\s*100/i.test(readme)) {
  errors.push('README.md must not describe fixture calibration metrics as live-model merge rates');
}

if (errors.length > 0) {
  console.error('\nREADME metrics check FAILED:\n');
  for (const err of errors) console.error(`  ✗ ${err}`);
  process.exit(1);
}

console.log(`✓ README.md verified (${lineCount}/${MAX_README_LINES} lines · all ${requiredFacts.length} published metrics match source data)`);
