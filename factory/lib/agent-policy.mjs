/**
 * Closed, data-only policy for the optional M4 adapter host.
 *
 * This is intentionally distinct from the M3 Runtime policy: M3 remains closed
 * to process execution. An M4 adapter invocation needs an additional, explicit
 * reviewed policy file that names one adapter and its bounded capabilities.
 * Neither policy may carry a shell fragment, credential reference or plugin.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { digest, ensureProjectDir, extensionError, ID_PATTERN } from './extension-utils.mjs';

export const AGENT_POLICY_SCHEMA_VERSION = 1;
export const AGENT_ADAPTER_IDS = Object.freeze(['fake', 'local-process']);
export const AGENT_CAPABILITIES = Object.freeze([
  'readWorkspace',
  'writeWorkspace',
  'runDeclaredCommands',
  'network',
  'streamEvents',
  'cancel',
  'reconnect',
  'sandbox',
  'credentialAccess',
  'gitPush',
  'gitMerge'
]);

const POLICY_FIELDS = new Set(['schemaVersion', 'id', 'adapter', 'mode', 'capabilities', 'limits', 'environment', 'command']);
const LIMIT_FIELDS = new Set(['durationMs', 'outputBytes', 'retryBudget']);
const COMMAND_FIELDS = new Set(['script', 'executable', 'args']);
const SAFE_ENVIRONMENT_NAMES = new Set(['LANG', 'LC_ALL', 'TZ', 'NO_COLOR']);
const FAKE_SCRIPTS = new Set(['succeed', 'fail', 'silent']);
const MAX_DURATION_MS = 15 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SECRETISH = /(?:token|secret|password|credential|authorization|api[_-]?key)/i;
const EVAL_ARGUMENT = /^(?:-c|-e|-p|--(?:command|eval|print)(?:=|$)|--env(?:=|$))/;

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function closedObject(value, allowed, label, errors) {
  if (!plainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  return true;
}

function safeText(value, { minimum = 1, maximum = 240 } = {}) {
  return typeof value === 'string'
    && value.trim().length >= minimum
    && value.length <= maximum
    && !/[\r\n\0]/.test(value);
}

function safeAbsoluteExecutable(value) {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && value.length <= 4096
    && !/[\r\n\0]/.test(value)
    && !value.split(path.sep).includes('..');
}

/** A closed fake policy is useful in CI and never launches a host process. */
export function defaultFakeAgentPolicy() {
  return {
    schemaVersion: AGENT_POLICY_SCHEMA_VERSION,
    id: 'fake-agent-v1',
    adapter: 'fake',
    mode: 'write-workspace',
    capabilities: {
      readWorkspace: true,
      writeWorkspace: true,
      runDeclaredCommands: false,
      network: false,
      streamEvents: true,
      cancel: true,
      reconnect: true,
      sandbox: true,
      credentialAccess: false,
      gitPush: false,
      gitMerge: false
    },
    limits: { durationMs: 5_000, outputBytes: 8_192, retryBudget: 0 },
    environment: {},
    command: { script: 'succeed', executable: null, args: [] }
  };
}

/**
 * Structural validation deliberately performs no filesystem lookup, so policy
 * review/digest tests are deterministic. `resolveLocalProcessCommand` performs
 * the executable resolution immediately before spawn.
 */
export function validateAgentPolicy(policy) {
  const errors = [];
  closedObject(policy, POLICY_FIELDS, 'agent policy', errors);
  if (!plainObject(policy)) return { ok: false, errors };
  if (policy.schemaVersion !== AGENT_POLICY_SCHEMA_VERSION) errors.push(`agent policy schemaVersion must be ${AGENT_POLICY_SCHEMA_VERSION}`);
  if (!ID_PATTERN.test(String(policy.id ?? ''))) errors.push('agent policy id must be lowercase kebab-case');
  if (!AGENT_ADAPTER_IDS.includes(policy.adapter)) errors.push(`agent policy adapter must be one of: ${AGENT_ADAPTER_IDS.join(', ')}`);
  if (!['read-only', 'write-workspace'].includes(policy.mode)) errors.push('agent policy mode must be read-only or write-workspace');

  if (closedObject(policy.capabilities, new Set(AGENT_CAPABILITIES), 'agent policy.capabilities', errors)) {
    for (const capability of AGENT_CAPABILITIES) {
      if (typeof policy.capabilities[capability] !== 'boolean') errors.push(`agent policy.capabilities.${capability} must be boolean`);
    }
    if (policy.capabilities.network !== false) errors.push('M4 agent policy.capabilities.network must be false');
    if (policy.capabilities.credentialAccess !== false) errors.push('M4 agent policy.capabilities.credentialAccess must be false');
    if (policy.capabilities.gitPush !== false || policy.capabilities.gitMerge !== false) errors.push('M4 agent policy must deny Git push and merge');
    if (policy.capabilities.writeWorkspace !== (policy.mode === 'write-workspace')) errors.push('agent policy writeWorkspace must exactly match mode');
  }

  if (closedObject(policy.limits, LIMIT_FIELDS, 'agent policy.limits', errors)) {
    const { durationMs, outputBytes, retryBudget } = policy.limits;
    if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > MAX_DURATION_MS) errors.push(`agent policy.limits.durationMs must be an integer from 100 to ${MAX_DURATION_MS}`);
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 1024 || outputBytes > MAX_OUTPUT_BYTES) errors.push(`agent policy.limits.outputBytes must be an integer from 1024 to ${MAX_OUTPUT_BYTES}`);
    if (!Number.isSafeInteger(retryBudget) || retryBudget < 0 || retryBudget > 3) errors.push('agent policy.limits.retryBudget must be an integer from 0 to 3');
  }

  if (!plainObject(policy.environment)) {
    errors.push('agent policy.environment must be an object');
  } else {
    for (const [name, value] of Object.entries(policy.environment)) {
      if (!SAFE_ENVIRONMENT_NAMES.has(name)) errors.push(`agent policy.environment.${name} is not an approved non-secret environment key`);
      if (!safeText(value, { maximum: 240 }) || SECRETISH.test(value)) errors.push(`agent policy.environment.${name} must be a bounded non-secret one-line value`);
    }
  }

  if (closedObject(policy.command, COMMAND_FIELDS, 'agent policy.command', errors)) {
    const { script, executable, args } = policy.command;
    if (!Array.isArray(args) || args.length > 64 || args.some((arg) => !safeText(arg, { maximum: 2_048 }) || EVAL_ARGUMENT.test(arg) || SECRETISH.test(arg))) {
      errors.push('agent policy.command.args must be at most 64 bounded non-secret arguments without eval/shell/environment flags');
    }
    if (policy.adapter === 'fake') {
      if (!FAKE_SCRIPTS.has(script)) errors.push(`fake adapter script must be one of: ${[...FAKE_SCRIPTS].join(', ')}`);
      if (executable !== null) errors.push('fake adapter command.executable must be null');
      if (policy.capabilities?.runDeclaredCommands !== false) errors.push('fake adapter must not have process command authority');
    }
    if (policy.adapter === 'local-process') {
      if (script !== null) errors.push('local-process command.script must be null');
      if (!safeAbsoluteExecutable(executable)) errors.push('local-process command.executable must be a safe absolute path');
      // A bare local process has no portable filesystem containment. Do not
      // pretend CWD is a sandbox; a future explicit sandbox adapter owns writes.
      if (policy.mode !== 'read-only' || policy.capabilities?.writeWorkspace !== false || policy.capabilities?.sandbox !== false) {
        errors.push('local-process is read-only until a separately reviewed sandbox adapter is available');
      }
      if (policy.capabilities?.runDeclaredCommands !== true) errors.push('local-process requires runDeclaredCommands: true for its one declared argv');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertAgentPolicy(policy) {
  const checked = validateAgentPolicy(policy);
  if (!checked.ok) throw extensionError(`agent policy is invalid:\n${checked.errors.map((entry) => `- ${entry}`).join('\n')}`, 'INVALID_AGENT_POLICY');
  return policy;
}

export function agentPolicyDigest(policy) {
  return digest(assertAgentPolicy(policy));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Load a reviewed, regular JSON policy file from inside the project boundary. */
export function loadAgentPolicy(policyFile, { projectDir = '.' } = {}) {
  const project = ensureProjectDir(projectDir);
  if (typeof policyFile !== 'string' || !policyFile.trim() || path.isAbsolute(policyFile) || /[\r\n\0]/.test(policyFile)) {
    throw extensionError('agent policy file must be a non-empty relative path inside the project', 'INVALID_AGENT_POLICY_PATH');
  }
  const file = path.resolve(project, policyFile);
  if (!isWithin(project, file)) throw extensionError('agent policy file escapes the project', 'INVALID_AGENT_POLICY_PATH');
  let cursor = project;
  for (const part of path.relative(project, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw extensionError('agent policy file may not traverse a symbolic link', 'INVALID_AGENT_POLICY_PATH');
  }
  if (!existsSync(file) || !lstatSync(file).isFile()) throw extensionError('agent policy file is not a regular file', 'AGENT_POLICY_NOT_FOUND');
  let policy;
  try { policy = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw extensionError(`agent policy file is invalid JSON: ${error.message}`, 'INVALID_AGENT_POLICY'); }
  assertAgentPolicy(policy);
  return { project, file, policy, digest: agentPolicyDigest(policy) };
}

/** Resolve the exact executable just before spawn; no PATH lookup is permitted. */
export function resolveLocalProcessCommand(policy) {
  assertAgentPolicy(policy);
  if (policy.adapter !== 'local-process') throw extensionError('agent policy does not select the local-process adapter', 'INVALID_AGENT_POLICY');
  const requested = policy.command.executable;
  let resolved;
  try { resolved = realpathSync(path.resolve(requested)); } catch { throw extensionError('local-process executable cannot be resolved', 'INVALID_AGENT_EXECUTABLE'); }
  if (!safeAbsoluteExecutable(resolved)) throw extensionError('local-process executable is not a safe absolute path', 'INVALID_AGENT_EXECUTABLE');
  let stats;
  try { stats = lstatSync(resolved); } catch { throw extensionError('local-process executable is unavailable', 'INVALID_AGENT_EXECUTABLE'); }
  if (stats.isSymbolicLink() || !stats.isFile()) throw extensionError('local-process executable is not a regular file', 'INVALID_AGENT_EXECUTABLE');
  if ((stats.mode & 0o111) === 0) throw extensionError('local-process executable is not executable', 'INVALID_AGENT_EXECUTABLE');
  return { executable: resolved, args: [...policy.command.args] };
}
