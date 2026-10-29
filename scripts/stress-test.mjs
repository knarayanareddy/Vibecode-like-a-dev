#!/usr/bin/env node
/**
 * Stress test: run every profile in examples/ideas/ through the pipeline and
 * judge the packet, not just the exit code.
 *
 * Usage: node scripts/stress-test.mjs [--json]
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitPacket } from '../factory/lib/emit/index.mjs';
import { buildIndex } from '../factory/lib/indexer.mjs';
import { buildPlan } from '../factory/lib/planner.mjs';
import { normalizeProfile } from '../factory/lib/profile.mjs';
import { auditPacket, runShippedChecker } from './lib/packet-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDEAS = path.join(ROOT, 'examples', 'ideas');
const BUILD = path.join(IDEAS, 'build');
const JSON_OUT = process.argv.includes('--json');

const index = buildIndex();

const files = readdirSync(IDEAS).filter((file) => file.endsWith('.json')).sort();
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

const results = [];
for (const file of files) {
  const slug = path.basename(file, '.json');
  const profile = normalizeProfile(JSON.parse(readFileSync(path.join(IDEAS, file), 'utf8')));
  const outDir = path.join(BUILD, slug);
  const plan = buildPlan(profile, { index });
  emitPacket(plan, outDir, { force: true });

  const result = auditPacket(profile, outDir);
  const checker = runShippedChecker(outDir);
  result.checkerCode = checker.code;
  if (checker.code !== 0) result.findings.push({ id: 'shipped-checker', detail: checker.stdout.trim().split('\n').slice(-3).join(' ') });
  result.ok = result.findings.length === 0;
  result.id = slug;
  results.push(result);
}

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const header = ['idea', 'kind', 'tier', 'req', 'crit', 'gates', 'lines', 'vocab', 'gaps', 'verdict'];
  const rows = results.map((result) => [
    result.id,
    result.kind,
    String(result.tier),
    String(result.requirements),
    String(result.criteria),
    String(result.gates),
    String(result.lines),
    `${Math.round(result.keywordCoverage * 100)}%`,
    String(result.gaps),
    result.ok ? 'pass' : `${result.findings.length} finding(s)`
  ]);
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(row));

  const failing = results.filter((result) => !result.ok);
  if (failing.length > 0) {
    console.log('\nFindings');
    for (const result of failing) {
      console.log(`\n${result.id}`);
      for (const finding of result.findings) console.log(`  ✗ ${finding.id}: ${finding.detail}`);
    }
  }
  const coverage = results.map((result) => result.keywordCoverage);
  process.exitCode = failing.length > 0 ? 1 : 0;
  console.log(`\n${results.length} ideas · ${failing.length} with findings · idea-vocabulary coverage ${Math.round(
    (coverage.reduce((a, b) => a + b, 0) / coverage.length) * 100
  )}% mean`);
}
