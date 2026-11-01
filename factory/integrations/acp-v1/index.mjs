/**
 * Optional stable ACP v1 process bridge.
 *
 * Install this package explicitly (`npm install --prefix factory/integrations/acp-v1`)
 * before selecting the `acp-v1` agent policy. VLD Core dynamically imports this
 * boundary only for that policy; Core never imports the SDK or an ACP unstable/v2
 * entry point during ordinary operation.
 */

import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { digest, extensionError } from '../../lib/extension-utils.mjs';
import { redactAgentOutput } from '../../lib/agent-adapters.mjs';
import { acpV1Prompt, negotiateAcpV1, normalizeAcpV1Stop, normalizeAcpV1Update } from './contract.mjs';

function now() { return new Date().toISOString(); }
function commandFor(policy) {
  const command = policy?.command;
  if (!command || command.script !== null || typeof command.executable !== 'string' || !path.isAbsolute(command.executable) || command.executable.split(path.sep).includes('..') || !Array.isArray(command.args)) throw extensionError('ACP v1 policy does not contain one safe direct argv', 'INVALID_ACP_V1_POLICY');
  let executable; let stats;
  try { executable = realpathSync(path.resolve(command.executable)); stats = lstatSync(executable); } catch { throw extensionError('ACP v1 peer executable cannot be resolved', 'INVALID_ACP_V1_POLICY'); }
  if (!path.isAbsolute(executable) || executable.split(path.sep).includes('..') || stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o111) === 0) throw extensionError('ACP v1 peer executable is not a regular executable file', 'INVALID_ACP_V1_POLICY');
  return { executable, args: [...command.args] };
}
function environmentFor(spec, policy) {
  return Object.assign(Object.create(null), policy.environment, {
    VLD_RUN_ID: spec.id,
    VLD_MISSION_ID: spec.missionId,
    VLD_PACKAGE_ID: spec.packageId,
    VLD_PACKET_DIGEST: spec.packetDigest,
    VLD_CONTEXT_DIGEST: spec.contextDigest,
    VLD_REQUIREMENT_IDS: spec.requirementIds.join(',')
  });
}
const TERMINATION_GRACE_MS = 250;
const CANCELLATION_GRACE_MS = 250;

function signalProcess(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
}

function waitForExit(child, milliseconds) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('close', onClose); resolve(false); }, milliseconds);
    const onClose = () => { clearTimeout(timer); resolve(true); };
    child.once('close', onClose);
  });
}

async function terminate(child) {
  signalProcess(child, 'SIGTERM');
  if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
  signalProcess(child, 'SIGKILL');
  await waitForExit(child, TERMINATION_GRACE_MS);
}

function boundedCancellation(connection, sessionId) {
  if (!connection || !sessionId) return;
  // Cancellation is advisory. Never allow a non-responsive peer RPC to delay
  // local process termination or the caller's AbortSignal outcome.
  void Promise.race([
    connection.agent.request(methods.agent.session.cancel, { sessionId }),
    new Promise((resolve) => setTimeout(resolve, CANCELLATION_GRACE_MS))
  ]).catch(() => {});
}
function result({ outcome, startedAt, outputDigest, outputBytes, outputSummary, signal = null }) {
  return { outcome, exitCode: outcome === 'completed' ? 0 : null, signal, outputDigest, outputBytes, outputSummary, startedAt, finishedAt: now() };
}

/**
 * Run one stable ACP v1 peer over stdio. The peer sees a fresh minimal
 * environment. VLD advertises no filesystem/terminal/auth/MCP capabilities;
 * peer notifications become bounded progress metadata only and never Runtime
 * state transitions.
 */
export async function runAcpV1Adapter({ spec, policy, signal = null, onEvent = null } = {}) {
  const startedAt = now(); const command = commandFor(policy); const prompt = acpV1Prompt(spec); let child; let timer; let updateBytes = 0; let updates = 0; let diagnosticBytes = 0; let connection = null; let sessionId = null; let stopped = null;
  const emit = (event) => { if (typeof onEvent === 'function') onEvent(event); };
  try {
    child = spawn(command.executable, command.args, {
      cwd: spec.workspace,
      env: environmentFor(spec, policy),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    // Drain diagnostics so a chatty peer cannot block on stderr, but never retain
    // their raw content: ACP process diagnostics may contain arbitrary data.
    child.stderr.on('data', (chunk) => { diagnosticBytes = Math.min(8_192, diagnosticBytes + Buffer.from(chunk).length); });
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 64 * 1024 });
    const app = client().onNotification(methods.client.session.update, ({ params }) => {
      const normalized = normalizeAcpV1Update(params.update);
      updates += 1; updateBytes += normalized.bytes;
      emit({ type: normalized.type, at: normalized.at, message: normalized.message, bytes: normalized.bytes });
    });
    connection = app.connect(stream);
    const stop = () => {
      if (!stopped) {
        stopped = (async () => {
          try { connection?.close(); } catch {}
          await terminate(child);
        })();
      }
      return stopped;
    };
    const abort = () => {
      boundedCancellation(connection, sessionId);
      return stop();
    };
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(extensionError('ACP v1 session exceeded policy duration', 'ACP_V1_TIMED_OUT')), policy.limits.durationMs); });
    const work = (async () => {
      emit({ type: 'started', at: startedAt, message: 'ACP v1 adapter started' });
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'VLD', version: '0.19.0' }
      });
      negotiateAcpV1(initialized, { requireReconnect: policy.capabilities.reconnect === true });
      const session = await connection.agent.buildSession(spec.workspace).start(); sessionId = session.sessionId;
      const stop = await session.prompt(prompt); const normalized = normalizeAcpV1Stop(stop);
      try { if (initialized.agentCapabilities?.sessionCapabilities?.close) await connection.agent.request(methods.agent.session.close, { sessionId }); } catch {}
      session.dispose(); connection.close();
      return normalized;
    })();
    let rejectCancellation;
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
    const onAbort = () => {
      void abort();
      rejectCancellation(extensionError('ACP v1 session cancelled', 'ACP_V1_CANCELLED'));
    };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let normalized;
    try { normalized = await Promise.race([work, timeout, cancellation]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    if (signal?.aborted || normalized.outcome === 'cancelled') return result({ outcome: 'cancelled', startedAt, outputDigest: normalized.outputDigest, outputBytes: updateBytes + diagnosticBytes, outputSummary: normalized.outputSummary, signal: 'SIGTERM' });
    emit({ type: normalized.outcome === 'completed' ? 'completed' : 'failed', at: now(), message: normalized.outputSummary });
    return result({ outcome: normalized.outcome, startedAt, outputDigest: digest({ peer: normalized.outputDigest, updates, updateBytes, diagnosticBytes }), outputBytes: updateBytes + diagnosticBytes, outputSummary: normalized.outputSummary });
  } catch (error) {
    const timedOut = error?.code === 'ACP_V1_TIMED_OUT'; const cancelled = signal?.aborted || error?.code === 'ACP_V1_CANCELLED';
    boundedCancellation(connection, sessionId);
    await (stopped ?? (async () => { try { connection?.close(); } catch {}; await terminate(child); })());
    const output = redactAgentOutput(timedOut ? 'ACP v1 session timed out' : cancelled ? 'ACP v1 session cancelled' : `ACP v1 peer failed: ${error?.code ?? 'protocol-error'}`);
    emit({ type: timedOut ? 'timed-out' : cancelled ? 'cancelled' : 'failed', at: now(), message: output });
    return result({ outcome: timedOut ? 'timed-out' : cancelled ? 'cancelled' : 'failed', startedAt, outputDigest: digest({ outcome: timedOut ? 'timed-out' : cancelled ? 'cancelled' : 'failed', updateBytes, diagnosticBytes }), outputBytes: updateBytes + diagnosticBytes, outputSummary: output, signal: timedOut || cancelled ? 'SIGTERM' : null });
  } finally {
    clearTimeout(timer);
    if (stopped) await stopped;
    else { try { connection?.close(); } catch {}; await terminate(child); }
  }
}
