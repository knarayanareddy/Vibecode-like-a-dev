#!/usr/bin/env node
/**
 * Write the provenance attached to a manually approved live benchmark run.
 * This stays separate from the deterministic compiler: its timestamp describes
 * empirical execution evidence, not generated specification output.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const position = args.indexOf('--out');
const output = position === -1 ? null : args[position + 1];
if (!output || output.startsWith('-')) {
  console.error('usage: node scripts/write-live-benchmark-provenance.mjs --out <provenance.json>');
  process.exitCode = 2;
} else {
  const provenance = {
    schemaVersion: 1,
    provider: process.env.BENCHMARK_PROVIDER ?? null,
    model: process.env.BENCHMARK_MODEL ?? null,
    tasks: process.env.BENCHMARK_TASKS ?? null,
    commit: process.env.BENCHMARK_COMMIT ?? null,
    runId: process.env.BENCHMARK_RUN_ID ?? null,
    runAttempt: process.env.BENCHMARK_RUN_ATTEMPT ?? null,
    runnerOs: process.env.BENCHMARK_RUNNER_OS ?? null,
    runnerImageOs: process.env.ImageOS ?? null,
    runnerImageVersion: process.env.ImageVersion ?? null,
    node: process.version,
    generatedAt: new Date().toISOString()
  };
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
}
