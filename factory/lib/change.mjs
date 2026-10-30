/**
 * Delta specs for brownfield work.
 *
 * Greenfield specs are the easy case. Real work is: a requirement changes, and
 * everything downstream of it has to change in a way that a reviewer can see.
 *
 * A change proposal here has three obligations the other tools in this space do
 * not impose:
 *   1. It must declare what it will do: ADDED / MODIFIED / REMOVED requirements.
 *   2. It must declare how it will be detected if it silently degrades: a probe.
 *   3. It must declare how to back out: rollback, with a schema rule for data.
 *
 * Applying a change never mutates the packet in place. It produces
 * `spec.after.json`, which is a reviewable diff of intent. `--apply` copies it
 * over a backup.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACTS, validateArtifact } from './artifacts.mjs';
import { earsError } from './ears.mjs';
import { emitPacket } from './emit/index.mjs';
import { buildIndex, loadIndex } from './indexer.mjs';
import { buildPlan } from './planner.mjs';
import { normalizeProfile } from './profile.mjs';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;
// Keys are namespaced like the catalog: "feature.export", not "feature-export".
const KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const RISKS = ['low', 'medium', 'high'];

const AREA_OBLIGATIONS = {
  api: 'Update the contract inventory in `04-contracts.md` and add a contract test. A changed interface is a breaking change until proven otherwise.',
  data: 'Ship a forward-only migration with an expand/migrate/contract path, and state the restore step.',
  security: 'Update the threat model and add a denial-path test. Security requirements cannot be removed without a replacement control.',
  frontend: 'Cover the four UI states for any new screen, and run the keyboard pass on the changed journey.',
  reliability: 'Name the retry, timeout and idempotency behaviour of anything that crosses a process boundary.',
  core: 'No area-specific obligation, but the change still needs a test anchor and a gate check.'
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function nextRequirementIds(existing, count) {
  const numbers = existing
    .map((requirement) => Number(String(requirement.id).replace(/[^0-9]/g, '')))
    .filter((value) => Number.isFinite(value));
  const start = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
  return Array.from({ length: count }, (_, index) => `REQ-${String(start + index).padStart(3, '0')}`);
}

/** Criteria are appended, never renumbered: an anchor may already cite AC-01. */
function appendCriteria(requirement, texts) {
  const existing = requirement.acceptance ?? [];
  let next = existing.length;
  return texts.map((text) => {
    next += 1;
    return { id: `AC-${String(next).padStart(2, '0')}`, text: String(text).trim() };
  });
}

export function validateChange(change) {
  const errors = [];
  if (!change.id || !ID_PATTERN.test(change.id)) errors.push('id: required, lowercase kebab-case (e.g. "add-export")');
  if (!change.title) errors.push('title: required, one line');
  if (!change.why || String(change.why).length < 20) errors.push('why: required, at least 20 characters. A change without a reason is a rewrite.');
  if (!RISKS.includes(change.risk)) errors.push(`risk: must be one of ${RISKS.join(', ')}`);

  const add = change.add ?? [];
  const modify = change.modify ?? [];
  const remove = change.remove ?? [];
  if (add.length + modify.length + remove.length === 0) errors.push('a change must add, modify or remove at least one requirement');

  const addKeys = new Set();
  add.forEach((requirement, index) => {
    const label = `add[${index}]`;
    if (!requirement.key || !KEY_PATTERN.test(requirement.key)) errors.push(`${label}.key: required, namespaced kebab-case (e.g. "feature.export")`);
    else if (addKeys.has(requirement.key)) errors.push(`${label}.key: "${requirement.key}" is added twice`);
    else addKeys.add(requirement.key);
    if (!requirement.title) errors.push(`${label}.title: required`);
    if (!requirement.statement || String(requirement.statement).length < 40) {
      errors.push(`${label}.statement: required, at least 40 characters`);
    } else {
      const ears = earsError(requirement.statement);
      if (ears) errors.push(`${label}.statement: not an EARS requirement — ${ears}`);
    }
    if (!requirement.failurePath || String(requirement.failurePath).length < 10) errors.push(`${label}.failurePath: required. A requirement without a failure path is a demo script.`);
    if (!Array.isArray(requirement.acceptance) || requirement.acceptance.length === 0) errors.push(`${label}.acceptance: at least one criterion`);
    if (!['automated', 'manual', 'gate'].includes(requirement.verify)) errors.push(`${label}.verify: automated, manual or gate`);
    if (!['core', 'data', 'security', 'frontend', 'api', 'reliability', 'ai'].includes(requirement.area ?? 'core')) {
      errors.push(`${label}.area: must be core, data, security, frontend, api, reliability or ai`);
    }
  });

  modify.forEach((entry, index) => {
    const label = `modify[${index}]`;
    if (!entry.key) errors.push(`${label}.key: required (the requirement key or id to change)`);
    if (!entry.statement && !entry.failurePath && !(entry.addAcceptance ?? []).length) {
      errors.push(`${label}: does nothing. Provide statement, failurePath or addAcceptance.`);
    }
    if (entry.statement) {
      const ears = earsError(entry.statement);
      if (ears) errors.push(`${label}.statement: not an EARS requirement — ${ears}`);
    }
  });

  remove.forEach((entry, index) => {
    const label = `remove[${index}]`;
    if (!entry.key) errors.push(`${label}.key: required`);
    if (!entry.why || String(entry.why).length < 20) errors.push(`${label}.why: required. Removing a requirement needs an argument, not a delete.`);
  });

  if (change.risk === 'high') {
    if (!Array.isArray(change.probe) || change.probe.length === 0) {
      errors.push('probe: a high-risk change needs at least one probe — the check that would catch it silently degrading.');
    }
    if (!change.rollback || String(change.rollback).length < 20) {
      errors.push('rollback: required for a high-risk change.');
    }
  }

  return errors;
}

export function planChange({ packetDir, change }) {
  const specPath = path.join(packetDir, 'spec.json');
  if (!existsSync(specPath)) throw new Error(`no spec.json in ${packetDir}`);
  const spec = readJson(specPath);
  const index = safeIndex();

  const errors = validateChange(change);
  const warnings = [];
  const requirements = spec.requirements ?? [];
  const byKey = new Map(requirements.map((requirement) => [requirement.key, requirement]));
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const find = (reference) => byKey.get(reference) ?? byId.get(reference);

  // --- resolve and validate references against the packet
  const modified = [];
  for (const entry of change.modify ?? []) {
    const target = find(entry.key);
    if (!target) {
      errors.push(`modify: "${entry.key}" is not in this packet. Use add instead, or check the key.`);
      continue;
    }
    modified.push({ definition: entry, target });
  }

  const removed = [];
  for (const entry of change.remove ?? []) {
    const target = find(entry.key);
    if (!target) {
      errors.push(`remove: "${entry.key}" is not in this packet.`);
      continue;
    }
    removed.push({ definition: entry, target });
  }

  const added = [];
  const ids = nextRequirementIds(requirements, (change.add ?? []).length);
  (change.add ?? []).forEach((entry, position) => {
    if (byKey.has(entry.key)) {
      errors.push(`add: "${entry.key}" already exists in this packet. Use modify instead.`);
      return;
    }
    added.push({
      id: ids[position],
      key: entry.key,
      area: entry.area ?? 'core',
      title: entry.title,
      statement: entry.statement,
      failurePath: entry.failurePath,
      acceptance: (entry.acceptance ?? []).map((criteria, criteriaIndex) => ({
        id: `AC-${String(criteriaIndex + 1).padStart(2, '0')}`,
        text: String(criteria).trim()
      })),
      verify: entry.verify ?? 'automated',
      anchor: entry.anchor ?? `tests/${entry.area ?? 'core'}/${entry.key.replace(/\./g, '-')}.test.ts`,
      status: 'todo',
      why: entry.why ?? ''
    });
  });

  // --- the new state of the manifest, produced as a reviewable diff
  const afterRequirements = requirements.map((requirement) => ({ ...requirement }));
  const applyModification = (target, definition) => {
    const next = afterRequirements.find((requirement) => requirement.id === target.id);
    if (definition.statement) next.statement = definition.statement;
    if (definition.failurePath) next.failurePath = definition.failurePath;
    if ((definition.addAcceptance ?? []).length > 0) {
      next.acceptance = [...(next.acceptance ?? []), ...appendCriteria(next, definition.addAcceptance)];
      if (next.status === 'done') next.status = 'todo';
    }
    if (definition.title) next.title = definition.title;
    return next;
  };

  for (const { definition, target } of modified) applyModification(target, definition);
  for (const { target } of removed) {
    const position = afterRequirements.findIndex((requirement) => requirement.id === target.id);
    if (position !== -1) afterRequirements.splice(position, 1);
  }
  for (const requirement of added) afterRequirements.push({ ...requirement });

  const afterSpec = { ...spec, requirements: afterRequirements, gates: spec.gates ?? [] };

  // --- blast radius
  const touchedKeys = new Set([
    ...added.map((requirement) => requirement.key),
    ...modified.map(({ target }) => target.key),
    ...removed.map(({ target }) => target.key)
  ]);
  const areas = new Set([
    ...added.map((requirement) => requirement.area),
    ...modified.map(({ target }) => target.area ?? 'core'),
    ...removed.map(({ target }) => target.area ?? 'core')
  ]);

  const practices = index
    ? index.primitives.filter((primitive) => (primitive.enforces ?? []).some((key) => touchedKeys.has(key)))
    : [];

  const tier = spec.rigor?.tier ?? 0;
  const gateCollisions = practices
    .filter((primitive) => primitive.tier_min <= tier)
    .map((primitive) => `${primitive.id} enforces ${(primitive.enforces ?? []).filter((key) => touchedKeys.has(key)).join(', ')} at tier ${tier}`);

  // --- automated requirements that lose their anchor when removed
  const orphanedAnchors = removed
    .filter(({ target }) => target.verify === 'automated' && target.anchor)
    .map(({ target }) => ({ id: target.id, anchor: target.anchor }));

  // --- impact classification
  const interfaceTouched = [...areas].some((area) => area === 'api' || area === 'data');
  const behaviouralModification = modified.some(
    ({ definition }) => definition.statement || definition.failurePath
  );
  const dataTouched = [...areas].includes('data');
  let impact = 'patch';
  if (removed.length > 0 || interfaceTouched || dataTouched || behaviouralModification) impact = 'major';
  else if (added.length > 0) impact = 'minor';

  // --- obligations derived from risk and area
  const obligations = [];
  for (const area of areas) obligations.push(`${area}: ${AREA_OBLIGATIONS[area] ?? AREA_OBLIGATIONS.core}`);
  if (orphanedAnchors.length > 0) {
    obligations.push(
      `Delete or re-anchor the tests for removed requirements: ${orphanedAnchors.map((entry) => `${entry.id} (${entry.anchor})`).join(', ')}. A leftover @req becomes a stray anchor and fails the drift check.`
    );
  }
  if (change.risk === 'high' && !change.probe) obligations.push('Add a probe: how would you notice this change silently degrading?');

  if (removed.length > 0) warnings.push('Removing requirements lowers the packet\'s coverage floor. Confirm the gates still pass, or the tier should drop.');
  if (added.length > 0) warnings.push('Added requirements start as `todo`: the spec check will report them as pending until a test carries their anchor.');
  if (interfaceTouched) warnings.push('An interface or data area is touched, so this is a major change even if the code diff is small.');

  return {
    change,
    packet: { dir: packetDir, schemaVersion: spec.schemaVersion, requirements: requirements.length, tier },
    added,
    modified: modified.map(({ definition, target }) => ({ target: { id: target.id, key: target.key }, definition })),
    removed: removed.map(({ definition, target }) => ({ target: { id: target.id, key: target.key, anchor: target.anchor }, definition })),
    impact,
    blastRadius: {
      areas: [...areas],
      obligations,
      gateCollisions,
      practices: practices.map((primitive) => ({ id: primitive.id, title: primitive.title, tier_min: primitive.tier_min })),
      orphanedAnchors
    },
    afterSpec,
    errors,
    warnings
  };
}

function safeIndex() {
  try {
    return loadIndex();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rendering

function table(headers, rows) {
  if (rows.length === 0) return '_None._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
  ].join('\n');
}

function proposalMarkdown(plan) {
  const { change, packet, added, modified, removed, impact, blastRadius } = plan;
  const lines = [];

  lines.push(`# Change ${change.id} — ${change.title}`);
  lines.push('');
  lines.push(`> Delta spec for \`${path.basename(packet.dir)}\` · base ${packet.requirements} requirements · tier ${packet.tier} · risk **${change.risk}** · impact **${impact}**`);
  lines.push('');
  lines.push('## Why');
  lines.push('');
  lines.push(String(change.why).trim());
  lines.push('');

  if (added.length > 0) {
    lines.push('## ADDED');
    lines.push('');
    for (const requirement of added) {
      lines.push(`### ${requirement.id} — ${requirement.title}  \`(${requirement.key})\``);
      lines.push('');
      lines.push(requirement.statement);
      lines.push('');
      for (const criteria of requirement.acceptance) lines.push(`- \`${criteria.id}\` ${criteria.text}`);
      lines.push('');
      lines.push(`**Failure path:** ${requirement.failurePath}`);
      lines.push(`**Verification:** ${requirement.verify}${requirement.anchor ? ` · anchor \`${requirement.anchor}\`` : ''}`);
      lines.push('');
    }
  }

  if (modified.length > 0) {
    lines.push('## MODIFIED');
    lines.push('');
    lines.push(table(
      ['Requirement', 'Field', 'After'],
      modified.flatMap(({ target, definition }) => {
        const rows = [];
        if (definition.statement) rows.push([`${target.id} \`${target.key}\``, 'statement', definition.statement]);
        if (definition.failurePath) rows.push([`${target.id} \`${target.key}\``, 'failure path', definition.failurePath]);
        for (const text of definition.addAcceptance ?? []) rows.push([`${target.id} \`${target.key}\``, 'accepted criterion (appended)', text]);
        return rows;
      })
    ));
    lines.push('');
    lines.push('Appended criteria keep existing identifiers, so anchors that already cite `AC-01` stay valid.');
    lines.push('');
  }

  if (removed.length > 0) {
    lines.push('## REMOVED');
    lines.push('');
    lines.push(table(
      ['Requirement', 'Reason', 'Replacement'],
      removed.map(({ target, definition }) => [`${target.id} \`${target.key}\``, definition.why, definition.replaceWith ?? 'none'])
    ));
    lines.push('');
  }

  lines.push('## Blast radius');
  lines.push('');
  lines.push(`Areas touched: ${blastRadius.areas.join(', ')}`);
  lines.push('');
  for (const obligation of blastRadius.obligations) lines.push(`- ${obligation}`);
  if (blastRadius.practices.length > 0) {
    lines.push('');
    lines.push('Practices that enforce these requirements:');
    lines.push('');
    for (const primitive of blastRadius.practices) lines.push(`- \`${primitive.id}\` ${primitive.title} (tier ${primitive.tier_min})`);
  }
  if (blastRadius.gateCollisions.length > 0) {
    lines.push('');
    lines.push('Gates in the way:');
    lines.push('');
    for (const collision of blastRadius.gateCollisions) lines.push(`- ${collision}`);
  }
  lines.push('');

  lines.push('## Probe: how you will know it broke');
  lines.push('');
  if ((change.probe ?? []).length > 0) {
    for (const probe of change.probe) lines.push(`- ${probe}`);
  } else {
    lines.push('_None declared. For a low-risk change that is acceptable; write the test that would fail if the behaviour regressed._');
  }
  lines.push('');

  lines.push('## Rollback');
  lines.push('');
  lines.push(change.rollback ?? 'Revert the commit. No data migration is involved, so there is nothing to unwind.');
  lines.push('');

  if ((change.notes ?? []).length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of change.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function tasksMarkdown(plan) {
  const { change, added, modified, removed, impact } = plan;
  const lines = [];
  const box = (text) => `- [ ] ${text}`;

  lines.push(`# Tasks for ${change.id}`);
  lines.push('');
  lines.push('Work in this order. Each step ends with a check, because a delta that is not verified is a rewrite with extra paper.');
  lines.push('');
  lines.push('## 1. Approve the intent');
  lines.push('');
  lines.push(box('Read `proposal.md`. Reject it here if the blast radius is wrong: rejecting a spec is an hour, rejecting an implementation is a week.'));
  lines.push(box('Fill and review `design.md`: decisions, rejected alternatives, risks and rollback must be explicit before implementation.'));
  lines.push(box('Register reviewed product, architecture, QA and review artifacts in `evidence.json`, then record the accountable release decision in `evidence.md`.'));
  lines.push(box('Confirm `spec.after.json` is the manifest you want. It is a diff of intent, not a copy of the code.'));
  lines.push('');

  lines.push('## 2. Anchor before implementing');
  lines.push('');
  for (const requirement of added) {
    lines.push(box(`${requirement.id} \`${requirement.key}\`: write a failing test at \`${requirement.anchor}\` with \`@req ${requirement.id}\`, then implement.`));
  }
  for (const { target, definition } of modified) {
    const criteria = (definition.addAcceptance ?? []).length;
    lines.push(box(`${target.id} \`${target.key}\`: ${criteria > 0 ? `add ${criteria} assertion(s) for the new criteria` : 'update the existing test'} in the anchored test, then change the behaviour.`));
  }
  for (const { target, definition } of removed) {
    lines.push(box(`Remove ${target.id} \`${target.key}\`${target.anchor ? ` and delete or re-anchor \`${target.anchor}\`` : ''}. Reason recorded: ${definition.why}`));
  }
  lines.push('');

  lines.push('## 3. Apply the manifest');
  lines.push('');
  lines.push(box('Replace `spec.json` with `spec.after.json` (or run `vld change --apply`).'));
  lines.push(box('Update the prose documents the delta touches; the obligations in `proposal.md` name them.'));
  lines.push(box('Run `node specs/spec-check.mjs --repo .` — new requirements appear as pending until their tests exist.'));
  lines.push('');

  lines.push('## 4. Verify');
  lines.push('');
  lines.push(box('YOUR GATES: every gate for the tier still passes. A change that weakens a gate is a tier question, not a code question.'));
  for (const probe of change.probe ?? []) lines.push(box(`Probe: ${probe}`));
  lines.push(box('`node specs/spec-check.mjs --repo . --strict` passes before release.'));
  lines.push('');

  lines.push('## 5. Close the loop');
  lines.push('');
  lines.push(box('Rebuild the index if a primitive changed: `node factory/cli.mjs index --check`.'));
  lines.push(box(`Archive this change directory under \`specs/changes/archive/\` once merged. Impact: **${impact}**.`));
  lines.push(box('If the change taught you something about the domain, update the glossary in the same pull request.'));
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function evidenceMarkdown(plan) {
  const changed = [
    ...plan.added.map((requirement) => ({ id: requirement.id, key: requirement.key, action: 'Added' })),
    ...plan.modified.map(({ target }) => ({ id: target.id, key: target.key, action: 'Modified' })),
    ...plan.removed.map(({ target }) => ({ id: target.id, key: target.key, action: 'Removed' }))
  ];
  return `# Evidence for ${plan.change.id}\n\n**Status:** Pending\n\n## Artifact Register\n\nThe paths and requirement links are recorded in \`evidence.json\`. Those links point at reviewed human artifacts; they do not replace \`delta.json\` or \`spec.after.json\` as the requirement source of truth.\n\n## Change Traceability\n\n| Change | Requirement | Evidence to review |\n| --- | --- | --- |\n${changed.map((entry) => `| ${entry.action} | ${entry.id} — ${entry.key} | [Link a reviewed product, architecture, QA or review artifact.] |`).join('\n')}\n\n## Release Decision\n\n[Record the accountable approver, decision, residual risk and the release or rollback condition.]\n`;
}

function evidenceManifest() {
  return { schemaVersion: 1, artifacts: [] };
}

function designMarkdown(plan) {
  const { change, impact, blastRadius, added, modified, removed } = plan;
  const lines = [
    `# Design for ${change.id}`,'',
    `**Status:** Proposed · **Impact:** ${impact} · **Risk:** ${change.risk}`,'',
    '## Context','',
    `This change touches ${blastRadius.areas.join(', ')} and changes ${added.length} added, ${modified.length} modified and ${removed.length} removed requirement(s).`,'',
    '## Decisions','',
    '- [Record the implementation boundary, data/contract decision and rationale before changing code.]','',
    '## Alternatives Considered','',
    '- [Record a rejected alternative and the reason it is unsafe, too costly or does not meet the requirements.]','',
    '## Risks and Rollback','',
    change.rollback ?? 'Revert the change; document any data restoration step before approval.','',
    '## Requirement Links','',
    ...[...added.map((r) => `- ${r.id} — ${r.key}`), ...modified.map((r) => `- ${r.target.id} — ${r.target.key}`), ...removed.map((r) => `- ${r.target.id} — ${r.target.key}`)], ''
  ];
  return `${lines.join('\n')}\n`;
}

export function renderChange(plan) {
  const files = new Map();
  files.set('proposal.md', proposalMarkdown(plan));
  files.set('design.md', designMarkdown(plan));
  files.set('evidence.md', evidenceMarkdown(plan));
  files.set('evidence.json', `${JSON.stringify(evidenceManifest(), null, 2)}\n`);
  files.set('tasks.md', tasksMarkdown(plan));
  files.set('delta.json', `${JSON.stringify(
    {
      schemaVersion: 1,
      id: plan.change.id,
      title: plan.change.title,
      why: plan.change.why,
      risk: plan.change.risk,
      impact: plan.impact,
      base: {
        packet: path.basename(plan.packet.dir),
        requirements: plan.packet.requirements,
        tier: plan.packet.tier
      },
      added: plan.added,
      modified: plan.modified,
      removed: plan.removed,
      probe: plan.change.probe ?? [],
      rollback: plan.change.rollback ?? null,
      blastRadius: plan.blastRadius,
      requirementsAfter: plan.afterSpec.requirements.length
    },
    null,
    2
  )}\n`);
  files.set('spec.after.json', `${JSON.stringify(plan.afterSpec, null, 2)}\n`);
  return files;
}

export function emitChange(plan, outDir, { force = false } = {}) {
  if (plan.errors.length > 0) {
    const error = new Error(`change is not valid:\n  - ${plan.errors.join('\n  - ')}`);
    error.code = 'INVALID_CHANGE';
    throw error;
  }

  const target = path.resolve(outDir);
  if (existsSync(target) && !force) {
    const error = new Error(`${target} already exists. Pass --force to replace it.`);
    error.code = 'OUTPUT_EXISTS';
    throw error;
  }

  mkdirSync(target, { recursive: true });
  const files = renderChange(plan);
  const written = [];
  for (const [name, content] of files) {
    writeFileSync(path.join(target, name), content, 'utf8');
    written.push({ name, lines: content.split('\n').length });
  }
  return { outDir: target, written };
}

/** Copy the post-change manifest into the packet, keeping a backup. */
export function applyChange(plan, { force = false } = {}) {
  const specPath = path.join(plan.packet.dir, 'spec.json');
  const backupPath = path.join(plan.packet.dir, 'spec.json.bak');
  if (existsSync(backupPath) && !force) {
    const error = new Error(`${backupPath} already exists from an earlier apply. Restore or remove it first.`);
    error.code = 'OUTPUT_EXISTS';
    throw error;
  }
  writeFileSync(backupPath, readFileSync(specPath, 'utf8'), 'utf8');
  writeFileSync(specPath, `${JSON.stringify(plan.afterSpec, null, 2)}\n`, 'utf8');
  return { specPath, backupPath };
}


// ------------------------------------------------------------------ archive

/**
 * Fold an applied change back into the packet's source of truth.
 *
 * A delta is a proposal; the packet is generated from a profile. Leaving an applied
 * delta only in `spec.json` means the next `vld compile` silently drops it, which is
 * the worst kind of data loss: the requirement is gone and nothing says so. So the
 * archive step writes the delta into the profile's overlay stack (the team layer),
 * records the merge in `changes/history.json`, keeps the change directory under
 * `changes/archive/<id>/`, and recompiles.
 *
 * Idempotent by construction: the overlay file is a pure function of the delta, the
 * history entry is keyed by change id, and the recompile is a pure function of the
 * profile — so archiving twice produces byte-identical files.
 */
export async function archiveChange({ packetDir, changeDir, profilePath = null, force = false, recompile = true }) {
  const specPath = path.join(packetDir, 'spec.json');
  if (!existsSync(specPath)) throw new Error(`no spec.json in ${packetDir}`);
  const spec = readJson(specPath);
  const deltaPath = path.join(changeDir, 'delta.json');
  if (!existsSync(deltaPath)) {
    const error = new Error(`${changeDir} is not a change directory: no delta.json`);
    error.code = 'NO_DELTA';
    throw error;
  }
  const delta = readJson(deltaPath);

  const profileFile = resolveProfileFile({ profilePath, spec, packetDir });
  const evidenceCheck = verifyChange(changeDir, { projectDir: path.dirname(profileFile) });
  if (!evidenceCheck.ok) {
    const error = new Error(`change evidence is not ready to archive:\n${evidenceCheck.errors.map((issue) => `- ${issue}`).join('\n')}`);
    error.code = 'CHANGE_EVIDENCE_INVALID';
    throw error;
  }
  const evidence = readJson(path.join(changeDir, 'evidence.json'));

  const profile = readJson(profileFile);
  const overlayId = `change-${delta.id}`;
  const overlayDir = path.join(path.dirname(profileFile), 'overlays');
  const overlayPath = path.join(overlayDir, `${overlayId}.json`);

  // --- the delta, restated as an overlay a later compile can re-apply
  const addRequirements = (delta.added ?? []).map((requirement) => ({
    key: requirement.key,
    title: requirement.title,
    area: requirement.area ?? 'core',
    statement: requirement.statement,
    failurePath: requirement.failurePath,
    acceptance: (requirement.acceptance ?? []).map((criteria) => criteria.text ?? String(criteria)),
    verify: requirement.verify ?? 'automated',
    why: requirement.why ?? ''
  }));

  const modify = (delta.modified ?? [])
    .map(({ definition = {}, target = {} }) => {
      const entry = { key: target.key ?? definition.key };
      if (definition.statement) entry.statement = definition.statement;
      if (definition.failurePath) entry.failurePath = definition.failurePath;
      if (definition.title) entry.title = definition.title;
      if ((definition.addAcceptance ?? []).length > 0) entry.addAcceptance = definition.addAcceptance;
      return Object.keys(entry).length > 1 ? entry : null;
    })
    .filter(Boolean);

  const remove = (delta.removed ?? [])
    .map(({ definition = {}, target = {} }) => ({ key: target.key ?? definition.key, why: definition.why }))
    .filter((entry) => entry.key);

  const overlay = {
    id: overlayId,
    layer: 'team',
    title: `Change: ${delta.title}`,
    why: delta.why,
    provenance: {
      from: 'vld change',
      change: delta.id,
      risk: delta.risk,
      impact: delta.impact,
      base: delta.base ?? null
    },
    addRequirements,
    addGates: [],
    modify,
    remove
  };

  mkdirSync(overlayDir, { recursive: true });
  const overlayText = `${JSON.stringify(overlay, null, 2)}\n`;
  const overlayChanged = !existsSync(overlayPath) || readFileSync(overlayPath, 'utf8') !== overlayText;
  writeFileSync(overlayPath, overlayText, 'utf8');

  // --- the profile lists the overlay, once
  const overlays = Array.isArray(profile.overlays) ? profile.overlays : [];
  const profileChanged = !overlays.includes(overlayId);
  if (profileChanged) {
    profile.overlays = [...overlays, overlayId];
    writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  }

  // --- the change directory is kept with the packet that absorbed it
  const archiveRoot = path.join(packetDir, 'changes', 'archive');
  const archiveDir = path.join(archiveRoot, delta.id);
  mkdirSync(archiveRoot, { recursive: true });
  if (path.resolve(changeDir) !== path.resolve(archiveDir)) {
    cpSync(changeDir, archiveDir, { recursive: true, force: true });
  }

  // --- history: one entry per change, in merge order, rewritten in place
  const historyPath = path.join(packetDir, 'changes', 'history.json');
  const history = existsSync(historyPath)
    ? readJson(historyPath)
    : { schemaVersion: 1, packet: path.basename(path.resolve(packetDir)), entries: [] };
  const entry = {
    id: delta.id,
    title: delta.title,
    risk: delta.risk,
    impact: delta.impact,
    why: delta.why,
    overlay: overlayId,
    added: addRequirements.map((requirement) => requirement.key),
    modified: modify.map((item) => item.key),
    removed: remove.map((item) => item.key),
    requirementsAfter: Number.isInteger(delta.requirementsAfter) ? delta.requirementsAfter : null,
    evidence: {
      file: 'evidence.md',
      artifacts: evidence.artifacts.map((artifact) => ({ kind: artifact.kind, file: artifact.file, requirements: artifact.requirements }))
    }
  };
  // A recompile reports what it carried forward and what it dropped in the manifest.
  // That is a record of one transition, not a property of the packet, so it belongs
  // next to the change that caused it — and leaving it in spec.json would make an
  // archived packet differ from a freshly compiled one for the same inputs.
  const compiled = recompile ? await recompilePacket(profileFile, packetDir, { force: true }) : null;
  if (compiled) {
    const after = readJson(specPath);
    if (after.history) {
      entry.compile = after.history;
      delete after.history;
      writeFileSync(specPath, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
    }
  }

  const existing = history.entries.findIndex((item) => item.id === delta.id);
  if (existing === -1) history.entries.push(entry);
  else {
    // Re-archiving keeps the first record of what the compile did: it is history,
    // and rewriting it to "nothing to report" would erase the drop it documents.
    history.entries[existing] = { ...entry, compile: history.entries[existing].compile ?? entry.compile };
  }
  history.entries = history.entries.map((item, index) => ({ ...item, n: index + 1 }));
  writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');

  return {
    overlayId,
    overlayPath,
    historyPath,
    archiveDir,
    profilePath: profileFile,
    evidence: { artifacts: evidence.artifacts.length, file: path.join(archiveDir, 'evidence.md') },
    changed: { overlay: overlayChanged, profile: profileChanged, history: true },
    compiled
  };
}

/**
 * Recompile an existing packet in place. Kept here rather than in the CLI so the
 * archive path and the `vld compile` path cannot drift: same planner, same emitter,
 * same id carry-over.
 */
export function recompilePacket(profileFile, packetDir, { force = true } = {}) {
  const profile = normalizeProfile(readJson(profileFile));
  const previousIds = existsSync(path.join(packetDir, 'spec.json'))
    ? Object.fromEntries(
        (readJson(path.join(packetDir, 'spec.json')).requirements ?? []).map((requirement) => [requirement.key, requirement.id])
      )
    : {};
  const plan = buildPlan(profile, {
    index: buildIndex(),
    previousIds,
    profileDir: path.dirname(path.resolve(profileFile))
  });
  // Keep the packet's own record of its source, so a second archive is not an error.
  const previousSpec = existsSync(path.join(packetDir, 'spec.json')) ? readJson(path.join(packetDir, 'spec.json')) : null;
  plan.profileLabel = previousSpec?.project?.profile ?? profileFile.split(path.sep).join('/');
  const result = emitPacket(plan, packetDir, { force });
  return { outDir: result.outDir, requirements: plan.requirements.length, gates: plan.gates.length };
}

/**
 * Find the profile an archive should write back to.
 *
 * `spec.project.profile` is recorded as the CLI was given it, so it is relative to
 * whatever directory that command ran in. Archiving from a different directory would
 * then resolve to a different file, and writing an overlay into the wrong profile is
 * silent data corruption with a plausible-looking success message. So every candidate
 * is checked against the packet's own project name, and a mismatch refuses rather
 * than guesses.
 */
function resolveProfileFile({ profilePath, spec, packetDir }) {
  const declared = profilePath ?? spec.project?.profile ?? null;
  if (!declared) {
    const error = new Error(
      'this packet does not record where its profile lives, so the change cannot be folded back. Pass --profile <path> (the file `vld compile` was run with).'
    );
    error.code = 'NO_PROFILE';
    throw error;
  }

  const candidates = declared.startsWith('/') || /^[A-Za-z]:\\/.test(declared)
    ? [path.resolve(declared)]
    : [path.resolve(declared), path.resolve(packetDir, '..', declared), path.resolve(packetDir, declared)];

  const expected = spec.project?.name ?? null;
  let wrongName = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let raw;
    try {
      raw = readJson(candidate);
    } catch {
      continue;
    }
    if (!expected || raw.name === expected) return candidate;
    wrongName = wrongName ?? { candidate, name: raw.name };
  }

  if (wrongName) {
    const error = new Error(
      `${wrongName.candidate} is the profile for "${wrongName.name}", not "${expected}". ` +
        'The recorded path is relative to the directory the packet was compiled in; pass --profile <path> to resolve it here.'
    );
    error.code = 'PROFILE_MISMATCH';
    throw error;
  }

  const error = new Error(`profile ${declared} does not exist (looked from ${process.cwd()} and ${packetDir}); nothing was archived`);
  error.code = 'NO_PROFILE';
  throw error;
}

// ------------------------------------------------------------------ verify

const EVIDENCE_STATUS = /\*\*Status:\*\*\s*(Approved|Conditional)/i;
function evidenceFile(project, file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || /[\r\n\0]/.test(file)) return null;
  const resolved = path.resolve(project, file);
  if (!resolved.startsWith(`${project}${path.sep}`) || !resolved.endsWith('.md') || path.relative(project, resolved).split(path.sep)[0] === '.vld') return null;
  return resolved;
}
function changedRequirementIds(delta) {
  return [
    ...(delta.added ?? []).map((requirement) => requirement.id),
    ...(delta.modified ?? []).map((entry) => entry.target?.id),
    ...(delta.removed ?? []).map((entry) => entry.target?.id)
  ].filter(Boolean);
}
function verifyEvidence({ changeDir, projectDir, delta, after }) {
  const errors = [], warnings = [], passes = [], artifacts = [];
  const markdown = path.join(changeDir, 'evidence.md');
  const manifestFile = path.join(changeDir, 'evidence.json');
  if (!existsSync(markdown)) errors.push('no evidence.md: a change needs reviewed artifact and release-decision evidence');
  else {
    const content = readFileSync(markdown, 'utf8');
    if (!content.startsWith(`# Evidence for ${delta.id}`)) errors.push('evidence.md title does not match delta id');
    for (const heading of ['Artifact Register', 'Change Traceability', 'Release Decision']) if (!new RegExp(`^## ${heading}$`, 'm').test(content)) errors.push(`evidence.md is missing ## ${heading}`);
    if (!EVIDENCE_STATUS.test(content)) errors.push('evidence.md status must be Approved or Conditional before verification');
  }
  if (!existsSync(manifestFile)) return { errors: [...errors, 'no evidence.json: a change needs explicit artifact links'], warnings, passes, artifacts };
  let manifest;
  try { manifest = readJson(manifestFile); } catch (error) { return { errors: [...errors, `evidence.json is not valid JSON: ${error.message}`], warnings, passes, artifacts }; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) errors.push('evidence.json must be an object');
  if (manifest?.schemaVersion !== 1) errors.push('evidence.json schemaVersion must be 1');
  if (!Array.isArray(manifest?.artifacts) || !manifest.artifacts.length) errors.push('evidence.json needs at least one linked reviewed artifact');
  const changed = changedRequirementIds(delta);
  const afterRequirements = after?.requirements ?? [];
  const removedRequirements = (delta.removed ?? []).map((entry) => entry.target).filter(Boolean);
  const known = new Set([...afterRequirements, ...removedRequirements].map((requirement) => requirement.id));
  const covered = new Set();
  const seen = new Set();
  for (const [index, entry] of (manifest?.artifacts ?? []).entries()) {
    const label = `evidence.json artifacts[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${label} must be an object`); continue; }
    if (!ARTIFACTS[entry.kind]) { errors.push(`${label}.kind is not a known VLD artifact type`); continue; }
    const file = evidenceFile(projectDir, entry.file);
    if (!file) { errors.push(`${label}.file must be a Markdown path inside the project`); continue; }
    const signature = `${entry.kind}:${file}`;
    if (seen.has(signature)) { errors.push(`${label} repeats ${entry.kind} at ${entry.file}`); continue; }
    seen.add(signature);
    if (!Array.isArray(entry.requirements) || !entry.requirements.length || entry.requirements.some((id) => typeof id !== 'string' || !/^REQ-\d{3}$/.test(id))) {
      errors.push(`${label}.requirements must be a non-empty REQ-### list`); continue;
    }
    if (new Set(entry.requirements).size !== entry.requirements.length) { errors.push(`${label}.requirements must not repeat`); continue; }
    for (const id of entry.requirements) {
      if (!known.has(id)) errors.push(`${label}: ${id} is not a requirement in this change's before/after manifest`);
      if (!changed.includes(id)) errors.push(`${label}: ${id} is not changed by this delta`);
      covered.add(id);
    }
    const decisionId = entry.kind === 'architecture-decision' ? path.basename(file, '.md') : null;
    try {
      const requirementsOverride = entry.kind === 'qa-plan' ? afterRequirements : [...afterRequirements, ...removedRequirements];
      const report = validateArtifact({ kind: entry.kind, projectDir, file, id: decisionId, requirementsOverride, strict: true });
      artifacts.push({ kind: entry.kind, file: entry.file, requirements: entry.requirements, strictOk: report.strictOk });
      for (const issue of report.errors) errors.push(`${label}: ${issue}`);
      if (!report.strictOk && !report.errors.length) errors.push(`${label}: linked artifact has strict-validation warnings`);
      for (const issue of report.warnings) warnings.push(`${label}: ${issue}`);
      for (const id of entry.requirements) if (!report.requirements.includes(id)) errors.push(`${label}: linked artifact does not cite ${id}`);
    } catch (error) { errors.push(`${label}: ${error.message}`); }
  }
  const missing = changed.filter((id) => !covered.has(id));
  if (missing.length) errors.push(`evidence.json does not link changed requirement(s): ${missing.join(', ')}`);
  if (!errors.length) passes.push(`${artifacts.length} reviewed artifact link(s) cover ${changed.length} changed requirement(s)`);
  return { errors, warnings, passes, artifacts };
}

export function verifyChange(changeDir, { projectDir = '.' } = {}) {
  const errors = [];
  const warnings = [];
  const passes = [];
  const project = path.resolve(projectDir);

  const deltaPath = path.join(changeDir, 'delta.json');
  if (!existsSync(deltaPath)) return { ok: false, errors: ['no delta.json in this change directory'], warnings, passes };
  if (!existsSync(path.join(changeDir, 'proposal.md'))) errors.push('no proposal.md: a change needs its argument written down');
  if (!existsSync(path.join(changeDir, 'design.md'))) errors.push('no design.md: a change needs its implementation decisions recorded');
  if (!existsSync(path.join(changeDir, 'tasks.md'))) errors.push('no tasks.md: a change needs its work order');
  if (!existsSync(path.join(changeDir, 'spec.after.json'))) errors.push('no spec.after.json: the resulting manifest is missing');

  let delta;
  try {
    delta = readJson(deltaPath);
  } catch (error) {
    return { ok: false, errors: [`delta.json is not valid JSON: ${error.message}`], warnings, passes };
  }

  if (delta.schemaVersion !== 1) errors.push(`delta.json schemaVersion is ${delta.schemaVersion}; expected 1`);
  if (!delta.id) errors.push('delta.json has no id');
  if (!RISKS.includes(delta.risk)) errors.push('delta.json has an invalid risk');
  if (!delta.why || String(delta.why).length < 20) errors.push('delta.json has no usable rationale');

  const added = delta.added ?? [];
  const modified = delta.modified ?? [];
  const removed = delta.removed ?? [];
  if (added.length + modified.length + removed.length === 0) errors.push('delta.json changes nothing');

  for (const requirement of added) {
    if (!requirement.statement || String(requirement.statement).length < 40) errors.push(`${requirement.id}: statement too thin`);
    if (!(requirement.acceptance ?? []).length) errors.push(`${requirement.id}: no acceptance criteria`);
    if (!requirement.failurePath) errors.push(`${requirement.id}: no failure path`);
    if (requirement.verify === 'automated' && !requirement.anchor) errors.push(`${requirement.id}: automated requirement needs an anchor path`);
    if ((requirement.status ?? 'todo') === 'done') errors.push(`${requirement.id}: a new requirement cannot start as done`);
  }

  for (const entry of removed) {
    if (!entry.definition?.why) errors.push(`${entry.target?.id}: removal has no reason`);
    if (entry.target?.anchor) warnings.push(`${entry.target.id}: its test at ${entry.target.anchor} will become a stray anchor unless removed or re-pointed`);
  }

  if (delta.risk === 'high') {
    if (!(delta.probe ?? []).length) errors.push('high-risk change declares no probe');
    if (!delta.rollback) errors.push('high-risk change declares no rollback');
  }

  if (errors.length === 0) passes.push(`${removed.length} removed, ${modified.length} modified, ${added.length} added · impact ${delta.impact}`);

  if (existsSync(path.join(changeDir, 'spec.after.json'))) {
    try {
      const after = readJson(path.join(changeDir, 'spec.after.json'));
      const ids = (after.requirements ?? []).map((requirement) => requirement.id);
      if (new Set(ids).size !== ids.length) errors.push('spec.after.json has duplicate requirement ids');
      if ((after.requirements ?? []).length !== delta.requirementsAfter) {
        errors.push(`spec.after.json has ${(after.requirements ?? []).length} requirements; delta.json claims ${delta.requirementsAfter}`);
      }
      if (Number(delta.base?.requirements) + added.length - removed.length !== (after.requirements ?? []).length) {
        errors.push('requirement arithmetic does not balance: base + added − removed ≠ after');
      }
      for (const requirement of after.requirements ?? []) {
        if (!(requirement.acceptance ?? []).length) errors.push(`spec.after.json: ${requirement.id} has no acceptance criteria`);
      }
      const evidence = verifyEvidence({ changeDir, projectDir: project, delta, after });
      errors.push(...evidence.errors);
      warnings.push(...evidence.warnings);
      passes.push(...evidence.passes);
      if (errors.length === 0) passes.push(`spec.after.json is consistent (${(after.requirements ?? []).length} requirements)`);
    } catch (error) {
      errors.push(`spec.after.json is not valid JSON: ${error.message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, passes };
}

export const CHANGE_TEMPLATE = {
  $help: {
    fields: {
      id: 'kebab-case, unique',
      title: 'one line',
      why: 'the argument for the change; required',
      risk: 'low | medium | high (high requires probe and rollback)',
      add: 'new requirements: {key, title, area, statement, failurePath, acceptance[], verify}',
      modify: 'existing requirements: {key, statement?, failurePath?, addAcceptance[]}',
      remove: 'existing requirements: {key, why, replaceWith?}',
      probe: 'how you would detect this change silently degrading',
      rollback: 'how to undo it'
    }
  },
  id: 'example-change',
  title: 'One line describing the change',
  why: 'Why this change now, and what breaks if it is not made.',
  risk: 'medium',
  add: [
    {
      key: 'feature.export',
      title: 'A user can export their own data',
      area: 'api',
      statement: 'When an authenticated user requests an export, the application shall deliver one download containing every record they own, which either completes or fails as a unit.',
      failurePath: 'An export that exceeds the size limit fails with a message naming the limit and leaves no partial file.',
      acceptance: ['Given a user with records, when they request an export, then a single file containing all their records is produced.'],
      verify: 'automated'
    }
  ],
  modify: [
    {
      key: 'core.primary-journey',
      addAcceptance: ['Given a completed journey, when the user requests an export, then it contains the records created in that journey.'],
      note: 'The journey now ends with a deliverable.'
    }
  ],
  remove: [],
  probe: ['After the change, a user with records in two areas exports and receives both.'],
  rollback: 'Revert the endpoint; no schema change is involved.'
};
