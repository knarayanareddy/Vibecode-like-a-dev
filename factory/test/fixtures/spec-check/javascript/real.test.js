import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTotal } from '../src/billing.js';

// @anchor __REQ__
test('__REQ__ calculates line-item total', () => {
  assert.equal(calculateTotal([120, 80]), 200);
});
