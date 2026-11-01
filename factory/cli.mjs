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
import { artifactStatus, initArtifact, listArtifacts, validateArtifact, verifyArtifacts } from './lib/artifacts.mjs';
import { agentStatus, installAgent, listAdapters } from './lib/agents.mjs';
import { applyBundle, getBundle, listBundles } from './lib/bundles.mjs';
import { CHANGE_TEMPLATE, applyChange, archiveChange, emitChange, planChange, verifyChange } from './lib/change.mjs';
import { emitPacket } from './lib/emit/index.mjs';
import { exportPacket } from './lib/exports.mjs';
import { buildIndex, loadIndex, writeIndex } from './lib/indexer.mjs';
import { enableModules, listModules, moduleStatus } from './lib/modules.mjs';
import { createMission, missionStatus, readMission, validateMission } from './lib/missions.mjs';
import { addCatalog, catalogStatus, copyCatalogPayload, previewCatalogRefresh, readCatalogState, refreshCatalog, trustCatalogRoot } from './lib/catalog.mjs';
import { addStore, copyStoreAsset, initStore, previewStoreRefresh, readStoreState, refreshStore, storeStatus } from './lib/stores.mjs';
import { createWorkspace, recoverWorkspaces, removeWorkspace, workspaceStatus } from './lib/workspaces.mjs';
import { allocateRuntimePackage, heartbeatRuntimeLease, initializeRuntime, recoverRuntime, runtimeStatus, transitionRuntimePackage } from './lib/runtime.mjs';
import { exportRuntimeForgePlan, prepareRuntimeForgePlan, writeRuntimeForgePlan } from './lib/runtime-forge.mjs';
import { runRuntimeAgent, runtimeAgentStatus } from './lib/runtime-agent.mjs';
import { approveRuntimeDeliveryCandidate, queueRuntimeDeliveryCandidate, runtimeDeliveryStatus, submitRuntimeDeliveryCandidate, verifyRuntimeDeliveryCandidate } from './lib/runtime-delivery.mjs';
import { createRuntimeServer, listenRuntimeServer } from './lib/runtime-server.mjs';
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
  '--project', '--modules', '--evidence', '--file', '--ref', '--title', '--from-store', '--types', '--acknowledge', '--target',
  '--assignee', '--lease-ms', '--run', '--lease-token', '--to', '--actor', '--expected-version', '--port', '--token', '--policy', '--sha', '--adapter-run', '--candidate', '--reason', '--repository', '--head-ref', '--base-ref', '--checks'
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
  vld change verify <change-dir> [--project <dir>]
                                     validate a change proposal, reviewed evidence links and resulting manifest
  vld change archive <change-dir> <packet-dir> [--profile <p>]
                                     fold an applied change into the profile's overlay stack
  vld change init <dir>              write change.json to fill in
  vld artifact list|init|validate|verify|status <type> [id] [--from-store store/asset] [--project <dir>]
                                     generate, validate and cross-check product, architecture, delivery, review and QA artifacts
  vld export <spec-kit|kiro> <packet-dir> -o <dir> [--force]
                                     generate a bounded interoperability view; the VLD packet remains authoritative
  vld store init <dir> [--id <id>] | add <id> <git-url> | diff <id> | update <id> --acknowledge <commit>
                                     fetch, review, pin and verify read-only Git-backed shared delivery stores
  vld catalog trust <root.json> | add <id> <git-url> | diff <id> | update <id> --acknowledge <commit>
  vld catalog status [id] | copy <id> <package> <payload> --out <file>
                                     verify a threshold-signed, content-only catalog; it cannot execute or enable content
  vld module list|enable|status|verify [ids] [--project <dir>] [--json]
                                     manage version-locked optional delivery modules
  vld bundle list|show|apply <id> [--profile <file>] [--project <dir>] [--dry-run]
                                     apply a conservative profile/module starter bundle
  vld agent list|install|status [id] [--project <dir>] [--force] [--json]
                                     install or inspect generated Codex, Claude Code or Copilot handoffs
  vld workflow list|lint|run|status|complete <id> [step] [--project <dir>]
                                     typed resumable workflows; \`run\` previews unless --execute is supplied
  vld mission init <definition.json> --packet <dir> [--target HEAD] [--project <dir>] [-o <file>]
  vld mission validate|status <mission.json> [--project <dir>] [--json]
                                     freeze a verified packet and Git target into versioned work packages; no agent is run
  vld workspace create <mission.json> <package> [--project <dir>] [--json]
  vld workspace status|recover <mission.json> [--project <dir>] [--json]
  vld workspace remove <mission.json> <package> [--discard --acknowledge <workspace-id>] [--project <dir>]
                                     allocate, inspect, reconcile or safely remove one Git worktree; no agent is run
  vld runtime init|status|recover <mission.json> [--project <dir>] [--json]
  vld runtime allocate <mission.json> <package> --assignee <implementer-id> [--lease-ms <ms>] [--project <dir>] [--json]
  vld runtime heartbeat <mission.json> <package> --run <run-id> --lease-token <token> --actor implementer:<id> [--lease-ms <ms>]
  vld runtime transition <mission.json> <package> --to <state> --actor <role:id> --expected-version <n> [--lease-token <token>]
  vld runtime agent run <mission.json> <package> --policy <agent-policy.json> --lease-token <token> [--project <dir>] [--json]
  vld runtime agent status <mission.json> [--project <dir>] [--json]
                                     opt-in fake or one-declared-argv adapter; local processes are unconfined (no VLD write authority)
  vld runtime delivery submit <mission.json> <package> --policy <delivery-policy.json> --lease-token <token> --sha <commit> [--adapter-run <id>]
  vld runtime delivery verify <mission.json> <package> --policy <delivery-policy.json> [--project <dir>] [--json]
  vld runtime delivery approve <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor reviewer:<id> --reason <text>
  vld runtime delivery queue <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor release-approver:<id>
  vld runtime delivery status <mission.json> [--project <dir>] [--json]
                                     frozen candidate/packet verification, independent review and a local queue; no merge, push or forge access
  vld runtime forge plan-export <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch> [--base-ref <branch>] [--checks <name,...>] [--title <text>] [--out <file>] [--dry-run] [--json]
                                     derive a durable, offline GitHub v1 plan; never reads credentials, invokes gh, pushes, changes a PR, or requests merge
  vld runtime serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
                                     loopback-only Runtime API plus the local Studio dashboard; never starts an agent
  vld studio serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
                                     launch the same loopback Runtime API and accessible browser Studio; token stays in browser memory only
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
        console.log(`  evidence   ${result.evidence.artifacts} reviewed artifact link(s) archived from ${displayPath(result.evidence.file)}`);
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
    const report = verifyChange(second, { projectDir: option('--project', '.') });
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
    if (action === 'verify') {
      const report = verifyArtifacts({ projectDir: project, packetDir: option('--packet', null), kinds: option('--types', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`\nartifact verify · ${displayPath(report.project)}\n`);
        for (const pass of report.passes) console.log(`  ✓ ${pass}`);
        for (const warning of report.warnings) console.log(`  ! ${warning}`);
        for (const error of report.errors) console.log(`  ✗ ${error}`);
        console.log(`\n${report.ok ? 'PASS' : 'FAIL'} · ${report.artifacts.length} artifact(s) · ${report.requirements.length} packet requirement(s)\n`);
      }
      if (!report.ok) process.exit(1);
      return;
    }
    if (action === 'status') {
      const report = artifactStatus({ projectDir: project, packetDir: option('--packet', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else { console.log('\nartifacts\n'); for (const entry of report) console.log(`  ${entry.exists && entry.ok ? '✓' : entry.exists ? '!' : '·'} ${entry.id.padEnd(24)} ${entry.exists ? displayPath(entry.file) : 'not created'}`); console.log(''); }
      return;
    }
    fail('Usage: vld artifact list|init|validate|verify|status');
  } catch (error) { fail(error.message); }
}

function runExport() {
  const [format, packetDir] = positional;
  const out = option('-o', option('--out', null));
  if (!format || !packetDir || !out) fail('Usage: vld export <spec-kit|kiro> <packet-dir> -o <dir> [--force]');
  try {
    const result = exportPacket({ format, packetDir, outDir: out, force: hasFlag('--force') });
    if (hasFlag('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n✓ exported ${result.source.requirements} VLD requirements as a ${format} view\n`);
      console.log(`  output   ${displayPath(result.out)}`);
      console.log(`  manifest ${displayPath(result.manifest)}`);
      console.log('\n  This is generated, one-way interoperability. Edit VLD sources and export again; do not treat these files as requirement authority.\n');
    }
  } catch (error) { fail(error.message); }
}

function printStoreRefreshPreview(report, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const { current, next, changes } = report;
  console.log(`\nstore refresh preview · ${current.id}\n`);
  console.log(`  locked   ${current.commit}`);
  console.log(`  remote   ${next.commit}${changes.commitChanged ? '' : ' (unchanged)'}`);
  if (changes.metadata.length) console.log(`  metadata ${changes.metadata.join(', ')}`);
  for (const asset of changes.assets.added) console.log(`  + asset  ${asset.id} (${asset.kind})`);
  for (const asset of changes.assets.removed) console.log(`  - asset  ${asset.id} (${asset.kind})`);
  for (const asset of changes.assets.changed) console.log(`  ~ asset  ${asset.id} (${asset.fields.join(', ')})`);
  if (!changes.changed) {
    console.log('\n  No snapshot update. Project state was not changed.\n');
    return;
  }
  console.log(`\n  Project state was not changed. Review the remote commit and asset digest changes, then run:\n  vld store update ${current.id} --acknowledge ${next.commit} --project ${displayPath(report.project)}\n`);
}

function runStore() {
  const [action = 'status', id, third] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'init') {
      const result = initStore({ directory: id, id: option('--id', null), title: option('--title', null), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ wrote ${result.manifest}\n\nCommit the manifest and its declared Markdown assets before another project consumes it.\n`);
      return;
    }
    if (action === 'add') {
      if (!id || !third) fail('Usage: vld store add <id> <git-url> [--ref <branch|tag>] [--project <dir>]');
      const result = addStore({ projectDir: project, id, repository: third, ref: option('--ref', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ pinned store ${result.store.id} at ${result.store.commit}\n  ${result.store.assets.length} declared asset(s) · ${displayPath(result.file)}\n`);
      return;
    }
    if (action === 'diff') {
      if (!id) fail('Usage: vld store diff <id> [--project <dir>]');
      printStoreRefreshPreview(previewStoreRefresh({ projectDir: project, id }), { json: hasFlag('--json') });
      return;
    }
    if (action === 'update') {
      if (!id) fail('Usage: vld store update <id> --acknowledge <full-commit> [--project <dir>]');
      const result = refreshStore({ projectDir: project, id, acknowledge: option('--acknowledge', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else if (result.unchanged) console.log(`\n✓ store ${result.store.id} is already pinned at ${result.store.commit}; no state changed.\n`);
      else console.log(`\n✓ refreshed store ${result.store.id} at ${result.store.commit}\n  acknowledgement ${result.store.acknowledgedCommit} recorded in ${displayPath(result.file)}\n`);
      return;
    }
    if (action === 'assets') {
      if (!id) fail('Usage: vld store assets <id> [--project <dir>]');
      const report = storeStatus(project, id);
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else {
        const store = report.stores[0];
        console.log(`\nstore assets · ${id}\n`);
        for (const asset of store?.assets ?? []) console.log(`  ${asset.id.padEnd(26)} ${asset.kind}${asset.artifact ? ` · ${asset.artifact}` : ''} · ${asset.file}`);
        for (const error of report.errors) console.log(`  ✗ ${error}`);
        for (const drift of store?.drift ?? []) console.log(`  ! ${drift}`);
        console.log(`\n${report.ok ? 'PASS' : 'FAIL'}\n`);
      }
      if (!report.ok) process.exit(1);
      return;
    }
    if (action === 'copy') {
      if (!id || !third) fail('Usage: vld store copy <id> <asset-id> [--out <file>] [--project <dir>]');
      const result = copyStoreAsset({ projectDir: project, storeId: id, assetId: third, out: option('--out', null), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify({ ...result, content: undefined }, null, 2));
      else console.log(`\n✓ copied verified ${id}/${third} to ${displayPath(result.output)}\n`);
      return;
    }
    if (action === 'list' || action === 'status') {
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
    fail('Usage: vld store init|add|diff|update|list|status|assets|copy');
  } catch (error) { fail(error.message); }
}

function printCatalogRefreshPreview(report, { json = false } = {}) {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  const { current, next, changes } = report;
  console.log(`\ncatalog refresh preview · ${current.id}\n`);
  console.log(`  locked   ${current.commit}`);
  console.log(`  remote   ${next.commit}${changes.commitChanged ? '' : ' (unchanged)'}`);
  console.log(`  root     ${next.rootDigest.slice(0, 16)}…`);
  for (const item of changes.added) console.log(`  + package ${item.name}@${item.version}`);
  for (const item of changes.removed) console.log(`  - package ${item.name}@${item.version}`);
  for (const item of changes.changedPackages) console.log(`  ~ package ${item.name}@${item.version}`);
  if (!changes.changed) console.log('\n  No catalog update. Project state was not changed.\n');
  else console.log(`\n  Project state was not changed. Review signed metadata and payload digest changes, then run:\n  vld catalog update ${current.id} --acknowledge ${next.commit} --project ${displayPath(report.project)}\n`);
}

function runCatalog() {
  const [action = 'status', id, third, fourth] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'trust') {
      if (!id) fail('Usage: vld catalog trust <root.json> [--acknowledge <root-digest>] [--project <dir>]');
      const result = trustCatalogRoot({ projectDir: project, rootFile: id, acknowledge: option('--acknowledge', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ ${result.changed ? 'trusted' : 'already trusted'} catalog root v${result.root.version} · ${result.root.digest}\n`);
      return;
    }
    if (action === 'add') {
      if (!id || !third) fail('Usage: vld catalog add <id> <git-url> [--ref <branch|tag>] [--project <dir>]');
      const result = addCatalog({ projectDir: project, id, repository: third, ref: option('--ref', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ pinned signed catalog ${result.catalog.id} at ${result.catalog.commit}\n  ${result.catalog.packages.length} verified content-only package(s) · ${displayPath(result.file)}\n`);
      return;
    }
    if (action === 'diff') {
      if (!id) fail('Usage: vld catalog diff <id> [--project <dir>]');
      printCatalogRefreshPreview(previewCatalogRefresh({ projectDir: project, id }), { json: hasFlag('--json') });
      return;
    }
    if (action === 'update') {
      if (!id) fail('Usage: vld catalog update <id> --acknowledge <full-commit> [--project <dir>]');
      const result = refreshCatalog({ projectDir: project, id, acknowledge: option('--acknowledge', null) });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else if (result.unchanged) console.log(`\n✓ catalog ${result.catalog.id} is already pinned at ${result.catalog.commit}; no state changed.\n`);
      else console.log(`\n✓ refreshed catalog ${result.catalog.id} at ${result.catalog.commit}\n  acknowledgement ${result.catalog.acknowledgedCommit} recorded in ${displayPath(result.file)}\n`);
      return;
    }
    if (action === 'copy') {
      if (!id || !third || !fourth) fail('Usage: vld catalog copy <id> <package> <payload> --out <file> [--project <dir>]');
      const result = copyCatalogPayload({ projectDir: project, catalogId: id, packageName: third, payloadId: fourth, out: option('--out', null), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify({ ...result, source: undefined }, null, 2));
      else console.log(`\n✓ copied verified ${id}/${third}/${fourth} to ${displayPath(result.output)}\n  publisher ${result.provenance.publisher} · digest ${result.provenance.payloadDigest}\n`);
      return;
    }
    if (action === 'list' || action === 'status') {
      const report = action === 'list' ? readCatalogState(project) : catalogStatus(project, id ?? null);
      if (hasFlag('--json')) console.log(JSON.stringify(action === 'list' ? { ...report, catalogs: report.state?.catalogs ?? [] } : report, null, 2));
      else {
        const catalogs = action === 'list' ? report.state?.catalogs ?? [] : report.catalogs;
        console.log(`\nsigned content catalogs · ${displayPath(report.project)}\n`);
        for (const catalog of catalogs) console.log(`  ${catalog.ok === false ? '!' : '✓'} ${catalog.id.padEnd(20)} ${catalog.commit ? catalog.commit.slice(0, 12) : 'unlocked'} · ${(catalog.packages ?? []).length} package(s)`);
        for (const error of report.errors ?? []) console.log(`  ✗ ${error}`);
        if (action === 'status') for (const catalog of catalogs) for (const drift of catalog.drift ?? []) console.log(`  ! ${catalog.id}: ${drift}`);
        console.log(`\n${report.ok === false ? 'FAIL' : 'PASS'}\n`);
      }
      if (report.ok === false) process.exit(1);
      return;
    }
    fail('Usage: vld catalog trust|add|diff|update|list|status|copy');
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

function printMissionReport(label, report) {
  console.log(`\nmission ${label} · ${displayPath(report.file ?? '')}\n`);
  for (const pass of report.passes ?? []) console.log(`  ✓ ${pass}`);
  for (const stale of report.stale ?? []) {
    if (stale.kind === 'target') console.log(`  ! target moved: ${stale.expected} -> ${stale.actual}`);
    else if (stale.kind === 'target-unresolved') console.log(`  ! target cannot be resolved: ${stale.detail}`);
    else console.log(`  ! ${stale.kind} differs from the current project`);
  }
  for (const warning of report.warnings ?? []) console.log(`  ! ${warning}`);
  for (const error of report.errors ?? []) console.log(`  ✗ ${error}`);
  const requirements = report.requirements ? ` · ${report.requirements.assigned}/${report.requirements.total} requirements assigned` : '';
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}${requirements}\n`);
}

function runMission() {
  const [action, file] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'init') {
      if (!file) fail('Usage: vld mission init <definition.json> --packet <dir> [--target HEAD] [--project <dir>]');
      const packet = option('--packet', null);
      if (!packet) fail('mission init requires --packet <verified-packet-dir>');
      const target = option('--target', null);
      if (hasFlag('--target') && !target) fail('mission init --target requires a ref value');
      const definition = readMission(file, { projectDir: project }).mission;
      const result = createMission({
        definition,
        projectDir: project,
        packetDir: packet,
        targetRef: target ?? 'HEAD',
        outFile: option('-o', option('--out', null)),
        force: hasFlag('--force')
      });
      const output = { ok: true, file: result.file, mission: result.mission, digest: result.digest, warnings: result.warnings, passes: result.passes };
      if (hasFlag('--json')) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`\n✓ wrote ${displayPath(result.file)}\n`);
        console.log(`  packet    ${result.mission.packet.path} @ ${result.mission.packet.digest}`);
        console.log(`  target    ${result.mission.target.ref} @ ${result.mission.target.commit}`);
        console.log(`  packages  ${result.mission.workPackages.length} · ${result.mission.workPackages.reduce((count, workPackage) => count + workPackage.requirements.length, 0)} requirement assignments`);
        for (const warning of result.warnings) console.log(`  ! ${warning}`);
        console.log(`\nNext\n  vld mission status ${displayPath(result.file)} --project ${displayPath(path.resolve(project))}\n`);
      }
      return;
    }
    if (action === 'validate') {
      if (!file) fail('Usage: vld mission validate <mission.json> [--project <dir>]');
      const loaded = readMission(file, { projectDir: project });
      const report = { ...validateMission(loaded.mission, { projectDir: loaded.project }), file: loaded.file };
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else printMissionReport('validate', report);
      process.exit(report.ok ? 0 : 1);
    }
    if (action === 'status') {
      if (!file) fail('Usage: vld mission status <mission.json> [--project <dir>]');
      const report = missionStatus({ file, projectDir: project });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else printMissionReport('status', report);
      process.exit(report.ok ? 0 : 1);
    }
    fail('Usage: vld mission init|validate|status <definition-or-mission.json>');
  } catch (error) {
    fail(error.message);
  }
}

function printWorkspaceReport(action, report) {
  console.log(`\nworkspace ${action} · ${report.mission?.id ?? report.allocation?.missionId ?? ''}\n`);
  if (report.allocation) {
    console.log(`  package   ${report.allocation.packageId}`);
    console.log(`  branch    ${report.allocation.branch}`);
    console.log(`  worktree  ${report.allocation.worktree}`);
    if (report.changed === false) console.log('  status    already allocated; no Git state changed');
    if (report.discarded) console.log('  removal   discarded after exact workspace acknowledgement');
  }
  for (const entry of report.packageStatus ?? []) {
    console.log(`  ${entry.status.state === 'healthy' ? '✓' : entry.status.state === 'unallocated' ? '·' : '!'} ${entry.id.padEnd(20)} ${entry.status.state}${entry.status.detail ? ` — ${entry.status.detail}` : ''}`);
  }
  if (report.recoveredLock) console.log(`  ✓ removed stale lock ${report.recoveredLock.directory}`);
  for (const entry of report.finalized ?? []) console.log(`  ✓ finalized interrupted removal ${entry.id}${entry.branchRetained ? ' (branch retained)' : ''}`);
  for (const id of report.reset ?? []) console.log(`  ✓ restored interrupted removal ${id}`);
  for (const warning of report.warnings ?? []) console.log(`  ! ${warning}`);
  for (const error of report.errors ?? []) console.log(`  ✗ ${error}`);
  console.log(`\n${report.ok === false ? 'FAIL' : 'PASS'}\n`);
}

function runWorkspace() {
  const [action, missionFile, packageId] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'create') {
      if (!missionFile || !packageId) fail('Usage: vld workspace create <mission.json> <package> [--project <dir>]');
      const result = createWorkspace({ missionFile, packageId, projectDir: project });
      if (hasFlag('--json')) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printWorkspaceReport('create', { ok: true, ...result });
      return;
    }
    if (action === 'status') {
      if (!missionFile) fail('Usage: vld workspace status <mission.json> [--project <dir>]');
      const report = workspaceStatus({ missionFile, projectDir: project });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else printWorkspaceReport('status', report);
      process.exit(report.ok ? 0 : 1);
    }
    if (action === 'recover') {
      if (!missionFile) fail('Usage: vld workspace recover <mission.json> [--project <dir>]');
      const report = recoverWorkspaces({ missionFile, projectDir: project });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else printWorkspaceReport('recover', report);
      process.exit(report.ok ? 0 : 1);
    }
    if (action === 'remove') {
      if (!missionFile || !packageId) fail('Usage: vld workspace remove <mission.json> <package> [--discard --acknowledge <workspace-id>] [--project <dir>]');
      const result = removeWorkspace({
        missionFile,
        packageId,
        projectDir: project,
        discard: hasFlag('--discard'),
        acknowledge: option('--acknowledge', null)
      });
      if (hasFlag('--json')) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printWorkspaceReport('remove', { ok: true, ...result });
      return;
    }
    fail('Usage: vld workspace create|status|recover|remove <mission.json> [package]');
  } catch (error) {
    fail(error.message);
  }
}

function runtimeActor(value, fallback = null) {
  if (!value && fallback) return fallback;
  if (typeof value !== 'string') fail('runtime actor must use role:id');
  const match = /^([a-z-]+):([a-z0-9][a-z0-9-]{1,60})$/.exec(value);
  if (!match) fail('runtime actor must use role:id with lowercase kebab-case id');
  return { role: match[1], id: match[2] };
}

function integerOption(name, fallback = null) {
  const value = option(name, fallback === null ? null : String(fallback));
  if (value === null || value === undefined) return null;
  if (!/^\d+$/.test(value)) fail(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} is outside the supported integer range`);
  return parsed;
}

function printRuntimeReport(action, report) {
  console.log(`\nruntime ${action} · ${report.runtime?.missionId ?? report.mission?.id ?? ''}\n`);
  for (const workPackage of report.packages ?? []) {
    console.log(`  ${workPackage.id.padEnd(20)} ${workPackage.state.padEnd(15)} v${workPackage.version}${workPackage.lease ? ` · lease until ${workPackage.lease.expiresAt}` : ''}`);
  }
  for (const warning of report.warnings ?? []) console.log(`  ! ${warning}`);
  if (report.recovered) {
    for (const id of report.recovered.expiredLeases ?? []) console.log(`  ! expired lease blocked ${id}`);
    if (report.recovered.pending?.action) console.log(`  ✓ ${report.recovered.pending.action}`);
    if (report.recovered.lock) console.log(`  ✓ removed stale lock for pid ${report.recovered.lock.pid ?? 'unknown'}`);
  }
  console.log(`\n${report.ok === false ? 'FAIL' : 'PASS'}\n`);
}

function startStudioServer({ missionFile, project, label = 'Runtime' }) {
  const token = option('--token', null);
  const identities = token ? { [token]: { role: 'operator', id: 'local-operator' } } : undefined;
  const { server, tokens } = createRuntimeServer({ missionFile, projectDir: project, identities });
  listenRuntimeServer(server, { host: '127.0.0.1', port: integerOption('--port', 0) })
    .then((address) => {
      const operatorToken = tokens.find((entry) => entry.actor.role === 'operator');
      console.error(`VLD ${label} API · http://${address.host}:${address.port}/v1/runtime · loopback only`);
      console.error(`VLD Studio · http://${address.host}:${address.port}/studio`);
      console.error(`Local operator token (shown once; paste it into Studio): ${operatorToken.token}`);
    })
    .catch((error) => fail(error.message));
}

function runStudio() {
  try {
    const [action, missionFile] = positional;
    const project = option('--project', '.');
    if (action !== 'serve' || !missionFile) fail('Usage: vld studio serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]');
    startStudioServer({ missionFile, project, label: 'Studio Runtime' });
  } catch (error) {
    fail(error.message);
  }
}

async function runRuntime() {
  const [action, missionFile, packageId] = positional;
  const project = option('--project', '.');
  const json = hasFlag('--json');
  try {
    if (action === 'delivery') {
      const [_, deliveryAction, deliveryMissionFile, deliveryPackageId] = positional;
      if (deliveryAction === 'status') {
        if (!deliveryMissionFile) fail('Usage: vld runtime delivery status <mission.json> [--project <dir>]');
        const result = runtimeDeliveryStatus({ missionFile: deliveryMissionFile, projectDir: project });
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          printRuntimeReport('delivery status', result);
          for (const entry of result.delivery) {
            const receipt = entry.candidate ?? entry.verification ?? entry.approval ?? entry.queue ?? entry.forge;
            const type = entry.candidate ? 'candidate' : entry.verification ? 'verification' : entry.approval ? 'approval' : entry.queue ? 'queue' : 'forge-plan';
            console.log(`  ${entry.packageId.padEnd(20)} ${type.padEnd(13)} ${receipt.id}`);
          }
        }
        process.exit(result.ok ? 0 : 1);
      }
      if (!['submit', 'verify', 'approve', 'queue'].includes(deliveryAction) || !deliveryMissionFile || !deliveryPackageId) {
        fail('Usage: vld runtime delivery submit|verify|approve|queue <mission.json> <package> --policy <delivery-policy.json>');
      }
      const policyFile = option('--policy', null);
      if (!policyFile) fail('runtime delivery requires --policy <delivery-policy.json>');
      let result;
      if (deliveryAction === 'submit') {
        const leaseToken = option('--lease-token', null);
        const candidateSha = option('--sha', null);
        if (!leaseToken || !candidateSha) fail('runtime delivery submit requires --lease-token and --sha');
        result = submitRuntimeDeliveryCandidate({ missionFile: deliveryMissionFile, packageId: deliveryPackageId, policyFile, leaseToken, candidateSha, adapterRunId: option('--adapter-run', null), projectDir: project });
      } else if (deliveryAction === 'verify') {
        result = verifyRuntimeDeliveryCandidate({ missionFile: deliveryMissionFile, packageId: deliveryPackageId, policyFile, projectDir: project });
      } else if (deliveryAction === 'approve') {
        const actor = runtimeActor(option('--actor', null));
        const candidateId = option('--candidate', null);
        const reason = option('--reason', null);
        if (!candidateId || !reason) fail('runtime delivery approve requires --candidate and --reason');
        result = approveRuntimeDeliveryCandidate({ missionFile: deliveryMissionFile, packageId: deliveryPackageId, policyFile, candidateId, actor, reason, projectDir: project });
      } else {
        const actor = runtimeActor(option('--actor', null));
        const candidateId = option('--candidate', null);
        if (!candidateId) fail('runtime delivery queue requires --candidate');
        result = queueRuntimeDeliveryCandidate({ missionFile: deliveryMissionFile, packageId: deliveryPackageId, policyFile, candidateId, actor, projectDir: project });
      }
      if (json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printRuntimeReport(`delivery ${deliveryAction}`, result.status);
      return;
    }
    if (action === 'forge') {
      const [_, forgeAction, forgeMissionFile, forgePackageId] = positional;
      if (forgeAction !== 'plan-export' || !forgeMissionFile || !forgePackageId) {
        fail('Usage: vld runtime forge plan-export <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch>');
      }
      const actor = runtimeActor(option('--actor', null));
      const candidateId = option('--candidate', null);
      const repository = option('--repository', null);
      const headRef = option('--head-ref', null);
      if (!candidateId || !repository || !headRef) fail('runtime forge plan-export requires --candidate, --repository and --head-ref');
      const request = {
        missionFile: forgeMissionFile,
        packageId: forgePackageId,
        candidateId,
        repository,
        headRef,
        baseRef: option('--base-ref', null),
        title: option('--title', undefined),
        requiredChecks: option('--checks', ''),
        projectDir: project
      };
      if (hasFlag('--dry-run')) {
        const prepared = prepareRuntimeForgePlan(request);
        const result = { ok: true, dryRun: true, plan: prepared.plan, proposedForgeReceipt: prepared.forge };
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const result = exportRuntimeForgePlan({ ...request, actor });
      const outFile = option('--out', null);
      const output = outFile ? writeRuntimeForgePlan({ projectDir: project, outFile, plan: result.plan }) : null;
      if (json) {
        console.log(JSON.stringify({ ok: true, ...result, ...(output ? { output } : {}) }, null, 2));
      } else if (!output) {
        // stdout is the reviewable plan itself when no local review file was requested.
        console.log(JSON.stringify(result.plan, null, 2));
      } else {
        printRuntimeReport('forge plan export', result.status);
        console.log(`  receipt   ${result.forge.id}`);
        console.log(`  plan      ${output.file} (${output.digest})`);
        console.log('  safe      offline only; no credential lookup, gh, network, push, PR update, or merge request\n');
      }
      return;
    }
    if (action === 'agent') {
      const [_, agentAction, agentMissionFile, agentPackageId] = positional;
      if (agentAction === 'status') {
        if (!agentMissionFile) fail('Usage: vld runtime agent status <mission.json> [--project <dir>]');
        const result = runtimeAgentStatus({ missionFile: agentMissionFile, projectDir: project });
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`\nruntime agent status · ${result.runtime.missionId}\n`);
          for (const agentRun of result.agentRuns) console.log(`  ${agentRun.packageId.padEnd(20)} ${agentRun.adapter.padEnd(14)} ${agentRun.outcome.padEnd(11)} ${agentRun.id}`);
          if (result.agentRuns.length === 0) console.log('  · no durable adapter receipts');
          for (const warning of result.warnings) console.log(`  ! ${warning}`);
          console.log(`\n${result.ok ? 'PASS' : 'FAIL'}\n`);
        }
        process.exit(result.ok ? 0 : 1);
      }
      if (agentAction === 'run') {
        if (!agentMissionFile || !agentPackageId) fail('Usage: vld runtime agent run <mission.json> <package> --policy <agent-policy.json> --lease-token <token>');
        const policyFile = option('--policy', null);
        const leaseToken = option('--lease-token', null);
        if (!policyFile || !leaseToken) fail('runtime agent run requires --policy and --lease-token');
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once('SIGINT', interrupt);
        try {
          const result = await runRuntimeAgent({ missionFile: agentMissionFile, packageId: agentPackageId, policyFile, leaseToken, projectDir: project, signal: controller.signal });
          if (json) console.log(JSON.stringify(result, null, 2));
          else {
            printRuntimeReport('agent run', result.status);
            console.log(`  adapter   ${result.agentRun.adapter}`);
            console.log(`  outcome   ${result.agentRun.outcome}`);
            console.log(`  receipt   ${result.agentRun.id}\n`);
          }
          process.exit(result.ok ? 0 : 1);
        } finally {
          process.removeListener('SIGINT', interrupt);
        }
      }
      fail('Usage: vld runtime agent run|status <mission.json> [package]');
    }
    if (action === 'init') {
      if (!missionFile) fail('Usage: vld runtime init <mission.json> [--project <dir>]');
      const result = initializeRuntime({ missionFile, projectDir: project });
      if (json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printRuntimeReport(result.changed ? 'init' : 'init (already initialized)', result.status);
      return;
    }
    if (action === 'status') {
      if (!missionFile) fail('Usage: vld runtime status <mission.json> [--project <dir>]');
      const result = runtimeStatus({ missionFile, projectDir: project });
      if (json) console.log(JSON.stringify(result, null, 2));
      else printRuntimeReport('status', result);
      process.exit(result.ok ? 0 : 1);
    }
    if (action === 'allocate') {
      if (!missionFile || !packageId) fail('Usage: vld runtime allocate <mission.json> <package> --assignee <implementer-id> [--lease-ms <ms>]');
      const assignee = option('--assignee', null);
      if (!assignee) fail('runtime allocate requires --assignee <implementer-id>');
      const leaseMs = integerOption('--lease-ms', 5 * 60 * 1_000);
      const result = allocateRuntimePackage({ missionFile, projectDir: project, packageId, assignee: { role: 'implementer', id: assignee }, leaseMs });
      if (json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else {
        printRuntimeReport('allocate', result.status);
        console.log(`  run       ${result.allocation.run.id}`);
        console.log(`  lease     ${result.allocation.lease.id}`);
        console.log(`  token     ${result.leaseToken}\n`);
        console.log('Store this one-time lease token securely; it is not persisted in the Runtime ledger.\n');
      }
      return;
    }
    if (action === 'heartbeat') {
      if (!missionFile || !packageId) fail('Usage: vld runtime heartbeat <mission.json> <package> --run <run-id> --lease-token <token> --actor implementer:<id>');
      const runId = option('--run', null); const leaseToken = option('--lease-token', null);
      if (!runId || !leaseToken) fail('runtime heartbeat requires --run and --lease-token');
      const actor = runtimeActor(option('--actor', null));
      const result = heartbeatRuntimeLease({ missionFile, projectDir: project, packageId, runId, leaseToken, actor, leaseMs: integerOption('--lease-ms', 5 * 60 * 1_000) });
      if (json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printRuntimeReport('heartbeat', result.status);
      return;
    }
    if (action === 'transition') {
      if (!missionFile || !packageId) fail('Usage: vld runtime transition <mission.json> <package> --to <state> --actor <role:id> --expected-version <n> [--lease-token <token>]');
      const to = option('--to', null);
      if (!to) fail('runtime transition requires --to <state>');
      const actor = runtimeActor(option('--actor', null));
      const expectedVersion = integerOption('--expected-version', null);
      if (expectedVersion === null) fail('runtime transition requires --expected-version <n>');
      const result = transitionRuntimePackage({ missionFile, projectDir: project, packageId, to, actor, expectedVersion, leaseToken: option('--lease-token', null) });
      if (json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printRuntimeReport('transition', result.status);
      return;
    }
    if (action === 'recover') {
      if (!missionFile) fail('Usage: vld runtime recover <mission.json> [--project <dir>]');
      const result = recoverRuntime({ missionFile, projectDir: project });
      if (json) console.log(JSON.stringify(result, null, 2));
      else printRuntimeReport('recover', result);
      process.exit(result.ok ? 0 : 1);
    }
    if (action === 'serve') {
      if (!missionFile) fail('Usage: vld runtime serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]');
      startStudioServer({ missionFile, project, label: 'Runtime' });
      return;
    }
    fail('Usage: vld runtime init|status|allocate|heartbeat|transition|delivery|recover|serve <mission.json> [package]');
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
  case 'export':
    runExport();
    break;
  case 'store':
    runStore();
    break;
  case 'catalog':
    runCatalog();
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
  case 'mission':
    runMission();
    break;
  case 'workspace':
    runWorkspace();
    break;
  case 'runtime':
    runRuntime().catch((error) => fail(error.message));
    break;
  case 'studio':
    runStudio();
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
