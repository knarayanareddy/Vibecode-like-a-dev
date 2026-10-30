/**
 * Typed, resumable VLD workflows.
 *
 * A workflow is deliberately not an arbitrary shell runner. Builtin command steps
 * can invoke only a small allowlist of VLD CLI actions through execFileSync (never
 * a shell), while agent handoffs and approvals require explicit evidence from a
 * human. Runtime state lives outside compiled packets in `.vld/workflows/`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './indexer.mjs';
import { ARTIFACTS, verifyArtifacts } from './artifacts.mjs';
import { requireVerifiedModules } from './modules.mjs';
import {
  ID_PATTERN,
  SEMVER_PATTERN,
  digest,
  ensureProjectDir,
  extensionError,
  readJson,
  vldDir,
  writeJsonAtomic
} from './extension-utils.mjs';

export const WORKFLOWS_DIR = path.join(ROOT, 'factory', 'workflows');
const STEP_TYPES = new Set(['human-input', 'agent-handoff', 'command', 'validation', 'artifact-validation', 'approval', 'gate']);
const EXECUTABLE_TYPES = new Set(['command', 'validation', 'artifact-validation', 'gate']);
const MANUAL_TYPES = new Set(['human-input', 'agent-handoff', 'approval']);
const ALLOWED_COMMANDS = new Set(['plan', 'compile', 'verify']);

function workflowPath(id) {
  return path.join(WORKFLOWS_DIR, `${id}.json`);
}

function validStringList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() && !/[\r\n]/.test(entry));
}

export function validateWorkflow(workflow, expectedId = workflow?.id) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return [`${expectedId ?? 'workflow'}: workflow is not an object`];
  if (workflow.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
  if (!workflow.id || !ID_PATTERN.test(workflow.id)) errors.push('id: required, lowercase kebab-case');
  else if (expectedId && workflow.id !== expectedId) errors.push(`id: "${workflow.id}" does not match file name "${expectedId}"`);
  if (!SEMVER_PATTERN.test(String(workflow.version ?? ''))) errors.push('version: required semantic version');
  for (const field of ['title', 'summary']) {
    if (typeof workflow[field] !== 'string' || workflow[field].trim().length < (field === 'summary' ? 20 : 3) || /[\r\n]/.test(workflow[field])) errors.push(`${field}: required one-line string`);
  }
  if (!validStringList(workflow.requiresModules) || new Set(workflow.requiresModules ?? []).size !== (workflow.requiresModules ?? []).length) errors.push('requiresModules: must be a unique list of module ids');
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    errors.push('steps: must be a non-empty list');
    return errors;
  }

  const ids = new Set();
  for (const [index, step] of workflow.steps.entries()) {
    const label = `steps[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${label}: must be an object`);
      continue;
    }
    if (!step.id || !ID_PATTERN.test(step.id)) errors.push(`${label}.id: required, lowercase kebab-case`);
    else if (ids.has(step.id)) errors.push(`${label}.id: "${step.id}" repeats`);
    else ids.add(step.id);
    if (!STEP_TYPES.has(step.type)) errors.push(`${label}.type: must be ${[...STEP_TYPES].join(', ')}`);
    if (typeof step.description !== 'string' || step.description.trim().length < 20 || /[\r\n]/.test(step.description)) errors.push(`${label}.description: required one-line string of at least 20 characters`);
    if (step.dependsOn !== undefined && (!validStringList(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length)) errors.push(`${label}.dependsOn: must be a unique list of step ids`);
    if (['command', 'validation', 'gate'].includes(step.type)) {
      if (!validStringList(step.run) || step.run.length < 1) errors.push(`${label}.run: executable steps require an argv list`);
      else if (!ALLOWED_COMMANDS.has(step.run[0])) errors.push(`${label}.run[0]: only ${[...ALLOWED_COMMANDS].join(', ')} are allowed in builtin workflows`);
    } else if (step.run !== undefined) {
      errors.push(`${label}.run: only command, validation and gate steps may run an argv command`);
    }
    if (step.type === 'artifact-validation') {
      if (!validStringList(step.artifacts) || step.artifacts.length < 1) errors.push(`${label}.artifacts: requires a non-empty list of artifact types`);
      else {
        if (new Set(step.artifacts).size !== step.artifacts.length) errors.push(`${label}.artifacts: artifact types must not repeat`);
        for (const artifact of step.artifacts) if (!ARTIFACTS[artifact]) errors.push(`${label}.artifacts: unknown artifact type "${artifact}"`);
      }
    } else if (step.artifacts !== undefined) {
      errors.push(`${label}.artifacts: only artifact-validation steps may declare artifacts`);
    }
    if (step.type === 'agent-handoff') {
      if (!step.module || !ID_PATTERN.test(step.module)) errors.push(`${label}.module: agent handoff needs a module id`);
      if (!step.skill || !/^vld-[a-z0-9-]+$/.test(step.skill)) errors.push(`${label}.skill: agent handoff needs a VLD skill name`);
    } else if (step.module !== undefined || step.skill !== undefined) {
      errors.push(`${label}: module and skill only apply to an agent-handoff`);
    }
  }

  const byId = new Map(workflow.steps.filter((step) => step?.id).map((step) => [step.id, step]));
  for (const step of workflow.steps) {
    for (const dependency of step?.dependsOn ?? []) {
      if (!byId.has(dependency)) errors.push(`step "${step.id}" depends on missing step "${dependency}"`);
      if (dependency === step.id) errors.push(`step "${step.id}" cannot depend on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) {
      errors.push(`workflow dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return errors;
}

export function listWorkflows() {
  const workflows = [];
  const errors = [];
  for (const entry of readdirSync(WORKFLOWS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    try {
      const workflow = readJson(workflowPath(id));
      errors.push(...validateWorkflow(workflow, id).map((problem) => `${entry.name}: ${problem}`));
      workflows.push({ ...workflow, digest: digest(workflow), source: `factory/workflows/${entry.name}` });
    } catch (error) {
      errors.push(`${entry.name}: invalid JSON (${error.message})`);
    }
  }
  return { workflows, errors };
}

export function getWorkflow(id) {
  const catalogue = listWorkflows();
  if (catalogue.errors.length > 0) throw extensionError(`builtin workflows are invalid:\n${catalogue.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_WORKFLOW_CATALOGUE');
  const workflow = catalogue.workflows.find((entry) => entry.id === id);
  if (!workflow) throw extensionError(`unknown workflow "${id}". Known: ${catalogue.workflows.map((entry) => entry.id).join(', ')}`, 'UNKNOWN_WORKFLOW');
  return workflow;
}

function statePath(project, id) {
  return path.join(vldDir(project), 'workflows', `${id}.json`);
}

function normalizedContext(project, context = {}) {
  return {
    project,
    profile: path.resolve(context.profile ?? path.join(project, 'profile.json')),
    packet: path.resolve(context.packet ?? path.join(project, 'specs')),
    repo: path.resolve(context.repo ?? project)
  };
}

function newState(workflow, project, context) {
  return {
    schemaVersion: 1,
    workflow: workflow.id,
    version: workflow.version,
    workflowDigest: workflow.digest,
    context: normalizedContext(project, context),
    steps: Object.fromEntries(workflow.steps.map((step) => [step.id, { status: 'pending' }]))
  };
}

function validateState(state, workflow, file) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [`${file}: state is not an object`];
  if (state.schemaVersion !== 1) errors.push(`${file}: schemaVersion must be 1`);
  if (state.workflow !== workflow.id) errors.push(`${file}: workflow does not match ${workflow.id}`);
  if (state.version !== workflow.version || state.workflowDigest !== workflow.digest) errors.push(`${file}: workflow definition differs from state; reset only after reviewing the workflow update`);
  if (!state.context || typeof state.context !== 'object') errors.push(`${file}: context is missing`);
  if (!state.steps || typeof state.steps !== 'object' || Array.isArray(state.steps)) errors.push(`${file}: steps are missing`);
  for (const step of workflow.steps) {
    const entry = state.steps?.[step.id];
    if (!entry || !['pending', 'complete', 'failed'].includes(entry.status)) errors.push(`${file}: step "${step.id}" has an invalid status`);
  }
  for (const id of Object.keys(state.steps ?? {})) if (!workflow.steps.some((step) => step.id === id)) errors.push(`${file}: state contains unknown step "${id}"`);
  return errors;
}

function loadState(project, workflow) {
  const file = statePath(project, workflow.id);
  if (!existsSync(file)) return { file, state: null, errors: [] };
  try {
    const state = readJson(file);
    return { file, state, errors: validateState(state, workflow, file) };
  } catch (error) {
    return { file, state: null, errors: [`${file}: invalid JSON (${error.message})`] };
  }
}

function statusFor(workflow, state) {
  const outcome = [];
  for (const step of workflow.steps) {
    const record = state.steps[step.id];
    let status = record.status;
    if (status === 'pending') {
      const dependencies = step.dependsOn ?? [];
      const failed = dependencies.some((id) => state.steps[id].status === 'failed');
      const complete = dependencies.every((id) => state.steps[id].status === 'complete');
      status = failed ? 'blocked' : complete ? 'ready' : 'blocked';
    }
    outcome.push({ ...step, status, evidence: record.evidence ?? null });
  }
  return outcome;
}

export function workflowStatus({ id, projectDir = '.', requireStarted = true }) {
  const project = ensureProjectDir(projectDir);
  const workflow = getWorkflow(id);
  const loaded = loadState(project, workflow);
  if (loaded.errors.length > 0) throw extensionError(loaded.errors.join('\n'), 'INVALID_WORKFLOW_STATE');
  if (!loaded.state && requireStarted) throw extensionError(`workflow "${id}" has not started. Run \`vld workflow run ${id} --project ${project} --execute\` to start it.`, 'WORKFLOW_NOT_STARTED');
  const state = loaded.state ?? newState(workflow, project, {});
  return { project, workflow, file: loaded.file, state, started: Boolean(loaded.state), steps: statusFor(workflow, state) };
}

export function previewWorkflow({ id, projectDir = '.', context = {} }) {
  const project = ensureProjectDir(projectDir);
  const workflow = getWorkflow(id);
  const status = workflowStatus({ id, projectDir: project, requireStarted: false });
  return { ...status, state: status.started ? status.state : newState(workflow, project, context), context: normalizedContext(project, context) };
}

export function startWorkflow({ id, projectDir = '.', context = {}, reset = false }) {
  const project = ensureProjectDir(projectDir);
  const workflow = getWorkflow(id);
  requireVerifiedModules(project, workflow.requiresModules);
  const loaded = loadState(project, workflow);
  if (loaded.errors.length > 0 && !reset) throw extensionError(loaded.errors.join('\n'), 'INVALID_WORKFLOW_STATE');
  if (loaded.state && !reset) return { project, workflow, file: loaded.file, state: loaded.state, created: false };
  const state = newState(workflow, project, context);
  writeJsonAtomic(loaded.file, state);
  return { project, workflow, file: loaded.file, state, created: true };
}

function evidenceForManual(evidence) {
  if (typeof evidence !== 'string' || evidence.trim().length < 8 || evidence.trim().length > 2000 || /[\r\n]/.test(evidence)) {
    throw extensionError('manual completion needs --evidence with 8-2000 one-line characters describing the artifact or decision', 'EVIDENCE_REQUIRED');
  }
  return evidence.trim();
}

export function completeWorkflowStep({ id, stepId, projectDir = '.', evidence }) {
  const project = ensureProjectDir(projectDir);
  const workflow = getWorkflow(id);
  // A handoff is meaningful only while its locked module set still matches the
  // version that produced it. Do not let an in-progress workflow bypass drift.
  requireVerifiedModules(project, workflow.requiresModules);
  const loaded = loadState(project, workflow);
  if (loaded.errors.length > 0 || !loaded.state) throw extensionError(loaded.errors.join('\n') || `workflow "${id}" has not started`, 'WORKFLOW_NOT_STARTED');
  const step = workflow.steps.find((entry) => entry.id === stepId);
  if (!step) throw extensionError(`workflow "${id}" has no step "${stepId}"`, 'UNKNOWN_WORKFLOW_STEP');
  if (!MANUAL_TYPES.has(step.type)) throw extensionError(`step "${stepId}" is executable; use \`vld workflow run ${id} --execute\` instead of manually claiming it complete`, 'EXECUTABLE_STEP');
  const stateSteps = statusFor(workflow, loaded.state);
  const current = stateSteps.find((entry) => entry.id === stepId);
  if (current.status === 'complete') return { project, workflow, file: loaded.file, state: loaded.state, changed: false };
  if (current.status !== 'ready') throw extensionError(`step "${stepId}" is ${current.status}; complete its dependencies first`, 'WORKFLOW_STEP_BLOCKED');
  loaded.state.steps[stepId] = { status: 'complete', evidence: { type: 'human', note: evidenceForManual(evidence) } };
  writeJsonAtomic(loaded.file, loaded.state);
  return { project, workflow, file: loaded.file, state: loaded.state, changed: true };
}

function resolveArg(token, context) {
  return String(token).replace(/\{(profile|packet|repo|project)\}/g, (_, name) => context[name]);
}

function runStep(step, context) {
  if (step.type === 'artifact-validation') {
    try {
      const report = verifyArtifacts({ projectDir: context.project, packetDir: context.packet, kinds: step.artifacts });
      return {
        status: report.ok ? 'complete' : 'failed',
        evidence: {
          type: 'artifact-validation',
          artifacts: [...step.artifacts],
          reportDigest: digest({ artifacts: report.artifacts.map((artifact) => ({ kind: artifact.kind, id: artifact.id, strictOk: artifact.strictOk })), requirements: report.requirements, errors: report.errors, warnings: report.warnings }),
          summary: report.ok ? `${report.artifacts.length} artifact(s) verified` : `${report.errors.length} artifact verification finding(s)`
        }
      };
    } catch (error) {
      return { status: 'failed', evidence: { type: 'artifact-validation', artifacts: [...step.artifacts], summary: error.message, reportDigest: digest(error.message) } };
    }
  }
  const argv = step.run.map((token) => resolveArg(token, context));
  const action = argv[0];
  if (!ALLOWED_COMMANDS.has(action)) throw extensionError(`workflow step "${step.id}" has a disallowed action`, 'DISALLOWED_WORKFLOW_COMMAND');
  const cli = path.join(ROOT, 'factory', 'cli.mjs');
  try {
    const output = execFileSync(process.execPath, [cli, ...argv], {
      cwd: context.project,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 'complete', evidence: { type: 'command', argv, outputDigest: digest(output) } };
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    const stderr = String(error.stderr ?? '');
    return {
      status: 'failed',
      evidence: {
        type: 'command',
        argv,
        exitCode: Number.isInteger(error.status) ? error.status : 1,
        outputDigest: digest(`${stdout}\n${stderr}`),
        summary: `${action} exited ${Number.isInteger(error.status) ? error.status : 1}`
      }
    };
  }
}

/**
 * Execute ready builtin command steps until an agent/human step blocks progress,
 * a command fails, or the workflow completes. No shell is involved and no agent is
 * invoked. A second run resumes from the saved state.
 */
export function runWorkflow({ id, projectDir = '.', context = {}, execute = false, reset = false }) {
  const project = ensureProjectDir(projectDir);
  if (!execute) return previewWorkflow({ id, projectDir: project, context });
  const started = startWorkflow({ id, projectDir: project, context, reset });
  const { workflow, state } = started;
  let executed = [];
  while (true) {
    const ready = statusFor(workflow, state).find((step) => step.status === 'ready');
    if (!ready || !EXECUTABLE_TYPES.has(ready.type)) break;
    const result = runStep(ready, state.context);
    state.steps[ready.id] = result;
    executed.push({ id: ready.id, status: result.status, evidence: result.evidence });
    writeJsonAtomic(started.file, state);
    if (result.status === 'failed') break;
  }
  return { project, workflow, file: started.file, state, created: started.created, executed, steps: statusFor(workflow, state) };
}
