/**
 * The knowledge base is data, so its integrity is testable. These tests are the
 * reason a contributor can add a primitive without breaking routing silently.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, loadPrimitives, validatePrimitives } from '../lib/indexer.mjs';
import { loadCatalog, loadPolicy, loadRouting } from '../lib/planner.mjs';

const index = buildIndex();
const routing = loadRouting();
const policy = loadPolicy();
const catalog = loadCatalog();

test('every primitive is valid', () => {
  const errors = validatePrimitives(loadPrimitives());
  assert.deepEqual(errors, [], `primitive validation failed:\n${errors.join('\n')}`);
});

test('index ids are unique and namespaced by module', () => {
  const ids = index.primitives.map((primitive) => primitive.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const primitive of index.primitives) {
    assert.ok(primitive.id.startsWith(`${primitive.module}.`), `${primitive.id} is not namespaced under ${primitive.module}`);
  }
});

test('every routing rule points at a primitive that exists', () => {
  const known = new Set(index.primitives.map((primitive) => primitive.id));
  for (const rule of routing.rules) {
    assert.ok(known.has(rule.primitive), `routing references unknown primitive "${rule.primitive}"`);
  }
});

test('every primitive has at most one routing rule and every rule has a reason', () => {
  const seen = new Map();
  for (const rule of routing.rules) {
    assert.ok(rule.why && rule.why.length > 20, `${rule.primitive} has no usable "why"`);
    assert.ok(rule.when, `${rule.primitive} has no predicate`);
    assert.equal(seen.get(rule.primitive), undefined, `${rule.primitive} is routed twice`);
    seen.set(rule.primitive, rule);
  }
});

test('every primitive is reachable: routed, or explicitly marked as reference-only', () => {
  const routed = new Set(routing.rules.map((rule) => rule.primitive));
  const unreachable = index.primitives.filter((primitive) => !routed.has(primitive.id)).map((primitive) => primitive.id);
  assert.deepEqual(unreachable, [], `primitives with no routing rule:\n${unreachable.join('\n')}`);
});

test('primitives only enforce requirement keys that exist in the catalog', () => {
  const keys = new Set(catalog.requirements.map((requirement) => requirement.key));
  for (const primitive of index.primitives) {
    for (const key of primitive.enforces ?? []) {
      assert.ok(keys.has(key), `${primitive.id} enforces unknown requirement key "${key}"`);
    }
  }
});

test('catalog requirement keys are unique and every requirement is implementable', () => {
  const seen = new Set();
  for (const requirement of catalog.requirements) {
    assert.ok(!seen.has(requirement.key), `duplicate requirement key ${requirement.key}`);
    seen.add(requirement.key);
    assert.ok(['automated', 'manual', 'gate'].includes(requirement.verify), `${requirement.key} has no verification method`);
    assert.ok(requirement.acceptance?.length > 0, `${requirement.key} has no acceptance criteria`);
    assert.ok(requirement.failurePath?.length > 10, `${requirement.key} has no failure path`);
    assert.ok(
      !/\byou should\b|\bbest practice\b/i.test(requirement.statement),
      `${requirement.key} states an aspiration rather than a behaviour`
    );
  }
});

test('policy gates are unique, ordered by tier, and stated as checkable facts', () => {
  const ids = new Set();
  for (const [tier, gates] of Object.entries(policy.gates)) {
    assert.ok(Array.isArray(gates) && gates.length > 0, `tier ${tier} has no gates`);
    for (const gate of gates) {
      assert.ok(!ids.has(gate.id), `duplicate gate id ${gate.id}`);
      ids.add(gate.id);
      assert.ok(gate.id.startsWith(`G${tier}-`), `gate ${gate.id} is filed under tier ${tier}`);
      assert.ok(gate.statement.length > 20, `gate ${gate.id} has no statement`);
    }
  }
});

test('tier ceilings increase and the line budget is defined for every tier', () => {
  let previousPrimitives = 0;
  let previousLines = 0;
  for (const tier of policy.tiers) {
    assert.ok(tier.maxPrimitives > previousPrimitives, `tier ${tier.tier} ceiling does not increase`);
    previousPrimitives = tier.maxPrimitives;
    const lines = policy.budgets.maxLinesByTier[String(tier.tier)];
    assert.ok(typeof lines === 'number' && lines > previousLines, `tier ${tier.tier} has no increasing line ceiling`);
    previousLines = lines;
  }
});

test('every required document is rendered by the emitter', async () => {
  const { renderPacket } = await import('../lib/emit/index.mjs');
  const { buildPlan } = await import('../lib/planner.mjs');
  const { normalizeProfile } = await import('../lib/profile.mjs');

  const cases = [
    ['single-file', { name: 'sketch-docs', idea: 'A throwaway prototype whose only purpose is to check the single-file packet.', kind: 'cli', stage: 'prototype' }],
    ['full', { name: 'full-docs', idea: 'A production service whose only purpose is to check that the full packet renders every document.', kind: 'api', stage: 'production' }]
  ];

  for (const [packet, profileInput] of cases) {
    const plan = buildPlan(normalizeProfile(profileInput), { index });
    assert.equal(plan.packet, packet);
    const { files } = renderPacket(plan);
    for (const doc of policy.requiredDocs[packet]) {
      assert.ok(files.has(doc), `${packet} packet does not render ${doc}`);
    }
  }
});
