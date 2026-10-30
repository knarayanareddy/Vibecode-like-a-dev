/**
 * EARS is a shape, and a shape is only worth enforcing if the parser refuses things.
 * Half of these tests are the catalog; the other half are the sentences a well-meaning
 * author writes instead, because those are what the guard exists to catch.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { EARS_PATTERNS, isEars, parseEars } from '../lib/ears.mjs';
import { loadCatalog } from '../lib/planner.mjs';

const catalog = loadCatalog();

test('every catalog requirement parses as one of the five EARS shapes', () => {
  const failures = catalog.requirements
    .map((requirement) => ({ key: requirement.key, ...parseEars(requirement.statement) }))
    .filter((entry) => !entry.ok);
  assert.deepEqual(
    failures.map((entry) => `${entry.key}: ${entry.errors.join('; ')}`),
    [],
    'a requirement that does not parse cannot be turned into a test'
  );
});

test('the catalog uses more than one shape', () => {
  const patterns = new Set(catalog.requirements.map((requirement) => parseEars(requirement.statement).pattern));
  assert.ok(patterns.size >= 3, `only ${[...patterns].join(', ')} used`);
  assert.ok(!patterns.has(null), 'a null pattern means a statement failed to parse');
  for (const pattern of patterns) {
    assert.ok(
      EARS_PATTERNS.some((entry) => entry.pattern === pattern),
      `unknown pattern ${pattern}`
    );
  }
});

test('each of the five shapes is recognised, with its clauses separated', () => {
  const cases = [
    ['The application shall reject a file larger than the documented limit.', 'ubiquitous', {}],
    ['When an upload exceeds the limit, the application shall reject it with the limit in the message.', 'event', { trigger: 'an upload exceeds the limit' }],
    ['While a restore is running, the database shall refuse writes to the affected table.', 'state', { state: 'a restore is running' }],
    ['If the signature does not verify, then the application shall drop the event without retrying it.', 'unwanted', { condition: 'the signature does not verify' }],
    ['Where multi-tenancy is enabled, the application shall resolve the tenant from the session.', 'optional', { feature: 'multi-tenancy is enabled' }]
  ];

  for (const [statement, pattern, clauses] of cases) {
    const parsed = parseEars(statement);
    assert.equal(parsed.ok, true, `${statement}: ${parsed.errors.join('; ')}`);
    assert.equal(parsed.pattern, pattern, statement);
    for (const [key, value] of Object.entries(clauses)) assert.equal(parsed.clauses[key], value, statement);
    assert.ok(parsed.response, 'every parse yields a response');
    assert.match(parsed.system, /^(the|The) /);
  }
});

test('clauses compose in the fixed order WHERE -> WHILE -> WHEN -> IF', () => {
  const parsed = parseEars(
    'Where billing is enabled, while a payout is pending, when a charge is retried, the application shall reuse the original idempotency key.'
  );
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.deepEqual(Object.keys(parsed.clauses), ['feature', 'state', 'trigger']);
  assert.equal(parsed.pattern, 'event');
});

test('the shapes a reader would accept but a machine cannot are refused', () => {
  const cases = [
    ['A new contributor can install dependencies and run the tests.', /no "shall"/],
    ['The application should validate every upload.', /no "shall"/],
    ['The application may reject a file that is too large.', /no "shall"/],
    ['The application shall validate uploads and shall log every rejection.', /more than one "shall"/],
    ['When an upload fails the application shall retry it three times before giving up.', /system phrase/],
    ['If the file is too large, the application shall reject it with the limit in the message.', /", then"/],
    ['When a write arrives, while a restore runs, the application shall queue it.', /ordered/],
    ['When an upload fails, the application shall handle it appropriately.', /appropriately/],
    ['When an upload fails, the application shall retry it.', /too short/],
    ['When an upload fails, the application shall retry it three times before giving up', /full stop/]
  ];

  for (const [statement, expected] of cases) {
    const parsed = parseEars(statement);
    assert.equal(parsed.ok, false, `should have been refused: ${statement}`);
    assert.match(parsed.errors.join('; '), expected, statement);
    assert.equal(isEars(statement), false);
  }
});

test('the examples published with the patterns are themselves valid', () => {
  for (const entry of EARS_PATTERNS) {
    const parsed = parseEars(entry.example);
    assert.equal(parsed.ok, true, `${entry.pattern}: ${parsed.errors.join('; ')}`);
    assert.equal(parsed.pattern, entry.pattern);
  }
});
