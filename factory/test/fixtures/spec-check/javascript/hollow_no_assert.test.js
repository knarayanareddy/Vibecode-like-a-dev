import test from 'node:test';
import { calculateTotal } from '../src/billing.js';

// @anchor __REQ__
test('__REQ__ invokes code without asserting', () => {
  calculateTotal([120, 80]);
});
