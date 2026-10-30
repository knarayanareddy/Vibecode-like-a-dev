/**
 * The planner.
 *
 * Input: a profile. Output: a plan. The plan is a pure function of
 * (profile, policy, routing, catalog, index) so that two runs on the same repo
 * produce identical packets, and a reviewer can diff intent rather than prose.
 *
 * Three decisions are made here and nothing else:
 *   1. How much rigor this project earns (tier), from risk and stage signals.
 *   2. Which practices apply (primitives), by predicate, minus budget overflow.
 *   3. Which behaviours must exist (requirements), by predicate.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';
import { applyOverlays, checkOverlayTargets, overlayGates, resolveOverlays } from './overlays.mjs';
import { evaluate, explain, getPath } from './predicate.mjs';

const POLICY_PATH = path.join(ROOT, 'factory', 'policy.json');
const ROUTING_PATH = path.join(ROOT, 'factory', 'routing.json');
const CATALOG_PATH = path.join(ROOT, 'factory', 'catalog', 'requirements.json');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadPolicy() {
  return readJson(POLICY_PATH);
}

export function loadRouting() {
  return readJson(ROUTING_PATH);
}

export function loadCatalog() {
  return readJson(CATALOG_PATH);
}

/** Signals that are serious enough to override a prototype/mvp ceiling. */
function isRiskExempt(profile, policy) {
  const exempt = policy.caps?.exemptWhen ?? [];
  return exempt.some((predicate) => evaluate(predicate, profile));
}

export function computeRigor(profile, policy) {
  const signals = [];
  let score = 0;

  for (const signal of policy.signals) {
    // A signal is either a full predicate or the older {field, eq} shorthand;
    // predicates allow "declared as a feature but not flagged as a risk".
    const predicate =
      signal.when ?? (signal.eq !== undefined ? { field: signal.field, eq: signal.eq } : { field: signal.field, truthy: true });
    const matched = evaluate(predicate, profile);
    if (matched) {
      score += signal.weight;
      signals.push({ label: signal.label, weight: signal.weight, field: signal.field });
    }
  }

  const eligible = policy.tiers
    .filter((tier) => score >= tier.minScore)
    .sort((a, b) => b.tier - a.tier);
  let chosen = eligible[0] ?? policy.tiers[0];

  const capTier = policy.caps?.[profile.stage];
  const exempt = isRiskExempt(profile, policy);
  let capped = false;
  if (!exempt && typeof capTier === 'number' && chosen.tier > capTier) {
    chosen = policy.tiers.find((tier) => tier.tier === capTier) ?? chosen;
    capped = true;
  }

  return {
    tier: chosen.tier,
    label: chosen.label,
    packet: chosen.packet,
    maxPrimitives: chosen.maxPrimitives,
    score,
    signals,
    capped,
    cappedReason: capped
      ? `stage "${profile.stage}" caps rigor at tier ${capTier}; raise stage or declare a hard risk (payments, regulated) if that is wrong.`
      : null
  };
}

export function selectPrimitives(profile, index, routing, rigor) {
  const byId = new Map(index.primitives.map((primitive) => [primitive.id, primitive]));
  const context = { ...profile, tier: rigor.tier };

  const selected = [];
  const skipped = [];
  const missing = [];

  routing.rules.forEach((rule, order) => {
    const primitive = byId.get(rule.primitive);
    if (!primitive) {
      missing.push(rule.primitive);
      return;
    }

    if (primitive.tier_min > rigor.tier) {
      skipped.push({
        id: primitive.id,
        title: primitive.title,
        reason: 'tier',
        detail: `requires tier ${primitive.tier_min}, project is tier ${rigor.tier}`
      });
      return;
    }

    if (!evaluate(rule.when, context)) {
      skipped.push({
        id: primitive.id,
        title: primitive.title,
        reason: 'predicate',
        detail: `not applicable: ${explain(rule.when)}`
      });
      return;
    }

    selected.push({ primitive, why: rule.why, when: explain(rule.when), order });
  });

  selected.sort((a, b) => {
    if (a.primitive.priority !== b.primitive.priority) {
      return a.primitive.priority - b.primitive.priority;
    }
    return a.order - b.order;
  });

  const kept = selected.slice(0, rigor.maxPrimitives);
  const overflow = selected.slice(rigor.maxPrimitives).map((entry) => ({
    id: entry.primitive.id,
    title: entry.primitive.title,
    reason: 'budget',
    detail: `fits at tier ${rigor.tier} only above ${rigor.maxPrimitives} primitives; deferred, not deleted`
  }));

  return {
    selected: kept.map((entry) => ({
      id: entry.primitive.id,
      module: entry.primitive.module,
      title: entry.primitive.title,
      summary: entry.primitive.summary,
      cost: entry.primitive.cost,
      priority: entry.primitive.priority,
      tier_min: entry.primitive.tier_min,
      path: entry.primitive.path,
      enforces: entry.primitive.enforces ?? [],
      artifacts: entry.primitive.artifacts ?? [],
      gates: entry.primitive.gates ?? [],
      // Carried into the plan so the packet can say what the practice obliges here,
      // and so a reviewer can tell an enforced practice from an advisory one.
      obligation: entry.primitive.obligation ?? '',
      advisory: entry.primitive.advisory === true,
      advisoryReason: entry.primitive.advisory_reason ?? '',
      why: entry.why,
      when: entry.when
    })),
    skipped,
    deferred: overflow,
    missing
  };
}

/**
 * A practice an overlay forces into the packet.
 *
 * The router answers "does this profile need it?"; an overlay answers "does this
 * organisation require it regardless?". Both are legitimate, so the forced entry
 * carries its own `why` and is never counted as a predicate match.
 */
function forcePractices(index, overlays, rigor, selection) {
  const byId = new Map(index.primitives.map((primitive) => [primitive.id, primitive]));
  const forced = [];
  for (const { overlay } of overlays) {
    for (const id of overlay.addPrimitives ?? []) {
      const primitive = byId.get(id);
      if (!primitive || primitive.tier_min > rigor.tier) continue;
      if (forced.some((entry) => entry.id === id) || selection.selected.some((entry) => entry.id === id)) continue;
      forced.push({
        id: primitive.id,
        module: primitive.module,
        title: primitive.title,
        summary: primitive.summary,
        cost: primitive.cost,
        priority: primitive.priority,
        tier_min: primitive.tier_min,
        path: primitive.path,
        enforces: primitive.enforces ?? [],
        artifacts: primitive.artifacts ?? [],
        gates: primitive.gates ?? [],
        obligation: primitive.obligation ?? '',
        advisory: primitive.advisory === true,
        advisoryReason: primitive.advisory_reason ?? '',
        why: `required by overlay ${overlay.id}`,
        when: `overlay:${overlay.id}`
      });
    }
  }
  return forced;
}

/**
 * Forced practices keep their place; the budget is spent on the router's picks.
 * A layer that requires a practice outranks a ceiling the layer did not write.
 */
function forceBudget(selection, forced, rigor) {
  if (forced.length === 0) return { selected: selection.selected };
  const room = Math.max(0, rigor.maxPrimitives - forced.length);
  const kept = selection.selected.slice(0, room);
  const dropped = selection.selected.slice(room).map((entry) => ({
    id: entry.id,
    title: entry.title,
    reason: 'budget',
    detail: `fits at tier ${rigor.tier} only above ${rigor.maxPrimitives} primitives (${forced.length} are required by overlays); deferred, not deleted`
  }));
  return { selected: [...kept, ...forced], deferredExtra: dropped };
}

/**
 * Requirement identifiers must outlive the catalog.
 *
 * Anchors in a product repository cite `REQ-###`. If ids were a position in the
 * catalog, inserting one requirement in the middle would renumber every later
 * requirement and silently repoint thousands of anchors at the wrong rules --
 * the check would still pass, which is the worst possible failure. So ids are
 * assigned once and then preserved per requirement key:
 *
 *   - a key that already had an id keeps it;
 *   - ids that belonged to requirements which dropped out are retired, never
 *     recycled, so a stale anchor cannot bind to a different rule;
 *   - new keys take the next unused number.
 *
 * A first compile has no previous ids, so it is still a deterministic function
 * of the catalog.
 */
function assignRequirementIds(chosen, previousIds = {}) {
  const used = new Set(Object.values(previousIds));
  const ids = new Map();

  for (const requirement of chosen) {
    const previous = previousIds[requirement.key];
    if (previous && !ids.has(previous)) {
      ids.set(requirement.key, previous);
    }
  }

  let next = 1;
  for (const requirement of chosen) {
    if (ids.has(requirement.key)) continue;
    while (used.has(`REQ-${String(next).padStart(3, '0')}`)) next += 1;
    const id = `REQ-${String(next).padStart(3, '0')}`;
    ids.set(requirement.key, id);
    used.add(id);
    next += 1;
  }

  return ids;
}

export function selectRequirements(profile, catalog, rigor, previousIds = {}) {
  const context = { ...profile, tier: rigor.tier };
  const chosen = catalog.requirements.filter((requirement) => evaluate(requirement.when, context));
  const ids = assignRequirementIds(chosen, previousIds);

  const requirements = chosen.map((requirement) => ({
    id: ids.get(requirement.key),
    key: requirement.key,
    // `catalog` unless an overlay added or changed it. Provenance travels with the
    // requirement so spec.json can answer "why is this here?" without a Slack search.
    origin: requirement.origin ?? 'catalog',
    render: requirement.render,
    title: requirement.title,
    statement: requirement.statement,
    // How this obligation reads in *this* product's words. The catalog owns the
    // sentence; the emitter only fills in the vocabulary, so improving what a
    // requirement means is a catalog edit rather than a change to the compiler.
    definition: requirement.definition ?? null,
    failurePath: requirement.failurePath,
    acceptance: (requirement.acceptance ?? []).map((text, acIndex) => ({
      id: `AC-${String(acIndex + 1).padStart(2, '0')}`,
      text
    })),
    verify: requirement.verify,
    why: explain(requirement.when)
  }));

  return { requirements, skipped: catalog.requirements.filter((r) => !chosen.includes(r)).map((r) => r.key) };
}

/**
 * Gates accumulate: a tier 3 project must still satisfy the tier 0 basics.
 * Gates from lower tiers are labelled with the tier that introduced them so a
 * reader can see which obligations are new.
 */
export function collectGates(profile, policy, rigor, primitives, extraGates = []) {
  const gates = new Map();
  for (let tier = 0; tier <= rigor.tier; tier += 1) {
    for (const gate of policy.gates[String(tier)] ?? []) {
      if (!gates.has(gate.id)) gates.set(gate.id, { ...gate, origin: `policy:tier-${tier}` });
    }
  }

  // A practice may name the policy gate it makes real. That is a provenance link, not
  // a way to smuggle a higher tier's obligations into a lower tier's packet, so a gate
  // above the project's own tier is ignored here and still binds at that tier.
  const policyGate = new Map();
  const gateTier = new Map();
  for (const [tier, tierGates] of Object.entries(policy.gates)) {
    for (const gate of tierGates) {
      policyGate.set(gate.id, gate);
      gateTier.set(gate.id, Number(tier));
    }
  }

  for (const primitive of primitives) {
    for (const reference of primitive.gates ?? []) {
      const id = typeof reference === 'string' ? reference : reference?.id;
      if (!id || gates.has(id)) continue;
      const definition = policyGate.get(id);
      if (!definition) continue;
      if ((gateTier.get(id) ?? Infinity) > rigor.tier) continue;
      gates.set(id, { ...definition, origin: primitive.id });
    }
  }

  // Overlay gates are declared by a layer rather than by policy, so they carry their
  // own statement and only bind at or below the tier the layer claims.
  for (const gate of extraGates) {
    if (gates.has(gate.id)) continue;
    if ((gate.tier ?? 0) > rigor.tier) continue;
    gates.set(gate.id, { id: gate.id, statement: gate.statement, origin: gate.origin });
  }

  return [...gates.values()];
}

export function buildPlan(
  profile,
  {
    index,
    routing = loadRouting(),
    policy = loadPolicy(),
    catalog = loadCatalog(),
    previousIds = {},
    overlays: givenOverlays = null,
    profileDir = ROOT
  }
) {
  const rigor = computeRigor(profile, policy);

  // Overlays are policy, so they are resolved before anything is selected: a layer
  // can add a requirement, a gate or a practice, and every later decision has to see
  // the merged catalog rather than the baseline one.
  const resolved = givenOverlays ? { overlays: givenOverlays, errors: [] } : resolveOverlays(profile, { profileDir, index });
  if (resolved.errors.length > 0) {
    const error = new Error(`overlay stack is not valid:\n  - ${resolved.errors.join('\n  - ')}`);
    error.code = 'INVALID_OVERLAY';
    throw error;
  }
  const targetErrors = checkOverlayTargets(catalog, resolved.overlays);
  if (targetErrors.length > 0) {
    const error = new Error(`overlay stack does not apply to this catalog:\n  - ${targetErrors.join('\n  - ')}`);
    error.code = 'INVALID_OVERLAY';
    throw error;
  }
  const merged = applyOverlays(catalog, resolved.overlays);

  const selection = selectPrimitives(profile, index, routing, rigor);
  const forced = forcePractices(index, resolved.overlays, rigor, selection);
  const { selected, deferredExtra = [] } = forceBudget(selection, forced, rigor);
  selection.deferred = [...deferredExtra, ...selection.deferred];

  const { requirements } = selectRequirements(profile, merged.catalog, rigor, previousIds);
  const gates = collectGates(profile, policy, rigor, selected, overlayGates(resolved.overlays));
  const docs = policy.requiredDocs[rigor.packet];

  const knownEnforces = new Set(merged.catalog.requirements.map((requirement) => requirement.key));
  const dangling = selected
    .flatMap((primitive) => (primitive.enforces ?? []).map((key) => ({ primitive: primitive.id, key })))
    .filter((entry) => !knownEnforces.has(entry.key));

  return {
    version: 1,
    profile,
    rigor,
    packet: rigor.packet,
    docs,
    primitives: selected,
    // `skipped`/`deferred` come from the routing decision; a forced practice is not a
    // selection the predicates made, and the packet says so instead.
    deferred: selection.deferred,
    skipped: selection.skipped,
    overlays: merged.provenance,
    requirements,
    gates,
    config: {
      team: profile.constraints.team,
      weeks: profile.constraints.weeks,
      stack: profile.constraints.stack
    },
    stats: {
      primitives: selected.length,
      requirements: requirements.length,
      acceptanceCriteria: requirements.reduce((sum, r) => sum + r.acceptance.length, 0),
      automated: requirements.filter((r) => r.verify === 'automated').length,
      gates: gates.length,
      deferred: selection.deferred.length,
      skipped: selection.skipped.length
    },
    warnings: selection.missing.map((id) => `routing references unknown primitive "${id}"`),
    danglingEnforces: dangling
  };
}
