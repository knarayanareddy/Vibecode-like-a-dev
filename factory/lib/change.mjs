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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadIndex } from './indexer.mjs';

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
    if (!requirement.statement || String(requirement.statement).length < 40) errors.push(`${label}.statement: required, at least 40 characters`);
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

export function renderChange(plan) {
  const files = new Map();
  files.set('proposal.md', proposalMarkdown(plan));
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

// ------------------------------------------------------------------ verify

export function verifyChange(changeDir) {
  const errors = [];
  const warnings = [];
  const passes = [];

  const deltaPath = path.join(changeDir, 'delta.json');
  if (!existsSync(deltaPath)) return { ok: false, errors: ['no delta.json in this change directory'], warnings, passes };
  if (!existsSync(path.join(changeDir, 'proposal.md'))) errors.push('no proposal.md: a change needs its argument written down');
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
      statement: 'An authenticated user can request an export of every record they own, delivered as a download that completes or fails as a unit.',
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
