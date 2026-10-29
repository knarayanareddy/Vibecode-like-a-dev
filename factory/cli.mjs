#!/usr/bin/env node
/**
 * vld — vibecode like a dev.
 *
 * Four commands, one job each:
 *   vld init <dir>                 write a profile to fill in
 *   vld plan <profile>             show what would be selected and why
 *   vld compile <profile> -o <dir> render the specification packet
 *   vld verify <packet> [--repo .] check the packet, optionally against real code
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { emitPacket } from './lib/emit/index.mjs';
import { buildIndex, loadIndex, writeIndex } from './lib/indexer.mjs';
import { buildPlan, loadPolicy } from './lib/planner.mjs';
import { loadProfile, KINDS, STAGES, SCALES, TRAITS, RISK_FLAGS } from './lib/profile.mjs';
import { verifyPacket } from './lib/verify.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

const hasFlag = (name) => rest.includes(name);
const option = (name, fallback) => {
  const index = rest.indexOf(name);
  return index === -1 || index === rest.length - 1 ? fallback : rest[index + 1];
};
const positional = rest.filter((item, index) => !item.startsWith('-') && !(index > 0 && ['-o', '--out', '--repo'].includes(rest[index - 1])));

const USAGE = `vibecode like a dev — from one paragraph to a spec an agent can execute

Usage
  vld init <dir>                     write profile.json to fill in
  vld plan <profile.json> [--json]   show selection and reasoning, write nothing
  vld compile <profile.json> -o <dir> [--force]
                                     render the specification packet
  vld verify <packet-dir> [--repo <path>] [--strict] [--json]
                                     check a packet, optionally against code
  vld index [--check]                rebuild primitives/index.json

Exit codes
  0 ok · 1 verification findings · 2 usage or input error

Typical loop
  1. vld init my-app && edit my-app/profile.json
  2. vld plan my-app/profile.json          # does the reasoning match your intent?
  3. vld compile my-app/profile.json -o specs --force
  4. hand specs/ to your agent, or run: vld verify specs --repo .
`;

const PROFILE_TEMPLATE = {
  $help: {
    kinds: KINDS,
    stages: STAGES,
    'users.scale': SCALES,
    traits: TRAITS,
    'risks flags': RISK_FLAGS,
    note: 'Only name, idea, kind and stage are required. Unknown traits and risk flags are rejected so the router cannot silently ignore a decision.'
  },
  name: 'my-project',
  idea: 'One paragraph: who it is for, what it does, and what they do today instead.',
  kind: 'web-app',
  stage: 'prototype',
  users: { scale: 'small' },
  traits: [],
  risks: {
    pii: false,
    payments: false,
    regulated: false,
    multiTenant: false,
    destructiveWrites: false,
    publicFacing: false,
    integrations: false
  },
  constraints: {
    team: 1,
    weeks: 4,
    stack: 'undecided',
    mustUse: []
  }
};

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(2);
}

function loadPlanOrFail(profilePath) {
  if (!profilePath) fail('Missing profile path. Run `vld init <dir>` to create one.');
  if (!existsSync(profilePath)) fail(`No such profile: ${profilePath}`);

  const { profile, errors } = loadProfile(profilePath);
  if (errors.length > 0) {
    console.error('\n✗ Profile is not valid:\n');
    for (const error of errors) console.error(`  - ${error}`);
    console.error('');
    process.exit(2);
  }

  let index;
  try {
    index = loadIndex();
  } catch {
    index = buildIndex();
  }

  return buildPlan(profile, { index });
}

function printPlan(plan) {
  const { profile, rigor, stats } = plan;
  const lines = [];

  lines.push('');
  lines.push(`vibecode like a dev · plan`);
  lines.push(`────────────────────────────────────────────────────────────`);
  lines.push(`project   ${profile.name}  (${profile.kind}, ${profile.stage}, ${profile.users.scale} scale)`);
  lines.push(`idea      ${profile.idea.length > 88 ? `${profile.idea.slice(0, 85)}...` : profile.idea}`);
  lines.push('');
  lines.push(`rigor     tier ${rigor.tier} (${rigor.label}) · score ${rigor.score} · packet ${rigor.packet}`);
  if (rigor.signals.length > 0) {
    lines.push(`signals   ${rigor.signals.map((signal) => `${signal.label} (+${signal.weight})`).join(', ')}`);
  } else {
    lines.push('signals   none detected — a prototype is treated like one');
  }
  if (rigor.capped) lines.push(`capped    ${rigor.cappedReason}`);
  lines.push('');
  lines.push(
    `selected  ${stats.primitives} practices · ${stats.requirements} requirements · ${stats.acceptanceCriteria} criteria · ${stats.gates} gates`
  );
  lines.push('');

  for (const primitive of plan.primitives) {
    lines.push(`  ${primitive.id.padEnd(38)} ${String(primitive.cost).padEnd(7)} ${primitive.title}`);
    lines.push(`  ${''.padEnd(38)} ${' '.padEnd(7)} ${primitive.why}`);
  }

  if (plan.deferred.length > 0) {
    lines.push('');
    lines.push(`deferred by budget (${plan.deferred.length}) — applicable, did not fit tier ${rigor.tier}:`);
    for (const entry of plan.deferred) lines.push(`  ${entry.id.padEnd(38)} ${entry.title}`);
  }

  const skippedByPredicate = plan.skipped.filter((entry) => entry.reason === 'predicate');
  const skippedByTier = plan.skipped.filter((entry) => entry.reason === 'tier');
  if (skippedByTier.length > 0) {
    lines.push('');
    lines.push(`not applicable at tier ${rigor.tier} (${skippedByTier.length}):`);
    for (const entry of skippedByTier) lines.push(`  ${entry.id.padEnd(38)} ${entry.detail}`);
  }
  if (skippedByPredicate.length > 0) {
    lines.push('');
    lines.push(`skipped by predicate (${skippedByPredicate.length}):`);
    for (const entry of skippedByPredicate) lines.push(`  ${entry.id.padEnd(38)} ${entry.detail}`);
  }

  lines.push('');
  lines.push('requirements:');
  for (const requirement of plan.requirements) {
    lines.push(`  ${requirement.id}  ${requirement.verify.padEnd(9)} ${requirement.title}`);
  }

  if (plan.warnings.length > 0) {
    lines.push('');
    for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push('');
  lines.push(`next      vld compile ${positional[0] ?? '<profile.json>'} -o spec`);
  lines.push('');
  console.log(lines.join('\n'));
}

function runInit(dir) {
  if (!dir) fail('Missing directory. Usage: vld init <dir>');
  const target = path.resolve(dir);
  mkdirSync(target, { recursive: true });
  const file = path.join(target, 'profile.json');

  if (existsSync(file)) fail(`${file} already exists; refusing to overwrite`);

  writeFileSync(file, `${JSON.stringify(PROFILE_TEMPLATE, null, 2)}\n`, 'utf8');
  console.log(`
✓ wrote ${file}

Fill in name, idea, kind and stage. Then:
  vld plan ${path.relative(process.cwd(), file) || 'profile.json'}
`);
}

function runPlan(profilePath) {
  const plan = loadPlanOrFail(profilePath);
  if (hasFlag('--json')) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  printPlan(plan);
}

function runCompile(profilePath) {
  const plan = loadPlanOrFail(profilePath);
  const out = option('-o', option('--out', null));
  if (!out) fail('Missing output directory. Usage: vld compile <profile.json> -o <dir>');

  let result;
  try {
    result = emitPacket(plan, out, { force: hasFlag('--force') });
  } catch (error) {
    if (error.code === 'OUTPUT_NOT_EMPTY') fail(error.message);
    throw error;
  }

  const budgets = loadPolicy().budgets;
  const limit = budgets.maxLinesByTier[String(plan.rigor.tier)];
  const markdownLines = result.written
    .filter((file) => file.name.endsWith('.md'))
    .reduce((sum, file) => sum + file.lines, 0);

  console.log(`\n✓ wrote ${result.written.length} files to ${result.outDir}\n`);
  for (const file of result.written) {
    console.log(`  ${file.name.padEnd(24)} ${String(file.lines).padStart(5)} lines`);
  }
  console.log(`\n  ${'markdown total'.padEnd(24)} ${String(markdownLines).padStart(5)} lines (budget ${limit})`);

  if (markdownLines > limit) {
    console.log(`\n  ! Over the tier ceiling: this packet is more ceremony than the project earns.`);
    console.log(`    Trim prose or demote practices by priority. Do not trim criteria or gates.`);
  }

  const entry = path.basename(result.outDir);
  console.log(`
Next
  1. Read ${plan.packet === 'full' ? `${entry}/00-constitution.md` : `${entry}/spec.md`} and decide whether you agree.
  2. Hand ${entry}/ to your agent, starting at AGENTS.md.
  3. Wire the drift guard: node ${entry}/spec-check.mjs --repo .
`);
}

function runVerify(packetDir) {
  if (!packetDir) fail('Missing packet directory. Usage: vld verify <packet-dir> [--repo <path>]');
  if (!existsSync(packetDir)) fail(`No such packet: ${packetDir}`);

  const repo = hasFlag('--repo') ? path.resolve(option('--repo', '.')) : null;
  const report = verifyPacket(path.resolve(packetDir), { repo, strict: hasFlag('--strict') });

  if (hasFlag('--json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log(`\nverify · ${packetDir}\n`);
  for (const pass of report.passes) console.log(`  ✓ ${pass}`);
  for (const line of report.info) console.log(`  · ${line}`);
  if (report.warnings.length > 0) {
    console.log('');
    for (const warning of report.warnings) console.log(`  ! ${warning}`);
  }
  if (report.errors.length > 0) {
    console.log('');
    for (const error of report.errors) console.log(`  ✗ ${error}`);
  }

  const stats = report.stats ?? {};
  console.log(
    `\n${report.ok ? 'PASS' : 'FAIL'} · ${stats.requirements ?? 0} requirements · ${stats.criteria ?? 0} criteria · ` +
      `${stats.gates ?? 0} gates · ${report.errors.length} error(s) · ${report.warnings.length} warning(s)\n`
  );
  process.exit(report.ok ? 0 : 1);
}

function runIndex() {
  const result = writeIndex({ check: hasFlag('--check') });
  if (!result.ok) {
    console.error('\n✗ primitives are not valid:\n');
    for (const error of result.errors) console.error(`  - ${error}`);
    console.error('');
    process.exit(1);
  }
  console.log(
    hasFlag('--check')
      ? `✓ index is up to date (${result.count} primitives)`
      : `✓ index ${result.changed ? 'written' : 'unchanged'} (${result.count} primitives)`
  );
}

switch (command) {
  case 'init':
    runInit(positional[0]);
    break;
  case 'plan':
    runPlan(positional[0]);
    break;
  case 'compile':
    runCompile(positional[0]);
    break;
  case 'verify':
    runVerify(positional[0]);
    break;
  case 'index':
    runIndex();
    break;
  case '--version':
  case '-v':
    console.log('vibecode-like-a-dev 0.1.0');
    break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command "${command}".\n`);
    console.log(USAGE);
    process.exit(2);
}
