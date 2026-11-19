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

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `engines` is advisory: npm warns and nothing enforces it, which made the
 * documented "Node 22 or newer" a claim rather than a check. This has to run
 * before the rest of the CLI loads: ESM hoists every import, so a guard placed
 * after them would only execute once Node had already parsed (and possibly
 * rejected) modules that assume the newer runtime.
 *
 * Deliberately written in the oldest common syntax: if Node is too old to parse
 * this file at all, the failure belongs to Node, not to a product message.
 */
export const MINIMUM_NODE_MAJOR = 22;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(NODE_MAJOR) && NODE_MAJOR < MINIMUM_NODE_MAJOR) {
  process.stderr.write(
    `\n✗ vld requires Node ${MINIMUM_NODE_MAJOR} or newer; this is ${process.versions.node}.\n` +
      '  Install a supported release (https://nodejs.org) or run through npx with one.\n\n'
  );
  process.exit(2);
}

import { adoptRepo, isRemoteRepo, writeAdoptedProfile } from './lib/adopt.mjs';
import { artifactStatus, initArtifact, listArtifacts, validateArtifact, verifyArtifacts } from './lib/artifacts.mjs';
import { agentStatus, installAgent, listAdapters } from './lib/agents.mjs';
import { applyBundle, getBundle, listBundles } from './lib/bundles.mjs';
import { CHANGE_TEMPLATE, applyChange, archiveChange, emitChange, planChange, verifyChange } from './lib/change.mjs';
import { runPlannerAgent } from './agents/planner.mjs';
import { runReviewerAgent } from './agents/reviewer.mjs';
import { emitPacket } from './lib/emit/index.mjs';
import { exportPacket } from './lib/exports.mjs';
import { buildIndex, loadIndex, writeIndex } from './lib/indexer.mjs';
import { enableModules, listModules, moduleStatus } from './lib/modules.mjs';
import { createMission, missionStatus, readMission, rebaseMission, validateMission } from './lib/missions.mjs';
import { addCatalog, catalogStatus, copyCatalogPayload, previewCatalogRefresh, readCatalogState, refreshCatalog, trustCatalogRoot } from './lib/catalog.mjs';
import { addStore, copyStoreAsset, initStore, previewStoreRefresh, readStoreState, refreshStore, storeStatus } from './lib/stores.mjs';
import { createWorkspace, recoverWorkspaces, removeWorkspace, workspaceStatus } from './lib/workspaces.mjs';
import { allocateRuntimePackage, heartbeatRuntimeLease, initializeRuntime, recoverRuntime, runtimeEventHistory, runtimeStatus, transitionRuntimePackage } from './lib/runtime.mjs';
import { exportRuntimeForgePlan, prepareRuntimeForgePlan, writeRuntimeForgePlan, executeRuntimeForgePlan } from './lib/runtime-forge.mjs';
import { appendEvidence, configureTelemetry, exportEvidenceBundle, purgeTelemetry, telemetryStatus, verifyEvidenceChain } from './lib/evidence.mjs';
import { prepareReviewPacket, recordReviewDecision, validateReviewReport } from './lib/review.mjs';
import { detectSpecDrift, initSemanticOracles, scaffoldDriftWorkflow } from './lib/drift.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { migrateProject } from './lib/migrate.mjs';
import { runRuntimeAgent, runtimeAgentStatus } from './lib/runtime-agent.mjs';
import { approveRuntimeDeliveryCandidate, queueRuntimeDeliveryCandidate, recordRuntimeDeliveryReview, runtimeDeliveryStatus, submitRuntimeDeliveryCandidate, verifyRuntimeDeliveryCandidateAsync } from './lib/runtime-delivery.mjs';
import { runBuild } from './lib/build.mjs';
import { detectSandboxBackends, runSandboxConformance } from './lib/sandbox/index.mjs';
import { createRuntimeServer, listenRuntimeServer } from './lib/runtime-server.mjs';
import { createRuntimeClient } from './lib/runtime-client.mjs';
import { buildPlan, loadPolicy } from './lib/planner.mjs';
import { defaultedProductionTierFields, injectionFindings, loadProfile, KINDS, STAGES, SCALES, TRAITS, RISK_FLAGS, REGULATIONS } from './lib/profile.mjs';
import { acceptIntakeDraft, runIntake } from './lib/intake.mjs';
import { parseMutationReport, runMutationGate } from './lib/mutation-runner.mjs';
import { runRepositoryTests } from './lib/test-runner.mjs';
import { formatRuleLintFindings } from './lib/rule-lint.mjs';
import { scanAllIdeaCues, scanRiskHints } from './lib/risk-hints.mjs';
import { completeWorkflowStep, getWorkflow, listWorkflows, runWorkflow, workflowStatus } from './lib/workflows.mjs';
import { verifyPacket } from './lib/verify.mjs';
import { writeAbsoluteManagedFileAtomic } from './lib/extension-utils.mjs';
import { PACKAGE_VERSION } from './lib/version.mjs';

// The package manifest, loaded through the shared metadata authority, is the
// version advertised by every CLI surface.
const VERSION = PACKAGE_VERSION;

const argv = process.argv.slice(2);
// `vld experimental <command>` rewrites these before dispatch (BUG-9).
let command = argv[0];
let rest = argv.slice(1);

const hasFlag = (name) => rest.includes(name);
const option = (name, fallback) => {
  const index = rest.indexOf(name);
  return index === -1 || index === rest.length - 1 ? fallback : rest[index + 1];
};
const optionAll = (name) => {
  const out = [];
  for (let i = 0; i < rest.length - 1; i += 1) {
    if (rest[i] === name) out.push(rest[i + 1]);
  }
  return out;
};
const REPEATABLE_FLAGS = new Set(['--answer', '--waive', '--arg']);
const VALUE_FLAGS = new Set([
  '-o', '--out', '--repo', '--name', '--idea', '--profile', '--packet',
  '--project', '--modules', '--evidence', '--file', '--ref', '--title', '--from-store', '--types', '--acknowledge', '--target', '--packet-dir',
  '--assignee', '--lease-ms', '--run', '--lease-token', '--to', '--actor', '--expected-version', '--port', '--token', '--policy', '--sha', '--adapter-run', '--candidate', '--reason', '--repository', '--head-ref', '--base-ref', '--checks', '--id', '--runtime-url', '--runtime-token', '--request-id', '--after', '--limit', '--max-bytes', '--node', '--owner', '--expires',
  '--backend', '--adapter', '--executable', '--arg', '--mission', '--max-repairs', '--assign-added', '--test-cmd',
  '--action', '--pr', '--token-env', '--author', '--report', '--cron', '--kind', '--subject', '--format', '--from',
  '--provider', '--model', '--base-url', '--cassette', '--cassette-mode', '--answer', '--waive',
  '--budget-usd', '--max-tokens', '--concurrency', '--test-cmd', '--mutation-report', '--diff-base', '--reviewer-provider', '--reviewer-model', '--reviewer-id', '--requirements', '--api-url',
  '--mission-id', '--max-turns', '--max-chars'
]);
const isValueFlag = (token) => VALUE_FLAGS.has(token) && !(command === 'verify' && token === '--run');
const positional = rest.filter((item, index) => !item.startsWith('-') && !(index > 0 && isValueFlag(rest[index - 1])));

const USAGE = `vibecode like a dev — from one paragraph to a spec an agent can execute

Usage
  vld init <dir> [--interactive]     write profile.json (or build one via guided wizard)
  vld doctor [--project <dir>] [--packet <dir>] [--json]
                                     diagnose Node runtime, Git, sandbox backends, packet and audit chain
  vld migrate [--project <dir>] [--profile <file>] [--packet <dir>] [--dry-run] [--json]
                                     safely upgrade legacy profiles, runtime policies and packets to current VLD
  vld adopt <repo-or-url> [-o <file>] [--name <slug>] [--idea <text>] [--force] [--json]
                                     infer a profile from a local path or Git repository URL
  vld intake [idea] [--file <path>] [--offline] [--provider <id>] [--model <id>] [-o profile.draft.json]
                                     extract an evidence-grounded draft profile and <=7 questions from prose or stdin
  vld intake accept [profile.draft.json] [-o profile.json] [--answer k=v] [--waive flag:reason:date]
                                     promote a reviewed draft to a strict-ready profile.json with full provenance
  vld plan <profile.json> [--explain] [--json] [--advisory]
                                     strict by default: blocks unwaived risks, rule conflicts & defaulted production fields (--advisory downgrades to warnings)
  vld compile <profile.json> -o <dir> [--force] [--advisory] [--packet-dir <label>] [--lean]
                                     strict by default; --advisory permits unwaived warnings with an advisory banner
                                     --packet-dir overrides the directory name embedded in generated commands
                                     --lean emits AGENTS.md and spec.json only, for a token-budgeted reader
  vld ci init [--project <dir>] [--packet <dir>] [--node <version>] [--force]
                                     write the required pull-request check that runs the packet's enforcement
  vld verify <packet-dir> [--repo <path>] [--run] [--report <file>] [--require-report] [--mutation] [--strict] [--require-assertions] [--json]
                                     verify packet, AST non-tautological assertions, and executed test/mutation proof
  vld change <packet-dir> <change.json> -o <dir> [--apply] [--force] [--json] [--repo <dir>]
                                     render a delta spec for a brownfield change
  vld change verify <change-dir> [--project <dir>]
                                     validate a change proposal, reviewed evidence links and resulting manifest
  vld change archive <change-dir> <packet-dir> [--profile <p>] [--to-profile-rules]
                                     fold an applied change into the profile's overlay stack or profile.rules
  vld change init <dir>              write change.json to fill in
  vld artifact list|init|validate|verify|status <type> [id] [--from-store store/asset] [--project <dir>]
                                     generate, validate and cross-check product, architecture, delivery, review and QA artifacts
  vld discoverability-readiness init|validate [--project <dir>] [--profile <file>] [--packet <dir>] [--file <path>]
                                     locally link a human readiness record to an opted-in packet; advisory only, no crawler or provider claims
  vld export <spec-kit|kiro> <packet-dir> -o <dir> [--force]
                                     generate a bounded interoperability view; the VLD packet remains authoritative
  vld store init <directory> [--id <store-id>] | add <id> <git-url> | diff <id> | update <id> --acknowledge <commit> [--debug]
                                     fetch, review, pin and verify read-only Git-backed shared delivery stores; debug details are bounded and redacted
  vld catalog trust <root.json> | add <id> <git-url> | diff <id> | update <id> --acknowledge <commit> [--debug]
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
  vld mission plan <packet-dir> [-o <definition.json>] [--mission-id <id>] [--title <t>] [--offline] [--provider <id> --model <id>] [--cassette <dir> --cassette-mode <m>] [--max-turns <n>] [--max-chars <n>] [--json]
  vld mission init <definition.json> --packet <dir> [--target HEAD] [--project <dir>] [-o <file>]
  vld mission validate|status <mission.json> [--project <dir>] [--json]
                                     freeze a verified packet and Git target into versioned work packages; no agent is run
  vld workspace create <mission.json> <package> [--project <dir>] [--json]
  vld workspace status|recover <mission.json> [--project <dir>] [--json]
  vld workspace remove <mission.json> <package> [--discard --acknowledge <workspace-id>] [--project <dir>]
                                     allocate, inspect, reconcile or safely remove one Git worktree; no agent is run
  vld runtime init|status|recover <mission.json> [--project <dir>] [--json]
  vld runtime events <mission.json> --actor <role:id> [--after <sequence>] [--limit <1-100>] [--max-bytes <1024-65536>] [--project <dir>] [--json]
  vld runtime allocate <mission.json> <package> --assignee <implementer-id> [--lease-ms <ms>] [--project <dir>] [--json]
  vld runtime heartbeat <mission.json> <package> --run <run-id> --lease-token <token> --actor implementer:<id> [--lease-ms <ms>]
  vld runtime transition <mission.json> <package> --to <state> --actor <role:id> --expected-version <n> [--lease-token <token>]
  vld runtime agent run <mission.json> <package> --policy <agent-policy.json> --lease-token <token> [--project <dir>] [--json]
  vld runtime agent status <mission.json> [--project <dir>] [--json]
                                     opt-in fake or one-declared-argv adapter; local processes are unconfined (no VLD write authority)
  vld runtime delivery submit <mission.json> <package> --policy <delivery-policy.json> --lease-token <token> --sha <commit> [--adapter-run <id>]
  vld runtime delivery verify <mission.json> <package> --policy <delivery-policy.json> [--project <dir>] [--json]
  vld runtime delivery approve <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor reviewer:<id> --reason <text>
  vld runtime delivery review <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor reviewer:<id> [--rules | --report <review.json> --reviewer-model <provider:model>]
  vld runtime delivery queue <mission.json> <package> --policy <delivery-policy.json> --candidate <id> --actor release-approver:<id>
  vld runtime delivery status <mission.json> [--project <dir>] [--json]
                                     frozen candidate/packet verification, independent review and a local queue; no merge, push or forge access
  vld runtime forge plan-export <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch> [--base-ref <branch>] [--checks <name,...>] [--title <text>] [--out <file>] [--dry-run] [--json]
                                     derive a durable, offline GitHub v1 plan; never reads credentials, invokes gh, pushes, changes a PR, or requests merge
  vld runtime forge execute <mission.json> <package> --candidate <id> --actor release-approver:<id> --repository <owner/repo> --head-ref <branch> [--action publish|inspect|merge] [--pr <n>] [--allow-merge] [--token-env GITHUB_TOKEN] [--api-url <url>]
                                     opt-in governed GitHub v1 delivery using an explicit memory-only token; records hash-chained receipt
  vld review prepare|run|verify|record [--packet <dir>] [--project <dir>] [--report <review.json>] [--base-ref <ref>] [--head-ref <ref>] [--json]
                                     context-isolated six-category spec review and high-rigor human escalation
  vld drift check|init-workflow|init-oracles [--packet <dir>] [--project <dir>] [--base-ref <ref>] [--record] [--force] [--json]
                                     continuous specification-to-code drift checks, CI workflow, and semantic oracles
  vld evidence verify|export|append [--project <dir>] [--format json|markdown] [-o <file>] [--json]
                                     verify or export the tamper-evident SHA-256 hash-chained evidence ledger
  vld telemetry status|enable|disable|purge [--project <dir>] [--json]
                                     strictly opt-in local anonymous telemetry (disabled by default; zero automatic network calls)
  vld runtime serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
  vld runtime status|events|allocate|heartbeat|transition|recover [package] --runtime-url <https-url> --runtime-token <token> [--request-id <id>]
                                     explicit typed remote client; https required except loopback development
                                     loopback-only Runtime API plus the local Studio dashboard; never starts an agent
  vld studio serve <mission.json> [--port <0-65535>] [--token <local-token>] [--project <dir>]
                                     launch the same loopback Runtime API and accessible browser Studio; token stays in browser memory only
  vld mission rebase <mission.json> [--target <ref>] [--packet <dir>] [--assign-added <pkg>] [--drop-removed] [--dry-run] [--project <dir>] [--json]
                                     rebase a mission onto an updated target commit and/or recompiled packet without dropping coverage
  vld sandbox probe|conformance [--backend <auto|oci|bwrap|linux-ns|darwin-seatbelt|node-permission>] [--json]
                                     inspect host sandbox backends or execute the 8 live confinement probes (ADR 0011)
  vld build [--profile <file>] [--packet <dir>] [--mission <file>] [--mission-overrides <file>] [--adapter <sandboxed-cli|sandboxed-acp|sandboxed-agent|fake>] [--executable <path>] [--arg <value>] [--backend <id>] [--max-repairs <0-5>] [--gates] [--require-os] [--dry-run] [--project <dir>] [--model <provider:model>] [--cassette <dir>] [--cassette-mode <replay|record|auto|off>] [--test-cmd <json>] [--json]
                                     compile/verify spec, partition mission DAG, run sandboxed packages with bounded repair and emit build-report.json
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

function fail(message, error = null) {
  const debug = hasFlag('--debug') && error?.debug ? `\n\n  debug: ${error.debug}` : '';
  console.error(`\n✗ ${message}${debug}\n`);
  process.exit(2);
}

// A misspelled option used to be silently ignored because every command read the
// shared argv array opportunistically. Reject it before a command can perform a
// side effect; command-specific arity is checked by the command handlers below.
const BOOLEAN_FLAGS = new Set([
  '--apply', '--check', '--debug', '--discard', '--drop-removed', '--dry-run', '--execute', '--explain',
  '--force', '--gates', '--interactive', '--json', '--require-assertions', '--require-os', '--reset',
  '--strict', '--advisory', '--offline', '--accept-suggested', '--require-report', '--static-only', '--mutation',
  '--attest', '--draft', '--to-profile-rules', '--lean', '--allow-merge', '--no-comment', '--record',
  '--run', '--help', '-h'
]);
function validateCliTokens() {
  const seen = new Set();
  const canonical = (flag) => flag === '-o' ? '--out' : flag;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('-')) continue;
    const flag = canonical(token);
    if (seen.has(flag) && !REPEATABLE_FLAGS.has(flag)) fail(`option supplied more than once: ${flag}`);
    seen.add(flag);
    if (isValueFlag(token)) {
      const value = rest[index + 1];
      // Mission init gives --target a more precise public diagnostic ("ref value").
      // Preserve that command contract while every other value flag fails here.
      if (!value || value.startsWith('-')) {
        if (token === '--target') continue;
        fail(`requires ${token} value`);
      }
      index += 1;
    } else if (!BOOLEAN_FLAGS.has(token)) {
      fail(`unknown option: ${token}. Usage: vld ${command ?? '<command>'} …`);
    }
  }
}

function requirePositionals(usage, { min = 0, max = min } = {}) {
  if (positional.length < min || positional.length > max) fail(`Usage: ${usage}`);
}

// Command-specific allowlists cover the public compiler commands whose output is
// routinely piped by people and automation. Extension families retain their own
// subcommand validation while this parser rejects every unknown token globally.
const TOP_LEVEL_FLAGS = {
  init: new Set(['--interactive', '--force']),
  intake: new Set([
    '-o', '--out', '--file', '--name', '--project', '--report', '--offline',
    '--provider', '--model', '--token-env', '--base-url', '--cassette', '--cassette-mode',
    '--answer', '--waive', '--accept-suggested', '--budget-usd', '--max-tokens', '--force', '--json'
  ]),
  doctor: new Set(['--project', '--profile', '--packet', '--json']),
  migrate: new Set(['--project', '--profile', '--packet', '--dry-run', '--json']),
  adopt: new Set(['-o', '--out', '--name', '--idea', '--force', '--json']),
  plan: new Set(['--explain', '--json', '--strict', '--advisory']),
  compile: new Set(['-o', '--out', '--force', '--strict', '--advisory', '--packet-dir', '--lean']),
  verify: new Set(['--repo', '--strict', '--require-assertions', '--run', '--report', '--require-report', '--test-cmd', '--mutation', '--mutation-report', '--backend', '--static-only', '--gates', '--json']),
  ci: new Set(['--project', '--packet', '--node', '--force']),
  index: new Set(['--check']),
  mcp: new Set()
};
function validateTopLevelFlags() {
  const allowed = TOP_LEVEL_FLAGS[command];
  if (!allowed) return;
  for (const token of rest) if (token.startsWith('-') && !allowed.has(token)) fail(`option is not supported by vld ${command}: ${token}`);
}

/** Requirement ids already handed out by an existing packet, so they survive a catalog change. */
function previousRequirementIds(packetDir) {
  if (!packetDir || !existsSync(path.join(packetDir, 'spec.json'))) return {};
  try {
    const previous = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
    const ids = Object.fromEntries((previous.requirements ?? []).map((requirement) => [requirement.key, requirement.id]));
    const historyFile = path.join(packetDir, 'changes', 'history.json');
    if (existsSync(historyFile)) {
      const history = JSON.parse(readFileSync(historyFile, 'utf8'));
      for (const entry of history.retiredRequirementIds ?? []) {
        if (/^REQ-\d{3,}$/.test(String(entry?.id ?? ''))) ids[`__retired__${entry.id}`] = entry.id;
      }
    }
    return ids;
  } catch {
    // Preserve the existing non-destructive behavior for a malformed predecessor;
    // packet verification still reports it, while an absent history is harmless.
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

  if (plan.explain) {
    lines.push('');
    lines.push('explain · signal & vocabulary trace:');
    lines.push(`  fired signals (${rigor.signals.length}):`);
    if (rigor.signals.length === 0) lines.push('    (none)');
    for (const sig of rigor.signals) lines.push(`    + ${sig.field ?? 'predicate'} (+${sig.weight}): ${sig.label}`);
    const rh = plan.explain.riskHints ?? plan.riskHints;
    if (rh) {
      lines.push(`  unflagged risk cues (${rh.unflaggedRisks.length}):`);
      if (rh.unflaggedRisks.length === 0) lines.push('    (none)');
      for (const hit of rh.unflaggedRisks) {
        lines.push(`    ! risks.${hit.flag} <- "${hit.phrase}" (${hit.cue})${hit.expiredWaiver ? ` [waiver expired ${hit.expiredWaiver}]` : ''}`);
      }
      lines.push(`  waived risk cues (${rh.waivedRisks.length}):`);
      if (rh.waivedRisks.length === 0) lines.push('    (none)');
      for (const w of rh.waivedRisks) {
        lines.push(`    ~ risks.${w.flag} <- "${w.phrase}" (waived until ${w.expires}: ${w.reason})`);
      }
      lines.push(`  suggested regimes (${rh.suggestedRegimes.length}):`);
      if (rh.suggestedRegimes.length === 0) lines.push('    (none)');
      for (const reg of rh.suggestedRegimes) {
        lines.push(`    * regulation "${reg.regime}" <- "${reg.phrase}"`);
      }
    }
    if (plan.vocabulary) {
      lines.push(
        `  domain noun: "${plan.vocabulary.primary}" (actor: "${plan.vocabulary.secondary}") · source=${plan.vocabulary.source} · confidence=${plan.vocabulary.confidence.toFixed(2)}` +
          `${plan.vocabulary.candidates.length ? ` · candidates=[${plan.vocabulary.candidates.join(', ')}]` : ''}`
      );
    }
    const rl = plan.explain.ruleLint ?? plan.ruleLint;
    if (rl) {
      const unresolved = [...(rl.contradictions ?? []), ...(rl.infeasible ?? [])];
      lines.push(`  rule lint (${rl.rulesChecked} rule(s) checked · ${unresolved.length} blocking · ${(rl.duplicates ?? []).length} duplicate/subsumed):`);
      if (unresolved.length === 0 && (rl.resolvedConflicts ?? []).length === 0 && (rl.duplicates ?? []).length === 0) {
        lines.push('    (clean)');
      }
      for (const c of unresolved) lines.push(`    ✗ ${c.reason}`);
      for (const r of rl.resolvedConflicts ?? []) lines.push(`    ✓ ${r.label} resolved -> winner ${r.winner} (${r.resolutionReason})`);
      for (const d of rl.duplicates ?? []) lines.push(`    ! ${d.label}: ${d.reason}`);
    }
    const prov = plan.explain.provenance ?? plan.provenance;
    if (prov) {
      lines.push('  field provenance (user | inferred | default | waived):');
      for (const [field, src] of Object.entries(prov)) {
        lines.push(`    ${field.padEnd(22)} ${src}`);
      }
    }
  }

  lines.push('');
  lines.push(`next      vld compile ${positional[0] ?? '<profile.json>'} -o spec`);
  lines.push('');
  console.log(lines.join('\n'));
}

async function runInit(dir) {
  requirePositionals('vld init <dir> [--interactive]', { min: 1 });
  if (!dir) fail('Missing directory. Usage: vld init <dir> [--interactive]');
  const target = path.resolve(dir);
  const file = path.join(target, 'profile.json');
  let template = structuredClone(PROFILE_TEMPLATE);

  if (hasFlag('--interactive')) {
    let rl = null;
    let scriptedLines = null;
    let lineCursor = 0;
    if (process.stdin.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      rl = createInterface({ input: process.stdin, output: process.stdout });
    } else {
      try { scriptedLines = readFileSync(0, 'utf8').split(/\r?\n/); } catch { scriptedLines = []; }
    }
    const ask = async (label, fallback) => {
      if (scriptedLines !== null) {
        const raw = String(scriptedLines[lineCursor++] ?? '').trim();
        return raw || fallback;
      }
      try {
        const raw = (await rl.question(`  ${label} [${fallback}]: `)).trim();
        return raw || fallback;
      } catch {
        return fallback;
      }
    };
    try {
      delete template.$help;
      console.log('\nvibecode like a dev · interactive project setup\n');
      const defaultSlug = path.basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'my-project';
      template.name = await ask('Project slug', defaultSlug);
      template.idea = await ask('One-paragraph idea (who, what, instead of what)', template.idea);
      const kindAns = await ask(`Kind (${KINDS.join('|')})`, 'web-app');
      template.kind = KINDS.includes(kindAns) ? kindAns : 'web-app';
      const stageAns = await ask(`Stage (${STAGES.join('|')})`, 'mvp');
      template.stage = STAGES.includes(stageAns) ? stageAns : 'mvp';
      const scaleAns = await ask(`User scale (${SCALES.join('|')})`, 'small');
      template.users = { scale: SCALES.includes(scaleAns) ? scaleAns : 'small' };
      const stackAns = await ask('Primary stack (typescript|javascript|python|go|rust|java|kotlin|csharp|ruby|php|undecided)', 'typescript');
      template.constraints.stack = stackAns;
      const traitsAns = await ask(`Traits comma-separated (${TRAITS.slice(0, 6).join(',')}…)`, '');
      template.traits = traitsAns.split(',').map((t) => t.trim()).filter((t) => TRAITS.includes(t));
      const piiAns = await ask('Stores personal data (PII)? (y/n)', 'n');
      template.risks.pii = /^y/i.test(piiAns);
      const payAns = await ask('Moves money or processes payments? (y/n)', 'n');
      template.risks.payments = /^y/i.test(payAns);
      // Roadmap P1.2: ask targeted inline risk & regime questions for every cue detected in the idea.
      const detected = scanAllIdeaCues(template.idea);
      template.provenance = {
        kind: 'user',
        stage: 'user',
        'users.scale': 'user',
        traits: 'user',
        'constraints.stack': 'user',
        'risks.pii': 'user',
        'risks.payments': 'user'
      };
      for (const hit of detected.risks) {
        if (template.risks[hit.flag] === true) continue;
        const ans = await ask(`Idea mentions "${hit.phrase}" — enable risks.${hit.flag}=true? (y/n)`, 'y');
        template.risks[hit.flag] = /^y/i.test(ans);
        template.provenance[`risks.${hit.flag}`] = 'user';
      }
      for (const flag of RISK_FLAGS) {
        if (!template.provenance[`risks.${flag}`]) template.provenance[`risks.${flag}`] = 'user';
      }
      const suggestedRegs = detected.regimes.map((r) => r.regime).join(',');
      const regAns = await ask(`Regulatory overlays comma-separated (${REGULATIONS.join(',')})`, suggestedRegs);
      const regs = regAns.split(',').map((r) => r.trim().toLowerCase()).filter((r) => REGULATIONS.includes(r));
      if (regs.length > 0) {
        template.risks.regulated = true;
        template.regulation = regs;
        template.provenance.regulation = 'user';
      }
    } finally {
      if (rl) rl.close();
    }
  }

  try {
    writeAbsoluteManagedFileAtomic(file, `${JSON.stringify(template, null, 2)}\n`, { overwrite: hasFlag('--force'), label: 'initial profile' });
  } catch (error) {
    if (error.code === 'MANAGED_FILE_EXISTS') fail(`${file} already exists; refusing to overwrite`);
    fail(error.message);
  }

  const hints = hasFlag('--interactive') ? scanRiskHints(template) : null;
  console.log(`\n✓ wrote ${file}`);
  for (const h of hints?.unflaggedRisks ?? []) console.log(`  ! hint: idea mentions "${h.phrase}" — set risks.${h.flag}=true or record a riskWaivers entry`);
  console.log(`\nFill in or refine fields, then:\n  vld plan ${path.relative(process.cwd(), file) || 'profile.json'}\n  vld compile ${path.relative(process.cwd(), file) || 'profile.json'} -o specs\n`);
}

function runDoctorCommand() {
  const report = runDoctor({
    projectDir: option('--project', '.'),
    profileFile: option('--profile', 'profile.json'),
    packetDir: option('--packet', 'specs')
  });
  if (hasFlag('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nvld doctor · v${report.version} · ${report.platform}/${report.arch}\n`);
    for (const check of report.checks) {
      const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : check.status === 'fail' ? '✗' : '·';
      console.log(`  ${icon} ${check.id.padEnd(16)} ${check.detail}`);
      if (check.remediation) console.log(`                     → ${check.remediation}`);
    }
    console.log(`\n${report.ok ? 'PASS' : 'FAIL'} · ${report.failures} failure(s) · ${report.warnings} warning(s)\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

function runMigrateCommand() {
  try {
    const report = migrateProject({
      projectDir: option('--project', '.'),
      profileFile: option('--profile', 'profile.json'),
      packetDir: option('--packet', 'specs'),
      dryRun: hasFlag('--dry-run')
    });
    if (hasFlag('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\nvld migrate · target v${report.targetVersion}${report.dryRun ? ' (dry-run)' : ''}\n`);
      for (const action of report.actions) {
        const icon = action.kind === 'up-to-date' ? '·' : '✓';
        console.log(`  ${icon} ${action.target.padEnd(26)} ${action.kind}`);
        for (const c of action.changes) console.log(`      - ${c}`);
      }
      console.log(`\nDONE · ${report.changedCount} file(s) ${report.dryRun ? 'would be updated' : 'updated'}\n`);
    }
  } catch (error) {
    fail(error.message);
  }
}

function runAdopt(repoPath) {
  requirePositionals('vld adopt <repo-or-url> [--name <slug>] [--idea <text>]', { min: 0, max: 1 });
  const repo = repoPath ?? '.';
  const remote = isRemoteRepo(repo);
  if (!remote && !existsSync(repo)) fail(`No such repository: ${repo}`);

  const explicitName = option('--name', null);
  const explicitIdea = option('--idea', null);
  let report;
  try {
    report = adoptRepo(repo, { name: explicitName, idea: explicitIdea });
  } catch (error) {
    if (error.code === 'INVALID_REMOTE_URL' || error.code === 'REMOTE_CLONE_FAILED') fail(error.message, error);
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
    fail(`profile not written: ${error.message}`);
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

function adoptedIdeaWarning(plan) {
  return /^TODO\b/i.test(String(plan.profile?.idea ?? ''))
    ? 'Adopted profile idea is still a TODO draft. Replace it with the product purpose before relying on this packet.'
    : null;
}

function enforceAdoptedIdea(plan) {
  const warning = adoptedIdeaWarning(plan);
  if (warning && isCompilerStrict()) {
    fail(`${warning} Replace TODO in profile.idea or pass --advisory for an explicitly advisory preview.`);
  }
  return warning;
}

/**
 * The warning that would have prevented BLK-1.
 *
 * `risks.regulated: true` raises the tier and, on its own, adds no obligation.
 * Naming the regime is what adds HIPAA/GDPR/PCI content, so an unnamed regime is
 * reported at plan time rather than discovered as a gap in the packet.
 */
function regulatedWithoutRegime(plan) {
  const { risks, regulation } = plan.profile;
  if (risks?.regulated !== true || (regulation ?? []).length > 0) return null;
  const suggested = (plan.riskHints?.suggestedRegimes ?? []).map((item) => item.regime);
  const hint = suggested.length > 0 ? ` Suggested from idea: ${suggested.join(', ')}.` : '';
  return `risks.regulated is true but profile.regulation is empty: the tier rises, but no regime-specific obligation is added. Name the regime (${REGULATIONS.join(', ')}) so its overlay applies.${hint}`;
}

const ADVISORY_BANNER =
  '⚠ ADVISORY MODE (--advisory): strict compiler guards (unwaived risks, missing regimes, rule conflicts, defaulted production fields) were downgraded to warnings. Do not ship advisory packets.';

/** Roadmap P1.2: `vld plan` and `vld compile` are strict by default; `--advisory` opts out. */
function isCompilerStrict() {
  if (hasFlag('--strict') && hasFlag('--advisory')) {
    fail('cannot combine --strict and --advisory on the same invocation');
  }
  return !hasFlag('--advisory');
}

function enforceStrictCompilerGuards(plan) {
  const strict = isCompilerStrict();
  const today = new Date().toISOString().slice(0, 10);
  const liveRiskScan = scanRiskHints(plan.profile, { referenceDate: today });
  const extraWarnings = [];
  const strictViolations = [];

  if (!strict) {
    console.error(`\n${ADVISORY_BANNER}\n`);
  }

  // 1. P1.1 & P1.2: unwaived risk cues (including waivers expired as of today).
  const unwaived = liveRiskScan.unflaggedRisks.filter((hit) => !hit.traitPresent);
  if (unwaived.length > 0) {
    strictViolations.push(`unflagged risk signal(s): ${unwaived.map((hit) => `risks.${hit.flag}`).join(', ')}`);
    for (const hit of unwaived) {
      const phrases = [...new Set((hit.matches ?? [{ phrase: hit.phrase }]).map((m) => `"${m.phrase}"`))].join(', ');
      strictViolations.push(
        `risks.${hit.flag}: idea mentions ${phrases} (cue: ${(hit.cues ?? [hit.cue]).join(', ')})${hit.expiredWaiver ? ` (waiver expired ${hit.expiredWaiver})` : ''} — set "risks.${hit.flag}": true or add a dated entry in "riskWaivers"`
      );
    }
  }

  // 2. P1.3: cross-rule contradictions and physically infeasible latency bounds.
  if (plan.ruleLint && !plan.ruleLint.ok) {
    const formatted = formatRuleLintFindings(plan.ruleLint);
    strictViolations.push(...formatted.errors);
  }

  // 3. P1.5: production profiles cannot leave tier-driving fields at default provenance.
  const defaultedProd = defaultedProductionTierFields(plan.profile);
  if (defaultedProd.length > 0) {
    strictViolations.push(
      `provenance: stage is "production" but tier-driving field(s) remain at default (${defaultedProd.join(', ')}) — declare them explicitly in profile.json, run \`vld migrate\`, or record dated waivers`
    );
  }

  // 4. Tier >= 2 with low primary-noun confidence requires explicit profile.domain.
  if (plan.rigor.tier >= 2 && plan.vocabulary?.lowConfidence && !plan.profile?.domain?.entity) {
    const candidates = plan.vocabulary.candidates?.length ? ` Candidates: ${plan.vocabulary.candidates.join(', ')}.` : '';
    strictViolations.push(
      `domain: primary domain noun confidence is ${plan.vocabulary.confidence.toFixed(2)} (< 0.60) at tier ${plan.rigor.tier}.${candidates} ` +
        'Set profile.domain: { "entity": "<noun>", "actors": ["<actor>"] }'
    );
  }

  // 5. Adopted placeholder idea & regulated-without-regime & prompt-injection guards.
  const unregulated = regulatedWithoutRegime(plan);
  if (unregulated) strictViolations.push(unregulated);

  if (strict && strictViolations.length > 0) {
    fail(
      `strict profile check failed (${strictViolations.length} finding(s); fix below or pass --advisory to preview):\n  - ${strictViolations.join('\n  - ')}`
    );
  }

  for (const expired of liveRiskScan.expiredWaivers) {
    extraWarnings.push(`riskWaivers: waiver for risks.${expired.flag} expired on ${expired.expires}; renew or set risks.${expired.flag}: true.`);
  }
  return { liveRiskScan, extraWarnings, advisory: !strict };
}

/**
 * The idea is quoted to an agent that will act on what it reads. Say so, and in
 * strict mode refuse to compile text that tries to give that agent orders.
 */
function injectionWarning(plan) {
  const findings = injectionFindings(plan.profile);
  if (findings.length === 0) return [];
  if (isCompilerStrict()) {
    fail(`the profile's text looks like instructions, not a product description:\n  - ${findings.join('\n  - ')}`);
  }
  return findings.map((finding) => `untrusted idea text: ${finding} It is quoted as data in the packet; remove it if it was not meant literally.`);
}

async function runIntakeCommand() {
  const json = hasFlag('--json');
  const projectDir = option('--project', '.');

  if (positional[0] === 'accept') {
    const draftFile = positional[1] ?? 'profile.draft.json';
    const outFile = option('-o', option('--out', 'profile.json'));
    const answers = optionAll('--answer').map((raw) => {
      const eq = raw.indexOf('=');
      if (eq === -1) fail(`--answer expects field=value (got "${raw}")`);
      const field = raw.slice(0, eq).trim();
      const rawVal = raw.slice(eq + 1).trim();
      let value = rawVal;
      if (rawVal === 'true') value = true;
      else if (rawVal === 'false') value = false;
      else if (rawVal.startsWith('[') || rawVal.startsWith('{')) {
        try { value = JSON.parse(rawVal); } catch {}
      } else if (field === 'regulation' || field === 'traits') {
        value = rawVal.split(',').map((s) => s.trim()).filter(Boolean);
      }
      return { field, value };
    });
    const waivers = optionAll('--waive').map((raw) => {
      const parts = raw.split(':');
      if (parts.length < 3) fail(`--waive expects flag:reason:YYYY-MM-DD (got "${raw}")`);
      const flag = parts[0].trim();
      const expires = parts[parts.length - 1].trim();
      const reason = parts.slice(1, -1).join(':').trim();
      return { flag, reason, expires };
    });
    const accepted = acceptIntakeDraft({
      projectDir,
      draftFile,
      outFile,
      answers,
      waivers,
      acceptSuggested: hasFlag('--accept-suggested'),
      force: hasFlag('--force')
    });
    if (json) {
      console.log(JSON.stringify(accepted, null, 2));
    } else {
      console.log(`\n✓ accepted ${draftFile} -> ${displayPath(accepted.profileFile)} (${accepted.answeredCount} recorded answer(s))\n`);
      console.log(`Next:\n  vld plan ${displayPath(accepted.profileFile)} --explain\n  vld compile ${displayPath(accepted.profileFile)} -o specs\n`);
    }
    return;
  }

  let inputText = positional[0] ?? null;
  const fromFile = option('--file', null);
  if (fromFile) {
    const abs = path.resolve(fromFile);
    if (!existsSync(abs)) fail(`intake input file not found: ${fromFile}`);
    inputText = readFileSync(abs, 'utf8');
  } else if (!inputText && !process.stdin.isTTY) {
    inputText = readFileSync(0, 'utf8');
  }
  if (!inputText || !inputText.trim()) {
    fail('Usage: vld intake "<idea prose>" | --file <path> | (stdin) [--offline] [--provider anthropic|openai|openai-compatible|command] [-o profile.draft.json]');
  }

  const outFile = option('-o', option('--out', 'profile.draft.json'));
  const reportFile = option('--report', 'intake-report.json');
  const budgetUsd = option('--budget-usd', null);
  const maxTok = option('--max-tokens', null);
  const result = await runIntake({
    text: inputText,
    name: option('--name', null),
    projectDir,
    outFile,
    reportFile,
    offline: hasFlag('--offline'),
    provider: option('--provider', null),
    model: option('--model', null),
    tokenEnv: option('--token-env', undefined),
    baseUrl: option('--base-url', null),
    cassetteDir: option('--cassette', null),
    cassetteMode: option('--cassette-mode', null),
    budget: {
      ...(budgetUsd !== null ? { maxCostUsd: Number(budgetUsd) } : {}),
      ...(maxTok !== null ? { maxTotalTokens: Number(maxTok) } : {})
    }
  });

  if (json) {
    console.log(JSON.stringify({
      ok: result.ok,
      mode: result.mode,
      draftFile: displayPath(result.draftFile),
      reportFile: displayPath(result.reportFile),
      pendingQuestionCount: result.questions.length,
      questions: result.questions,
      disagreements: result.report.disagreements,
      ruleLint: result.report.ruleLint
    }, null, 2));
    return;
  }

  console.log(`\n✓ wrote ${displayPath(result.draftFile)} and ${displayPath(result.reportFile)} (${result.mode})`);
  if (result.questions.length > 0) {
    console.log(`\nQuestions requiring confirmation (${result.questions.length}/${result.draft.questions.length}, ordered by tier impact):`);
    for (const [idx, q] of result.questions.entries()) {
      console.log(`  ${idx + 1}. [${q.field}] ${q.prompt}`);
      console.log(`     reason: ${q.reason} · suggested: ${JSON.stringify(q.suggestedValue)}`);
      for (const dep of q.dependentQuestions ?? []) {
        console.log(`     ↳ if true -> [${dep.field}] ${dep.prompt}`);
      }
    }
  }
  console.log(`\nNext:\n  vld intake accept ${displayPath(result.draftFile)} -o profile.json --accept-suggested\n`);
}

function runPlan(profilePath) {
  requirePositionals('vld plan <profile.json>', { min: 1 });
  const plan = loadPlanOrFail(profilePath);
  const adoptedWarn = enforceAdoptedIdea(plan);
  const injWarnings = injectionWarning(plan);
  const { liveRiskScan, extraWarnings, advisory } = enforceStrictCompilerGuards(plan);
  const unregulated = regulatedWithoutRegime(plan);
  const warnings = [
    ...(advisory ? [ADVISORY_BANNER] : []),
    adoptedWarn,
    unregulated,
    ...injWarnings,
    ...extraWarnings
  ].filter(Boolean);
  const warning = warnings.length > 0 ? warnings.join('\n⚠ ') : null;
  const explain = hasFlag('--explain')
    ? {
        firedSignals: plan.rigor.signals,
        riskHints: liveRiskScan,
        ruleLint: plan.ruleLint,
        provenance: plan.provenance,
        defaultedTierFields: plan.defaultedTierFields,
        vocabulary: plan.vocabulary,
        overlays: plan.overlays
      }
    : undefined;
  if (hasFlag('--json')) {
    const out = {
      ...plan,
      advisory,
      ...(explain ? { explain } : {}),
      warnings: warning ? [...new Set([...(plan.warnings ?? []), ...warnings])] : plan.warnings
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (warning) console.error(`\n! ${warning}\n`);
  printPlan(explain ? { ...plan, explain } : plan);
}

function runCompile(profilePath) {
  requirePositionals('vld compile <profile.json> -o <dir>', { min: 1 });
  const out = option('-o', option('--out', null));
  if (!out) fail('Missing output directory. Usage: vld compile <profile.json> -o <dir>');
  const plan = loadPlanOrFail(profilePath, { previousIds: previousRequirementIds(out) });
  const adoptedWarn = enforceAdoptedIdea(plan);
  const injWarnings = injectionWarning(plan);
  const { extraWarnings, advisory } = enforceStrictCompilerGuards(plan);
  const compileWarnings = [
    ...(advisory ? [ADVISORY_BANNER] : []),
    adoptedWarn,
    regulatedWithoutRegime(plan),
    ...injWarnings,
    ...(plan.warnings ?? []),
    ...extraWarnings
  ].filter(Boolean);
  if (compileWarnings.length > 0) console.error(`\n! ${[...new Set(compileWarnings)].join('\n! ')}\n`);

  let result;
  try {
    result = emitPacket(plan, out, { force: hasFlag('--force'), packetDir: option('--packet-dir', undefined), lean: hasFlag('--lean') });
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

  const relOut = path.relative(process.cwd(), result.outDir).split(path.sep).join('/');
  const entry = relOut && !relOut.startsWith('..') ? relOut : path.basename(result.outDir);
  const ciCommand = `node ${entry}/spec-check.mjs --repo . --strict --require-assertions && node ${entry}/enforcement/gates.mjs --repo . --strict`;
  console.log(`
Next
  1. Read ${plan.packet === 'full' ? `${entry}/00-constitution.md` : `${entry}/spec.md`} and decide whether you agree.
  2. Hand ${entry}/ to your agent, starting at AGENTS.md (commands inside resolve relative to ${entry}/).
  3. CI gate: ${ciCommand}
  4. Optional GitHub Actions scaffold: vld ci init --packet ${entry}
`);
}

/**
 * BLK-4: enforcement lived in a script the agent had to choose to run, so nothing
 * outside the agent loop could fail a build. `vld ci init` writes the one thing that
 * fails regardless of agent behaviour: a required pull-request check.
 *
 * It writes real files into the product repository, so it never overwrites: a
 * workflow the team has already edited is theirs.
 */
function runCi() {
  // `command` is `ci`, so positional holds only the subcommand (`init`).
  const action = positional[0];
  if (action !== 'init') fail('Usage: vld ci init [--project <dir>] [--packet <dir>] [--node <version>] [--force]');

  const project = path.resolve(option('--project', process.cwd()));
  const rawPacket = option('--packet', 'specs');
  const packet = path.posix.normalize(rawPacket.split(path.sep).join('/')).replace(/\/+$/, '');
  const nodeVersion = option('--node', '22');
  if (packet.startsWith('..') || path.isAbsolute(packet)) {
    fail('--packet must be a directory inside the repository, because the workflow runs relative to it');
  }
  if (!existsSync(path.join(project, packet, 'spec-check.mjs'))) {
    fail(`no packet at ${path.join(packet, 'spec-check.mjs')}. Compile one first: vld compile profile.json -o ${packet}`);
  }

  const workflow = `# Required check: the specification and the code cannot drift apart silently.
# Written by \`vld ci init\`. Edit it; it is yours now.
name: spec
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  spec:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '${nodeVersion}'
      # Execute unit/integration tests and capture a machine-readable report when present
      # (Node TAP, Vitest/Jest JSON, pytest --junitxml, or go test -json).
      - name: Run tests for execution proof
        run: |
          if [ -f package.json ] && grep -q '"test"' package.json; then
            node --test --test-reporter=tap > .vld-test-report.tap || (cat .vld-test-report.tap; exit 1)
          fi
      # --strict: a requirement marked done must keep its test; nothing ships unfinished.
      # --require-assertions: anchored tests must contain non-tautological assertions.
      # --report + --require-report: anchored tests must actually run and pass in CI.
      - name: Anchors, assertions, and execution proof
        run: |
          if [ -f test-report.json ]; then
            node ${packet}/spec-check.mjs --repo . --strict --require-assertions --report test-report.json --require-report
          elif [ -f .vld-test-report.tap ]; then
            node ${packet}/spec-check.mjs --repo . --strict --require-assertions --report .vld-test-report.tap --require-report
          else
            node ${packet}/spec-check.mjs --repo . --strict --require-assertions
          fi
      # Execute gates (G0-RUN, G0-CHECK, G0-SMOKE, drift, mutation) and publish a
      # Markdown summary distinguishing PASS-EXECUTED from PASS-STATIC / WAIVED.
      - name: Gates
        id: gates
        run: node ${packet}/enforcement/gates.mjs --repo . --json > gates-report.json || (cat gates-report.json; exit 1)
      - name: Gate summary
        if: always()
        run: node ${packet}/enforcement/summary.mjs gates-report.json >> $GITHUB_STEP_SUMMARY || true
`;

  const target = path.join(project, '.github', 'workflows', 'spec.yml');
  const force = hasFlag('--force');
  if (existsSync(target) && !force) {
    fail(`${path.relative(process.cwd(), target)} already exists; pass --force to replace it`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, workflow);

  console.log(`
✓ wrote ${path.relative(process.cwd(), target)}

On the next pull request the \`spec\` check fails when a done requirement loses its
test, an anchor names a requirement that does not exist, or a gate regresses. That
happens whether or not an agent chose to run anything.

  vld ci init --packet <dir>     point at a packet that is not ${packet}
`);
}

async function runVerify(packetDir) {
  requirePositionals('vld verify <packet-dir> [--repo <path>] [--run] [--report <file>] [--require-report] [--mutation]', { min: 1 });
  if (!packetDir) fail('Missing packet directory. Usage: vld verify <packet-dir> [--repo <path>]');
  if (!existsSync(packetDir)) fail(`No such packet: ${packetDir}`);

  const resolvedPacket = path.resolve(packetDir);
  const runLive = hasFlag('--run');
  const runMut = hasFlag('--mutation');
  const reportOpt = option('--report', null);
  const mutReportOpt = option('--mutation-report', null);
  const requireReport = hasFlag('--require-report') || runLive;
  const repo = hasFlag('--repo')
    ? path.resolve(option('--repo', '.'))
    : (runLive || runMut || reportOpt ? path.resolve('.') : null);

  let testReport = null;
  let testRunMeta = null;
  if (runLive) {
    if (!repo) fail('--run requires a repository (defaults to "." or pass --repo <path>)');
    const explicitCmd = option('--test-cmd', null);
    const customArgv = explicitCmd ? explicitCmd.trim().split(/\s+/).filter(Boolean) : null;
    try {
      testRunMeta = await runRepositoryTests({
        repoDir: repo,
        backend: option('--backend', 'auto'),
        command: customArgv,
        writeReport: true
      });
      testReport = testRunMeta.report;
    } catch (err) {
      fail(err.message, err);
    }
  }

  let mutationReport = null;
  if (runMut) {
    let tier = 2;
    try {
      const sp = JSON.parse(readFileSync(path.join(resolvedPacket, 'spec.json'), 'utf8'));
      tier = Math.max(2, Number(sp.rigor?.tier ?? 2));
    } catch { /* default tier 2 */ }
    mutationReport = await runMutationGate({
      repoDir: repo,
      tier,
      backend: option('--backend', 'auto'),
      writeReport: true
    });
  } else if (mutReportOpt) {
    if (!existsSync(mutReportOpt)) fail(`Mutation report not found: ${mutReportOpt}`);
    let tier = 2;
    try {
      const sp = JSON.parse(readFileSync(path.join(resolvedPacket, 'spec.json'), 'utf8'));
      tier = Math.max(2, Number(sp.rigor?.tier ?? 2));
    } catch { /* default tier 2 */ }
    mutationReport = parseMutationReport(readFileSync(mutReportOpt, 'utf8'), { tier });
  }

  const report = verifyPacket(resolvedPacket, {
    repo,
    strict: hasFlag('--strict') || runLive,
    requireAssertions: hasFlag('--require-assertions') || runLive,
    testReport,
    reportPath: testReport ? null : reportOpt,
    requireReport,
    mutationReport
  });

  // If mutation ran or was supplied on tier >= 2, enforce its threshold honestly!
  if (mutationReport) {
    if (mutationReport.verdictLabel === 'FAIL') {
      const pct = typeof mutationReport.score === 'number' ? `${(mutationReport.score * 100).toFixed(1)}%` : '0%';
      const floor = `${Math.round((mutationReport.threshold ?? 0.6) * 100)}%`;
      report.errors.push(`mutation gate failed: ${pct} killed (${mutationReport.killed}/${mutationReport.total}) < required ${floor} floor`);
      report.ok = false;
      report.verdict = 'failed';
    } else if (mutationReport.verdictLabel === 'SKIPPED-UNAVAILABLE') {
      const msg = `mutation gate SKIPPED-UNAVAILABLE: ${mutationReport.reason ?? 'runner unavailable'}`;
      if (hasFlag('--strict')) {
        report.errors.push(`${msg} (record a dated waiver or install the mutation runner)`);
        report.ok = false;
        report.verdict = 'failed';
      } else {
        report.warnings.push(msg);
      }
    }
  }

  // Record tamper-evident evidence when tests actually executed (`--run`).
  if (runLive && repo) {
    try {
      appendEvidence({
        projectDir: repo,
        kind: 'verify',
        actor: 'cli:verify',
        subject: path.basename(resolvedPacket),
        payload: {
          verdict: report.verdict,
          ok: report.ok,
          passed: testReport?.passed ?? 0,
          failed: testReport?.failed ?? 0,
          skipped: testReport?.skipped ?? 0,
          sandboxBackend: testReport?.sandboxBackend ?? null,
          receiptDigest: testReport?.receiptDigest ?? null,
          mutationScore: mutationReport?.score ?? null,
          mutationVerdict: mutationReport?.verdictLabel ?? null
        }
      });
    } catch {
      // Evidence ledger append is best-effort on read-only checkouts.
    }
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log(`\nverify · ${packetDir} · verdict: ${report.verdict}\n`);
  for (const pass of report.passes) console.log(`  ✓ ${pass}`);
  for (const line of report.info) console.log(`  · ${line}`);
  if (mutationReport) {
    const scoreText = typeof mutationReport.score === 'number'
      ? `${(mutationReport.score * 100).toFixed(1)}% (${mutationReport.killed}/${mutationReport.total} killed, floor ${Math.round(mutationReport.threshold * 100)}%)`
      : (mutationReport.reason ?? mutationReport.verdictLabel);
    console.log(`  · mutation [${mutationReport.verdictLabel}]: ${scoreText}`);
  }
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
    `\n${report.ok ? 'PASS' : 'FAIL'} [${report.verdict}] · ${stats.requirements ?? 0} requirements · ${stats.criteria ?? 0} criteria · ` +
      `${stats.gates ?? 0} gates · ${report.errors.length} error(s) · ${report.warnings.length} warning(s)\n`
  );
  process.exit(report.ok ? 0 : 1);
}

function runChange() {
  const [first, second] = positional;

  if (first === 'init') {
    const dir = second ?? 'changes';
    const file = path.join(dir, 'change.json');
    try {
      writeAbsoluteManagedFileAtomic(file, `${JSON.stringify(CHANGE_TEMPLATE, null, 2)}\n`, { overwrite: hasFlag('--force'), label: 'change template' });
    } catch (error) {
      if (error.code === 'MANAGED_FILE_EXISTS') fail(`${file} already exists; pass --force to replace it`);
      fail(error.message);
    }
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
      force: hasFlag('--force'),
      toProfileRules: hasFlag('--to-profile-rules')
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

  // Optional, because the graph lives in the repository rather than the packet.
  const projectDir = option('--repo', option('--project', null));
  const plan = planChange({ packetDir, change, projectDir });

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

async function runDiscoverabilityReadiness() {
  // Keep this optional advisory surface out of unrelated CLI command graphs.
  const { initDiscoverabilityReadiness, validateDiscoverabilityReadiness } = await import('./lib/discoverability-readiness.mjs');
  const [action] = positional;
  const common = {
    projectDir: option('--project', '.'),
    profilePath: option('--profile', null),
    packetDir: option('--packet', null)
  };
  try {
    if (action === 'init') {
      const result = initDiscoverabilityReadiness({ ...common, out: option('--out', option('--file', null)), force: hasFlag('--force') });
      if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ wrote ${displayPath(result.file)}\n\n  Human-authored, locally verifiable, and advisory only. Fill the record, then run:\n  vld discoverability-readiness validate --project ${displayPath(result.project)} --strict\n`);
      return;
    }
    if (action === 'validate') {
      const report = validateDiscoverabilityReadiness({ ...common, file: option('--file', null), strict: hasFlag('--strict') });
      if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`\ndiscoverability readiness validate · ${displayPath(report.file)}\n`);
        for (const pass of report.passes) console.log(`  ✓ ${pass}`);
        for (const warning of report.warnings) console.log(`  ! ${warning}`);
        for (const error of report.errors) console.log(`  ✗ ${error}`);
        console.log(`\n${hasFlag('--strict') ? report.strictOk ? 'PASS' : 'FAIL' : report.ok ? 'PASS' : 'FAIL'} · advisory local evidence only\n`);
      }
      if (hasFlag('--strict') ? !report.strictOk : !report.ok) process.exit(1);
      return;
    }
    fail('Usage: vld discoverability-readiness init|validate [--project <dir>] [--profile <file>] [--packet <dir>] [--file <path>]');
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
      if (!id || third) fail('Usage: vld store init <directory> [--id <store-id>] [--title <text>] [--force]');
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
    fail('Usage: vld store init|add|diff|update|list|status|assets|copy [--debug]');
  } catch (error) { fail(error.message, error); }
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
    fail('Usage: vld catalog trust|add|diff|update|list|status|copy [--debug]');
  } catch (error) { fail(error.message, error); }
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

async function runMission() {
  const [action, file] = positional;
  const project = option('--project', '.');
  try {
    if (action === 'plan') {
      const packet = file ?? 'specs';
      const outFile = option('-o', option('--out', 'mission-definition.json'));
      const maxTurns = Number(option('--max-turns', '3'));
      const maxChars = Number(option('--max-chars', '24000'));
      const result = await runPlannerAgent({
        packetDir: path.resolve(project, packet),
        missionId: option('--mission-id', null),
        title: option('--title', null),
        offline: hasFlag('--offline'),
        provider: option('--provider', null),
        model: option('--model', null),
        tokenEnv: option('--token-env', undefined),
        baseUrl: option('--base-url', null),
        cassetteDir: option('--cassette', null),
        cassetteMode: option('--cassette-mode', null),
        maxTurns,
        maxChars,
        budget: {
          ...(option('--budget-usd', null) !== null ? { maxCostUsd: Number(option('--budget-usd', null)) } : {}),
          ...(option('--max-tokens', null) !== null ? { maxTokens: Number(option('--max-tokens', null)) } : {})
        }
      });
      if (!result.ok) {
        fail(`mission planning failed (${result.mode}):\n${result.errors.map((error) => `- ${error}`).join('\n')}`);
      }
      const outPath = path.resolve(project, outFile);
      writeFileSync(outPath, `${JSON.stringify(result.definition, null, 2)}\n`, 'utf8');
      const summary = {
        ok: true,
        mode: result.mode,
        definitionFile: displayPath(outPath),
        contextDigest: result.context.digest,
        contextChars: result.context.chars,
        contextTruncated: result.context.truncated,
        turns: result.turns.map((turn) => ({ index: turn.index, cached: turn.cached, validationErrors: turn.validationErrors })),
        workPackageContexts: result.workPackageContexts,
        validation: result.validation,
        usage: result.usage
      };
      if (hasFlag('--json')) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`\n✓ planned ${result.definition.workPackages.length} work package(s) -> ${displayPath(outPath)} (${result.mode})`);
        for (const pkg of result.workPackageContexts) console.log(`  · ${pkg.packageId}: context ${pkg.digest.slice(0, 12)}… (${pkg.chars} chars)`);
        console.log('');
      }
      return;
    }
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
    if (action === 'rebase') {
      if (!file) fail('Usage: vld mission rebase <mission.json> [--target <ref>] [--packet <dir>] [--assign-added <pkg>] [--drop-removed] [--dry-run] [--project <dir>] [--json]');
      const rebased = rebaseMission({
        file,
        projectDir: project,
        targetRef: option('--target', null),
        packetDir: option('--packet', null),
        assignAddedTo: option('--assign-added', null),
        dropRemoved: hasFlag('--drop-removed'),
        dryRun: hasFlag('--dry-run')
      });
      if (hasFlag('--json')) console.log(JSON.stringify(rebased, null, 2));
      else {
        console.log(`\nmission rebase · ${displayPath(rebased.file)}${rebased.dryRun ? ' (dry-run)' : ''}\n`);
        console.log(`  changed    ${rebased.changed ? 'yes' : 'no'} · fast-forward: ${rebased.fastForward ? 'yes' : 'no'}`);
        console.log(`  target     ${rebased.diff.fromCommit.slice(0, 12)} -> ${rebased.diff.toCommit.slice(0, 12)}`);
        console.log(`  coverage   retained ${rebased.diff.retainedCount} · added ${rebased.diff.addedRequirements.length} · removed ${rebased.diff.removedRequirements.length}`);
        console.log(`  impacted   ${rebased.diff.impactedPackages.length ? rebased.diff.impactedPackages.join(', ') : '(none)'}`);
        console.log(`\nPASS · digest ${rebased.digest.slice(0, 16)}\n`);
      }
      return;
    }
    fail('Usage: vld mission plan <packet-dir>|init <definition.json>|validate|status|rebase');
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
  const remoteUrl = option('--runtime-url', null);
  try {
    if (remoteUrl) {
      const remoteToken = option('--runtime-token', null);
      if (!remoteToken) fail('remote Runtime client requires --runtime-token');
      if (!['status', 'events', 'allocate', 'heartbeat', 'transition', 'recover'].includes(action)) fail('remote Runtime client supports status, events, allocate, heartbeat, transition, and recover only');
      const client = createRuntimeClient({ endpoint: remoteUrl, token: remoteToken });
      // Remote Runtime owns its mission selection. The second positional is a
      // package only for package-scoped remote methods; a local mission path is
      // never sent over the network or interpreted by the remote endpoint.
      let params = {};
      if (action === 'allocate') {
        if (!missionFile) fail('Usage: vld runtime allocate <package> --assignee <implementer-id> --runtime-url <url> --runtime-token <token>');
        const assignee = option('--assignee', null); if (!assignee) fail('runtime allocate requires --assignee <implementer-id>');
        params = { packageId: missionFile, assignee: { role: 'implementer', id: assignee }, leaseMs: integerOption('--lease-ms', 5 * 60 * 1_000), ...(option('--lease-token', null) ? { leaseToken: option('--lease-token', null) } : {}) };
      } else if (action === 'heartbeat') {
        if (!missionFile) fail('Usage: vld runtime heartbeat <package> --run <run-id> --lease-token <token> --runtime-url <url> --runtime-token <token>');
        const runId = option('--run', null); const leaseToken = option('--lease-token', null); if (!runId || !leaseToken) fail('runtime heartbeat requires --run and --lease-token');
        params = { packageId: missionFile, runId, leaseToken, leaseMs: integerOption('--lease-ms', 5 * 60 * 1_000) };
      } else if (action === 'events') {
        if (missionFile) fail('remote runtime events has no mission-file positional; the endpoint owns the frozen mission');
        const after = integerOption('--after', 0); const limit = integerOption('--limit', 50); const maxBytes = integerOption('--max-bytes', 64 * 1024);
        params = { after, limit, maxBytes };
      } else if (action === 'transition') {
        if (!missionFile) fail('Usage: vld runtime transition <package> --to <state> --expected-version <n> --runtime-url <url> --runtime-token <token>');
        const to = option('--to', null); const expectedVersion = integerOption('--expected-version', null); if (!to || expectedVersion === null) fail('runtime transition requires --to and --expected-version');
        params = { packageId: missionFile, to, expectedVersion, ...(option('--lease-token', null) ? { leaseToken: option('--lease-token', null) } : {}), ...(option('--reason', null) ? { reason: option('--reason', null) } : {}) };
      } else if (action === 'status' && missionFile) {
        fail('remote runtime status has no mission-file positional; the endpoint owns the frozen mission');
      } else if (action === 'recover' && missionFile) {
        fail('remote runtime recover has no mission-file positional; the endpoint owns the frozen mission');
      }
      const result = await client.request(action, params, { ...(option('--request-id', null) ? { requestId: option('--request-id', null) } : {}) });
      if (json) console.log(JSON.stringify(result, null, 2));
      else printRuntimeReport(`remote ${action}`, result.status ?? result);
      if (action === 'status' || action === 'recover') process.exit(result.ok ? 0 : 1);
      return;
    }
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
      if (!['submit', 'verify', 'review', 'approve', 'queue'].includes(deliveryAction) || !deliveryMissionFile || !deliveryPackageId) {
        fail('Usage: vld runtime delivery submit|verify|review|approve|queue <mission.json> <package> --policy <delivery-policy.json>');
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
        result = await verifyRuntimeDeliveryCandidateAsync({ missionFile: deliveryMissionFile, packageId: deliveryPackageId, policyFile, projectDir: project });
      } else if (deliveryAction === 'review') {
        const actor = runtimeActor(option('--actor', null));
        const candidateId = option('--candidate', null);
        if (!candidateId) fail('runtime delivery review requires --candidate');
        const statusForReview = runtimeDeliveryStatus({ missionFile: deliveryMissionFile, projectDir: project });
        const reviewEntry = (statusForReview.delivery ?? []).find((item) => item.candidate?.id === candidateId);
        const reviewCandidate = reviewEntry?.candidate;
        if (!reviewCandidate) fail(`runtime delivery review: unknown candidate ${candidateId}`);
        const reportFile = option('--report', null);
        if (reportFile) {
          const reviewerModelId = option('--reviewer-model', null);
          if (!reviewerModelId) fail('runtime delivery review --report requires --reviewer-model <provider:model>');
          const parsed = JSON.parse(readFileSync(reportFile, 'utf8'));
          result = recordRuntimeDeliveryReview({
            missionFile: deliveryMissionFile,
            packageId: deliveryPackageId,
            candidateId,
            policyFile,
            reviewerModelId,
            categories: parsed.categories,
            verdict: parsed.verdict,
            humanSignoff: parsed.humanSignoff ?? null,
            riskDigest: option('--risk-digest', null),
            actor,
            projectDir: project
          });
        } else {
          const missionRaw = JSON.parse(readFileSync(path.resolve(project, deliveryMissionFile), 'utf8'));
          const packet = prepareReviewPacket({
            projectDir: project,
            packetDir: missionRaw.packet?.path ?? 'specs',
            baseRef: reviewCandidate.targetSha,
            headRef: reviewCandidate.candidateSha,
            authorId: actor.id
          });
          const agentReview = await runReviewerAgent({ packet, provider: 'rules', reviewerId: actor.id });
          result = recordRuntimeDeliveryReview({
            missionFile: deliveryMissionFile,
            packageId: deliveryPackageId,
            candidateId,
            policyFile,
            reviewerModelId: agentReview.reviewerModelId,
            categories: agentReview.categories,
            verdict: agentReview.verdict,
            actor,
            projectDir: project
          });
        }
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
      if ((forgeAction !== 'plan-export' && forgeAction !== 'execute') || !forgeMissionFile || !forgePackageId) {
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
      if (forgeAction === 'execute' || hasFlag('--execute')) {
        const tokenEnvName = option('--token-env', 'GITHUB_TOKEN');
        const token = process.env[tokenEnvName];
        if (!token) fail(`Governed GitHub execute mode requires an explicit token in ${tokenEnvName}.`);
        const prRaw = option('--pr', null);
        const pullNumber = prRaw ? Number.parseInt(prRaw, 10) : null;
        const executed = await executeRuntimeForgePlan({
          ...request,
          action: option('--action', 'publish'),
          allowMergeRequest: hasFlag('--allow-merge'),
          pullNumber: Number.isSafeInteger(pullNumber) ? pullNumber : null,
          postEvidence: !hasFlag('--no-comment'),
          token,
          apiUrl: option('--api-url', null)
        });
        console.log(JSON.stringify(executed, null, 2));
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
    if (action === 'events') {
      if (!missionFile) fail('Usage: vld runtime events <mission.json> --actor <role:id> [--after <sequence>] [--limit <1-100>] [--max-bytes <1024-65536>]');
      const actor = runtimeActor(option('--actor', null));
      const result = runtimeEventHistory({ missionFile, projectDir: project, actor, after: integerOption('--after', 0), limit: integerOption('--limit', 50), maxBytes: integerOption('--max-bytes', 64 * 1024) });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`\nruntime events · ${result.page.returned} event(s)${result.page.truncated ? ` · next cursor ${result.page.nextCursor}` : ''}\n`);
        for (const event of result.events) console.log(`  #${event.sequence} ${event.type.padEnd(14)} ${event.packageId ?? '-'} · ${event.actor.role}:${event.actor.id}`);
        console.log('');
      }
      return;
    }
    if (action === 'allocate') {
      if (!missionFile || !packageId) fail('Usage: vld runtime allocate <mission.json> <package> --assignee <implementer-id> [--lease-ms <ms>]');
      const assignee = option('--assignee', null);
      if (!assignee) fail('runtime allocate requires --assignee <implementer-id>');
      const leaseMs = integerOption('--lease-ms', 5 * 60 * 1_000);
      const result = allocateRuntimePackage({ missionFile, projectDir: project, packageId, assignee: { role: 'implementer', id: assignee }, leaseMs, idempotencyKey: option('--request-id', null) });
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
      const result = heartbeatRuntimeLease({ missionFile, projectDir: project, packageId, runId, leaseToken, actor, leaseMs: integerOption('--lease-ms', 5 * 60 * 1_000), idempotencyKey: option('--request-id', null) });
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
      const result = transitionRuntimePackage({ missionFile, projectDir: project, packageId, to, actor, expectedVersion, leaseToken: option('--lease-token', null), idempotencyKey: option('--request-id', null) });
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
      if (json) fail('runtime serve is a long-running local service; --json is not a one-shot response or readiness protocol');
      startStudioServer({ missionFile, project, label: 'Runtime' });
      return;
    }
    fail('Usage: vld runtime init|status|events|allocate|heartbeat|transition|delivery|recover|serve <mission.json> [package]');
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

// BUG-9: the deterministic compiler and the agent runtime became one package with
// one `vld` prefix, so the unconfined host-process runner reads as a supported part
// of the promise. They are separated here: `vld experimental <command>` is the only
// way to reach the runtime family, the word appears in every error and in --help,
// and `vld --core` never loads those modules at all.
const SESSION_NOTICE_TTL_MS = 12 * 60 * 60 * 1_000;
function shouldPrintExperimentalNotice() {
  const rawSession = process.env.VLD_SESSION_ID;
  if (rawSession === 'always') return true;
  // When a session id is exported (or inside an interactive shell whose PPID stays
  // constant across commands), record a single session marker so the experimental
  // notice prints on the first call and stays quiet for the rest of the session.
  const sessionKey = typeof rawSession === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(rawSession)
    ? `sid-${rawSession}`
    : process.stderr.isTTY && Number.isInteger(process.ppid) && process.ppid > 1
      ? `ppid-${process.ppid}`
      : null;
  if (!sessionKey) return true;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const marker = path.join(os.tmpdir(), `vld-exp-notice-${uid}-${sessionKey}`);
  try {
    if (existsSync(marker)) {
      const info = lstatSync(marker);
      if (info.isSymbolicLink()) return true;
      if (Date.now() - info.mtimeMs < SESSION_NOTICE_TTL_MS) return false;
    }
    writeFileSync(marker, `${process.pid}\n`, { mode: 0o600, flag: 'w' });
  } catch {
    // Non-fatal: fall back to printing the notice.
  }
  return true;
}

async function runSandboxCommand() {
  const [action = 'probe'] = positional;
  const backend = option('--backend', 'auto');
  const json = hasFlag('--json');
  if (action === 'probe') {
    const probe = detectSandboxBackends({ refresh: true });
    if (json) console.log(JSON.stringify(probe, null, 2));
    else {
      console.log(`\nsandbox probe · ${probe.platform} · Node ${probe.nodeVersion} · preferred: ${probe.preferred ?? 'none'}\n`);
      for (const b of probe.backends) {
        console.log(`  ${b.available ? '✓' : '·'} ${b.id.padEnd(18)} ${b.confinementClass.padEnd(20)} ${b.detail}`);
      }
      console.log('');
    }
    process.exit(probe.preferred ? 0 : 1);
  }
  if (action === 'conformance') {
    const report = await runSandboxConformance({ backend });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`\nsandbox conformance · ${report.backend} (${report.confinementClass})\n`);
      for (const p of report.probes) console.log(`  ${p.passed ? '✓' : '✗'} ${p.id.padEnd(32)} ${p.detail}`);
      console.log(`\n${report.ok ? 'PASS' : 'FAIL'} · ${report.passed}/${report.total} probe(s) passed\n`);
    }
    process.exit(report.ok ? 0 : 1);
  }
  fail('Usage: vld sandbox probe|conformance [--backend <auto|oci|bwrap|linux-ns|darwin-seatbelt|node-permission>] [--json]');
}

async function runBuildCommand() {
  const project = option('--project', '.');
  const rawMax = option('--max-repairs', '2');
  const maxRepairs = Number(rawMax);
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) fail('--max-repairs must be an integer from 0 to 5');
  const argValue = option('--arg', null);
  const adapter = option('--adapter', 'sandboxed-cli');
  if (!['sandboxed-cli', 'sandboxed-acp', 'sandboxed-agent', 'fake'].includes(adapter)) {
    fail('--adapter must be sandboxed-cli, sandboxed-acp, sandboxed-agent or fake');
  }
  let testCommand = null;
  const rawTestCmd = option('--test-cmd', null);
  if (rawTestCmd) {
    try {
      const parsed = JSON.parse(rawTestCmd);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.executable !== 'string') throw new Error('test-cmd');
      testCommand = {
        id: parsed.id ?? 'project-tests',
        executable: parsed.executable,
        args: Array.isArray(parsed.args) ? parsed.args : [],
        ...(parsed.timeoutMs ? { timeoutMs: Number(parsed.timeoutMs) } : {})
      };
    } catch {
      fail('--test-cmd must be a JSON object like {"executable":"node","args":["--test","tests/"]}');
    }
  }
  let missionOverrides = null;
  const overridesFile = option('--mission-overrides', null);
  if (overridesFile) {
    const overridesPath = path.resolve(project, overridesFile);
    try {
      missionOverrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
    } catch (error) {
      fail(`--mission-overrides must be readable JSON: ${error.message}`);
    }
  }
  const report = await runBuild({
    projectDir: project,
    profileFile: option('--profile', null),
    packetDir: option('--packet', 'specs'),
    missionFile: option('--mission', null),
    missionOverrides,
    adapter,
    executable: option('--executable', null),
    args: argValue ? [argValue] : [],
    sandboxBackend: option('--backend', 'auto'),
    requireOsSandbox: hasFlag('--require-os'),
    testCommand,
    verifyGates: hasFlag('--gates'),
    requireAssertions: hasFlag('--require-assertions') || true,
    maxRepairs,
    dryRun: hasFlag('--dry-run'),
    reportFile: option('-o', option('--out', null)),
    model: option('--model', null),
    cassetteDir: option('--cassette', null),
    cassetteMode: option('--cassette-mode', null)
  });
  if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\nvld build · ${report.ok ? 'PASS' : 'FAIL'}${report.dryRun ? ' (dry-run)' : ''}\n`);
    console.log(`  packet    ${report.packet?.path ?? 'specs'}`);
    console.log(`  order     ${report.order.join(' -> ')}`);
    for (const pkg of report.packages ?? []) {
      console.log(`  ${pkg.ok ? '✓' : '✗'} ${pkg.packageId.padEnd(18)} stage=${pkg.stage} repairs=${pkg.repairsUsed} backend=${pkg.sandboxBackend ?? 'n/a'}`);
    }
  if (report.reportFile) console.log(`  report    ${report.reportFile}`);
    console.log('');
  }
  process.exit(report.ok ? 0 : 1);
}

async function runReviewCommand() {
  const [sub = 'prepare'] = positional;
  const project = option('--project', '.');
  const packet = option('--packet', 'specs');
  const json = hasFlag('--json');
  try {
    if (sub === 'prepare') {
      const prepared = prepareReviewPacket({
        projectDir: project,
        packetDir: packet,
        baseRef: option('--base-ref', 'HEAD~1'),
        headRef: option('--head-ref', 'HEAD'),
        authorId: option('--author', 'unknown-author')
      });
      const out = option('-o', option('--out', null));
      if (out) {
        mkdirSync(path.dirname(path.resolve(project, out)), { recursive: true });
        writeFileSync(path.resolve(project, out), `${JSON.stringify(prepared, null, 2)}\n`, 'utf8');
      }
      if (json || !out) console.log(JSON.stringify(prepared, null, 2));
      else console.log(`\n✓ prepared isolated review packet ${out} (${prepared.requirements.length} requirement(s), human escalation: ${prepared.humanEscalation.required ? 'yes' : 'no'})\n`);
      return;
    }
    if (sub === 'verify') {
      const reportPath = option('--report', positional[1]);
      if (!reportPath) fail('Usage: vld review verify --report <review.json> [--packet <dir>] [--author <id>] [--json]');
      const report = JSON.parse(readFileSync(path.resolve(reportPath), 'utf8'));
      const specPath = path.resolve(project, packet, 'spec.json');
      const known = existsSync(specPath) ? (JSON.parse(readFileSync(specPath, 'utf8')).requirements ?? []).map((r) => r.id) : null;
      const result = validateReviewReport(report, { knownRequirements: known, authorId: option('--author', null) });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`\nreview verify · ${result.ok ? 'PASS' : 'FAIL'}\n`);
        for (const err of result.errors) console.log(`  ✗ ${err}`);
      }
      process.exit(result.ok ? 0 : 1);
    }
    if (sub === 'record') {
      const reportPath = option('--report', positional[1]);
      if (!reportPath) fail('Usage: vld review record --report <review.json> [--packet <dir>] [--project <dir>] [-o <file>] [--json]');
      const report = JSON.parse(readFileSync(path.resolve(reportPath), 'utf8'));
      const result = recordReviewDecision({ projectDir: project, packetDir: packet, report, outFile: option('-o', option('--out', null)) });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n✓ recorded review (${result.review.verdict}) → ${path.relative(path.resolve(project), result.file)} · evidence ${result.evidenceHash.slice(0, 12)}\n`);
      return;
    }
    if (sub === 'run') {
      const provider = option('--provider', 'rules');
      const model = option('--model', null);
      const prepared = prepareReviewPacket({
        projectDir: project,
        packetDir: packet,
        baseRef: option('--base-ref', 'HEAD~1'),
        headRef: option('--head-ref', 'HEAD'),
        authorId: option('--author', 'unknown-author'),
        requirementIds: option('--requirements', null) ? option('--requirements', '').split(',').map((v) => v.trim()).filter(Boolean) : undefined
      });
      const run = await runReviewerAgent({
        packet: prepared,
        provider,
        model,
        env: process.env,
        cassetteDir: option('--cassette', null),
        cassetteMode: option('--cassette-mode', null),
        reviewerId: option('--reviewer-id', `reviewer:${provider === 'rules' ? 'diff-risk-v1' : String(model ?? 'model')}`),
        maxTokens: 2048
      });
      const out = option('-o', option('--out', null));
      const recorded = recordReviewDecision({ projectDir: project, packetDir: packet, report: run.report, outFile: out });
      const summary = {
        ok: recorded.review.verdict !== 'changes-requested',
        mode: run.mode,
        reviewerModelId: run.reviewerModelId,
        verdict: recorded.review.verdict,
        categories: recorded.review.categories,
        blocking: run.blocking,
        findings: run.report.findings ?? [],
        humanEscalation: prepared.humanEscalation,
        reviewFile: recorded.file,
        evidenceHash: recorded.evidenceHash,
        warnings: run.warnings
      };
      if (json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`\nreview run · ${run.mode} · ${run.reviewerModelId}\n`);
        console.log(`  verdict   ${summary.verdict} (${summary.blocking} blocking)`);
        console.log(`  recorded  ${path.relative(path.resolve(project), recorded.file)} · evidence ${recorded.evidenceHash.slice(0, 12)}`);
        if (prepared.humanEscalation.required) console.log('  ! human escalation required by risk tier');
        for (const warning of run.warnings) console.log(`  ! ${warning}`);
      }
      return;
    }
    fail('Usage: vld review <prepare|run|verify|record> [--packet <dir>] [--project <dir>] [--report <review.json>] [--provider rules|openai|...] [--model <id>] [--cassette <dir>] [--cassette-mode <replay|record|auto|off>] [--json]');
  } catch (error) {
    fail(error.message);
  }
}

function runDriftCommand() {
  const [sub = 'check'] = positional;
  const project = option('--project', '.');
  const packet = option('--packet', 'specs');
  const json = hasFlag('--json');
  try {
    if (sub === 'check') {
      const result = detectSpecDrift({
        projectDir: project,
        packetDir: packet,
        profileFile: option('--profile', null),
        baseRef: option('--base-ref', null),
        headRef: option('--head-ref', 'HEAD'),
        requireAssertions: true,
        record: hasFlag('--record')
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`\ndrift check · ${result.packetDir}\n`);
        for (const f of result.findings) console.log(`  ${f.severity === 'high' ? '✗' : '!'} [${f.kind}] ${f.detail}`);
        if (result.findings.length === 0) console.log('  ✓ zero drift findings');
        console.log(`\n${result.ok ? 'PASS' : 'FAIL'} · ${result.findingCount} finding(s) (${result.blockingCount} blocking)\n`);
      }
      process.exit(result.ok ? 0 : 1);
    }
    if (sub === 'init-workflow') {
      const result = scaffoldDriftWorkflow({
        projectDir: project,
        packetDir: packet,
        nodeVersion: option('--node', '22.x'),
        cron: option('--cron', '0 6 * * 1'),
        outFile: option('-o', option('--out', '.github/workflows/vld-drift.yml')),
        force: hasFlag('--force')
      });
      console.log(json ? JSON.stringify(result, null, 2) : `\n✓ wrote ${path.relative(path.resolve(project), result.file)}\n`);
      return;
    }
    if (sub === 'init-oracles') {
      const result = initSemanticOracles({ projectDir: project, packetDir: packet, force: hasFlag('--force') });
      console.log(json ? JSON.stringify(result, null, 2) : `\n✓ wrote semantic-oracles.json (${result.count} oracle(s) · stack ${result.stack} · ${result.mutationRunner.tool})\n`);
      return;
    }
    fail('Usage: vld drift <check|init-workflow|init-oracles> [--packet <dir>] [--project <dir>] [--base-ref <ref>] [--record] [--json]');
  } catch (error) {
    fail(error.message);
  }
}

function runEvidenceCommand() {
  const [sub = 'verify'] = positional;
  const project = option('--project', '.');
  const json = hasFlag('--json');
  try {
    if (sub === 'verify') {
      const result = verifyEvidenceChain({ projectDir: project });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`\nevidence chain · ${result.ok ? 'VERIFIED' : 'TAMPERED'} · ${result.entries} entry/entries · head ${result.headHash.slice(0, 16)}\n`);
        for (const err of result.errors) console.log(`  ✗ ${err}`);
      }
      process.exit(result.ok ? 0 : 1);
    }
    if (sub === 'export') {
      const format = option('--format', 'json');
      const output = exportEvidenceBundle({ projectDir: project, format });
      const out = option('-o', option('--out', null));
      if (out) {
        mkdirSync(path.dirname(path.resolve(project, out)), { recursive: true });
        writeFileSync(path.resolve(project, out), output, 'utf8');
        console.log(`\n✓ exported evidence bundle (${format}) → ${out}\n`);
      } else {
        process.stdout.write(output);
      }
      return;
    }
    if (sub === 'append') {
      const kind = option('--kind', 'verify');
      const appended = appendEvidence({
        projectDir: project,
        kind,
        actor: option('--from', 'operator:local'),
        subject: option('--subject', 'project'),
        payload: { note: option('--reason', '') }
      });
      console.log(json ? JSON.stringify(appended, null, 2) : `\n✓ appended evidence seq ${appended.entry.seq} (${appended.entry.hash.slice(0, 16)})\n`);
      return;
    }
    fail('Usage: vld evidence <verify|export|append> [--project <dir>] [--format json|markdown] [-o <file>] [--json]');
  } catch (error) {
    fail(error.message);
  }
}

function runTelemetryCommand() {
  const [sub = 'status'] = positional;
  const project = option('--project', '.');
  const json = hasFlag('--json');
  try {
    if (sub === 'status') {
      const status = telemetryStatus({ projectDir: project });
      console.log(json ? JSON.stringify(status, null, 2) : `\ntelemetry · ${status.enabled ? 'ENABLED (opt-in local)' : 'DISABLED (default)'} · ${status.recordedEvents} event(s) · network: ${status.networkTransmission}\n`);
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const status = configureTelemetry({ projectDir: project, enabled: sub === 'enable' });
      console.log(json ? JSON.stringify(status, null, 2) : `\n✓ telemetry ${status.enabled ? 'enabled (local anonymous counters only; zero automatic network calls)' : 'disabled'}\n`);
      return;
    }
    if (sub === 'purge') {
      const status = purgeTelemetry({ projectDir: project });
      console.log(json ? JSON.stringify(status, null, 2) : `\n✓ purged local telemetry (${status.recordedEvents} remaining)\n`);
      return;
    }
    fail('Usage: vld telemetry <status|enable|disable|purge> [--project <dir>] [--json]');
  } catch (error) {
    fail(error.message);
  }
}

const EXPERIMENTAL = new Set(['runtime', 'workspace', 'mission', 'workflow', 'agent', 'studio', 'sandbox', 'build']);
function experimentalGate() {
  if (command === 'experimental') {
    const requested = rest.find((item) => !item.startsWith('-'));
    if (!requested) fail('Usage: vld experimental <runtime|workspace|mission|workflow|agent|studio|sandbox|build> … — see docs/EXPERIMENTAL.md');
    if (!EXPERIMENTAL.has(requested)) {
      fail(`"${requested}" is not an experimental runtime command. One of: ${[...EXPERIMENTAL].join(', ')}.`);
    }
    // Re-dispatch: drop the word so the existing handlers see their own argv.
    argv.splice(argv.indexOf('experimental'), 1);
    command = argv[0];
    rest = argv.slice(1);
    // `positional` was derived from the original argv; recompute it the same way.
    positional.length = 0;
    rest.forEach((item, index) => {
      if (!item.startsWith('-') && !(index > 0 && VALUE_FLAGS.has(rest[index - 1]))) positional.push(item);
    });
    return;
  }
  if (!EXPERIMENTAL.has(command)) return;
  // The bare spelling still works; print the experimental boundary notice once per
  // interactive/labelled session so onboarding is clear without spamming every call.
  if (!hasFlag('--json') && shouldPrintExperimentalNotice()) {
    console.error(
      `note: \`vld ${command}\` is the experimental runtime, not the compiler. ` +
        'It starts unconfined same-user processes; see docs/EXPERIMENTAL.md. ' +
        `Prefer \`vld experimental ${argv.join(' ')} …\`.`
    );
  }
}

experimentalGate();
validateCliTokens();
validateTopLevelFlags();

switch (command) {
  case 'init':
    runInit(positional[0]).catch((error) => fail(error.message));
    break;
  case 'intake':
    runIntakeCommand().catch((error) => fail(error.message));
    break;
  case 'doctor':
    runDoctorCommand();
    break;
  case 'migrate':
    runMigrateCommand();
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
  case 'discoverability-readiness':
    await runDiscoverabilityReadiness();
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
    runMission().catch((error) => fail(error.message));
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
  case 'sandbox':
    runSandboxCommand().catch((error) => fail(error.message));
    break;
  case 'build':
    runBuildCommand().catch((error) => fail(error.message));
    break;
  case 'review':
    await runReviewCommand();
    break;
  case 'drift':
    runDriftCommand();
    break;
  case 'evidence':
    runEvidenceCommand();
    break;
  case 'telemetry':
    runTelemetryCommand();
    break;
  case 'mcp':
    runMcp();
    break;
  case 'compile':
    runCompile(positional[0]);
    break;
  case 'verify':
    await runVerify(positional[0]);
    break;
  case 'ci':
    runCi();
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
