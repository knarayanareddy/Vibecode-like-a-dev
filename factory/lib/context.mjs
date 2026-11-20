/**
 * Bounded, digest-pinned context assembly for agent planning (roadmap P4.2).
 *
 * Turns a compiled packet into the prompt context a planning agent works
 * from: project shape, requirements, product rules, gates, rule-lint notes
 * and tier scope. Three properties are load-bearing:
 *
 *   1. Deterministic — the same packet always assembles byte-identically, so
 *      the returned digest pins exactly what an agent saw (and record/replay
 *      cassettes stay valid across runs).
 *   2. Bounded — assembly never exceeds `maxChars`; anything dropped is
 *      reported in `truncated`, never silently cut.
 *   3. Slice-aware — a work-package context carries only that package's
 *      requirement bodies, with the remaining packet ids listed as an
 *      assignment note so the agent knows what it does NOT own.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { digest, extensionError } from './extension-utils.mjs';

const REQUIREMENT = /^REQ-(?:C\d{2,}|\d{3,})$/;

/** Section order = survival order under the character budget (first survives longest). */
export const CONTEXT_SECTION_ORDER = Object.freeze(['project', 'requirements', 'rules', 'gates', 'rule-lint', 'scope-notes']);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadPacket(packetDir) {
  const specFile = path.join(packetDir, 'spec.json');
  if (!existsSync(specFile)) {
    throw extensionError(`packet has no spec.json: ${specFile}`, 'INVALID_MISSION_PACKET');
  }
  const spec = readJson(specFile);
  const ruleLintFile = path.join(packetDir, 'rule-lint.json');
  const ruleLint = existsSync(ruleLintFile) ? readJson(ruleLintFile) : null;
  return { spec, ruleLint, packetDigest: digest(readFileSync(specFile, 'utf8')) };
}

function projectSection(spec) {
  const project = spec.project ?? {};
  const risks = Object.entries(project.risks ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  const lines = [
    `project: ${project.name ?? 'unnamed'} (${project.title ?? ''})`,
    `kind: ${project.kind ?? 'unknown'} · stage: ${project.stage ?? 'unknown'} · scale: ${project.users?.scale ?? 'unknown'}`,
    `idea: ${project.idea ?? ''}`,
    `traits: ${(project.traits ?? []).join(', ') || 'none'}`,
    `stack: ${project.constraints?.stack ?? 'unset'}`,
    `active risks: ${risks.join(', ') || 'none'}`,
    `regulation: ${(project.regulation ?? []).join(', ') || 'none'}`
  ];
  const waivers = [...(project.riskWaivers ?? []), ...(project.traitWaivers ?? [])];
  for (const waiver of waivers) lines.push(`waiver: ${JSON.stringify(waiver)}`);
  return lines.join('\n');
}

function requirementLines(spec, requirementIds) {
  const wanted = requirementIds ? new Set(requirementIds) : null;
  const requirements = (spec.requirements ?? [])
    .filter((requirement) => REQUIREMENT.test(String(requirement?.id ?? '')))
    .filter((requirement) => !wanted || wanted.has(requirement.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return requirements.map((requirement) => {
    const acceptance = (requirement.acceptance ?? []).map((entry) => String(entry).trim()).join(' | ');
    return [
      `${requirement.id} [${requirement.area ?? '?'} · verify: ${requirement.verify ?? '?'}${requirement.status ? ` · ${requirement.status}` : ''}] ${requirement.title ?? ''}`,
      `  statement: ${requirement.statement ?? ''}`,
      acceptance ? `  acceptance: ${acceptance}` : null,
      requirement.failurePath ? `  failure path: ${requirement.failurePath}` : null
    ].filter(Boolean).join('\n');
  });
}

function compactRequirementLines(spec, requirementIds) {
  const wanted = requirementIds ? new Set(requirementIds) : null;
  return (spec.requirements ?? [])
    .filter((requirement) => REQUIREMENT.test(String(requirement?.id ?? '')))
    .filter((requirement) => !wanted || wanted.has(requirement.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((requirement) => `${requirement.id} [${requirement.area ?? '?'} · verify: ${requirement.verify ?? '?'}] ${requirement.title ?? ''} — ${requirement.statement ?? ''}`);
}

function rulesSection(spec) {
  // Custom product rules compile into `custom.<slug>` requirements; the packet
  // keeps their slug in `key` and the rule text in the requirement statement.
  const customs = (spec.requirements ?? [])
    .filter((requirement) => String(requirement?.key ?? '').startsWith('custom.'))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (customs.length === 0) return 'none';
  return customs.map((requirement) => `${String(requirement.key).slice('custom.'.length)}: ${requirement.statement ?? ''}`).join('\n');
}

function gatesSection(spec) {
  const gates = spec.gates ?? [];
  if (gates.length === 0) return 'none';
  return gates.map((gate) => `${gate.id}: ${gate.statement}`).join('\n');
}

function ruleLintSection(ruleLint) {
  if (!ruleLint) return 'none recorded';
  const lines = [];
  for (const conflict of ruleLint.conflicts ?? []) lines.push(`conflict: ${conflict.message ?? JSON.stringify(conflict)}`);
  for (const disagreement of ruleLint.disagreements ?? []) lines.push(`disagreement: ${disagreement.message ?? JSON.stringify(disagreement)}`);
  return lines.length > 0 ? lines.join('\n') : 'none recorded';
}

function scopeNotesSection(spec) {
  const lines = [`rigor tier: ${spec.rigor?.tier ?? 0} (${spec.rigor?.label ?? 'sketch'})`];
  for (const entry of spec.deferred ?? []) lines.push(`deferred: ${entry.id} (${entry.reason})`);
  for (const entry of spec.skipped ?? []) lines.push(`skipped: ${entry.id} (${entry.reason})`);
  return lines.join('\n');
}

/**
 * Assemble the bounded planning context for a whole packet, or for the
 * `requirementIds` slice when provided. The returned `digest` pins the exact
 * assembled `text`.
 */
export function assemblePacketContext({ packetDir, requirementIds = null, maxChars = 24_000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 2_000) {
    throw extensionError('context maxChars must be an integer >= 2000', 'INVALID_CONTEXT_BUDGET');
  }
  const { spec, ruleLint, packetDigest } = loadPacket(packetDir);
  const assignedElsewhere = requirementIds
    ? (spec.requirements ?? [])
      .map((requirement) => requirement?.id)
      .filter((id) => REQUIREMENT.test(String(id ?? '')) && !requirementIds.includes(id))
      .sort()
    : [];

  const sections = [
    { name: 'project', text: projectSection(spec) },
    { name: 'requirements', text: requirementLines(spec, requirementIds).join('\n\n') || 'none' },
    { name: 'rules', text: rulesSection(spec) },
    { name: 'gates', text: gatesSection(spec) },
    { name: 'rule-lint', text: ruleLintSection(ruleLint) },
    { name: 'scope-notes', text: scopeNotesSection(spec) }
  ];
  if (assignedElsewhere.length > 0) {
    sections.push({
      name: 'assignment-note',
      text: `Requirements assigned to other work packages (out of scope here): ${assignedElsewhere.join(', ')}`
    });
  }

  // Greedy inclusion in priority order; the requirements section is the core
  // and falls back to a compact form before anything is dropped entirely.
  const truncated = [];
  const included = [];
  let budget = maxChars;
  for (const section of sections) {
    const head = `\n## ${section.name}\n`;
    const cost = head.length + section.text.length;
    if (cost <= budget) {
      included.push({ name: section.name, text: `${head}${section.text}` });
      budget -= cost;
      continue;
    }
    if (section.name === 'requirements') {
      const compact = compactRequirementLines(spec, requirementIds).join('\n');
      const compactCost = head.length + compact.length;
      if (compactCost <= budget) {
        included.push({ name: section.name, text: `${head}${compact}` });
        budget -= compactCost;
        truncated.push({ section: 'requirements', dropped: 'acceptance criteria and failure paths (compact form)' });
        continue;
      }
    }
    truncated.push({ section: section.name, dropped: 'entire section over context budget' });
  }

  const text = included.map((section) => section.text).join('\n');
  return {
    digest: digest(text),
    packetDigest,
    chars: text.length,
    maxChars,
    truncated,
    sections: included.map((section) => section.name),
    requirementIds: requirementIds
      ? [...requirementIds].sort()
      : (spec.requirements ?? []).map((r) => r?.id).filter((id) => REQUIREMENT.test(String(id ?? ''))).sort(),
    assignedElsewhere,
    text
  };
}

/** Assemble the context bundle for one mission work package. */
export function assembleWorkPackageContext({ packetDir, workPackage, maxChars = 24_000 } = {}) {
  const requirementIds = [...(workPackage?.requirements ?? [])];
  if (requirementIds.length === 0) {
    throw extensionError('work package context needs at least one requirement id', 'INVALID_MISSION');
  }
  const assembled = assemblePacketContext({ packetDir, requirementIds, maxChars });
  return { ...assembled, packageId: workPackage.id ?? null };
}
