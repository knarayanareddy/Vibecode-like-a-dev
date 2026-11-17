#!/usr/bin/env node
/**
 * gate-summary.mjs — turn a gate run into a table a non-developer can read.
 *
 *   node enforcement/gates.mjs --repo . --json > gates-report.json
 *   node enforcement/summary.mjs gates-report.json >> $GITHUB_STEP_SUMMARY
 *
 * Generated into every specification packet by vibecode-like-a-dev.
 *
 * Why this exists: the people who most need the enforcement loop are the least
 * likely to read a CI log. A JSON report is evidence; a table with a verdict per
 * gate is a thing a product owner can look at and say "that one is not done". This
 * file reads the report and prints Markdown. It checks nothing itself, so it can
 * never disagree with the runner.
 *
 * No dependencies, by design.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node enforcement/summary.mjs <gates-report.json>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(2);
}

const rows = Array.isArray(report.results) ? report.results : [];
const symbol = { pass: '✅', fail: '❌', pending: '⏳', deferred: '⏭️', accepted: '🟡' };
const verdict = report.fail === 0 && report.pending === 0 ? 'PASS' : report.fail > 0 ? 'FAIL' : 'INCOMPLETE';

console.log(`### Specification enforcement — ${verdict}`);
console.log('');
console.log(
  `**${report.pass ?? 0} pass · ${report.fail ?? 0} fail · ${report.pending ?? 0} pending` +
    `${report.deferred ? ` · ${report.deferred} deferred` : ''}` +
    `${report.accepted ? ` · ${report.accepted} accepted` : ''}** ` +
    `across ${report.gates ?? rows.length} gates in \`${report.repo ?? 'this repository'}\`.`
);
console.log('');
console.log('| Gate | Status | What it checked |');
console.log('| --- | --- | --- |');
// A gate covered by the baseline still failed; calling it "fail" in a table the
// product owner reads would overstate the problem, and calling it "pass" would lie.
// It gets its own word.
const acceptedIds = new Set((report.acceptedIds ?? []));
for (const row of rows) {
  const status = row.status === 'fail' && acceptedIds.has(row.id)
    ? 'accepted'
    : row.status === 'fail' && row.actual === 'fail'
      ? 'fail'
      : row.status;
  const detail = String(row.detail ?? '').replace(/\|/g, '\\|').slice(0, 160);
  console.log(`| \`${row.id}\` | ${symbol[status] ?? status} ${status} | ${detail} |`);
}
console.log('');
if (report.fail > 0) {
  console.log('A failing gate is not a style opinion: it means something the packet requires is not true of this repository.');
  console.log('If a gate cannot be met yet, record it as debt with an owner and an expiry rather than deleting it:');
  console.log('');
  console.log('```bash');
  console.log(`node ${process.env.VLD_PACKET ?? 'specs'}/enforcement/gates.mjs --repo . --baseline --owner @you --expires YYYY-MM-DD`);
  console.log('```');
}
