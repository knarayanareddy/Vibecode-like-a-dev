#!/usr/bin/env node
/**
 * vld — vibecode like a dev.
 *
 * One deterministic compiler with optional, separately locked platform layers:
 *   vld init <dir>                 write a profile to fill in
 *   vld plan <profile>             show what would be selected and why
 *   vld compile <profile> -o <dir> render the specification packet
 *   vld verify <packet> [--repo .] check the packet, optionally against real code
 *   vld module|bundle|agent|workflow manage opt-in delivery extensions
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adoptRepo, isRemoteRepo, writeAdoptedProfile } from './lib/adopt.mjs';
import { artifactStatus, initArtifact, listArtifacts, validateArtifact } from './lib/artifacts.mjs';
import { agentStatus, installAgent, listAdapters } from './lib/agents.mjs';
import { applyBundle, getBundle, listBundles } from './lib/bundles.mjs';
import { CHANGE_TEMPLATE, applyChange, archiveChange, emitChange, planChange, verifyChange } from './lib/change.mjs';
import { emitPacket } from './lib/emit/index.mjs';
import { buildIndex, loadIndex, writeIndex } from './lib/indexer.mjs';
import { enableModules, listModules, moduleStatus } from './lib/modules.mjs';
import { addStore, copyStoreAsset, initStore, readStoreState, refreshStore, storeStatus } from './lib/stores.mjs';
import { buildPlan, loadPolicy } from './lib/planner.mjs';
import { loadProfile, KINDS, STAGES, SCALES, TRAITS, RISK_FLAGS } from './lib/profile.mjs';
import { completeWorkflowStep, getWorkflow, listWorkflows, runWorkflow, workflowStatus } from './lib/workflows.mjs';
import { verifyPacket } from './lib/verify.mjs';

// Single source of truth for the version: a literal here drifted once already.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

const hasFlag = (name) => rest.includes(name);
const option = (name, fallback) => {
  const index = rest.indexOf(name);
  return index === -1 || index === rest.length - 1 ? fallback : rest[index + 1];
};
const VALUE_FLAGS = new Set([
  '-o', '--out', '--repo', '--name', '--idea', '--profile', '--packet',
  '--project', '--modules', '--evidence', '--file', '--ref', '--title', '--from-store'
]);
const positional = rest.filter((item, index) => !item.startsWith('-') && !(index > 0 && VALUE_FLAGS.has(rest[index - 1])));

const USAGE = `vibecode like a dev — from one paragraph to a spec an agent can execute

Usage
  vld init <dir>                     write profile.json to fill in
  vld adopt <repo-or-url> [-o <file>] [--name <slug>] [--idea <text>] [--force] [--json]
                                     infer a profile from a local path or Git repository URL
  vld plan <profile.json> [--json]   show selection and reasoning, write nothing
  vld compile <profile.json> -o <dir> [--force]
                                     render the specification packet
  vld verify <packet-dir> [--repo <path>] [--strict] [--json]
                                     check a packet, optionally against code
  vld change <packet-dir> <change.json> -o <dir> [--apply] [--force] [--json]
                                     render a delta spec for a brownfield change
  vld change verify <change-dir>     validate a change proposal
  vld change archive <change-dir> <packet-dir> [--profile <p>]
                                     fold an applied change into the profile's overlay stack
  vld change init <dir>              write change.json to fill in
  vld artifact list|init|validate|status <type> [id] [--from-store store/asset] [--project <dir>]
                                     generate and validate product, architecture, delivery, review and QA artifacts
  vld store init <dir> [--id <id>] | add <id> <git-url> | update|status [id] | assets|copy <id> [asset]
                                     fetch, pin and verify read-only Git-backed shared delivery stores
  vld module list|enable|status|verify [ids] [--project <dir>] [--json]
                                     manage version-locked optional delivery modules
  vld bundle list|show|apply <id> [--profile <file>] [--project <dir>] [--dry-run]
                                     apply a conservative profile/module starter bundle
  vld agent list|install|status [id] [--project <dir>] [--force] [--json]
                                     install or inspect generated Codex, Claude Code or Copilot handoffs
  vld workflow list|lint|run|status|complete <id> [step] [--project <dir>]
                                     typed resumable workflows; \`run\` previews unless --execute is supplied
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

/** Requirement ids already handed out by an existing packet, so they survive a catalog change. */
function previousRequirementIds(packetDir) {
  if (!packetDir || !existsSync(path.join(packetDir, 'spec.json'))) return {};
  try {
    const previous = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
    return Object.fromEntries((previous.requirements ?? []).map((requirement) => [requirement.key, requirement.id]));
  } catch {
    return {};
  }
}

function loadPlanOrFail(profilePath, { previousIds = {} } = {}) {
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

  // Overlays resolve beside the profile first, so a team can keep its own layers in
  // the same directory as the profile instead of editing the tool.
  let plan;
  try {
    plan = buildPlan(profile, { index, previousIds, profileDir: path.dirname(path.resolve(profilePath)) });
  } catch (error) {
    if (error.code === 'INVALID_OVERLAY' || error.code === 'INVALID_PROFILE') {
      console.error(`\n✗ ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  // Recorded in spec.json so an archive can find the source of truth later. As typed,
  // so two compiles of the same profile produce the same manifest.
  plan.profileLabel = profilePath.split(path.sep).join('/');
  return plan;
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

  if (plan.overlays.length > 0) {
    lines.push('');
    lines.push(`overlays (${plan.overlays.length}) — applied org -> domain -> team:`);
    for (const overlay of plan.overlays) {
      const adds = overlay.adds.requirements.length + overlay.adds.gates.length + overlay.adds.practices.length;
      lines.push(`  ${overlay.id.padEnd(24)} ${overlay.layer.padEnd(7)} +${adds} · ${overlay.title}`);
    }
  }

  lines.push('');
  lines.push('requirements:');
  for (const requirement of plan.requirements) {
    const origin = requirement.origin && requirement.origin !== 'catalog' ? ` [${requirement.origin}]` : '';
    lines.push(`  ${requirement.id}  ${requirement.verify.padEnd(9)} ${requirement.title}${origin}`);
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
  const remote = isRemoteRepo(repo);
  if (!remote && !existsSync(repo)) fail(`No such repository: ${repo}`);

  const explicitName = option('--name', null);
  const explicitIdea = option('--idea', null);
  let report;
  try {
    report = adoptRepo(repo, { name: explicitName, idea: explicitIdea });
  } catch (error) {
    if (error.code === 'INVALID_REMOTE_URL' || error.code === 'REMOTE_CLONE_FAILED') fail(error.message);
    throw error;
  }

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

  const defaultOut = report.remote ? path.resolve(process.cwd(), 'profile.json') : path.join(report.repo, 'profile.json');
  const out = option('-o', option('--out', defaultOut));
  let written;
  try {
    written = writeAdoptedProfile(report, out, { force: hasFlag('--force') });
    console.log(`\n✓ wrote ${written}`);
  } catch (error) {
    if (error.code === 'INVALID_PROFILE') fail(error.message);
    console.log(`\n  ! profile not written: ${error.message}`);
    return;
  }

  const stepOne = explicitIdea
    ? `1. Review and answer the remaining questions above inside ${displayPath(written)}.`
    : `1. Answer the questions above inside ${displayPath(written)} — the draft idea is a placeholder.`;
  console.log(`
Next
  ${stepOne}
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
  const out = option('-o', option('--out', null));
  if (!out) fail('Missing output directory. Usage: vld compile <profile.json> -o <dir>');
  const plan = loadPlanOrFail(profilePath, { previousIds: previousRequirementIds(out) });

  let result;
  try {
    result = emitPacket(plan, out, { force: hasFlag('--force') });
  } catch (error) {
    if (error.code === 'OUTPUT_NOT_EMPTY' || error.code === 'OUTPUT_NOT_DIRECTORY') fail(error.message);
    throw error;
  }

  const budgets = loadPolicy().budgets;
  const limit = budgets.maxLinesByTier[String(plan.rigor.tier)];
  // Match `verifyPacket`: count the packet's core markdown documents (`00`..`07`,
  // `AGENTS.md`, or `spec.md`), not nested `enforcement/` templates and READMEs.
  const markdownLines = result.written
    .filter((file) => !file.name.includes('/') && file.name.endsWith('.md'))
    .reduce((sum, file) => sum + file.lines, 0);

  console.log(`\n✓ wrote ${result.written.length} files to ${result.outDir}\n`);
  for (const file of result.written) {
    console.log(`  ${file.name.padEnd(24)} ${String(file.lines).padStart(5)} lines`);
  }
  console.log(`\n  ${'markdown total'.padEnd(24)} ${String(markdownLines).padStart(5)} lines (budget ${limit})`);

  if (result.progress?.carried > 0) {
    console.log(`\n  ✓ kept progress for ${result.progress.carried} requirement(s) from the previous packet:`);
    for (const entry of result.progress.carriedDetail) console.log(`    ${entry.id} ${entry.key} — ${entry.status}`);
  }
  if (result.progress?.removed?.length > 0) {
    console.log(`\n  ! ${result.progress.removed.length} requirement(s) are no longer selected and their progress is gone: ${result.progress.removed.join(', ')}`);
  }

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
  4. Check the gates: node ${entry}/enforcement/gates.mjs --repo .
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

  if (first === 'archive') {
    const changeDir = second;
    const packetDir = positional[2] ?? option('--packet', null);
    if (!changeDir || !packetDir) fail('Usage: vld change archive <change-dir> <packet-dir> [--profile <profile.json>]');
    archiveChange({
      packetDir,
      changeDir,
      profilePath: option('--profile', null),
      force: hasFlag('--force')
    })
      .then((result) => {
        console.log(`\n✓ archived ${changeDir} into ${displayPath(result.archiveDir)}\n`);
        console.log(`  overlay    ${displayPath(result.overlayPath)} ${result.changed.overlay ? '(written)' : '(unchanged)'}`);
        console.log(`  profile    ${displayPath(result.profilePath)} ${result.changed.profile ? `now lists ${result.overlayId}` : `already listed ${result.overlayId}`}`);
        console.log(`  history    ${displayPath(result.historyPath)}`);
        if (result.compiled) {
          console.log(`  recompiled ${result.compiled.requirements} requirements · ${result.compiled.gates} gates in ${displayPath(result.compiled.outDir)}`);
        }
        console.log(
          `\n  The delta now lives in the profile's overlay stack, so the next compile keeps it.\n` +
            `  Re-running this command is safe: the overlay, the history entry and the packet are rewritten identically.\n`
        );
      })
      .catch((error) => fail(error.message));
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

function reportModuleStatus(status, { json = false, verify = false } = {}) {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`\nmodules · ${displayPath(status.project)}\n`);
    if (status.modules.length === 0) console.log('  · no optional modules enabled');
    for (const module of status.modules) {
      console.log(`  ${status.drift.some((entry) => entry.id === module.id) ? '!' : '✓'} ${module.id.padEnd(14)} ${module.version} · ${module.title}`);
    }
    for (const entry of status.drift) console.log(`  ! ${entry.id}: ${entry.reason}`);
    for (const error of status.errors) console.log(`  ✗ ${error}`);
    console.log(`\n${status.ok ? 'PASS' : 'FAIL'} · ${status.modules.length} enabled module(s)${verify ? ' · lock verification' : ''}\n`);
  }
  if (!status.ok) process.exit(1);
}

function runArtifact() {
  const [action = 'list', kind, id] = positional;
  const project = option('--project', '.');
  const common = { projectDir: project, packetDir: option('--packet', null), profilePath: option('--profile', null), id: id ?? null, file: option('--file', null), fromStore: option('--from-store', null) };
  try {
    if (action === 'list') {
      const types = listArtifacts();
      if (hasFlag('--json')) console.log(JSON.stringify(types, null, 2));
      else { console.log('\nVLD validated artifacts\n'); for (const type of types) console.log(`  ${type.id.padEnd(24)} ${type.module.padEnd(14)} ${type.title}`); console.log(''); }
      return;
    }
    if (action === 'init') {
      if (!kind) fail('Usage: vld artifact init <type> [id] [--project <dir>] [--packet <dir>]');
      const result = initArtifact({ ...common, kind, out: option('--out', null), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ wrote ${displayPath(result.file)}${result.source ? ` from verified store ${result.source.store}/${result.source.asset} @ ${result.source.commit.slice(0, 12)}` : ''}\n\n  Fill the artifact, then run:\n  vld artifact validate ${kind}${id ? ` ${id}` : ''} --project ${displayPath(result.project)} --strict\n`);
      return;
    }
    if (action === 'validate') {
      if (!kind) fail('Usage: vld artifact validate <type> [id] [--strict] [--project <dir>]');
      const report = validateArtifact({ ...common, kind, strict: hasFlag('--strict') });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else { console.log(`\nartifact validate · ${displayPath(report.file)}\n`); for (const e of report.errors) console.log(`  ✗ ${e}`); for (const w of report.warnings) console.log(`  ! ${w}`); console.log(`\n${hasFlag('--strict') ? report.strictOk ? 'PASS' : 'FAIL' : report.ok ? 'PASS' : 'FAIL'}\n`); }
      if (hasFlag('--strict') ? !report.strictOk : !report.ok) process.exit(1);
      return;
    }
    if (action === 'status') {
      const report = artifactStatus({ projectDir: project, packetDir: option('--packet', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else { console.log('\nartifacts\n'); for (const entry of report) console.log(`  ${entry.exists && entry.ok ? '✓' : entry.exists ? '!' : '·'} ${entry.id.padEnd(24)} ${entry.exists ? displayPath(entry.file) : 'not created'}`); console.log(''); }
      return;
    }
    fail('Usage: vld artifact list|init|validate|status');
  } catch (error) { fail(error.message); }
}

function runStore() {
  const [action = 'status', id, repository] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'init') {
      if (!id) fail('Usage: vld store init <directory> [--id <store-id>] [--title <title>]');
      const result = initStore({ directory: id, id: option('--id', null), title: option('--title', null), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ wrote shared store skeleton in ${displayPath(result.directory)}\n\n  Add reviewed assets, commit it with Git, then consume it with:\n  vld store add ${result.manifest.id} <git-url> --project <project>\n`);
      return;
    }
    if (action === 'add') {
      if (!id || !repository) fail('Usage: vld store add <id> <git-url> [--ref <branch-or-tag>] [--project <dir>]');
      const result = addStore({ projectDir: project, id, repository, ref: option('--ref', null), refresh: hasFlag('--refresh') });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ ${result.refreshed ? 'refreshed' : 'locked'} store ${result.store.id}\n\n  commit    ${result.store.commit}\n  assets    ${result.store.assets.length}\n  cache     ${displayPath(path.join(result.project, '.vld', 'stores', result.store.id))}\n  lock      ${displayPath(result.file)}\n`);
      return;
    }
    if (action === 'update') {
      if (!id) fail('Usage: vld store update <id> [--project <dir>]');
      const result = refreshStore({ projectDir: project, id });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ refreshed store ${result.store.id} at ${result.store.commit}\n`);
      return;
    }
    if (action === 'assets') {
      if (!id) fail('Usage: vld store assets <store-id> [--project <dir>]');
      const report = storeStatus(project, id);
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else {
        const store = report.stores[0];
        console.log(`\nstore assets · ${id}\n`);
        for (const asset of store?.assets ?? []) console.log(`  ${asset.id.padEnd(22)} ${asset.kind}${asset.artifact ? ` · ${asset.artifact}` : ''}`);
        for (const error of report.errors) console.log(`  ✗ ${error}`);
        for (const drift of store?.drift ?? []) console.log(`  ! ${drift}`);
        console.log(`\n${report.ok ? 'PASS' : 'FAIL'}\n`);
      }
      if (!report.ok) process.exit(1);
      return;
    }
    if (action === 'copy') {
      if (!id || !repository) fail('Usage: vld store copy <store-id> <asset-id> [--out <relative.md>] [--project <dir>]');
      const result = copyStoreAsset({ projectDir: project, storeId: id, assetId: repository, out: option('--out', null), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify({ ...result, content: undefined }, null, 2));
      else console.log(`\n✓ copied verified ${result.asset.kind} ${id}/${repository} to ${displayPath(result.output)}\n`);
      return;
    }
    if (action === 'status' || action === 'list') {
      const report = action === 'list' ? readStoreState(project) : storeStatus(project, id ?? null);
      if (hasFlag('--json')) console.log(JSON.stringify(action === 'list' ? { ...report, stores: report.state?.stores ?? [] } : report, null, 2));
      else {
        const stores = action === 'list' ? report.state?.stores ?? [] : report.stores;
        console.log(`\nshared stores · ${displayPath(report.project)}\n`);
        for (const store of stores) console.log(`  ${store.ok === false ? '!' : '✓'} ${store.id.padEnd(20)} ${(store.title ?? '').slice(0, 45)}${store.commit ? ` · ${store.commit.slice(0, 12)}` : ''}`);
        for (const error of report.errors ?? []) console.log(`  ✗ ${error}`);
        if (action === 'status') for (const store of stores) for (const drift of store.drift ?? []) console.log(`  ! ${store.id}: ${drift}`);
        console.log(`\n${report.ok === false ? 'FAIL' : 'PASS'} · ${stores.length} locked store(s)\n`);
      }
      if (report.ok === false) process.exit(1);
      return;
    }
    fail('Usage: vld store init|add|update|list|status|assets|copy');
  } catch (error) { fail(error.message); }
}

function runModule() {
  const [action = 'list', ids] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'list') {
      const catalogue = listModules();
      if (hasFlag('--json')) {
        console.log(JSON.stringify(catalogue, null, 2));
      } else {
        console.log('\nVLD capability modules\n');
        for (const module of catalogue.modules) {
          console.log(`  ${module.id.padEnd(14)} ${module.version.padEnd(8)} ${module.title}`);
          console.log(`  ${''.padEnd(14)} ${''.padEnd(8)} ${module.summary}`);
        }
        for (const error of catalogue.errors) console.log(`  ✗ ${error}`);
        console.log('');
      }
      if (catalogue.errors.length > 0) process.exit(1);
      return;
    }
    if (action === 'enable') {
      const result = enableModules({ projectDir: project, ids: ids ?? option('--modules', '') });
      if (hasFlag('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ modules ${result.changed ? 'updated' : 'already enabled'} in ${displayPath(result.project)}\n`);
        console.log(`  enabled  ${result.enabled.join(', ')}`);
        console.log(`  added    ${result.added.length ? result.added.join(', ') : 'none'}`);
        console.log(`  refreshed ${result.updated.length ? result.updated.join(', ') : 'none'}`);
        console.log(`  lock     ${displayPath(result.file)}\n`);
      }
      return;
    }
    if (action === 'status' || action === 'verify') {
      reportModuleStatus(moduleStatus(project), { json: hasFlag('--json'), verify: action === 'verify' });
      return;
    }
    fail('Usage: vld module list|enable <ids>|status|verify [--project <dir>]');
  } catch (error) {
    fail(error.message);
  }
}

function runBundle() {
  const [action = 'list', id] = positional;
  try {
    if (action === 'list') {
      const catalogue = listBundles();
      if (hasFlag('--json')) {
        console.log(JSON.stringify(catalogue, null, 2));
      } else {
        console.log('\nVLD starter bundles\n');
        for (const bundle of catalogue.bundles) {
          console.log(`  ${bundle.id.padEnd(22)} ${bundle.title}`);
          console.log(`  ${''.padEnd(22)} ${bundle.summary}`);
        }
        for (const error of catalogue.errors) console.log(`  ✗ ${error}`);
        console.log('');
      }
      if (catalogue.errors.length > 0) process.exit(1);
      return;
    }
    if (action === 'show') {
      if (!id) fail('Usage: vld bundle show <id>');
      console.log(JSON.stringify(getBundle(id), null, 2));
      return;
    }
    if (action === 'apply') {
      if (!id) fail('Usage: vld bundle apply <id> [--profile <file>] [--project <dir>] [--dry-run]');
      const result = applyBundle({
        id,
        projectDir: option('--project', '.'),
        profilePath: option('--profile', null),
        dryRun: hasFlag('--dry-run')
      });
      if (hasFlag('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n${result.dryRun ? '· would apply' : '✓ applied'} bundle ${result.bundle.id} to ${displayPath(result.project)}\n`);
        console.log(`  profile   ${displayPath(result.profilePath)} ${result.changed ? (result.dryRun ? '(would update)' : '(updated)') : '(unchanged)'}`);
        const additions = [
          ...result.changes.traits.map((item) => `trait:${item}`),
          ...result.changes.risks.map((item) => `risk:${item}=true`),
          ...result.changes.overlays.map((item) => `overlay:${item}`),
          ...result.changes.constraints.map((item) => `constraint:${item}`)
        ];
        console.log(`  additions ${additions.length ? additions.join(', ') : 'none'}`);
        console.log(`  modules   ${result.dryRun ? result.bundle.modules.join(', ') : result.modules.state.modules.map((entry) => entry.id).join(', ')}`);
        console.log(`  workflows ${result.workflows.join(', ')}`);
        console.log(`\nNext\n  vld agent install codex --project ${displayPath(result.project)}\n  vld workflow run discovery --project ${displayPath(result.project)} --profile ${displayPath(result.profilePath)}\n`);
      }
      return;
    }
    fail('Usage: vld bundle list|show <id>|apply <id>');
  } catch (error) {
    fail(error.message);
  }
}

function runAgent() {
  const [action = 'list', id] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'list') {
      const catalogue = listAdapters();
      if (hasFlag('--json')) {
        console.log(JSON.stringify(catalogue, null, 2));
      } else {
        console.log('\nVLD agent adapters\n');
        for (const adapter of catalogue.adapters) console.log(`  ${adapter.id.padEnd(18)} ${adapter.title} → ${adapter.target}`);
        for (const error of catalogue.errors) console.log(`  ✗ ${error}`);
        console.log('');
      }
      if (catalogue.errors.length > 0) process.exit(1);
      return;
    }
    if (action === 'install') {
      if (!id) fail('Usage: vld agent install <codex|claude-code|github-copilot> [--project <dir>]');
      const result = installAgent({ id, projectDir: project, force: hasFlag('--force') });
      if (hasFlag('--json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ installed ${result.adapter.title} in ${displayPath(result.project)}\n`);
        for (const file of result.files) console.log(`  ${file.changed ? 'written' : 'kept   '}  ${file.path}`);
        console.log(`\n  modules  ${result.modules.length ? result.modules.join(', ') : 'none enabled'}`);
        console.log(`  state    ${displayPath(result.stateFile)}\n`);
      }
      return;
    }
    if (action === 'status') {
      const status = agentStatus(project, id ?? null);
      if (hasFlag('--json')) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`\nagents · ${displayPath(status.project)}\n`);
        for (const adapter of status.adapters) {
          console.log(`  ${adapter.drift.length ? '!' : adapter.installed ? '✓' : '·'} ${adapter.id.padEnd(18)} ${adapter.installed ? 'installed' : 'not installed'}`);
          for (const drift of adapter.drift) console.log(`    ! ${drift}`);
        }
        for (const error of status.errors) console.log(`  ✗ ${error}`);
        console.log(`\n${status.ok ? 'PASS' : 'FAIL'}\n`);
      }
      if (!status.ok) process.exit(1);
      return;
    }
    fail('Usage: vld agent list|install <id>|status [id] [--project <dir>]');
  } catch (error) {
    fail(error.message);
  }
}

function printWorkflow(result, { preview = false } = {}) {
  console.log(`\nworkflow · ${result.workflow.id} — ${result.workflow.title}${preview ? ' (preview)' : ''}\n`);
  for (const step of result.steps ?? []) {
    const marker = step.status === 'complete' ? '✓' : step.status === 'ready' ? '→' : step.status === 'failed' ? '✗' : '·';
    console.log(`  ${marker} ${step.id.padEnd(22)} ${step.type.padEnd(14)} ${step.status}`);
    if (step.status === 'ready' && ['human-input', 'agent-handoff', 'approval'].includes(step.type)) {
      console.log(`    evidence required: vld workflow complete ${result.workflow.id} ${step.id} --evidence "…" --project ${displayPath(result.project)}`);
    }
  }
  for (const entry of result.executed ?? []) console.log(`  ${entry.status === 'complete' ? '✓' : '✗'} executed ${entry.id}: ${entry.evidence.type === 'command' ? entry.evidence.argv.join(' ') : entry.evidence.type}`);
  console.log('');
}

function runWorkflowCommand() {
  const [action = 'list', id, stepId] = positional;
  const project = option('--project', '.');
  const context = { profile: option('--profile', null), packet: option('--packet', null), repo: option('--repo', null) };
  try {
    if (action === 'list') {
      const catalogue = listWorkflows();
      if (hasFlag('--json')) console.log(JSON.stringify(catalogue, null, 2));
      else {
        console.log('\nVLD workflows\n');
        for (const workflow of catalogue.workflows) console.log(`  ${workflow.id.padEnd(22)} ${workflow.title}`);
        for (const error of catalogue.errors) console.log(`  ✗ ${error}`);
        console.log('');
      }
      if (catalogue.errors.length > 0) process.exit(1);
      return;
    }
    if (action === 'lint') {
      if (id) {
        const workflow = getWorkflow(id);
        const result = { workflows: [workflow], errors: [] };
        if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
        else console.log(`\nPASS · workflow ${workflow.id} is valid\n`);
      } else {
        const catalogue = listWorkflows();
        if (hasFlag('--json')) console.log(JSON.stringify(catalogue, null, 2));
        else console.log(`\n${catalogue.errors.length ? 'FAIL' : 'PASS'} · ${catalogue.workflows.length} workflow(s) checked\n`);
        if (catalogue.errors.length > 0) process.exit(1);
      }
      return;
    }
    if (action === 'run') {
      if (!id) fail('Usage: vld workflow run <id> [--execute] [--profile <file>] [--packet <dir>] [--project <dir>]');
      const result = runWorkflow({ id, projectDir: project, context, execute: hasFlag('--execute'), reset: hasFlag('--reset') });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else printWorkflow(result, { preview: !hasFlag('--execute') });
      if ((result.executed ?? []).some((entry) => entry.status === 'failed')) process.exit(1);
      return;
    }
    if (action === 'status') {
      if (!id) fail('Usage: vld workflow status <id> [--project <dir>]');
      const result = workflowStatus({ id, projectDir: project });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else printWorkflow(result);
      return;
    }
    if (action === 'complete') {
      if (!id || !stepId) fail('Usage: vld workflow complete <id> <step> --evidence <note> [--project <dir>]');
      const completed = completeWorkflowStep({ id, stepId, projectDir: project, evidence: option('--evidence', null) });
      const result = workflowStatus({ id, projectDir: project });
      if (hasFlag('--json')) console.log(JSON.stringify({ ...completed, steps: result.steps }, null, 2));
      else printWorkflow(result);
      return;
    }
    fail('Usage: vld workflow list|lint [id]|run|status|complete');
  } catch (error) {
    fail(error.message);
  }
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
  case 'artifact':
    runArtifact();
    break;
  case 'store':
    runStore();
    break;
  case 'module':
    runModule();
    break;
  case 'bundle':
    runBundle();
    break;
  case 'agent':
    runAgent();
    break;
  case 'workflow':
    runWorkflowCommand();
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
    console.log(`vibecode-like-a-dev ${VERSION}`);
    break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    console.log(USAGE);
    break;
  default:
    // Usage errors go to stderr: stdout stays clean so `vld ... | jq` never
    // receives a help page it cannot parse.
    console.error(`Unknown command "${command}".\n`);
    console.error(USAGE);
    process.exit(2);
}
