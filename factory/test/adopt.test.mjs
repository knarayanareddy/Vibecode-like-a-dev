/**
 * Adoption tests.
 *
 * Fixtures are minimal repositories written to a temp directory: they assert what
 * adoption infers, and — just as important — what it refuses to infer.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adoptRepo, isRemoteRepo, parseRemoteRepo, writeAdoptedProfile } from '../lib/adopt.mjs';
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

test('compound tenant scoping column names like tenant_sponsor_id infer risks.multiTenant', (t) => {
  const repo = fixture({
    'backend/pyproject.toml': '[project]\nname = "trialbridge"\ndependencies = ["fastapi>=0.111.0", "sqlalchemy>=2.0.0"]\n',
    'backend/app/models.py': 'class ParticipantClaim:\n    id: str\n    tenant_sponsor_id: str\n    patient_email: str\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.risks.multiTenant, true);
  assert.equal(report.profile.risks.pii, true);
  const tenantEv = report.evidence.find((e) => e.field === 'risks.multiTenant');
  assert.match(tenantEv.evidence.join(' '), /backend\/app\/models\.py: tenant\/org scoping column/);
});

test('adoptRepo accepts explicit name and idea overrides and drops the placeholder idea question', (t) => {
  const repo = fixture(NEXT_APP);
  t.after(repo.cleanup);

  const customIdea = 'A multi-tenant virtual power plant dispatch and revenue-settlement platform for grid aggregators.';
  const report = adoptRepo(repo.root, { name: 'gridpulse-dispatch', idea: customIdea });
  assert.equal(report.profile.name, 'gridpulse-dispatch');
  assert.equal(report.profile.idea, customIdea);
  assert.ok(!report.questions.some((q) => /Replace the draft idea/i.test(q)), 'idea question must be omitted when --idea is given');
  const nameEv = report.evidence.find((e) => e.field === 'name');
  assert.deepEqual(nameEv.evidence, ['supplied via --name']);
  assert.deepEqual(validateProfile(report.profile), []);
});

test('polyglot monorepo detects @-scoped npm packages, Go /vN modules, raw SQL ON DELETE CASCADE, docker-compose and .env.example without reading live .env', (t) => {
  const repo = fixture({
    'services/customs-core/go.mod': `module github.com/portclear/customs-core/v2

go 1.23

require (
\tgithub.com/gin-gonic/gin v1.10.0
\tgithub.com/golang-jwt/jwt/v5 v5.2.1
\tgithub.com/jackc/pgx/v5 v5.7.1
\tgithub.com/acme/apgx v0.1.0
)
`,
    'services/customs-core/migrations/0001_init.sql': `CREATE TABLE consignments (
  id UUID PRIMARY KEY,
  organization_workspace_id UUID NOT NULL,
  consignee_passport_number TEXT NOT NULL
);
CREATE TABLE excursion_events (
  id UUID PRIMARY KEY,
  consignment_id UUID NOT NULL REFERENCES consignments(id) ON DELETE CASCADE
);
`,
    'services/customs-core/cmd/server/main.go': 'package main\nfunc main() {}\n',
    'apps/portal/web/package.json': {
      name: '@portclear/web',
      dependencies: {
        react: '19.0.0',
        '@anthropic-ai/sdk': '0.32.0',
        '@stripe/stripe-js': '4.8.0',
        '@aws-sdk/client-s3': '3.700.0',
        'next-intl': '3.22.0'
      }
    },
    'apps/portal/web/src/App.tsx': 'export function App() { return null; }\n',
    'docker-compose.yml': `services:
  cache:
    image: redis:7-alpine
  search:
    image: getmeili/meilisearch:v1.9
`,
    '.env.example': 'RESEND_API_KEY=\n',
    '.env': 'STRIPE_SECRET_KEY=do_not_read_live_env\nOPENAI_API_KEY=do_not_read_live_env\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  for (const trait of ['auth', 'persistence', 'ai', 'payments', 'upload', 'i18n', 'background-jobs', 'search', 'notifications']) {
    assert.ok(report.profile.traits.includes(trait), `missing trait ${trait} from polyglot/compose/.env.example signals; got ${report.profile.traits.join(', ')}`);
  }
  assert.equal(report.profile.risks.multiTenant, true);
  assert.equal(report.profile.risks.pii, true, 'passport column must infer PII');
  assert.equal(report.profile.risks.destructiveWrites, true, 'raw SQL ON DELETE CASCADE must infer destructiveWrites');

  // Ensure apgx did not false-match pgx and live .env was never cited in evidence.
  const allEvidenceText = JSON.stringify(report.evidence);
  assert.doesNotMatch(allEvidenceText, /apgx/);
  assert.doesNotMatch(allEvidenceText, /do_not_read_live_env|OPENAI_API_KEY/);
});

test('remote Git repository URLs parse safely, reject flag injection, redact credentials, and clone end-to-end via file://', (t) => {
  assert.equal(isRemoteRepo('https://github.com/acme/widget'), true);
  assert.equal(isRemoteRepo('github:acme/widget#release/v2'), true);
  assert.equal(isRemoteRepo('-oProxyCommand=evil'), false);
  assert.throws(() => parseRemoteRepo('--upload-pack=evil'), { code: 'INVALID_REMOTE_URL' });
  assert.throws(() => parseRemoteRepo('https://github.com/acme/widget/tree/--bad-branch'), { code: 'INVALID_REMOTE_URL' });

  const parsed = parseRemoteRepo('https://user:supersecret@github.com/acme/widget/tree/feat/coldchain');
  assert.equal(parsed.displayUrl, 'https://github.com/acme/widget');
  assert.equal(parsed.branch, 'feat/coldchain');
  assert.equal(parsed.name, 'widget');

  const sourceRepo = fixture({
    'go.mod': 'module github.com/acme/coldchain-api\n\ngo 1.23\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
    'main.go': 'package main\nfunc main() {}\n'
  });
  t.after(sourceRepo.cleanup);

  execFileSync('git', ['init', '-q'], { cwd: sourceRepo.root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRepo.root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: sourceRepo.root });
  execFileSync('git', ['add', '.'], { cwd: sourceRepo.root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: sourceRepo.root });

  const fileUrl = `file://${sourceRepo.root}`;
  const report = adoptRepo(fileUrl);
  assert.equal(report.remote, true);
  assert.equal(report.repo, fileUrl);
  assert.equal(report.profile.name, 'coldchain-api', 'Go module path last segment used as project name');
  assert.equal(report.profile.kind, 'api');
  assert.equal(report.profile.constraints.stack, 'go');
  assert.doesNotMatch(report.profile.$comment, /vld-remote-/, 'temporary clone path must not leak into $comment');
});

test('single-line PEP 621 pyproject.toml arrays with bracketed extras parse without dropping trailing packages', (t) => {
  const repo = fixture({
    'services/parts-predictor/pyproject.toml': `[project]
name = "parts-predictor"
version = "0.2.0"
dependencies = ["fastapi[standard]>=0.115.0", "psycopg[binary]>=3.1", "anthropic>=0.39.0", "celery>=5.4.0"]
[project.optional-dependencies]
dev = ["pytest>=8.0.0", "hypothesis>=6.100.0"]
`,
    'services/parts-predictor/app/rul.py': 'def run():\n    return True\n'
  });
  t.after(repo.cleanup);

  const report = adoptRepo(repo.root);
  assert.equal(report.profile.kind, 'api');
  for (const trait of ['persistence', 'ai', 'background-jobs']) {
    assert.ok(report.profile.traits.includes(trait), `single-line pyproject.toml missed trait "${trait}"; got ${report.profile.traits.join(', ')}`);
  }
  assert.ok(report.facts.tests.some((entry) => /pytest/.test(entry)), 'single-line dev optional-dependencies must detect pytest');
});


