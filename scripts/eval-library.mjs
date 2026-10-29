#!/usr/bin/env node
/**
 * Library eval: the first rung of the harness this project keeps claiming it needs.
 *
 * Two failure modes matter and neither needs a language model to measure:
 *
 *   1. A practice that cannot be found. If an agent asks "how do I stop duplicate
 *      webhooks" and the retry-idempotency practice does not come back first, the
 *      practice may as well not exist. Measured as self-recall@1 over the real MCP
 *      search, using the words a practitioner would type.
 *   2. A practice that is not discriminating. If a primitive is selected for every
 *      profile, or for none, it is not a selection rule; it is decoration. Measured
 *      over every committed profile.
 *
 * Every number here is deterministic: same catalog, same profiles, same output.
 * That is deliberate. A harness whose verdict depends on a model call cannot gate CI.
 *
 * Usage: node scripts/eval-library.mjs [--json]
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../factory/lib/indexer.mjs';
import { derive } from '../factory/lib/emit/derive.mjs';
import { renderPacket } from '../factory/lib/emit/index.mjs';
import { handleMessage } from '../factory/lib/mcp.mjs';
import { buildPlan, loadCatalog, loadPolicy, loadRouting } from '../factory/lib/planner.mjs';
import { normalizeProfile } from '../factory/lib/profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const index = buildIndex();
const policy = loadPolicy();

const THRESHOLDS = {
  selfRecallAtOne: 0.9, // a practice must be the top hit for its own title
  maxCollisions: 0, // two practices must not claim the same trigger phrase
  maxUnselected: 0, // a practice no profile ever selects is dead weight
  minDiscriminating: 0.95, // no practice may apply to nearly every profile
  minRedFlags: 3, // a pattern, not an anecdote
  minExcuses: 3, // the three things a competent person says while skipping it
  maxWithoutConsequence: 0, // every practice enforces something, or says it cannot
  maxMissingObligation: 0 // every selected practice must state what it obliges here
};

/** Call the MCP server exactly as an agent would. */
function call(name, args) {
  const response = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = response.result.content[0].text;
  if (response.result.isError) throw new Error(text);
  return JSON.parse(text);
}

const primitives = index.primitives;

// ---------------------------------------------------------------- discoverability
// The query is the practice's own title, lowercased, as a person would type it into
// a prompt. If that does not retrieve the practice first, the metadata is wrong.
const recall = primitives.map((primitive) => {
  const query = primitive.title.toLowerCase();
  const result = call('search_primitives', { query, limit: 3 });
  const ranked = result.matches.map((match) => match.id);
  return { id: primitive.id, query, rank: ranked.indexOf(primitive.id), top: ranked[0] ?? null };
});

const top1 = recall.filter((entry) => entry.rank === 0);
const missed = recall.filter((entry) => entry.rank !== 0);
const selfRecallAtOne = top1.length / recall.length;

// ---------------------------------------------------------------- collisions
// A trigger phrase claimed by two practices means one of them will absorb the other's
// requests. This is readable statically, before any run.
const byTrigger = new Map();
for (const primitive of primitives) {
  for (const trigger of primitive.triggers ?? []) {
    const key = trigger.toLowerCase().trim();
    if (!byTrigger.has(key)) byTrigger.set(key, []);
    byTrigger.get(key).push(primitive.id);
  }
}
const collisions = [...byTrigger.entries()]
  .filter(([, owners]) => owners.length > 1)
  .map(([trigger, owners]) => ({ trigger, owners }));

// ---------------------------------------------------------------- discrimination
// Run every committed profile through the real planner and count how often each
// practice is selected. A practice selected everywhere is not a decision.
const profileFiles = [
  ...readdirSync(path.join(ROOT, 'examples', 'ideas')).filter((file) => file.endsWith('.json')).map((file) => path.join(ROOT, 'examples', 'ideas', file)),
  path.join(ROOT, 'examples', 'retro-board', 'profile.json'),
  path.join(ROOT, 'profile.json')
];
const adversarial = path.join(ROOT, 'examples', 'ideas', 'adversarial', 'cases.json');
if (readdirSync(path.join(ROOT, 'examples', 'ideas', 'adversarial')).includes('cases.json')) {
  const cases = JSON.parse(readFileSync(adversarial, 'utf8')).cases;
  for (const testCase of cases.filter((entry) => entry.expect === 'packet')) {
    profileFiles.push({ inline: testCase.profile });
  }
}

const selectionCount = new Map(primitives.map((primitive) => [primitive.id, 0]));
const deferredCount = new Map(primitives.map((primitive) => [primitive.id, 0]));
let profilesRun = 0;

// Tier-1 item #2, checked the only way that counts: compile the packet and look for
// the sentence. Every selected practice must contribute at least one sentence in the
// product's own nouns, and the sentence must already be filled.
const obligationMisses = [];
const unfilledObligations = [];
let obligationChecks = 0;

for (const entry of profileFiles) {
  const raw = typeof entry === 'string' ? JSON.parse(readFileSync(entry, 'utf8')) : entry.inline;
  const profile = normalizeProfile(raw);
  const plan = buildPlan(profile, { index });
  profilesRun += 1;
  for (const practice of plan.primitives) selectionCount.set(practice.id, (selectionCount.get(practice.id) ?? 0) + 1);
  for (const practice of plan.deferred) deferredCount.set(practice.id, (deferredCount.get(practice.id) ?? 0) + 1);

  const cards = derive(plan).cards;
  const { files } = renderPacket(plan);
  const packet = [...files.values()].join('\n');
  for (const card of cards) {
    obligationChecks += 1;
    if (!card.obligation || card.obligation.trim() === '') {
      obligationMisses.push(`${profile.name || plan.profile.name}: ${card.id} has no obligation`);
      continue;
    }
    if (/\{[a-zA-Z]+\}/.test(card.obligation)) unfilledObligations.push(`${card.id}: "${card.obligation}"`);
    if (!packet.includes(card.obligation)) obligationMisses.push(`${profile.name || plan.profile.name}: ${card.id} obligation is not in the packet`);
  }
}

const never = [...selectionCount.entries()].filter(([, count]) => count === 0).map(([id]) => id);

// A practice declared `always: true` is meant to be in every packet — it is the
// skeleton, not a selection. Only an *undeclared* practice that lands on nearly every
// profile is a finding, because that means the predicate is not doing any work.
const declaredAlways = new Set(
  loadRouting()
    .rules.filter((rule) => rule.when?.always === true)
    .map((rule) => rule.primitive ?? rule.id)
);
const universal = [...selectionCount.entries()]
  .filter(([id, count]) => count / profilesRun > THRESHOLDS.minDiscriminating && !declaredAlways.has(id))
  .map(([id, count]) => ({ id, share: Number((count / profilesRun).toFixed(2)) }));

// ---------------------------------------------------------------- catalog reach
// A requirement with no practice that enforces it is a rule nothing in the library
// teaches; a practice that enforces no requirement is advice with no consequence.
const catalog = loadCatalog().requirements;
const enforced = new Set(primitives.flatMap((primitive) => primitive.enforces ?? []));
const unenforced = catalog.map((requirement) => requirement.key).filter((key) => !enforced.has(key));

// Tier-1 item #4: a practice that enforces nothing is advice. It either names the
// requirement or the policy gate it makes real, or it admits in writing that no gate
// can check it. Silence is no longer an option.
const unbound = primitives.filter((primitive) => (primitive.enforces ?? []).length === 0).map((primitive) => primitive.id);
const withoutConsequence = primitives
  .filter((primitive) => (primitive.enforces ?? []).length === 0 && (primitive.gates ?? []).length === 0 && primitive.advisory !== true)
  .map((primitive) => primitive.id);
const advisory = primitives.filter((primitive) => primitive.advisory === true);
const advisoryWithoutReason = advisory.filter((primitive) => !primitive.advisory_reason || primitive.advisory_reason.trim().length < 30).map((primitive) => primitive.id);
const knownGates = new Set(Object.values(policy.gates).flat().map((gate) => gate.id));
const unknownGates = primitives.flatMap((primitive) =>
  (primitive.gates ?? []).filter((gate) => !knownGates.has(gate)).map((gate) => `${primitive.id} → ${gate}`)
);

// Tier-1 item #3: the two sections that make a skill stick. Counted per practice, not
// in aggregate, so one richly documented practice cannot cover for a bare one.
const thinSkills = primitives
  .map((primitive) => {
    const source = readFileSync(path.join(ROOT, primitive.path), 'utf8');
    const section = (name) => {
      const start = source.indexOf(`\n## ${name}`);
      if (start === -1) return '';
      const rest = source.slice(start + 1);
      const next = rest.indexOf('\n## ', 1);
      return next === -1 ? rest : rest.slice(0, next);
    };
    const redFlags = (section('Red flags').match(/^\s*[-*]\s+\S/gm) ?? []).length;
    const excuses = (section('Anti-rationalization').match(/^\|[^|]/gm) ?? []).length;
    const rows = Math.max(0, excuses - 2); // header and separator are not rows
    return { id: primitive.id, redFlags, excuses: rows, inProduct: section('In this product').trim().length > 0 };
  })
  .filter((entry) => entry.redFlags < THRESHOLDS.minRedFlags || entry.excuses < THRESHOLDS.minExcuses || !entry.inProduct);
const thinCount = thinSkills.length;

// A requirement whose text cannot be said in the product's own words is a
// requirement that will be copied verbatim into every packet. The `definition`
// template is what makes it read about *this* product, so a missing or
// placeholder-free definition is a catalog defect, not a style preference.
const PRODUCT_SLOT = /\{(primary|aPrimary|primaryPlural|secondary|aSecondary|secondaryPlural|project|db)\}/;
const missingDefinition = catalog.filter((requirement) => !requirement.definition).map((requirement) => requirement.key);
const genericDefinition = catalog
  .filter((requirement) => requirement.definition && !PRODUCT_SLOT.test(requirement.definition))
  .map((requirement) => requirement.key);

const findings = [];
if (selfRecallAtOne < THRESHOLDS.selfRecallAtOne) {
  findings.push({
    id: 'discoverability',
    detail: `${missed.length}/${recall.length} practices do not rank first for their own title: ${missed.map((entry) => `${entry.id} → ${entry.top}`).join(', ')}`
  });
}
if (collisions.length > THRESHOLDS.maxCollisions) {
  findings.push({ id: 'trigger-collision', detail: collisions.map((entry) => `"${entry.trigger}" → ${entry.owners.join(' / ')}`).join('; ') });
}
if (never.length > THRESHOLDS.maxUnselected) {
  findings.push({ id: 'dead-weight', detail: `never selected by any of ${profilesRun} profiles: ${never.join(', ')}` });
}
if (missingDefinition.length > 0) {
  findings.push({ id: 'requirement-without-definition', detail: missingDefinition.join(', ') });
}
if (genericDefinition.length > 0) {
  findings.push({
    id: 'requirement-definition-is-generic',
    detail: `no product slot in: ${genericDefinition.join(', ')}`
  });
}
if (withoutConsequence.length > THRESHOLDS.maxWithoutConsequence) {
  findings.push({
    id: 'practice-without-consequence',
    detail: `no requirement, no gate and no advisory reason: ${withoutConsequence.join(', ')}`
  });
}
if (advisoryWithoutReason.length > 0) {
  findings.push({ id: 'advisory-without-reason', detail: advisoryWithoutReason.join(', ') });
}
if (unknownGates.length > 0) {
  findings.push({ id: 'unknown-gate', detail: unknownGates.join(', ') });
}
if (thinSkills.length > 0) {
  findings.push({
    id: 'thin-skill',
    detail: thinSkills
      .map((entry) => `${entry.id} (${entry.redFlags} red flags, ${entry.excuses} excuses${entry.inProduct ? '' : ', no obligation section'})`)
      .join('; ')
  });
}
if (obligationMisses.length > THRESHOLDS.maxMissingObligation) {
  findings.push({ id: 'obligation-not-in-packet', detail: obligationMisses.slice(0, 6).join('; ') + (obligationMisses.length > 6 ? `; +${obligationMisses.length - 6} more` : '') });
}
if (unfilledObligations.length > 0) {
  findings.push({ id: 'obligation-not-filled', detail: unfilledObligations.join('; ') });
}
if (universal.length > 0) {
  findings.push({
    id: 'non-discriminating',
    detail: `selected for >${THRESHOLDS.minDiscriminating * 100}% of profiles without being declared always: ${universal
      .map((entry) => `${entry.id} (${Math.round(entry.share * 100)}%)`)
      .join(', ')}`
  });
}

const report = {
  primitives: primitives.length,
  profilesRun,
  selfRecallAtOne: Number(selfRecallAtOne.toFixed(3)),
  missed,
  collisions,
  never,
  universal,
  declaredAlways: [...declaredAlways],
  unenforced,
  unbound,
  withoutConsequence,
  advisory: advisory.map((primitive) => ({ id: primitive.id, reason: primitive.advisory_reason })),
  unknownGates,
  thinSkills,
  obligationChecks,
  obligationMisses,
  unfilledObligations,
  missingDefinition,
  genericDefinition,
  selectionCount: Object.fromEntries([...selectionCount.entries()].sort((a, b) => b[1] - a[1])),
  findings
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`library eval · ${primitives.length} practices · ${profilesRun} profiles\n`);
  console.log(`discoverability   self-recall@1 ${(selfRecallAtOne * 100).toFixed(1)}%  (threshold ${THRESHOLDS.selfRecallAtOne * 100}%)`);
  if (missed.length > 0) {
    for (const entry of missed) console.log(`  ✗ "${entry.query}" → top hit ${entry.top ?? 'nothing'}, expected ${entry.id}`);
  }
  console.log(`collisions        ${collisions.length}`);
  for (const entry of collisions) console.log(`  ! "${entry.trigger}" claimed by ${entry.owners.join(', ')}`);
  console.log(
    `discrimination    ${never.length} never selected · ${universal.length} universally selected without being declared always · ` +
      `${declaredAlways.size} declared always-on (the packet skeleton)`
  );
  const ranked = Object.entries(report.selectionCount).slice(0, 6);
  console.log(`  most selected:  ${ranked.map(([id, count]) => `${id} ${count}`).join(' · ')}`);
  console.log(`catalog reach     ${catalog.length - unenforced.length}/${catalog.length} requirements have an enforcing practice`);
  console.log(
    `product wording   ${catalog.length - missingDefinition.length - genericDefinition.length}/${catalog.length} requirements define themselves in the product's words`
  );
  if (missingDefinition.length > 0) console.log(`  no definition: ${missingDefinition.join(', ')}`);
  if (genericDefinition.length > 0) console.log(`  definition never names the product: ${genericDefinition.join(', ')}`);
  if (unenforced.length > 0) console.log(`  no practice enforces: ${unenforced.join(', ')}`);
  if (unbound.length > 0) {
    console.log(`  practices with no requirement: ${unbound.length} (${unbound.slice(0, 6).join(', ')}${unbound.length > 6 ? ', …' : ''}), of which ${unbound.length - withoutConsequence.length} are bound to a gate or declared advisory`);
  }
  console.log(
    `consequences      ${primitives.length - withoutConsequence.length}/${primitives.length} practices have one ` +
      `(${primitives.length - unbound.length} enforce a requirement, ${primitives.filter((p) => (p.gates ?? []).length > 0).length} make a gate real, ${advisory.length} declared advisory)`
  );
  if (withoutConsequence.length > 0) console.log(`  no consequence and not advisory: ${withoutConsequence.join(', ')}`);
  for (const entry of advisory) console.log(`  advisory ${entry.id}: ${entry.advisory_reason}`);
  if (unknownGates.length > 0) console.log(`  gate ids not in policy: ${unknownGates.join(', ')}`);
  console.log(
    `skill depth       ${primitives.length - thinCount}/${primitives.length} have an obligation, ` +
      `${THRESHOLDS.minRedFlags}+ red flags and ${THRESHOLDS.minExcuses}+ anti-rationalization rows`
  );
  if (thinCount > 0) {
    for (const entry of thinSkills) console.log(`  ✗ ${entry.id}: ${entry.redFlags} red flags, ${entry.excuses} excuses, obligation section ${entry.inProduct ? 'present' : 'missing'}`);
  }
  console.log(`obligations       ${obligationChecks - obligationMisses.length}/${obligationChecks} selected practice/state pairs state what they oblige, filled, inside the packet`);

  if (findings.length === 0) {
    console.log('\nPASS · no library-level finding');
  } else {
    console.log('\nFindings');
    for (const finding of findings) console.log(`  ✗ ${finding.id}: ${finding.detail}`);
  }
}

process.exitCode = findings.length > 0 ? 1 : 0;
