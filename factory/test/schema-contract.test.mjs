/**
 * JSON Schema fixtures for the identifiers emitted by Core.
 *
 * The runtime intentionally has no schema-validator dependency. This small test
 * executes the schema keywords used by the requirement fragment, so a grammar
 * change cannot widen Core while leaving the public schema behind.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(path.join(ROOT, 'factory/schema/spec.schema.json'), 'utf8'));
const requirementSchema = schema.properties.requirements.items;

function check(value, rule, at = '$') {
  const errors = [];
  if (rule.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return [`${at}: expected object`];
  if (rule.type === 'array' && !Array.isArray(value)) return [`${at}: expected array`];
  if (rule.type === 'string' && typeof value !== 'string') return [`${at}: expected string`];
  if (rule.enum && !rule.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (rule.pattern && typeof value === 'string' && !new RegExp(rule.pattern).test(value)) errors.push(`${at}: does not match ${rule.pattern}`);
  if (rule.minLength && typeof value === 'string' && value.length < rule.minLength) errors.push(`${at}: too short`);
  if (rule.minItems && Array.isArray(value) && value.length < rule.minItems) errors.push(`${at}: too few items`);
  if (rule.required) for (const name of rule.required) if (!(name in value)) errors.push(`${at}.${name}: required`);
  if (rule.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, property] of Object.entries(rule.properties)) if (name in value) errors.push(...check(value[name], property, `${at}.${name}`));
  }
  if (rule.items && Array.isArray(value)) value.forEach((item, index) => errors.push(...check(item, rule.items, `${at}[${index}]`)));
  return errors;
}

const highWidthFixture = {
  id: 'REQ-1000',
  key: 'core.high-width-fixture',
  area: 'core',
  title: 'High-width identifiers remain schema-valid',
  statement: 'When a catalog grows beyond nine hundred ninety-nine requirements, the emitted identifier remains unambiguous and valid.',
  failurePath: 'A narrow identifier grammar rejects a historically allocated requirement.',
  acceptance: [{ id: 'AC-12', text: 'Given a four-digit requirement identifier, when emitted, then schema validation accepts it.' }],
  verify: 'automated',
  anchor: 'tests/core/high-width-fixture.test.ts',
  status: 'todo'
};

test('the public schema accepts emitted-width REQ and AC identifiers', () => {
  assert.deepEqual(check(highWidthFixture, requirementSchema), []);
});

test('the public schema still rejects short REQ and AC identifiers', () => {
  const invalidRequirement = { ...highWidthFixture, id: 'REQ-99' };
  const invalidAcceptance = { ...highWidthFixture, acceptance: [{ ...highWidthFixture.acceptance[0], id: 'AC-1' }] };
  assert.match(check(invalidRequirement, requirementSchema).join('\n'), /\$\.id/);
  assert.match(check(invalidAcceptance, requirementSchema).join('\n'), /\$\.acceptance\[0\]\.id/);
});
