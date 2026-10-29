import assert from 'node:assert/strict';
import test from 'node:test';
import { firstHeading, parseFrontmatter } from '../lib/frontmatter.mjs';

test('parses the field subset the repo actually uses', () => {
  const source = `---
id: testing.tdd-loop
title: Test-driven loop
tier_min: 1
cost: low
tags: [tdd, tests, red-green-refactor]
enforces: []
---

# Test-driven loop

Body text.
`;

  const { data, body } = parseFrontmatter(source);

  assert.equal(data.id, 'testing.tdd-loop');
  assert.equal(data.title, 'Test-driven loop');
  assert.equal(data.tier_min, 1);
  assert.equal(data.cost, 'low');
  assert.deepEqual(data.tags, ['tdd', 'tests', 'red-green-refactor']);
  assert.deepEqual(data.enforces, []);
  assert.match(body, /^# Test-driven loop/m);
});

test('booleans, quoted strings and floats survive the round trip', () => {
  const { data } = parseFrontmatter(`---
capped: true
other: no
label: "with: a colon"
ratio: 1.5
---
body`);

  assert.equal(data.capped, true);
  assert.equal(data.other, false);
  assert.equal(data.label, 'with: a colon');
  assert.equal(data.ratio, 1.5);
});

test('a document with no frontmatter is returned unchanged', () => {
  const { data, body } = parseFrontmatter('# Just markdown\n\ntext');
  assert.deepEqual(data, {});
  assert.match(body, /Just markdown/);
});

test('an unterminated block is treated as content, not metadata', () => {
  const source = '---\nid: broken\n\n# Heading\n';
  const { data } = parseFrontmatter(source);
  assert.deepEqual(data, {});
});

test('firstHeading finds the level-1 title only', () => {
  assert.equal(firstHeading('\n## subtitle\n\n# Real title\n'), 'Real title');
  assert.equal(firstHeading('no heading here'), '');
});
