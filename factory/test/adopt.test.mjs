/**
 * Adoption tests.
 *
 * Fixtures are minimal repositories written to a temp directory: they assert what
 * adoption infers, and — just as important — what it refuses to infer.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adoptRepo, writeAdoptedProfile } from '../lib/adopt.mjs';
import { validateProfile } from '../lib/profile.mjs';

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-adopt-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    if (relative.endsWith('/')) {
      mkdirSync(full, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const NEXT_APP = {
  'package.json': {
    name: '@acme/invoice-desk',
    scripts: { test: 'vitest run', build: 'next build' },
    dependencies: {
      next: '14.2.0',
      react: '18.3.0',
      '@prisma/client': '5.14.0',
      'next-auth': '4.24.7',
      stripe: '15.8.0',
      resend: '3.2.0'
    },
    devDependencies: { vitest: '1.6.0' }
  },
  'prisma/schema.prisma': `model Account {
  id String @id
  email String @unique
  tenantId String
}
model Invoice {
  id String @id
  account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
}`,
  'src/app/page.tsx': 'export default function Page() { return null; }',
  'src/lib/money.ts': 'export const cents = (n: number) => Math.round(n * 100);',
  'tests/invoice.test.ts': "test('x', () => {});",
  Dockerfile: 'FROM node:22\n',
  '.github/workflows/deploy.yml': 'name: deploy\non: push\n',
  'docs/adr/0001-db.md': '# ADR-001\nUse Postgres.\n'
};

test('a Next.js app with auth, payments and tenancy is recognised, with evidence', (t) => {
  const repo = fixture(NEXT_APP);
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);

  assert.equal(report.profile.name, 'invoice-desk');
  assert.equal(report.profile.kind, 'web-app');
  assert.equal(report.profile.stage, 'production');
  assert.equal(report.profile.constraints.stack, 'typescript');

  for (const trait of ['auth', 'payments', 'persistence', 'notifications']) {
    assert.ok(report.profile.traits.includes(trait), `missing trait ${trait}`);
  }

  assert.equal(report.profile.risks.payments, true);
  assert.equal(report.profile.risks.pii, true);
  assert.equal(report.profile.risks.multiTenant, true);
  assert.equal(report.profile.risks.destructiveWrites, true);
  assert.equal(report.profile.risks.publicFacing, true);
  assert.equal(report.profile.risks.integrations, true);

  // Regulation is never inferred from code.
  assert.equal(report.profile.risks.regulated, false);
  assert.ok(report.questions.some((question) => /regulated/i.test(question)));

  // Every inference carries the observation that produced it.
  const paymentEvidence = report.evidence.find((entry) => entry.field === 'risks.payments');
  assert.match(paymentEvidence.evidence.join(' '), /stripe/);

  const kindEvidence = report.evidence.find((entry) => entry.field === 'kind');
  assert.equal(kindEvidence.confidence, 'high');
  assert.match(kindEvidence.evidence.join(' '), /next/);
});

test('the adopted profile validates and can be planned', (t) => {
  const repo = fixture(NEXT_APP);
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.deepEqual(validateProfile(report.profile), []);
  assert.ok(report.profile.idea.length >= 20);
  assert.match(report.profile.idea, /TODO/, 'the idea is a draft and says so');
});

test('an empty repository adopts with low confidence and asks', (t) => {
  const repo = fixture({ 'README.md': '# nothing yet\n' });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  const kind = report.evidence.find((entry) => entry.field === 'kind');
  assert.equal(kind.confidence, 'low');
  assert.ok(report.questions.some((question) => /project kind|What is this project/i.test(question)));
  assert.equal(report.profile.stage, 'prototype');
  assert.deepEqual(validateProfile(report.profile), []);
});

test('a CLI is recognised from a bin entry, and stays a prototype without tests', (t) => {
  const repo = fixture({
    'package.json': {
      name: 'webhook-lab',
      bin: { lab: './cli.js' },
      dependencies: { commander: '12.0.0' }
    },
    'cli.mjs': '#!/usr/bin/env node\nconsole.log("hi");\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.kind, 'cli');
  assert.equal(report.profile.constraints.stack, 'javascript', '.mjs counts as JavaScript');
  assert.equal(report.profile.stage, 'prototype');
  assert.ok(!report.profile.traits.includes('auth'));
});

test('a Python service is recognised from its dependency manifest', (t) => {
  const repo = fixture({
    'pyproject.toml': `[project]
name = "ledger-api"
dependencies = [
  "fastapi>=0.111",
  "sqlalchemy>=2.0",
  "alembic>=1.13",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'tests/test_main.py': 'def test_x():\n    assert True\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.kind, 'api');
  assert.equal(report.profile.constraints.stack, 'python');
  assert.ok(report.profile.traits.includes('persistence'));
  assert.equal(report.profile.stage, 'mvp');
});

test('a mobile app is recognised from its framework', (t) => {
  const repo = fixture({
    'package.json': { name: 'field-notes', dependencies: { expo: '51.0.0', 'react-native': '0.74.0' } },
    'App.tsx': 'export default function App() { return null; }\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.kind, 'mobile');
});

test('deploying without tests is surfaced as a finding, not silently accepted', (t) => {
  const repo = fixture({
    'package.json': { name: 'shipped-untested', dependencies: { express: '4.19.2' } },
    'server.js': 'require("express")();\n',
    'fly.toml': 'app = "shipped-untested"\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.stage, 'production');
  assert.ok(report.observations.some((observation) => /no tests were found/i.test(observation)));
});

test('an existing packet is detected and the user is pointed at change', (t) => {
  const repo = fixture({
    ...NEXT_APP,
    'specs/spec.json': { schemaVersion: 1, requirements: [], gates: [], docs: [] }
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.existing.packet, 'specs/spec.json');
  assert.ok(report.observations.some((observation) => /already contains a specification packet/.test(observation)));
});

test('writing the profile refuses to clobber and rejects an invalid one', (t) => {
  const repo = fixture(NEXT_APP);
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  const out = path.join(repo.root, 'profile.json');

  assert.doesNotThrow(() => writeAdoptedProfile(report, out));
  assert.throws(() => writeAdoptedProfile(report, out), /already exists/);

  // Writing into a directory that does not exist yet should create it.
  const nested = path.join(repo.root, 'meta', 'nested', 'profile.json');
  assert.doesNotThrow(() => writeAdoptedProfile(report, nested));
  assert.ok(existsSync(nested));
  assert.doesNotThrow(() => writeAdoptedProfile(report, out, { force: true }));

  const broken = { ...report, profile: { ...report.profile, kind: 'spaceship' } };
  assert.throws(() => writeAdoptedProfile(broken, path.join(repo.root, 'broken.json'), { force: true }), /invalid profile/);
});

test('nested manifests are read, and extras in brackets do not truncate the list', (t) => {
  // Regression: real projects keep manifests in backend/ and frontend/, and
  // dependency specs like "psycopg[binary]" broke a naive array match.
  const repo = fixture({
    'backend/pyproject.toml': `[project]
name = "app"
dependencies = [
    "fastapi[standard]>=0.141",
    "psycopg[binary]>=3.3",
    "sqlmodel>=0.0.46",
    "pyjwt>=2.15",
    "pwdlib[argon2]>=0.3.1",
]

[dependency-groups]
dev = [
    "pytest>=7.4",
]
`,
    'backend/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'frontend/package.json': { name: 'frontend', dependencies: { react: '18.3.0' }, devDependencies: { typescript: '5.4.5' } },
    'frontend/src/App.tsx': 'export default function App() { return null; }\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.kind, 'web-app');
  assert.ok(report.profile.traits.includes('auth'), 'pyjwt and pwdlib after the bracketed extra are seen');
  assert.ok(report.profile.traits.includes('persistence'), 'sqlmodel is seen');
  assert.ok(report.facts.manifests.includes('backend/pyproject.toml'));
  assert.ok(report.facts.manifests.includes('frontend/package.json'));
  assert.equal(report.profile.stage, 'mvp', 'pytest is configured in a dev group, so this is past a spike');
});

test('a dev-only dependency does not decide the project kind', (t) => {
  // Regression: ky-style libraries list express in devDependencies for benchmarks.
  const repo = fixture({
    'package.json': {
      name: 'tiny-http-client',
      version: '1.0.0',
      exports: './distribution/index.js',
      main: './distribution/index.js',
      type: 'module',
      devDependencies: { express: '4.19.2', ava: '6.1.2', typescript: '5.4.5' }
    },
    'source/index.ts': 'export const fetchIt = async () => null;\n',
    'test/index.ts': 'test("x", () => {});\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.kind, 'library');
  assert.ok(!report.profile.traits.includes('auth'));
  assert.equal(report.profile.stage, 'production', 'a published package with tests is shipped software');
});

test('scanning ignores node_modules and build output', (t) => {
  const repo = fixture({
    ...NEXT_APP,
    'node_modules/.bin/next': '#!/bin/sh\n',
    'node_modules/react/index.js': 'module.exports = {};\n',
    '.next/server/chunk.js': '// built\n',
    'dist/bundle.js': '// built\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.ok(report.facts.filesScanned < 15, `scanned ${report.facts.filesScanned} files, so ignored directories leaked in`);
  assert.equal(report.profile.kind, 'web-app');
});
