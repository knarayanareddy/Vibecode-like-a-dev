#!/usr/bin/env node
/**
 * Adversarial stress test.
 *
 * The first stress run asked "does the pipeline work". This one asks "where does
 * it break": profiles on the boundary of the schema, ideas written in the wrong
 * language, a stack nobody has heard of, every risk flag at once, an idea that
 * tries to inject a document heading, and six inputs that must be *rejected*
 * cleanly rather than compiled into something plausible.
 *
 * Two verdicts are acceptable and only two: a sound packet, or a refusal that
 * names the field and exits 2 without a stack trace. Anything else is a finding.
 *
 * Usage: node scripts/stress-adversarial.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitPacket } from '../factory/lib/emit/index.mjs';
import { buildIndex } from '../factory/lib/indexer.mjs';
import { buildPlan } from '../factory/lib/planner.mjs';
import { normalizeProfile } from '../factory/lib/profile.mjs';
import { auditPacket, runShippedChecker } from './lib/packet-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.join(ROOT, 'examples', 'ideas', 'adversarial', 'cases.json');
const BUILD = path.join(ROOT, 'examples', 'ideas', 'build', 'adversarial');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

const index = buildIndex();
const cases = JSON.parse(readFileSync(CASES, 'utf8')).cases;

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
const scratch = mkdirSync(path.join(os.tmpdir(), `vld-adversarial-${process.pid}`), { recursive: true });

/** Compile one packet the way the library does, then judge it. */
function runPacketCase(testCase) {
  const profile = normalizeProfile(testCase.profile);
  const outDir = path.join(BUILD, testCase.id);
  const plan = buildPlan(profile, { index });
  emitPacket(plan, outDir, { force: true });

  const result = auditPacket(profile, outDir);
  const checker = runShippedChecker(outDir);
  if (checker.code !== 0) {
    result.findings.push({ id: 'shipped-checker', detail: checker.stdout.trim().split('\n').slice(-3).join(' ') });
  }

  const keys = new Set(plan.requirements.map((requirement) => requirement.key));
  for (const required of testCase.expectRequirements ?? []) {
    if (!keys.has(required)) result.findings.push({ id: 'expected-requirement', detail: `${required} should apply to this profile but does not` });
  }
  for (const forbidden of testCase.expectAbsent ?? []) {
    if (keys.has(forbidden)) result.findings.push({ id: 'unexpected-requirement', detail: `${forbidden} applies to this profile and should not` });
  }

  result.id = testCase.id;
  result.ok = result.findings.length === 0;
  return result;
}

/**
 * A rejected input must fail for the right reason, in the right channel, without
 * a stack trace: the message is the product here.
 */
function runRejectCase(testCase) {
  const profilePath = path.join(scratch, `${testCase.id}.json`);
  const outDir = path.join(scratch, `${testCase.id}-out`);
  writeFileSync(profilePath, JSON.stringify(testCase.profile, null, 2));

  let outcome;
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'compile', profilePath, '-o', outDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    outcome = { code: 0, stdout, stderr: '' };
  } catch (error) {
    outcome = { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }

  const findings = [];
  if (outcome.code !== 2) findings.push({ id: 'exit-code', detail: `expected exit 2 for an invalid profile, got ${outcome.code}` });
  if (/^\s+at\s/m.test(outcome.stderr) || /TypeError|ReferenceError/.test(outcome.stderr)) {
    findings.push({ id: 'stack-trace', detail: 'the refusal printed a stack trace instead of a message a user can act on' });
  }
  if (outcome.stdout.trim() !== '') findings.push({ id: 'stdout', detail: 'a rejected input wrote to stdout, so piping stays unsafe' });
  const covers = testCase.covers;
  if (covers && !new RegExp(covers, 'i').test(outcome.stderr)) {
    findings.push({ id: 'message', detail: `refusal does not name "${covers}": ${outcome.stderr.trim().split('\n').slice(0, 2).join(' ')}` });
  }

  return {
    id: testCase.id,
    kind: 'reject',
    tier: '-',
    requirements: '-',
    criteria: '-',
    gates: '-',
    lines: '-',
    vocab: '-',
    gaps: '-',
    findings,
    ok: findings.length === 0
  };
}

const results = cases.map((testCase) => {
  if (testCase.expect === 'reject') {
    const result = runRejectCase(testCase);
    result.kind = testCase.profile.kind;
    return result;
  }
  const result = runPacketCase(testCase);
  result.vocab = `${Math.round(result.keywordCoverage * 100)}%`;
  return result;
});

const header = ['case', 'expect', 'kind', 'tier', 'req', 'lines', 'vocab', 'gaps', 'verdict'];
const rows = results.map((result) => [
  result.id,
  cases.find((testCase) => testCase.id === result.id).expect,
  result.kind,
  String(result.tier),
  String(result.requirements),
  String(result.lines),
  String(result.vocab),
  String(result.gaps),
  result.ok ? 'pass' : `${result.findings.length} finding(s)`
]);
const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)));
console.log(header.map((cell, i) => cell.padEnd(widths[i])).join('  '));
console.log(widths.map((width) => '-'.repeat(width)).join('  '));
for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));

const failing = results.filter((result) => !result.ok);
if (failing.length > 0) {
  console.log('\nFindings');
  for (const result of failing) {
    console.log(`\n${result.id} — ${cases.find((testCase) => testCase.id === result.id).note}`);
    for (const finding of result.findings) console.log(`  ✗ ${finding.id}: ${finding.detail}`);
  }
}

const packets = results.filter((result) => cases.find((testCase) => testCase.id === result.id).expect === 'packet');
const overBudget = packets.filter((result) => result.lines !== '-' && typeof result.lines === 'number');
console.log(
  `\n${packets.length} packets compiled · ${results.length - packets.length} inputs rejected · ${failing.length} with findings · ` +
    `longest packet ${Math.max(...overBudget.map((result) => result.lines))} lines`
);

rmSync(scratch, { recursive: true, force: true });
process.exitCode = failing.length > 0 ? 1 : 0;
