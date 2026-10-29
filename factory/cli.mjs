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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adoptRepo, writeAdoptedProfile } from './lib/adopt.mjs';
import { CHANGE_TEMPLATE, applyChange, emitChange, planChange, verifyChange } from './lib/change.mjs';
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
  vld adopt <repo> [-o <file>] [--force] [--json]
                                     infer a profile from an existing repository
  vld plan <profile.json> [--json]   show selection and reasoning, write nothing
  vld compile <profile.json> -o <dir> [--force]
                                     render the specification packet
  vld verify <packet-dir> [--repo <path>] [--strict] [--json]
                                     check a packet, optionally against code
  vld change <packet-dir> <change.json> -o <dir> [--apply] [--force] [--json]
                                     render a delta spec for a brownfield change
  vld change verify <change-dir>     validate a change proposal
  vld change init <dir>              write change.json to fill in
  vld mcp                            run the MCP server over stdio
  vld index [--check]                rebuild primitives/index.json

Exit codes
  0 ok · 1 verification findings · 2 usage or input error

Typical loop
  new project       vld init my-app  →  plan  →  compile  →  hand specs/ to an agent
  existing project  vld adopt .      →  plan  →  compile  →  vld change …
  brownfield        vld change specs changes/add-export.json -o changes/add-export
  no repo access    see prompts/bootstrap.md
  agent integration vld mcp          (declare in your MCP client config)
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

/** Prefer a short relative path, but never a ../../.. chain. */
function displayPath(target) {
  const relative = path.relative(process.cwd(), target);
  return relative && !relative.startsWith('..') ? relative : target;
}

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

function runAdopt(repoPath) {
  const repo = repoPath ?? '.';
  if (!existsSync(repo)) fail(`No such repository: ${repo}`);

  const report = adoptRepo(repo);

  if (hasFlag('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const confidenceMark = { high: '●', medium: '◐', low: '○' };
  console.log(`\nadopt · ${report.repo}\n`);
  console.log(`  ${report.facts.filesScanned} files · ${report.facts.sourceFiles} source · ${report.facts.dependencies} dependencies` +
    `${report.facts.truncated ? ' · scan truncated' : ''}`);
  console.log('');
  console.log('  inferred');
  for (const entry of report.evidence) {
    const value = Array.isArray(entry.value) ? (entry.value.length ? entry.value.join(', ') : 'none') : String(entry.value);
    console.log(`  ${confidenceMark[entry.confidence] ?? '·'} ${entry.field.padEnd(24)} ${value}`);
    const why = (entry.evidence ?? []).slice(0, 2).join('; ');
    if (why) console.log(`  ${' '.padEnd(2)} ${' '.padEnd(24)} ${why}`);
  }

  if (report.observations.length > 0) {
    console.log('');
    console.log('  findings');
    for (const observation of report.observations) console.log(`  ! ${observation}`);
  }

  console.log('');
  console.log('  only you can answer');
  report.questions.forEach((question, index) => console.log(`  ${index + 1}. ${question}`));

  const out = option('-o', option('--out', path.join(report.repo, 'profile.json')));
  let written;
  try {
    written = writeAdoptedProfile(report, out, { force: hasFlag('--force') });
    console.log(`\n✓ wrote ${written}`);
  } catch (error) {
    console.log(`\n  ! profile not written: ${error.message}`);
    return;
  }

  console.log(`
Next
  1. Answer the questions above inside ${displayPath(written)} — the draft idea is a placeholder.
  2. vld plan ${displayPath(written)}      # check the tier before you trust it
  3. vld compile ${displayPath(written)} -o specs
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

function runChange() {
  const [first, second] = positional;

  if (first === 'init') {
    const dir = second ?? 'changes';
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'change.json');
    if (existsSync(file) && !hasFlag('--force')) fail(`${file} already exists; pass --force to replace it`);
    writeFileSync(file, `${JSON.stringify(CHANGE_TEMPLATE, null, 2)}\n`, 'utf8');
    console.log(`\n✓ wrote ${file}\n\nFill in id, title, why and at least one of add/modify/remove. Then:\n  vld change specs ${file} -o changes/<id>\n`);
    return;
  }

  if (first === 'verify') {
    if (!second) fail('Usage: vld change verify <change-dir>');
    const report = verifyChange(second);
    console.log(`\nchange verify · ${second}\n`);
    for (const pass of report.passes) console.log(`  ✓ ${pass}`);
    for (const warning of report.warnings) console.log(`  ! ${warning}`);
    for (const error of report.errors) console.log(`  ✗ ${error}`);
    console.log(`\n${report.ok ? 'PASS' : 'FAIL'} · ${report.errors.length} error(s) · ${report.warnings.length} warning(s)\n`);
    process.exit(report.ok ? 0 : 1);
  }

  const packetDir = first;
  const changePath = second;
  if (!packetDir || !changePath) fail('Usage: vld change <packet-dir> <change.json> -o <dir> [--apply]');

  let change;
  try {
    change = JSON.parse(readFileSync(changePath, 'utf8'));
    delete change.$help;
  } catch (error) {
    fail(`could not read change at ${changePath}: ${error.message}`);
  }

  const plan = planChange({ packetDir, change });

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ ...plan, afterSpec: undefined }, null, 2));
    if (plan.errors.length > 0) process.exit(2);
    return;
  }

  if (plan.errors.length > 0) {
    console.error('\n✗ change is not valid:\n');
    for (const error of plan.errors) console.error(`  - ${error}`);
    console.error('');
    process.exit(2);
  }

  const out = option('-o', option('--out', path.join(packetDir, 'changes', change.id)));
  const result = emitChange(plan, out, { force: hasFlag('--force') });

  console.log(`\n✓ ${change.id} · risk ${change.risk} · impact ${plan.impact}\n`);
  console.log(`  +${plan.added.length} added · ~${plan.modified.length} modified · -${plan.removed.length} removed`);
  console.log(`  areas: ${plan.blastRadius.areas.join(', ')}`);
  for (const file of result.written) console.log(`  ${file.name.padEnd(18)} ${String(file.lines).padStart(4)} lines`);

  if (plan.blastRadius.obligations.length > 0) {
    console.log('\n  obligations');
    for (const obligation of plan.blastRadius.obligations) console.log(`  - ${obligation}`);
  }
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);

  if (hasFlag('--apply')) {
    const applied = applyChange(plan);
    console.log(`\n✓ applied to ${applied.specPath} (backup at ${applied.backupPath})`);
  } else {
    console.log(`\n  spec.after.json is the resulting manifest. Review it, then apply with --apply or by copying it over spec.json.`);
  }

  console.log(`
Next
  1. Read ${displayPath(path.join(result.outDir, 'proposal.md'))} and reject it here if the blast radius is wrong.
  2. Work through ${displayPath(path.join(result.outDir, 'tasks.md'))} in order.
  3. After merging: vld change verify ${displayPath(result.outDir)}
`);
}

function runMcp() {
  import('./lib/mcp.mjs').then(({ serve, TOOLS }) => {
    console.error(`vibecode-like-a-dev MCP server · ${TOOLS.length} tools · stdio`);
    serve();
  });
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
  case 'adopt':
    runAdopt(positional[0]);
    break;
  case 'plan':
    runPlan(positional[0]);
    break;
  case 'change':
    runChange();
    break;
  case 'mcp':
    runMcp();
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
