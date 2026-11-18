#!/usr/bin/env node
/**
 * gate-summary.mjs — render an honest Markdown enforcement table (roadmap P2.5).
 *
 *   node enforcement/gates.mjs --repo . --json > gates-report.json
 *   node enforcement/summary.mjs gates-report.json >> $GITHUB_STEP_SUMMARY
 *
 * Generated into every specification packet by vibecode-like-a-dev.
 *
 * Separates executed proof (`PASS-EXECUTED`) from static config/file presence
 * (`PASS-STATIC` / `SKIPPED-STATIC-ONLY`), missing host toolchains
 * (`SKIPPED-UNAVAILABLE`), dated debt waivers (`WAIVED`), and manual attestations
 * (`MANUAL`) so a reader never mistakes an unexecuted check for runtime proof.
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
const symbol = {
  'PASS-EXECUTED': '✅',
  'PASS-STATIC': '☑️',
  'SKIPPED-STATIC-ONLY': '⏭️',
  'SKIPPED-UNAVAILABLE': '⚠️',
  WAIVED: '🟡',
  MANUAL: '⏳',
  DEFERRED: '⏭️',
  FAIL: '❌',
  pass: '✅',
  fail: '❌',
  pending: '⏳',
  deferred: '⏭️',
  accepted: '🟡'
};

const acceptedIds = new Set(report.acceptedIds ?? []);
const verdict = report.verdict
  ? report.verdict
  : report.fail === 0 && report.pending === 0
    ? 'PASS'
    : report.fail > 0
      ? 'FAIL'
      : 'INCOMPLETE';

console.log(`### Specification enforcement — ${verdict}`);
console.log('');
if (report.mode === 'static-only' || verdict === 'STATIC-ONLY') {
  console.log('> **Warning:** Ran with `--static-only`. Structural presence was checked, but no gate commands were executed.');
  console.log('');
}
console.log(
  `**${report.pass ?? 0} pass` +
    `${typeof report.executedPass === 'number' ? ` (${report.executedPass} executed, ${report.staticPass ?? 0} static)` : ''}` +
    ` · ${report.fail ?? 0} fail · ${report.pending ?? 0} pending` +
    `${report.skippedUnavailable ? ` · ${report.skippedUnavailable} skipped-unavailable` : ''}` +
    `${report.deferred ? ` · ${report.deferred} deferred` : ''}` +
    `${report.accepted ? ` · ${report.accepted} waived/accepted` : ''}** ` +
    `across ${report.gates ?? rows.length} gates in \`${report.repo ?? 'this repository'}\`.`
);
console.log('');
console.log('| Gate | Status | What it checked |');
console.log('| --- | --- | --- |');

for (const row of rows) {
  let label = row.verdictLabel;
  if (!label) {
    label = row.status === 'fail' && acceptedIds.has(row.id)
      ? 'accepted'
      : row.status === 'fail' && row.actual === 'fail'
        ? 'fail'
        : row.status;
  } else if (row.status === 'fail' && acceptedIds.has(row.id)) {
    label = 'WAIVED';
  }
  const detail = String(row.detail ?? '').replace(/\|/g, '\\|').slice(0, 180);
  console.log(`| \`${row.id}\` | ${symbol[label] ?? '·'} ${label} | ${detail} |`);
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
