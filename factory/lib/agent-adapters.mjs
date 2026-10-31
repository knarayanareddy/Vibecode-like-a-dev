/**
 * M4 adapter implementations.
 *
 * The fake adapter is deterministic and has no host-process authority. The
 * local-process adapter starts exactly one policy-declared executable using
 * direct argv spawning; it never uses a shell, PATH search or inherited env.
 * A portable process CWD is not a filesystem sandbox, so local-process is
 * deliberately read-only until a separately reviewed sandbox adapter exists.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_ADAPTER_IDS,
  assertAgentPolicy,
  resolveLocalProcessCommand
} from './agent-policy.mjs';
import { digest, extensionError } from './extension-utils.mjs';

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
    VLD_REQUIREMENT_IDS: spec.requirementIds.join(',')
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

export function adapterCapabilities(id) {
  if (!AGENT_ADAPTER_IDS.includes(id)) throw extensionError('unknown M4 agent adapter', 'UNKNOWN_AGENT_ADAPTER');
  return id === 'fake'
    ? { readWorkspace: true, writeWorkspace: true, runDeclaredCommands: false, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: true }
    : id === 'acp-v1'
      ? { readWorkspace: true, writeWorkspace: false, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: true, sandbox: false }
      : { readWorkspace: true, writeWorkspace: false, runDeclaredCommands: true, network: false, streamEvents: true, cancel: true, reconnect: false, sandbox: false };
}

/** Execute exactly one adapter attempt under a validated M4 policy. */
export async function executeAgentAdapter({ spec, policy, signal = null, onEvent = null } = {}) {
  assertAgentPolicy(policy);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw extensionError('agent run spec must be an object', 'INVALID_AGENT_RUN');
  if (policy.adapter === 'fake') return runFake({ policy, signal, onEvent });
  if (policy.adapter === 'acp-v1') {
    // The stable ACP v1 SDK is a deliberately optional nested package. Core
    // never imports it at startup and no experimental/v2 endpoint is selected.
    let adapter;
    try { adapter = await import('../integrations/acp-v1/index.mjs'); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /@agentclientprotocol\/sdk/.test(String(error.message))) {
        throw extensionError('ACP v1 adapter is not installed; run npm install --prefix factory/integrations/acp-v1 before selecting it', 'ACP_V1_ADAPTER_UNAVAILABLE');
      }
      throw error;
    }
    return adapter.runAcpV1Adapter({ spec, policy, signal, onEvent });
  }
  return runLocalProcess({ spec, policy, signal, onEvent });
}
