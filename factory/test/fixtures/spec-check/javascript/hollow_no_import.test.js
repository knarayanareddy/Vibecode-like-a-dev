import assert from 'node:assert/strict';
import test from 'node:test';

// @anchor __REQ__
test('__REQ__ imports only test framework', () => {
  const values = [1, 2, 3];
  assert.equal(values.length, 3);
});
