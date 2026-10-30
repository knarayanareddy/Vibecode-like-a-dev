/**
 * Overlays are the layer where an organisation's rules enter a packet without
 * forking the catalog. The tests below check the three things that make that true:
 * the layers apply in a fixed order, every claim is recorded, and a broken layer
 * fails loudly instead of silently adding nothing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { applyOverlays, checkOverlayTargets, overlayGates, resolveOverlays, validateOverlay } from '../lib/overlays.mjs';
import { buildPlan, loadCatalog } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { ROOT } from '../lib/indexer.mjs';

const index = buildIndex();
const catalog = loadCatalog();
const BUILTIN = path.join(ROOT, 'factory', 'overlays');

const profileWith = (overlays, overrides = {}) =>
  normalizeProfile({
    name: 'clinic-bookings',
    idea: 'A booking service for physiotherapy clinics where patients book with a therapist and clinics publish availability.',
    kind: 'api',
    stage: 'production',
    traits: ['auth', 'persistence'],
    risks: { pii: true, regulated: true },
    overlays,
    ...overrides
  });

test('every shipped overlay is valid and named after its file', () => {
  const files = readdirSync(BUILTIN).filter((file) => file.endsWith('.json'));
  assert.ok(files.length >= 3, 'the repository ships at least one overlay per layer');
  const layers = new Set();
  for (const file of files) {
    const overlay = JSON.parse(readFileSync(path.join(BUILTIN, file), 'utf8'));
    assert.deepEqual(validateOverlay(overlay, path.basename(file, '.json')), [], file);
    layers.add(overlay.layer);
  }
  assert.deepEqual([...layers].sort(), ['domain', 'org', 'team'], 'org, domain and team each have an example');
});

test('overlays apply org -> domain -> team regardless of the order they are listed', () => {
  const forwards = resolveOverlays(profileWith(['org-baseline', 'health-data', 'two-person-review']), { index });
  const backwards = resolveOverlays(profileWith(['two-person-review', 'health-data', 'org-baseline']), { index });

  assert.deepEqual(forwards.errors, []);
  assert.deepEqual(backwards.errors, []);
  assert.deepEqual(
    forwards.overlays.map((entry) => entry.overlay.id),
    ['org-baseline', 'health-data', 'two-person-review']
  );
  assert.deepEqual(forwards.overlays.map((entry) => entry.overlay.id), backwards.overlays.map((entry) => entry.overlay.id));
});

test('a broken layer fails with the reason, not with a silent omission', () => {
  const unknown = resolveOverlays(profileWith(['no-such-overlay']), { index });
  assert.equal(unknown.overlays.length, 0);
  assert.match(unknown.errors.join('\n'), /not found/);

  const duplicate = resolveOverlays(profileWith(['org-baseline', 'org-baseline']), { index });
  assert.match(duplicate.errors.join('\n'), /listed twice/);

  // health-data extends org-baseline, so dropping the base is a fork, not an overlay.
  const orphan = resolveOverlays(profileWith(['health-data']), { index });
  assert.match(orphan.errors.join('\n'), /extends "org-baseline"/);

  const badLayer = validateOverlay({ id: 'x', layer: 'company', title: 't', why: 'a sufficiently long reason for this fixture' });
  assert.match(badLayer.join('\n'), /layer: must be one of/);

  const notEars = validateOverlay({
    id: 'x',
    layer: 'org',
    title: 't',
    why: 'a sufficiently long reason for this fixture',
    addRequirements: [
      { key: 'x.y', title: 't', statement: 'Users can export things and it should work well.', failurePath: 'nope', acceptance: ['a'], verify: 'manual' }
    ]
  });
  assert.match(notEars.join('\n'), /not an EARS requirement/);

  // A layer that modifies a key the catalog does not have is a typo that would
  // otherwise be a no-op; the planner refuses the stack.
  const targets = checkOverlayTargets(catalog, [
    { overlay: { id: 'typo', layer: 'team', modify: [{ key: 'core.nonexistent', statement: 'The application shall do something, forever.' }] }, source: 'x' }
  ]);
  assert.match(targets.join('\n'), /is not a catalog requirement/);
});

test('a layer adds a requirement and a gate, and both keep their provenance', () => {
  const resolved = resolveOverlays(profileWith(['org-baseline']), { index });
  const merged = applyOverlays(catalog, resolved.overlays);

  const added = merged.catalog.requirements.find((requirement) => requirement.key === 'ops.incident-response');
  assert.ok(added, 'the overlay requirement is in the merged catalog');
  assert.equal(added.origin, 'overlay:org-baseline');
  assert.equal(merged.catalog.requirements.length, catalog.requirements.length + 1);

  const gates = overlayGates(resolved.overlays);
  assert.deepEqual(gates.map((gate) => gate.id), ['G1-INCIDENT']);
  assert.equal(gates[0].origin, 'overlay:org-baseline');

  assert.deepEqual(merged.provenance[0].adds, {
    requirements: ['ops.incident-response'],
    gates: ['G1-INCIDENT'],
    practices: []
  });
  // The base catalog is untouched: an overlay is a layer, not an edit.
  assert.equal(catalog.requirements.some((requirement) => requirement.key === 'ops.incident-response'), false);
});

test('modify and remove are recorded, and the last layer wins', () => {
  const resolved = resolveOverlays(profileWith(['org-baseline', 'two-person-review']), { index });
  const merged = applyOverlays(catalog, resolved.overlays);
  const journey = merged.catalog.requirements.find((requirement) => requirement.key === 'core.primary-journey');

  assert.ok(journey.acceptance.length > 1, 'the team layer appended an acceptance criterion');
  assert.match(journey.origin, /overlay:two-person-review/);
  assert.deepEqual(journey.overlaid, ['two-person-review']);

  const removal = applyOverlays(catalog, [
    { overlay: { id: 'lean', layer: 'team', remove: [{ key: 'ui.design-tokens', why: 'No interface in this product at all.' }] }, source: 'x' }
  ]);
  assert.equal(removal.catalog.requirements.some((requirement) => requirement.key === 'ui.design-tokens'), false);
  assert.deepEqual(removal.provenance[0].removes, ['ui.design-tokens']);
});

test('a compiled packet records the stack in spec.json and shows it in the constitution', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-overlay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const plan = buildPlan(profileWith(['org-baseline', 'health-data', 'two-person-review']), { index, profileDir: root });
  const { outDir } = emitPacket(plan, path.join(root, 'spec'));
  const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));

  // The acceptance test for this feature, read straight off the manifest.
  assert.equal(spec.overlays.length, 3);
  assert.deepEqual(spec.overlays.map((overlay) => overlay.layer), ['org', 'domain', 'team']);
  assert.ok(spec.overlays[0].adds.requirements.includes('ops.incident-response'));
  assert.ok(spec.overlays[0].adds.gates.includes('G1-INCIDENT'));

  const requirement = spec.requirements.find((entry) => entry.key === 'ops.incident-response');
  assert.equal(requirement.origin, 'overlay:org-baseline');
  assert.ok(spec.requirements.some((entry) => entry.origin === 'catalog'), 'baseline requirements stay labelled');

  const gate = spec.gates.find((entry) => entry.id === 'G1-INCIDENT');
  assert.equal(gate.origin, 'overlay:org-baseline');

  const constitution = readFileSync(path.join(outDir, '00-constitution.md'), 'utf8');
  assert.match(constitution, /Overlays/);
  assert.match(constitution, /org-baseline/);
  assert.match(constitution, /Health data handling/);
});

test('an overlay can force a practice the router would have skipped', () => {
  const profile = profileWith([]);
  const withoutOverlay = buildPlan(profile, { index });
  const skipped = withoutOverlay.skipped.map((entry) => entry.id);
  assert.ok(skipped.includes('frontend.ui-state-model'), 'the fixture profile skips this practice');

  const forcedOverlay = {
    overlay: {
      id: 'team-screens',
      layer: 'team',
      title: 'States on every screen',
      why: 'This team ships an admin interface with the API and wants the four screen states required even though the product is an API.',
      addPrimitives: ['frontend.ui-state-model']
    },
    source: 'inline'
  };
  const withOverlay = buildPlan(profile, { index, overlays: [forcedOverlay] });
  const forced = withOverlay.primitives.find((primitive) => primitive.id === 'frontend.ui-state-model');
  assert.ok(forced, 'the team overlay forces the practice into the packet');
  assert.equal(forced.when, 'overlay:team-screens');
  assert.match(forced.why, /required by overlay team-screens/);

  // A layer cannot force a practice above its own tier: that is a tier decision.
  const tooHigh = buildPlan(profile, {
    index,
    overlays: [{ overlay: { id: 'x', layer: 'team', addPrimitives: ['testing.property-based-testing'] }, source: 'inline' }]
  });
  assert.equal(tooHigh.primitives.some((primitive) => primitive.id === 'testing.property-based-testing'), false);

  // A forced practice that the router already picked is not listed twice.
  const redundant = buildPlan(profileWith(['org-baseline', 'two-person-review']), { index });
  const review = redundant.primitives.filter((primitive) => primitive.id === 'agent.review-protocol');
  assert.equal(review.length, 1);
});

test('an invalid stack stops the build instead of producing a packet without it', () => {
  assert.throws(() => buildPlan(profileWith(['no-such-overlay']), { index }), /overlay stack is not valid/);
});
