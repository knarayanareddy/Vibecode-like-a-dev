/**
 * VLD's narrow contract around the stable ACP v1 protocol.
 *
 * This file deliberately has no ACP SDK import. It lets Core validate a peer's
 * negotiated facts and normalize peer updates without making Core depend on an
 * optional transport package. `index.mjs` is that optional SDK boundary.
 */

import { digest, extensionError, ID_PATTERN } from '../../lib/extension-utils.mjs';
import { redactAgentOutput } from '../../lib/agent-adapters.mjs';

export const ACP_V1_PROTOCOL_VERSION = 1;
export const ACP_V1_SDK_PACKAGE = '@agentclientprotocol/sdk';

const SAFE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
const UPDATE_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'available_commands_update', 'current_mode_update', 'config_option_update']);

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeText(value, maximum = 500) { return typeof value === 'string' && value.length <= maximum && !/[\r\n\0]/.test(value); }
function fail(message, code = 'ACP_V1_PROTOCOL_INVALID') { throw extensionError(message, code); }

/**
 * Validate the only peer facts VLD needs. ACP v1's text/session baseline is
 * enough: VLD never advertises filesystem, terminal, MCP, elicitation or auth
 * capability, and it never selects ACP's unstable/v2 entry points.
 */
export function negotiateAcpV1(response, { requireReconnect = false } = {}) {
  if (!object(response)) fail('ACP initialize response must be an object');
  if (response.protocolVersion !== ACP_V1_PROTOCOL_VERSION) fail(`ACP peer must negotiate stable protocol v${ACP_V1_PROTOCOL_VERSION}`, 'ACP_V1_VERSION_UNSUPPORTED');
  if (response.authMethods && (!Array.isArray(response.authMethods) || response.authMethods.length > 0)) fail('ACP peer requires authentication but VLD ACP v1 has no credential authority', 'ACP_V1_AUTH_UNSUPPORTED');
  const capabilities = response.agentCapabilities;
  if (capabilities !== undefined && !object(capabilities)) fail('ACP agentCapabilities must be an object');
  const sessions = capabilities?.sessionCapabilities;
  if (sessions !== undefined && !object(sessions)) fail('ACP sessionCapabilities must be an object');
  if (requireReconnect && !(capabilities?.loadSession === true && sessions?.resume && typeof sessions.resume === 'object')) {
    fail('ACP peer does not advertise the reconnect capabilities required by policy', 'ACP_V1_CAPABILITY_MISSING');
  }
  const info = response.agentInfo;
  if (info !== undefined && info !== null && (!object(info) || !safeText(info.name, 120) || (info.version !== undefined && !SAFE_VERSION.test(String(info.version))))) fail('ACP agentInfo is invalid');
  return {
    protocolVersion: ACP_V1_PROTOCOL_VERSION,
    agent: info ? { name: info.name, ...(info.version ? { version: info.version } : {}) } : null,
    reconnect: Boolean(capabilities?.loadSession === true && sessions?.resume && typeof sessions.resume === 'object'),
    close: Boolean(sessions?.close && typeof sessions.close === 'object')
  };
}

/** Build a bounded host-owned prompt; callers must not supply a transcript. */
export function acpV1Prompt(spec) {
  if (!object(spec) || !ID_PATTERN.test(String(spec.id ?? '')) || !ID_PATTERN.test(String(spec.missionId ?? '')) || !ID_PATTERN.test(String(spec.packageId ?? ''))) fail('ACP run spec identity is invalid', 'INVALID_ACP_V1_RUN');
  for (const field of ['packetDigest', 'contextDigest']) if (!/^[a-f0-9]{64}$/.test(String(spec[field] ?? ''))) fail(`ACP run spec ${field} is invalid`, 'INVALID_ACP_V1_RUN');
  if (!Array.isArray(spec.requirementIds) || spec.requirementIds.length > 100 || spec.requirementIds.some((id) => !/^REQ-\d{3,6}$/.test(id))) fail('ACP run spec requirementIds are invalid', 'INVALID_ACP_V1_RUN');
  return [
    'VLD host session. Work only on the checked-out work package and preserve the reviewed scope.',
    `Mission: ${spec.missionId}; package: ${spec.packageId}; run: ${spec.id}.`,
    `Frozen packet digest: ${spec.packetDigest}; context digest: ${spec.contextDigest}.`,
    `Requirements: ${[...spec.requirementIds].sort().join(', ') || 'none'}.`,
    'Do not request client filesystem, terminal, credential, MCP, network, or permission capabilities. VLD does not grant them through ACP.',
    'Return a concise implementation status through the ACP session; VLD will independently inspect Runtime state.'
  ].join('\n');
}

/**
 * Convert an ACP session notification to bounded host event metadata. Raw
 * message/tool content never becomes a Runtime receipt or state transition.
 */
export function normalizeAcpV1Update(update, { at = new Date().toISOString() } = {}) {
  if (!object(update) || !UPDATE_KINDS.has(update.sessionUpdate ?? update.kind)) fail('ACP session update is unsupported');
  const kind = update.sessionUpdate ?? update.kind;
  const bytes = Buffer.byteLength(JSON.stringify(update));
  if (bytes > 64 * 1024) fail('ACP session update exceeds the bounded protocol limit', 'ACP_V1_MESSAGE_TOO_LARGE');
  return {
    type: 'progress',
    at,
    message: `ACP v1 ${kind.replaceAll('_', ' ')}`,
    bytes,
    digest: digest(update)
  };
}

/** Normalize final stop data with no raw response/transcript persistence. */
export function normalizeAcpV1Stop(stop) {
  if (!object(stop) || !STOP_REASONS.has(stop.stopReason)) fail('ACP session stop reason is invalid');
  const outcome = stop.stopReason === 'end_turn' ? 'completed' : stop.stopReason === 'cancelled' ? 'cancelled' : 'failed';
  return {
    outcome,
    stopReason: stop.stopReason,
    outputDigest: digest({ stopReason: stop.stopReason, meta: stop._meta ?? null }),
    outputSummary: redactAgentOutput(`ACP v1 session stopped: ${stop.stopReason}`)
  };
}
