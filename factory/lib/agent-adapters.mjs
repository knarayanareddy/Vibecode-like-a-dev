/**
 * M4 adapter implementations.
 *
 * The fake adapter is deterministic and has no host-process authority. The
 * local-process adapter starts exactly one policy-declared executable using
 * direct argv spawning; it never uses a shell, PATH search or inherited env.
 * A portable process CWD is not a filesystem/network/credential sandbox.
 * `local-process` is an unconfined host process with no VLD workspace-write
 * authority until a separately reviewed OS sandbox adapter exists.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  agentPolicyDigest,
  ALL_AGENT_ADAPTER_IDS,
  assertAgentPolicy,
  resolveDeclaredExecutable,
  resolveLocalProcessCommand
} from './agent-policy.mjs';
import { verifyAgentTranscript } from './agent-transcript.mjs';
import { digest, extensionError } from './extension-utils.mjs';
import { runSandboxed } from './sandbox/index.mjs';
import { createModelBroker } from './sandbox/broker.mjs';

const KILL_GRACE_MS = 250;
const EVENT_TYPES = new Set(['started', 'progress', 'output', 'completed', 'failed', 'cancelled', 'timed-out']);
const SECRET_ASSIGNMENT = /\b((?:api[_-]?key|token|secret|password|credential|authorization)\s*(?:=|:)\s*)([^\s,;]+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi;
const ABSOLUTE_PATH = /(^|[\s=])(?:\/[A-Za-z0-9._-]+){2,}(?=$|[\s,;])/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s,;\\]+\\)+[^\s,;\\]*/g;

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(extensionError('agent run was cancelled', 'AGENT_CANCELLED'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(extensionError('agent run was cancelled', 'AGENT_CANCELLED'));
    }, { once: true });
  });
}

function nowIso() {
  return new Date().toISOString();
}

/** Validate the selected CWD only; this does not constrain child filesystem access. */
function workspaceDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !existsSync(value)) throw extensionError('agent workspace is unavailable', 'AGENT_WORKSPACE_UNAVAILABLE');
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw extensionError('agent workspace is not a real directory', 'AGENT_WORKSPACE_UNAVAILABLE');
  return path.resolve(value);
}

export function redactAgentOutput(value) {
  return String(value ?? '')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(ABSOLUTE_PATH, '$1[REDACTED_PATH]')
    .replace(WINDOWS_PATH, '[REDACTED_PATH]')
    .replace(/[\r\n\0]/g, ' ')
    .slice(0, 4_000);
}

/** Reject adapter-provided event shapes before the Runtime sees an event. */
export function normalizeAdapterEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw extensionError('agent adapter event must be an object', 'INVALID_AGENT_EVENT');
  const allowed = new Set(['type', 'at', 'message', 'stream', 'bytes']);
  for (const key of Object.keys(event)) if (!allowed.has(key)) throw extensionError(`agent adapter event.${key} is not allowed`, 'INVALID_AGENT_EVENT');
  if (!EVENT_TYPES.has(event.type)) throw extensionError('agent adapter event type is not supported', 'INVALID_AGENT_EVENT');
  if (typeof event.at !== 'string' || Number.isNaN(new Date(event.at).getTime())) throw extensionError('agent adapter event timestamp is invalid', 'INVALID_AGENT_EVENT');
  if (event.message !== undefined && (typeof event.message !== 'string' || event.message.length > 500 || /[\r\n\0]/.test(event.message))) throw extensionError('agent adapter event message is invalid', 'INVALID_AGENT_EVENT');
  if (event.stream !== undefined && !['stdout', 'stderr'].includes(event.stream)) throw extensionError('agent adapter event stream is invalid', 'INVALID_AGENT_EVENT');
  if (event.bytes !== undefined && (!Number.isSafeInteger(event.bytes) || event.bytes < 0)) throw extensionError('agent adapter event bytes is invalid', 'INVALID_AGENT_EVENT');
  return {
    type: event.type,
    at: event.at,
    ...(event.message ? { message: redactAgentOutput(event.message) } : {}),
    ...(event.stream ? { stream: event.stream } : {}),
    ...(event.bytes !== undefined ? { bytes: event.bytes } : {})
  };
}

function emit(onEvent, event) {
  const normalized = normalizeAdapterEvent(event);
  if (typeof onEvent === 'function') onEvent(normalized);
}

function environmentFor(spec, policy) {
  // Never copy process.env. These are non-secret, VLD-derived references plus a
  // four-key policy allowlist; a child cannot receive an accidental parent token.
  return Object.assign(Object.create(null), policy.environment, {
    VLD_RUN_ID: spec.id,
    VLD_MISSION_ID: spec.missionId,
    VLD_PACKAGE_ID: spec.packageId,
    VLD_PACKET_DIGEST: spec.packetDigest,
    VLD_CONTEXT_DIGEST: spec.contextDigest,
    VLD_REQUIREMENT_IDS: spec.requirementIds.join(','),
    ...(Array.isArray(spec.resourceClaims) && spec.resourceClaims.length
      ? { VLD_WRITE_GLOBS: spec.resourceClaims.join(',') }
      : {})
  });
}

async function runFake({ policy, signal, onEvent }) {
  const startedAt = nowIso();
  emit(onEvent, { type: 'started', at: startedAt, message: 'deterministic fake adapter started' });
  try {
    await sleep(Math.min(policy.limits.durationMs, 20), signal);
  } catch (error) {
    if (error.code === 'AGENT_CANCELLED') {
      emit(onEvent, { type: 'cancelled', at: nowIso(), message: 'fake adapter cancelled' });
      return { outcome: 'cancelled', exitCode: null, signal: 'SIGTERM', outputDigest: digest(''), outputBytes: 0, outputSummary: '', startedAt, finishedAt: nowIso() };
    }
    throw error;
  }
  if (policy.command.script === 'fail') {
    emit(onEvent, { type: 'failed', at: nowIso(), message: 'fake adapter reported failure' });
    return { outcome: 'failed', exitCode: 1, signal: null, outputDigest: digest(''), outputBytes: 0, outputSummary: '', startedAt, finishedAt: nowIso() };
  }
  if (policy.command.script !== 'silent') emit(onEvent, { type: 'progress', at: nowIso(), message: 'fake adapter completed its scripted work' });
  emit(onEvent, { type: 'completed', at: nowIso(), message: 'fake adapter completed' });
  return { outcome: 'completed', exitCode: 0, signal: null, outputDigest: digest(''), outputBytes: 0, outputSummary: '', startedAt, finishedAt: nowIso() };
}

function terminateProcess(child, reason) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode) return;
    try {
      if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
  }, KILL_GRACE_MS).unref();
  return reason;
}

function runLocalProcess({ spec, policy, signal, onEvent }) {
  const command = resolveLocalProcessCommand(policy);
  const cwd = workspaceDirectory(spec.workspace);
  const startedAt = nowIso();
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let outputBytes = 0;
    let storedBytes = 0;
    let captured = '';
    const outputHash = createHash('sha256');

    const finish = ({ outcome, exitCode = null, exitSignal = null, startError = null } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const rawSummary = captured + (storedBytes < outputBytes ? '\n[output truncated]' : '');
      const outputSummary = redactAgentOutput(rawSummary);
      const result = {
        outcome,
        exitCode,
        signal: exitSignal,
        outputDigest: outputHash.digest('hex'),
        outputBytes,
        outputSummary,
        startedAt,
        finishedAt: nowIso(),
        ...(startError ? { startError: redactAgentOutput(startError) } : {})
      };
      const type = outcome === 'completed' ? 'completed' : outcome === 'timed-out' ? 'timed-out' : outcome === 'cancelled' ? 'cancelled' : 'failed';
      emit(onEvent, { type, at: result.finishedAt, message: outcome === 'completed' ? 'local process completed' : `local process ${outcome}` });
      resolve(result);
    };
    const capture = (stream, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      outputHash.update(buffer);
      if (storedBytes < policy.limits.outputBytes) {
        const slice = buffer.subarray(0, policy.limits.outputBytes - storedBytes);
        captured += slice.toString('utf8');
        storedBytes += slice.length;
      }
      emit(onEvent, { type: 'output', at: nowIso(), stream, bytes: buffer.length });
    };
    const onAbort = () => {
      cancelled = true;
      terminateProcess(child, 'cancelled');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child, 'timed-out');
    }, policy.limits.durationMs);

    try {
      child = spawn(command.executable, command.args, {
        cwd,
        env: environmentFor(spec, policy),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32'
      });
      emit(onEvent, { type: 'started', at: startedAt, message: 'local process adapter started' });
      child.stdout?.on('data', (chunk) => capture('stdout', chunk));
      child.stderr?.on('data', (chunk) => capture('stderr', chunk));
      child.once('error', (error) => finish({ outcome: 'failed', startError: error.message }));
      child.once('close', (exitCode, exitSignal) => {
        if (timedOut) finish({ outcome: 'timed-out', exitCode, exitSignal });
        else if (cancelled) finish({ outcome: 'cancelled', exitCode, exitSignal });
        else if (exitCode === 0) finish({ outcome: 'completed', exitCode, exitSignal });
        else finish({ outcome: 'failed', exitCode, exitSignal });
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    } catch (error) {
      finish({ outcome: 'failed', startError: error.message });
    }
  });
}

async function runSandboxedCli({ spec, policy, signal, onEvent }) {
  const command = resolveDeclaredExecutable(policy, ['sandboxed-cli']);
  const cwd = workspaceDirectory(spec.workspace);
  const sbx = policy.sandbox ?? { backend: 'auto' };
  const startedAt = nowIso();
  emit(onEvent, { type: 'started', at: startedAt, message: 'sandboxed CLI adapter started' });
  const run = await runSandboxed({
    id: `sbx-${spec.id}`,
    executable: command.executable,
    args: command.args,
    workspace: cwd,
    mode: policy.mode,
    network: false,
    allowChildProcess: Boolean(sbx.allowChildProcess),
    extraReadPaths: sbx.extraReadPaths ?? [],
    ociImage: sbx.ociImage,
    backend: sbx.backend ?? 'auto',
    requireOs: Boolean(sbx.requireOs),
    env: environmentFor(spec, policy),
    policyDigest: agentPolicyDigest(policy),
    limits: policy.limits,
    signal,
    onChunk: (stream, buf) => emit(onEvent, { type: 'output', at: nowIso(), stream, bytes: buf.length })
  });
  const finishType = run.outcome === 'completed' ? 'completed' : run.outcome === 'timed-out' ? 'timed-out' : run.outcome === 'cancelled' ? 'cancelled' : 'failed';
  emit(onEvent, { type: finishType, at: run.receipt.finishedAt, message: `sandboxed CLI ${run.outcome} (${run.backend})` });
  return {
    outcome: run.outcome,
    exitCode: run.exitCode,
    signal: run.signal,
    outputDigest: run.outputDigest,
    outputBytes: run.outputBytes,
    outputSummary: redactAgentOutput(`${run.stdout}\n${run.stderr}`),
    startedAt: run.receipt.startedAt,
    finishedAt: run.receipt.finishedAt,
    sandboxReceipt: run.receipt
  };
}

/**
 * Decide whether a `sandboxed-agent` run needs a model broker, and with which
 * provider allow-list. Cassette replay and command providers need no egress.
 * Exported for focused tests.
 */
export function agentModelBrokerSpec({ modelSpec, cassetteMode = null, env = process.env } = {}) {
  if (!modelSpec) return null;
  const separator = String(modelSpec).indexOf(':');
  const provider = separator > 0 ? String(modelSpec).slice(0, separator) : String(modelSpec);
  const rest = separator > 0 ? String(modelSpec).slice(separator + 1) : '';
  const secondSep = rest.indexOf(':');
  const model = secondSep > 0 ? rest.slice(0, secondSep) : rest;
  if (provider === 'command') return null;
  if (cassetteMode === 'replay') return null;
  if (env.VLD_MODEL_NO_BROKER === '1') return null;
  return {
    provider,
    model,
    baseUrl: (secondSep > 0 ? rest.slice(secondSep + 1) : null) ?? env.VLD_MODEL_BASE_URL ?? null,
    budget: {
      maxCalls: Number(env.VLD_MODEL_MAX_CALLS ?? 64),
      maxTokens: Number(env.VLD_MODEL_MAX_TOKENS ?? 200_000),
      maxCostUsd: Number(env.VLD_MODEL_MAX_COST_USD ?? 5)
    }
  };
}

/**
 * The `sandboxed-agent` adapter: runs the built-in tool-loop implementer
 * inside the sandbox. Model egress is broker-only — when a live model is
 * configured (no cassette replay), a loopback model broker is started for the
 * duration of the run and its binding is injected into the sandbox env, so the
 * agent process never holds provider credentials and can only reach the
 * model's allow-listed endpoint. Afterwards the tool transcript written inside
 * the workspace is verified and its digest is attached to the execution.
 */
async function runSandboxedAgent({ spec, policy, signal = null, onEvent = null }) {
  const command = resolveDeclaredExecutable(policy, ['sandboxed-agent']);
  const cwd = workspaceDirectory(spec.workspace);
  const sbx = policy.sandbox ?? { backend: 'auto' };
  const startedAt = nowIso();
  emit(onEvent, { type: 'started', at: startedAt, message: 'sandboxed agent adapter started' });

  const env = environmentFor(spec, policy);
  const brokerSpec = agentModelBrokerSpec({
    modelSpec: env.VLD_MODEL_SPEC ?? null,
    cassetteMode: env.VLD_MODEL_CASSETTE_MODE ?? null,
    env
  });
  let broker = null;
  if (brokerSpec) {
    const nonce = randomBytes(32).toString('hex');
    // Network-isolated backends (linux-ns) run with loopback down, so the
    // broker must be a bind-mounted unix socket there; loopback TCP works
    // under seatbelt/node-permission and on Windows where AF_UNIX is dicey.
    const brokerMode = process.platform === 'linux' ? 'unix-socket' : 'loopback-port';
    broker = createModelBroker({
      mode: brokerMode,
      nonce,
      providers: {
        [brokerSpec.provider]: brokerSpec.baseUrl ? { baseUrl: brokerSpec.baseUrl } : {}
      },
      allowModels: [brokerSpec.model],
      budget: brokerSpec.budget
    });
    await broker.start();
    const binding = broker.binding();
    if (binding.socketPath) env.VLD_MODEL_BROKER_SOCKET = binding.socketPath;
    else env.VLD_MODEL_BROKER_URL = `http://127.0.0.1:${binding.port}`;
    env.VLD_MODEL_BROKER_NONCE = binding.nonce;
    env.VLD_MODEL_BROKER_TOKEN = binding.nonce;
  }

  let run;
  try {
    const cassetteRead = env.VLD_MODEL_CASSETTE_DIR ? [path.resolve(env.VLD_MODEL_CASSETTE_DIR)] : [];
    // Record/auto modes write cassette entries from inside the sandbox.
    const cassetteWrite = env.VLD_MODEL_CASSETTE_DIR && (env.VLD_MODEL_CASSETTE_MODE === 'record' || env.VLD_MODEL_CASSETTE_MODE === 'auto')
      ? [path.resolve(env.VLD_MODEL_CASSETTE_DIR)]
      : [];
    run = await runSandboxed({
      id: `sbx-${spec.id}`,
      executable: command.executable,
      args: command.args,
      workspace: cwd,
      mode: policy.mode,
      network: false,
      broker: broker ? broker.binding() : undefined,
      allowChildProcess: Boolean(sbx.allowChildProcess),
      extraReadPaths: [...(sbx.extraReadPaths ?? []), ...cassetteRead],
      extraWritePaths: cassetteWrite,
      ociImage: sbx.ociImage,
      backend: sbx.backend ?? 'auto',
      requireOs: Boolean(sbx.requireOs),
      env,
      policyDigest: agentPolicyDigest(policy),
      limits: policy.limits,
      signal,
      onChunk: (stream, buf) => emit(onEvent, { type: 'output', at: nowIso(), stream, bytes: buf.length })
    });
  } finally {
    if (broker) await broker.stop();
  }

  // Verify the tool transcript the agent wrote inside its workspace.
  const transcriptBase = path.join(cwd, '.vld', 'agent-transcripts', `${spec.id}`);
  let transcriptDigest = null;
  let agentSummary = null;
  let transcriptVerified = false;
  let transcriptErrors = [];
  if (existsSync(`${transcriptBase}.jsonl`)) {
    const verification = verifyAgentTranscript(readFileSync(`${transcriptBase}.jsonl`, 'utf8'));
    transcriptVerified = verification.ok;
    transcriptErrors = verification.errors;
    transcriptDigest = verification.digest;
    if (existsSync(`${transcriptBase}.summary.json`)) {
      try {
        agentSummary = JSON.parse(readFileSync(`${transcriptBase}.summary.json`, 'utf8'));
      } catch {}
    }
    if (!verification.ok) {
      emit(onEvent, {
        type: 'failed',
        at: nowIso(),
        message: `agent transcript failed verification: ${verification.errors[0] ?? 'unknown'}`
      });
    }
  }

  let outcome = run.outcome;
  if (outcome === 'completed' && !transcriptVerified) outcome = 'failed';
  const finishType = outcome === 'completed' ? 'completed' : outcome === 'timed-out' ? 'timed-out' : outcome === 'cancelled' ? 'cancelled' : 'failed';
  emit(onEvent, { type: finishType, at: run.receipt.finishedAt, message: `sandboxed agent ${outcome} (${run.backend})` });
  return {
    outcome,
    exitCode: run.exitCode,
    signal: run.signal,
    outputDigest: run.outputDigest,
    outputBytes: run.outputBytes,
    outputSummary: redactAgentOutput(`${run.stdout}\n${run.stderr}`),
    startedAt: run.receipt.startedAt,
    finishedAt: run.receipt.finishedAt,
    sandboxReceipt: run.receipt,
    transcriptDigest,
    transcriptVerified,
    transcriptErrors,
    agentSummary,
    ...(agentSummary?.promptHash ? { promptHash: agentSummary.promptHash } : {}),
    ...(Array.isArray(agentSummary?.requestDigests) && agentSummary.requestDigests.length > 0
      ? { requestDigests: agentSummary.requestDigests }
      : {}),
    usage: agentSummary?.usage ?? null
  };
}

export function adapterCapabilities(id) {
  if (!ALL_AGENT_ADAPTER_IDS.includes(id)) throw extensionError('unknown agent adapter', 'UNKNOWN_AGENT_ADAPTER');
  if (id === 'fake') {
    return { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: false, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true };
  }
  if (id === 'sandboxed-cli') {
    return { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: false, sandbox: true };
  }
  if (id === 'sandboxed-agent') {
    return { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: false, sandbox: true };
  }
  if (id === 'sandboxed-acp') {
    return { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true };
  }
  if (id === 'acp-v1') {
    return { readWorkspace: true, writeWorkspace: false, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: false };
  }
  return { readWorkspace: true, writeWorkspace: false, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: false, sandbox: false };
}

/** Execute exactly one adapter attempt under a validated v1 or v2 agent policy. */
export async function executeAgentAdapter({ spec, policy, signal = null, onEvent = null } = {}) {
  assertAgentPolicy(policy);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw extensionError('agent run spec must be an object', 'INVALID_AGENT_RUN');
  if (policy.adapter === 'fake') return runFake({ policy, signal, onEvent });
  if (policy.adapter === 'sandboxed-cli') return runSandboxedCli({ spec, policy, signal, onEvent });
  if (policy.adapter === 'sandboxed-agent') return runSandboxedAgent({ spec, policy, signal, onEvent });
  if (policy.adapter === 'acp-v1' || policy.adapter === 'sandboxed-acp') {
    // The stable ACP v1 SDK is a deliberately optional nested package. Core
    // never imports it at startup and no experimental/v2 endpoint is selected.
    let adapter;
    try { adapter = await import('../integrations/acp-v1/index.mjs'); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /@agentclientprotocol\/sdk/.test(String(error.message))) {
        throw extensionError('ACP v1 adapter is not installed; run npm install --prefix factory/integrations/acp-v1 before selecting it', 'ACP_V1_ADAPTER_UNAVAILABLE');
      }
      throw error;
    }
    return adapter.runAcpV1Adapter({ spec, policy, signal, onEvent, sandboxed: policy.adapter === 'sandboxed-acp' });
  }
  return runLocalProcess({ spec, policy, signal, onEvent });
}
