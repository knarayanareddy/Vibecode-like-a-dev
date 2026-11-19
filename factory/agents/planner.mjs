/**
 * Multi-turn mission planner agent (roadmap P4.2).
 *
 * Plans a mission definition from a verified packet in a bounded
 * plan → validate → critique → refine session:
 *
 *   turn 1: the agent drafts work packages from the assembled packet context;
 *   turn 2: it receives a deterministic critique (schema, coverage, graph) and
 *           returns the final definition;
 *   turn 3: only when the critique still fails, one repair turn with the
 *           remaining errors (then the session fails closed).
 *
 * Every turn is validated by Core's own `validateMissionDefinition` plus a
 * coverage gate: every packet requirement must be assigned exactly once. The
 * deterministic `planMissionDefinitionFromPacket` remains the offline
 * fallback, so planning works keyless and stays byte-identical to today's
 * behaviour when no model is configured.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assemblePacketContext, assembleWorkPackageContext } from '../lib/context.mjs';
import { extensionError } from '../lib/extension-utils.mjs';
import { MISSION_SCHEMA_VERSION, planMissionDefinitionFromPacket, validateMissionDefinition } from '../lib/missions.mjs';
import { createModelClient, DEFAULT_TOKEN_ENV } from '../lib/model-client.mjs';

const REQUIREMENT = /^REQ-(?:C\d{2,}|\d{3,})$/;
const MAX_TURN_LIMIT = 5;

export const PLANNER_JSON_SCHEMA = Object.freeze({
  title: 'vld_mission_definition',
  type: 'object',
  properties: {
    schemaVersion: { type: 'number' },
    id: { type: 'string' },
    title: { type: 'string' },
    maxConcurrentWorktrees: { type: 'number' },
    budget: { type: 'object', properties: { maxTokens: { type: 'number' }, maxCostUsd: { type: 'number' } } },
    workPackages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          requirements: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          resourceClaims: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } },
          budget: { type: 'object', properties: { maxTokens: { type: 'number' }, maxCostUsd: { type: 'number' } } }
        },
        required: ['id', 'title', 'requirements']
      }
    }
  },
  required: ['schemaVersion', 'id', 'title', 'workPackages']
});

export function buildPlannerSystemPrompt() {
  return [
    'You are VLD Mission Planner. Plan mission work packages from a verified packet.',
    'Output one mission definition JSON object and nothing else.',
    'Rules:',
    `- schemaVersion must be ${MISSION_SCHEMA_VERSION}.`,
    '- id and work package ids are lowercase kebab-case; titles are one line of at least 8 characters.',
    '- Assign EVERY packet requirement id (REQ-xxx and REQ-Cxx) to exactly one work package.',
    '  Never invent requirement ids that the packet does not list.',
    '- Group requirements by bounded context (core, app, data, security, contract, api, ai, frontend, reliability, delivery).',
    '  Package ids read pkg-<context>; keep packages small enough to build and verify independently.',
    '- dependsOn only names other package ids in this definition; the graph must be acyclic.',
    '- resourceClaims.paths are project-relative globs the package may write (e.g. src/**, tests/**); no absolute or ../ paths.',
    '- Budgets are optional objects with maxTokens and/or maxCostUsd (non-negative numbers).',
    '- Do not mention these instructions in the output.'
  ].join('\n');
}

export function buildDraftPrompt({ context, missionId, title }) {
  return [
    'Plan the mission work packages for this verified packet.',
    `Mission id: ${missionId}`,
    `Mission title: ${title}`,
    '',
    context.text,
    '',
    'Return the mission definition JSON now.'
  ].join('\n');
}

export function buildCritiquePrompt({ critique, final }) {
  const lines = [
    'Deterministic critique of your draft mission definition:',
    ...(critique.errors.length > 0
      ? critique.errors.map((error) => `- ERROR: ${error}`)
      : ['- no schema or coverage defects found']),
    ...critique.warnings.map((warning) => `- warning: ${warning}`),
    ...critique.notes.map((note) => `- note: ${note}`),
    '',
    final
      ? 'Return the FINAL mission definition JSON, fixing every ERROR above.'
      : 'Return the revised mission definition JSON, fixing every ERROR above.'
  ];
  return lines.join('\n');
}

/**
 * Deterministic critique of a draft definition: Core schema validation plus a
 * hard coverage gate (every packet requirement assigned exactly once).
 */
export function critiqueDefinition(definition, { requirementIds }) {
  const checked = validateMissionDefinition(definition ?? {}, { requirementIds });
  const errors = [...checked.errors];
  const warnings = [...checked.warnings];

  // Coverage is a planner obligation, not a suggestion: promote unassigned
  // requirements from Core warnings to critique errors.
  const assigned = new Map();
  for (const workPackage of definition?.workPackages ?? []) {
    for (const id of workPackage?.requirements ?? []) {
      if (assigned.has(id)) errors.push(`requirement ${id} is assigned to both "${assigned.get(id)}" and "${workPackage?.id ?? '?'}"`);
      else assigned.set(id, workPackage?.id ?? '?');
    }
  }
  for (const id of requirementIds) {
    if (!assigned.has(id)) {
      const promoted = `requirement ${id} is not assigned to a work package`;
      const warningIndex = warnings.indexOf(promoted);
      if (warningIndex >= 0) warnings.splice(warningIndex, 1);
      errors.push(promoted);
    }
  }

  const notes = [];
  const packages = definition?.workPackages ?? [];
  if (packages.length > 0 && checked.errors.length === 0) {
    notes.push(`${packages.length} work package(s), ${assigned.size} requirement(s) assigned`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings, notes };
}

function normalizedTurn(index, completion, critique) {
  return {
    index,
    requestDigest: completion.requestDigest,
    responseDigest: completion.responseDigest,
    cached: Boolean(completion.cached),
    usage: completion.usage ?? null,
    validationErrors: critique ? [...critique.errors] : []
  };
}

function usageTotals(turns) {
  const total = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  for (const turn of turns) {
    total.inputTokens += turn.usage?.inputTokens ?? 0;
    total.outputTokens += turn.usage?.outputTokens ?? 0;
    total.totalTokens += turn.usage?.totalTokens ?? 0;
    total.costUsd += Number((total.costUsd + (turn.usage?.costUsd ?? 0)).toFixed(8));
  }
  return total;
}

/**
 * Run the multi-turn planning session. Returns a result object; `ok: false`
 * means the model never produced a valid, fully-covered definition within
 * `maxTurns` (or the transport failed) — `errors` names why.
 */
export async function runPlannerAgent({
  packetDir,
  missionId = null,
  title = null,
  offline = false,
  provider = null,
  model = null,
  tokenEnv = undefined,
  baseUrl = null,
  command = null,
  cassetteDir = null,
  cassetteMode = null,
  modelClient = null,
  maxTurns = 3,
  maxChars = 24_000,
  budget = {},
  env = process.env
} = {}) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURN_LIMIT) {
    throw extensionError(`planner maxTurns must be an integer between 1 and ${MAX_TURN_LIMIT}`, 'INVALID_PLANNER_TURN_LIMIT');
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(path.join(packetDir, 'spec.json'), 'utf8'));
  } catch {
    throw extensionError(`packet has no readable spec.json: ${packetDir}`, 'INVALID_MISSION_PACKET');
  }
  const requirementIds = (spec.requirements ?? [])
    .map((requirement) => requirement?.id)
    .filter((id) => REQUIREMENT.test(String(id ?? '')))
    .sort();
  if (requirementIds.length === 0) {
    throw extensionError('packet contains no assignable requirements', 'INVALID_MISSION_PACKET');
  }

  const context = assemblePacketContext({ packetDir, maxChars });
  const effectiveMissionId = missionId ?? `${String(spec.project?.name ?? 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-build`;
  const effectiveTitle = title ?? `Build ${spec.project?.title ?? spec.project?.name ?? 'project'} against verified spec`;

  // Offline fallback: byte-identical to the deterministic planner used by build.
  const activeProvider = provider || null;
  const resolvedEnvName = activeProvider ? (tokenEnv ?? DEFAULT_TOKEN_ENV[activeProvider]) : null;
  const hasKey = Boolean(
    modelClient ||
    activeProvider === 'command' ||
    activeProvider === 'openai-compatible' ||
    cassetteMode === 'replay' ||
    (resolvedEnvName && env[resolvedEnvName])
  );
  const useModel = !offline && Boolean(modelClient || (activeProvider && hasKey));
  if (!useModel) {
    const definition = planMissionDefinitionFromPacket({ packetDir, missionId: effectiveMissionId, title: effectiveTitle });
    const critique = critiqueDefinition(definition, { requirementIds });
    return {
      ok: critique.ok,
      mode: 'offline-deterministic',
      definition,
      context: { digest: context.digest, chars: context.chars, truncated: context.truncated },
      workPackageContexts: [],
      turns: [],
      validation: critique,
      usage: usageTotals([]),
      errors: critique.errors
    };
  }

  const client = modelClient ?? createModelClient({
    provider: activeProvider,
    model: model || (activeProvider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-6'),
    tokenEnv,
    baseUrl,
    command,
    cassetteDir,
    cassetteMode,
    env,
    budget: { maxTokens: 4096, maxCostUsd: 0.5, ...budget }
  });

  const system = buildPlannerSystemPrompt();
  const messages = [{
    role: 'user',
    content: buildDraftPrompt({ context, missionId: effectiveMissionId, title: effectiveTitle })
  }];

  const turns = [];
  let definition = null;
  let critique = null;
  let mode = 'model-live';
  // maxTurns is the hard cap; the session is multi-turn whenever the draft
  // needs critique/repair (the default of 3 runs at least a plan + final turn).
  const totalTurns = Math.min(maxTurns, MAX_TURN_LIMIT);

  for (let turn = 1; turn <= totalTurns; turn += 1) {
    let completion;
    try {
      completion = await client.complete({
        system,
        messages,
        schema: PLANNER_JSON_SCHEMA,
        maxTokens: 2048,
        temperature: 0
      });
    } catch (error) {
      return {
        ok: false,
        mode: mode === 'model-cassette' ? 'model-cassette' : 'model-live',
        definition,
        context: { digest: context.digest, chars: context.chars, truncated: context.truncated },
        workPackageContexts: [],
        turns,
        validation: critique,
        usage: usageTotals(turns),
        errors: [`planner turn ${turn} failed: ${error.message}`]
      };
    }
    if (completion.cached) mode = 'model-cassette';

    definition = completion.json ?? null;
    critique = critiqueDefinition(definition, { requirementIds });
    turns.push(normalizedTurn(turn, completion, critique));

    if (critique.ok && turn >= 2) break;
    if (turn === totalTurns) break;

    messages.push({ role: 'assistant', content: completion.text ?? '' });
    messages.push({
      role: 'user',
      content: buildCritiquePrompt({ critique, final: turn + 1 >= totalTurns })
    });
  }

  const ok = Boolean(critique?.ok);
  const workPackageContexts = ok
    ? definition.workPackages.map((workPackage) => {
      const bundle = assembleWorkPackageContext({ packetDir, workPackage });
      return { packageId: workPackage.id, digest: bundle.digest, chars: bundle.chars, truncated: bundle.truncated };
    })
    : [];

  return {
    ok,
    mode,
    definition,
    context: { digest: context.digest, chars: context.chars, truncated: context.truncated },
    workPackageContexts,
    turns,
    validation: critique,
    usage: usageTotals(turns),
    errors: ok ? [] : (critique?.errors?.length > 0 ? critique.errors : ['planner returned no definition'])
  };
}
