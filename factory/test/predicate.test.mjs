import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, explain, getPath } from '../lib/predicate.mjs';

const profile = {
  kind: 'web-app',
  stage: 'mvp',
  tier: 1,
  traits: ['auth', 'realtime'],
  risks: { payments: false, pii: true },
  users: { scale: 'small' }
};

test('always and boolean predicates', () => {
  assert.equal(evaluate({ always: true }, profile), true);
  assert.equal(evaluate(true, profile), true);
  assert.equal(evaluate(false, profile), false);
  assert.equal(evaluate(undefined, profile), true);
});

test('field comparison with eq, in and includes', () => {
  assert.equal(evaluate({ field: 'kind', eq: 'web-app' }, profile), true);
  assert.equal(evaluate({ field: 'kind', eq: 'api' }, profile), false);
  assert.equal(evaluate({ field: 'kind', in: ['api', 'web-app'] }, profile), true);
  assert.equal(evaluate({ field: 'traits', includes: 'auth' }, profile), true);
  assert.equal(evaluate({ field: 'traits', includes: 'payments' }, profile), false);
});

test('nested truthiness follows getPath', () => {
  assert.equal(evaluate({ field: 'risks.pii' }, profile), true);
  assert.equal(evaluate({ field: 'risks.payments' }, profile), false);
  assert.equal(evaluate({ field: 'risks.missing' }, profile), false);
  assert.equal(getPath(profile, 'users.scale'), 'small');
  assert.equal(getPath(profile, 'users.nope.deeper'), undefined);
});

test('numeric comparisons guard against undefined', () => {
  assert.equal(evaluate({ field: 'tier', gte: 1 }, profile), true);
  assert.equal(evaluate({ field: 'tier', gte: 2 }, profile), false);
  assert.equal(evaluate({ field: 'nope', gte: 0 }, profile), false);
});

test('all, any and not compose', () => {
  const predicate = {
    all: [
      { any: [{ field: 'kind', eq: 'api' }, { field: 'traits', includes: 'auth' }] },
      { not: { field: 'risks.payments', eq: true } }
    ]
  };
  assert.equal(evaluate(predicate, profile), true);

  const stricter = { all: [{ field: 'traits', includes: 'auth' }, { field: 'tier', gte: 2 }] };
  assert.equal(evaluate(stricter, profile), false);
});

test('unknown operators fail loudly rather than defaulting to false', () => {
  assert.throws(() => evaluate({ field: 'kind', startsWith: 'web' }, profile), /Unknown predicate operator/);
});

test('explain produces something a human can audit', () => {
  assert.equal(explain({ field: 'tier', gte: 2 }), 'tier gte 2');
  assert.match(explain({ any: [{ field: 'kind', eq: 'api' }, { field: 'tier', gte: 2 }] }), /kind eq "api" OR tier gte 2/);
  assert.match(explain({ all: [{ field: 'a', eq: 1 }, { field: 'b', eq: 2 }] }), / AND /);
  assert.equal(explain({ always: true }), 'always');
});
