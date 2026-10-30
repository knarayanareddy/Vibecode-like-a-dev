/**
 * Overlays: the org -> domain -> team layering, without forking the catalog.
 *
 * A single catalog for every project fails in two directions. Too generic and the
 * organisation's own rules never appear; too specific and every project forks the
 * JSON, which is how spec systems rot. The layered answer (Spec Kit's best idea) is
 * an overlay stack: the catalog stays the baseline, and each layer *adds* what it
 * knows better than the baseline does.
 *
 * Three layers, applied in order:
 *
 *   org     what every project in this organisation must do (incident response,
 *           the security baseline, the house review rule)
 *   domain  what this kind of product must do (health data, payments, public sector)
 *   team    what this team insists on beyond both
 *
 * An overlay may add requirements, add policy gates, force a practice into the
 * selection, modify a catalog requirement, or remove one with a reason. Every one of
 * those lands in the packet with the overlay's id attached, so `spec.json` answers
 * "why is this requirement here?" without a Slack search.
 *
 * The file format is a subset of `change.json` on purpose: an overlay is a change
 * that outlives the branch it was written on.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';
import { earsError } from './ears.mjs';

const BUILTIN_DIR = path.join(ROOT, 'factory', 'overlays');
const LAYERS = ['org', 'domain', 'team'];
const AREAS = ['core', 'data', 'security', 'frontend', 'api', 'reliability', 'ai'];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;
const KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const GATE_PATTERN = /^G[0-9]-[A-Z0-9-]+$/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const fail = (message, code) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

/**
 * Where an overlay id resolves to. A project's own overlays live beside its profile
 * (`<profileDir>/overlays/<id>.json`) and win over the built-ins, so a team can
 * override a shipped overlay without editing the tool.
 */
export function overlaySource(id, { profileDir = ROOT } = {}) {
  const local = path.join(profileDir, 'overlays', `${id}.json`);
  if (existsSync(local)) return local;
  const builtin = path.join(BUILTIN_DIR, `${id}.json`);
  if (existsSync(builtin)) return builtin;
  return null;
}

export function validateOverlay(overlay, id = overlay?.id) {
  const errors = [];
  if (!overlay || typeof overlay !== 'object') return [`${id}: overlay is not an object`];

  if (!overlay.id || !ID_PATTERN.test(overlay.id)) errors.push('id: required, lowercase kebab-case (e.g. "org-baseline")');
  else if (id && overlay.id !== id) errors.push(`id: "${overlay.id}" does not match the file name "${id}"`);
  if (!LAYERS.includes(overlay.layer)) errors.push(`layer: must be one of ${LAYERS.join(', ')}`);
  if (!overlay.title) errors.push('title: required, one line');
  if (!overlay.why || String(overlay.why).length < 20) errors.push('why: required, at least 20 characters. An overlay without a reason is a fork.');

  const add = overlay.addRequirements ?? [];
  const seen = new Set();
  add.forEach((requirement, index) => {
    const label = `addRequirements[${index}]`;
    if (!requirement.key || !KEY_PATTERN.test(requirement.key)) errors.push(`${label}.key: required, namespaced kebab-case`);
    else if (seen.has(requirement.key)) errors.push(`${label}.key: "${requirement.key}" is added twice`);
    else seen.add(requirement.key);
    if (!requirement.title) errors.push(`${label}.title: required`);
    if (!requirement.statement) {
      errors.push(`${label}.statement: required`);
    } else {
      const ears = earsError(requirement.statement);
      if (ears) errors.push(`${label}.statement: not an EARS requirement — ${ears}`);
    }
    if (!requirement.failurePath || String(requirement.failurePath).length < 10) errors.push(`${label}.failurePath: required`);
    if (!Array.isArray(requirement.acceptance) || requirement.acceptance.length === 0) errors.push(`${label}.acceptance: at least one criterion`);
    if (!['automated', 'manual', 'gate'].includes(requirement.verify)) errors.push(`${label}.verify: automated, manual or gate`);
    if (!AREAS.includes(requirement.area ?? 'core')) errors.push(`${label}.area: must be one of ${AREAS.join(', ')}`);
  });

  for (const [index, gate] of (overlay.addGates ?? []).entries()) {
    const label = `addGates[${index}]`;
    if (!gate.id || !GATE_PATTERN.test(gate.id)) errors.push(`${label}.id: required, e.g. "G2-INCIDENT"`);
    if (!gate.statement || String(gate.statement).length < 20) errors.push(`${label}.statement: required, one checkable sentence`);
    if (![0, 1, 2, 3].includes(gate.tier)) errors.push(`${label}.tier: 0, 1, 2 or 3`);
  }

  for (const [index, entry] of (overlay.modify ?? []).entries()) {
    const label = `modify[${index}]`;
    if (!entry.key) errors.push(`${label}.key: required`);
    if (!entry.statement && !entry.failurePath && !(entry.addAcceptance ?? []).length) {
      errors.push(`${label}: does nothing. Provide statement, failurePath or addAcceptance.`);
    }
    if (entry.statement) {
      const ears = earsError(entry.statement);
      if (ears) errors.push(`${label}.statement: not an EARS requirement — ${ears}`);
    }
  }

  for (const [index, entry] of (overlay.remove ?? []).entries()) {
    const label = `remove[${index}]`;
    if (!entry.key) errors.push(`${label}.key: required`);
    if (!entry.why || String(entry.why).length < 20) errors.push(`${label}.why: required. Removing a baseline obligation needs an argument.`);
  }

  if (overlay.extends && !ID_PATTERN.test(overlay.extends)) errors.push('extends: must be an overlay id');

  return errors;
}

/**
 * Resolve the profile's overlay stack: load, validate, order by layer.
 *
 * Order is by layer, not by the order the profile happens to list them in, because
 * "team overrides domain overrides org" is the only ordering that means anything.
 */
export function resolveOverlays(profile, { profileDir = ROOT, index = null } = {}) {
  const ids = Array.isArray(profile.overlays) ? profile.overlays : [];
  const errors = [];
  const loaded = [];
  const seen = new Set();

  for (const id of ids) {
    if (!ID_PATTERN.test(String(id))) {
      errors.push(`overlays: "${id}" is not a kebab-case overlay id`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`overlays: "${id}" is listed twice`);
      continue;
    }
    seen.add(id);
    const source = overlaySource(id, { profileDir });
    if (!source) {
      errors.push(`overlays: "${id}" not found. Looked in ${path.join(profileDir, 'overlays')} and factory/overlays.`);
      continue;
    }
    let overlay;
    try {
      overlay = readJson(source);
    } catch (error) {
      errors.push(`overlays: ${source} is not valid JSON (${error.message})`);
      continue;
    }
    const problems = validateOverlay(overlay, id);
    if (problems.length > 0) {
      errors.push(...problems.map((problem) => `${id}: ${problem}`));
      continue;
    }
    loaded.push({ overlay, source: path.relative(ROOT, source).split(path.sep).join('/'), absSource: source });
  }

  // `extends` is a promise that the layer above is built on the one below, so the
  // base has to be in the stack: a domain overlay that silently skips the org
  // baseline is a fork wearing an overlay's clothes.
  for (const { overlay } of loaded) {
    if (overlay.extends && !loaded.some((entry) => entry.overlay.id === overlay.extends)) {
      errors.push(`${overlay.id}: extends "${overlay.extends}", which is not in this profile's overlays`);
    } else if (overlay.extends) {
      const base = loaded.find((entry) => entry.overlay.id === overlay.extends).overlay;
      if (LAYERS.indexOf(base.layer) > LAYERS.indexOf(overlay.layer)) {
        errors.push(`${overlay.id}: extends "${base.id}" but a ${overlay.layer} overlay cannot build on a ${base.layer} one`);
      }
    }
  }

  if (index) {
    const known = new Set(index.primitives.map((primitive) => primitive.id));
    for (const { overlay } of loaded) {
      for (const id of overlay.addPrimitives ?? []) {
        if (!known.has(id)) errors.push(`${overlay.id}: addPrimitives references unknown practice "${id}"`);
      }
    }
  }

  const ordered = [...loaded].sort((a, b) => LAYERS.indexOf(a.overlay.layer) - LAYERS.indexOf(b.overlay.layer));

  return { overlays: ordered, errors };
}

/**
 * Fold the overlay stack into the catalog.
 *
 * Returns the merged catalog plus per-overlay provenance: what each layer added,
 * changed and removed. The base catalog is never mutated.
 */
export function applyOverlays(catalog, overlays = []) {
  let requirements = catalog.requirements.map((requirement) => ({ ...requirement, origin: 'catalog' }));
  const provenance = [];

  for (const { overlay, source } of overlays) {
    const added = [];
    const modified = [];
    const removed = [];

    for (const entry of overlay.modify ?? []) {
      const target = requirements.find((requirement) => requirement.key === entry.key);
      if (!target) continue;
      if (entry.statement) target.statement = entry.statement;
      if (entry.failurePath) target.failurePath = entry.failurePath;
      if (entry.title) target.title = entry.title;
      if ((entry.addAcceptance ?? []).length > 0) {
        target.acceptance = [...(target.acceptance ?? []), ...entry.addAcceptance];
      }
      target.origin = target.origin === 'catalog' ? `overlay:${overlay.id}` : `${target.origin}+${overlay.id}`;
      target.overlaid = [...new Set([...(target.overlaid ?? []), overlay.id])];
      modified.push(entry.key);
    }

    for (const entry of overlay.remove ?? []) {
      const before = requirements.length;
      requirements = requirements.filter((requirement) => requirement.key !== entry.key);
      if (requirements.length < before) removed.push(entry.key);
    }

    for (const entry of overlay.addRequirements ?? []) {
      // A later layer may redefine a requirement an earlier one added; the last
      // layer wins, which is what "team overrides domain" has to mean.
      requirements = requirements.filter((requirement) => requirement.key !== entry.key);
      requirements.push({
        ...entry,
        // An overlay is already a decision, so its requirements apply unless the
        // overlay says otherwise. Requiring every layer to restate `when` invites a
        // layer that adds a requirement no packet ever selects.
        when: entry.when ?? { always: true },
        render: entry.area ?? 'core',
        origin: `overlay:${overlay.id}`,
        overlaid: [overlay.id]
      });
      added.push(entry.key);
    }

    provenance.push({
      id: overlay.id,
      layer: overlay.layer,
      title: overlay.title,
      source,
      why: overlay.why,
      adds: { requirements: added, gates: (overlay.addGates ?? []).map((gate) => gate.id), practices: overlay.addPrimitives ?? [] },
      modifies: modified,
      removes: removed
    });
  }

  return { catalog: { ...catalog, requirements }, provenance };
}

/** Gates an overlay declares, each stamped with the layer that introduced it. */
export function overlayGates(overlays = []) {
  return overlays.flatMap(({ overlay }) =>
    (overlay.addGates ?? []).map((gate) => ({ ...gate, origin: `overlay:${overlay.id}` }))
  );
}

/**
 * The consistency check a packet cannot do for itself: an overlay that modifies,
 * removes or extends a requirement key that is not in the catalog is a typing
 * mistake that would otherwise be a silent no-op.
 */
export function checkOverlayTargets(catalog, overlays = []) {
  const keys = new Set(catalog.requirements.map((requirement) => requirement.key));
  const errors = [];
  for (const { overlay } of overlays) {
    for (const entry of overlay.modify ?? []) {
      if (!keys.has(entry.key)) errors.push(`${overlay.id}: modify "${entry.key}" is not a catalog requirement`);
    }
    for (const entry of overlay.remove ?? []) {
      if (!keys.has(entry.key)) errors.push(`${overlay.id}: remove "${entry.key}" is not a catalog requirement`);
    }
  }
  return errors;
}
