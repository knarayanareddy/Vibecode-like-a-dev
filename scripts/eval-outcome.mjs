#!/usr/bin/env node
/**
 * Multi-arm outcome evaluation harness across 24 software-engineering tasks.
 *
 * Compares three arms on identical starter repositories:
 *   1. `no-spec`      ticket paragraph only
 *   2. `generic-spec` ticket + ~125-line generic engineering specification
 *   3. `vld-packet`   ticket + compiled `vld` packet (`vld compile` + `vld change`)
 *
 * Modes:
 *   node scripts/eval-outcome.mjs                                           # CI calibration (no model calls)
 *   node scripts/eval-outcome.mjs --runner cmd --agent-cmd "claude -p ..."  # live CLI agent (Claude Code, Codex, Aider)
 *   node scripts/eval-outcome.mjs --runner openai --model gpt-4o            # live OpenAI-compatible model
 *   node scripts/eval-outcome.mjs --runner anthropic                        # live Anthropic model
 *
 * Options:
 *   --tasks <substr>   filter task IDs or categories (e.g. --tasks brownfield)
 *   --out <file>       save full JSON report
 *   --json             print JSON report to stdout
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUTCOME_TASKS } from '../factory/evals/tasks/index.mjs';
import { runOutcomeHarness } from '../factory/lib/outcome-eval.mjs';

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const option = (flag, fallback = undefined) => {
  const index = argv.indexOf(flag);
  return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1];
};

const runner = option('--runner', 'calibration');
const agentCmd = option('--agent-cmd', null);
const model = option('--model', undefined);
const filter = option('--tasks', null);
const outFile = option('--out', null);
const jsonOut = hasFlag('--json');

const selectedTasks = filter
  ? OUTCOME_TASKS.filter((task) => task.id.includes(filter) || task.category.includes(filter))
  : OUTCOME_TASKS;

if (selectedTasks.length === 0) {
  console.error(`No outcome tasks matched --tasks "${filter}"`);
  process.exit(2);
}

const report = await runOutcomeHarness({
  tasks: selectedTasks,
  runner,
  agentCmd,
  model
});

if (outFile) {
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const signedPct = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`outcome harness · ${report.tasksCount} tasks · ${report.arms.length} arms (${report.arms.join(' / ')})`);
  if (!report.liveAgent) {
    console.log('mode              calibration (starter/naive/reference fixtures — NO live model invoked)');
    console.log('note              proves oracle solvability, defect-probe sensitivity, context cost & drift catch rates;');
    console.log('                  pass --runner cmd|openai|anthropic to measure live agent merge & defect lift.\n');
  } else {
    console.log(`mode              live agent (${report.runner}${report.model ? ` · ${report.model}` : ''})\n`);
  }

  const header = ['arm', 'merge', 'clean-merge', 'defects/task', 'naive-gated', 'drift-total', 'drop/gate/sem', 'ctx-tok'];
  const rows = report.arms.map((arm) => {
    const s = report.summary[arm];
    return [
      arm,
      pct(s.mergeRate),
      pct(s.reviewCleanMergeRate),
      String(s.meanDefects.toFixed(2)),
      pct(s.naiveBlockedPreReviewRate),
      pct(s.driftCatchRate),
      `${pct(s.driftByClass.anchorDrop)} / ${pct(s.driftByClass.gateRegression)} / ${pct(s.driftByClass.semanticWeaken)}`,
      String(s.meanContextTokens)
    ];
  });

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(fmt(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(fmt(row));

  if (report.deltas?.vsNoSpec && report.deltas?.vsGenericSpec) {
    const dn = report.deltas.vsNoSpec;
    const dg = report.deltas.vsGenericSpec;
    console.log('\ndeltas (vld-packet minus baseline)');
    console.log(
      `  vs no-spec       merge ${signedPct(dn.mergeRateDelta)} · clean ${signedPct(dn.reviewCleanMergeRateDelta)} · ` +
        `defects ${dn.meanDefectsDelta >= 0 ? '+' : ''}${dn.meanDefectsDelta.toFixed(2)} · ` +
        `naive-gated ${signedPct(dn.naiveBlockedPreReviewDelta)} · drift ${signedPct(dn.driftCatchRateDelta)} · ` +
        `context +${dn.contextTokensDelta} tok`
    );
    console.log(
      `  vs generic-spec  merge ${signedPct(dg.mergeRateDelta)} · clean ${signedPct(dg.reviewCleanMergeRateDelta)} · ` +
        `defects ${dg.meanDefectsDelta >= 0 ? '+' : ''}${dg.meanDefectsDelta.toFixed(2)} · ` +
        `naive-gated ${signedPct(dg.naiveBlockedPreReviewDelta)} · drift ${signedPct(dg.driftCatchRateDelta)} · ` +
        `context +${dg.contextTokensDelta} tok`
    );
  }

  console.log('\nby category (drift catch rate · context tokens on vld-packet)');
  for (const [cat, armMap] of Object.entries(report.byCategory ?? {})) {
    const v = armMap['vld-packet'];
    const n = armMap['no-spec'];
    console.log(
      `  ${cat.padEnd(12)} ${String(v.tasks).padStart(2)} tasks · drift ${pct(n.driftCatchRate)} -> ${pct(v.driftCatchRate)} · ` +
        `naive-gated ${pct(n.naiveBlockedPreReviewRate)} -> ${pct(v.naiveBlockedPreReviewRate)} · ~${v.meanContextTokens} tok`
    );
  }

  if (report.ok) {
    console.log(`\nPASS · all ${report.tasksCount} tasks, hidden oracles, defect probes and drift mutations verified`);
  } else {
    console.log('\nFindings');
    for (const finding of report.findings) console.log(`  ✗ ${finding.id}: ${finding.detail}`);
  }
}

process.exitCode = report.ok ? 0 : 1;
