/**
 * Adoption: derive a profile from an existing repository.
 *
 * The point is not to guess perfectly. It is to move the starting line from
 * "describe your project in a questionnaire" to "here is what we saw, with the
 * evidence, and here are the six things only you can answer".
 *
 * Two rules keep it honest:
 *   1. Every inferred value carries the observation that produced it.
 *   2. Nothing legal or organisational is inferred from code. Regulation,
 *      user scale and team size become questions, never assertions.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, scanRepo } from './scan.mjs';
import { normalizeProfile, validateProfile } from './profile.mjs';

const DEP_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'requirements-dev.txt',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'composer.json',
  'pubspec.yaml'
];

const WEB_DEPS = ['next', 'react', 'vue', 'svelte', '@sveltejs/kit', 'nuxt', '@remix-run/react', 'astro', 'solid-js', '@angular/core', 'gatsby', 'qwik', '@builder.io/qwik'];
const SERVER_DEPS = ['express', 'fastify', 'hono', 'koa', '@nestjs/core', 'django', 'fastapi', 'flask', 'rails', 'laravel/framework', 'spring-boot', 'actix-web', 'axum', 'gin', 'phoenix'];
const MOBILE_DEPS = ['expo', 'react-native', 'flutter', '@capacitor/core', 'nativescript', '@ionic/react'];
const PIPELINE_DEPS = ['dbt-core', 'apache-airflow', 'dagster', 'prefect', 'pyspark', 'dlt', 'meltano', 'confluent-kafka', 'kafka-python', 'airbyte'];
const AGENT_DEPS = ['langgraph', 'crewai', 'autogen', '@langchain/langgraph', 'llama-index', '@openai/agents', 'pydantic-ai', 'google-adk'];
const CLI_DEPS = ['commander', 'yargs', 'ink', 'clap', 'cobra', 'typer', 'click', 'thor', 'oclif', '@oclif/core'];

const TRAIT_DEPS = {
  auth: ['next-auth', '@auth/core', '@auth/', '@clerk/', 'clerk', 'passport', 'lucia', 'better-auth', 'auth0', '@azure/msal-node', 'supertokens', 'workos', 'firebase-admin', '@supabase/auth-helpers', 'jsonwebtoken', 'jose', 'bcrypt', 'argon2', 'pyjwt', 'python-jose', 'passlib', 'pwdlib', 'authlib', 'flask-login', 'flask-security', 'django-allauth', 'djangorestframework-simplejwt', 'devise', 'bcrypt-ruby', 'golang-jwt', 'gorilla/sessions', 'nextauth'],
  payments: ['stripe', '@stripe/', 'paddle', '@paddle/', 'lemonsqueezy', '@lemonsqueezy/', 'revenuecat', 'braintree', 'paypal', '@paypal/', 'square'],
  persistence: ['prisma', '@prisma/', 'drizzle-orm', 'knex', 'typeorm', 'sequelize', 'mongoose', '@mikro-orm/core', 'pg', 'mysql2', 'better-sqlite3', 'sqlite3', 'sqlalchemy', 'alembic', 'psycopg', 'psycopg2', 'asyncpg', 'gorm', 'activerecord', 'ecto', 'sequel'],
  realtime: ['socket.io', 'ws', 'pusher', 'ably', 'liveblocks', '@supabase/realtime', 'channels', 'phoenix'],
  search: ['algolia', 'meilisearch', 'elasticsearch', '@elastic/', 'typesense', 'opensearch', 'pgvector', 'turbopuffer'],
  upload: ['multer', 'cloudinary', 'uploadthing', '@aws-sdk/client-s3', 'tus-js-client', 'shrine', 'carrierwave', 'filepond'],
  notifications: ['nodemailer', 'resend', 'sendgrid', '@sendgrid/', 'postmark', 'twilio', 'expo-notifications', 'onesignal', 'novu'],
  webhooks: ['svix', '@octokit/webhooks', 'standardwebhooks', 'stripe'],
  offline: ['workbox-', 'dexie', 'idb', 'serviceworker', 'react-native-mmkv'],
  ai: ['openai', '@anthropic-ai/', 'langchain', '@langchain/', 'ai', '@ai-sdk/', 'ollama', 'transformers', 'cohere-ai', 'groq-sdk', 'mistralai'],
  i18n: ['i18next', 'react-i18next', 'react-intl', 'vue-i18n', '@formatjs/', 'next-intl', 'fluent'],
  'background-jobs': ['bullmq', 'bull', 'celery', 'sidekiq', 'rq', 'dramatiq', 'temporal', '@temporalio/', 'inngest', 'trigger.dev', '@trigger.dev/', 'agenda']
};

const SERVICE_DEPS = ['stripe', 'twilio', 'sendgrid', '@sendgrid/', 'slack', '@slack/', '@octokit/', 'openai', '@anthropic-ai/', 'segment', '@segment/', 'algolia', 'auth0', 'clerk', '@clerk/', 'resend', 'postmark', 'serpapi', 'mapbox', 'google-maps'];

const LANGUAGE_BY_EXT = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rb': 'ruby', '.java': 'java', '.kt': 'kotlin',
  '.cs': 'csharp', '.php': 'php', '.rs': 'rust', '.ex': 'elixir', '.exs': 'elixir',
  '.swift': 'swift', '.dart': 'dart', '.vue': 'typescript', '.svelte': 'typescript'
};

const DEPLOY_FILES = ['Dockerfile', 'docker-compose.yml', 'fly.toml', 'render.yaml', 'vercel.json', 'netlify.toml', 'app.yaml', 'Procfile', 'k8s', 'helm', 'terraform', 'infra'];
const CI_FILES = ['.github/workflows', '.gitlab-ci.yml', 'circle.yml', '.circleci', 'Jenkinsfile', 'azure-pipelines.yml'];

function matches(name, patterns) {
  return patterns.some((pattern) => name === pattern || name.startsWith(pattern));
}

const MANIFEST_PATTERN = /(^|\/)(package\.json|pyproject\.toml|requirements(-[\w.]+)?\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|pubspec\.yaml)$/;
const TEST_TOOL_DEPS = ['vitest', 'jest', 'mocha', 'ava', 'pytest', 'playwright', '@playwright/test', 'cypress', 'coverage', 'uvu', 'tap'];

/**
 * Manifests live at the root in small projects and one or two levels down in
 * monorepo-ish layouts (backend/, frontend/, apps/web). Both are common enough
 * that missing one produces a confidently wrong profile.
 */
function discoverManifests(scan) {
  return [...scan.files]
    .filter((file) => MANIFEST_PATTERN.test(file) && file.split('/').length <= 3)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function pythonBlocks(text) {
  // pyproject arrays: dependencies = [ "pkg>=1" ] · dev = [ "pytest" ]
  // The closing bracket must be on its own line: dependency specs contain extras
  // like "psycopg[binary]", and a naive non-greedy match stops inside them.
  return [...text.matchAll(/^[ \t]*([a-z0-9_-]+)[ \t]*=[ \t]*\[([\s\S]*?)^[ \t]*\]/gim)].map((match) => ({
    name: match[1].toLowerCase(),
    body: match[2]
  }));
}

function namesIn(block) {
  return [...block.matchAll(/["']([^"']{2,80})["']/g)].map((match) => match[1].split(/[=<>!~;\s\[]/)[0]);
}

function collectDependencies(scan) {
  const runtime = new Map();
  const dev = new Map();
  const manifests = discoverManifests(scan);

  const add = (bucket, rawName, source) => {
    const name = String(rawName)
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
      .replace(/^@/, '')
      .replace(/[[(].*$/, '')
      .trim();
    if (!name || name.length > 60 || !/^[a-z0-9@/_.-]+$/.test(name)) return;
    if (!bucket.has(name)) bucket.set(name, source);
  };

  for (const file of manifests) {
    const base = path.posix.basename(file);

    if (base === 'package.json') {
      const pkg = readJsonFile(scan, file);
      if (!pkg) continue;
      for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[key] ?? {})) add(runtime, name, file);
      }
      for (const name of Object.keys(pkg.devDependencies ?? {})) add(dev, name, file);
      continue;
    }

    if (base === 'pyproject.toml') {
      const text = scan.contents(file);
      for (const block of pythonBlocks(text)) {
        const bucket = /dev|test|lint|type/i.test(block.name) ? dev : runtime;
        for (const name of namesIn(block.body)) add(bucket, name, file);
      }
      // Poetry tables: [tool.poetry.dependencies] / [tool.poetry.group.dev.dependencies]
      let scope = null;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (/^\[.*\.dependencies\]/.test(trimmed)) {
          scope = /dev|test/i.test(trimmed) ? dev : runtime;
          continue;
        }
        if (trimmed.startsWith('[')) { scope = null; continue; }
        if (!scope) continue;
        const match = trimmed.match(/^["']?([A-Za-z0-9_.-]{2,50})["']?\s*=/);
        if (match && match[1] !== 'python') add(scope, match[1], file);
      }
      continue;
    }

    if (base.startsWith('requirements') && base.endsWith('.txt')) {
      const bucket = /dev|test/i.test(base) ? dev : runtime;
      for (const line of scan.contents(file).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        add(bucket, trimmed.split(/[=<>!~;\[ ]/)[0], file);
      }
      continue;
    }

    if (base === 'go.mod') {
      for (const match of scan.contents(file).matchAll(/^\s*(?:require\s+)?([a-z0-9.\-]+\/[a-z0-9.\-/]+)\s+v/gm)) {
        add(runtime, match[1], file);
      }
      continue;
    }

    if (base === 'Cargo.toml') {
      let scope = runtime;
      for (const line of scan.contents(file).split('\n')) {
        const trimmed = line.trim();
        if (/^\[.*dev-dependencies.*\]/.test(trimmed)) { scope = dev; continue; }
        if (/^\[.*dependencies.*\]/.test(trimmed)) { scope = runtime; continue; }
        if (trimmed.startsWith('[')) { scope = runtime; continue; }
        const name = trimmed.split('=')[0].trim();
        if (/^[a-zA-Z0-9_-]+$/.test(name)) add(scope, name, file);
      }
      continue;
    }

    if (base === 'Gemfile') {
      for (const match of scan.contents(file).matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) add(runtime, match[1], file);
      continue;
    }

    if (base === 'composer.json') {
      const composer = readJsonFile(scan, file);
      for (const name of Object.keys(composer?.require ?? {})) add(runtime, name, file);
      for (const name of Object.keys(composer?.['require-dev'] ?? {})) add(dev, name, file);
      continue;
    }

    if (base === 'pubspec.yaml') {
      let scope = null;
      for (const line of scan.contents(file).split('\n')) {
        if (/^dependencies:/.test(line)) { scope = runtime; continue; }
        if (/^dev_dependencies:/.test(line)) { scope = dev; continue; }
        if (/^\S/.test(line) && line.trim()) { scope = null; continue; }
        if (!scope) continue;
        const name = line.trim().split(':')[0];
        if (/^[a-z0-9_]+$/.test(name)) add(scope, name, file);
      }
    }
  }

  return { runtime, dev, manifests };
}

function dominantLanguage(scan) {
  const counts = new Map();
  for (const file of scan.sourceFiles) {
    const language = LANGUAGE_BY_EXT[path.extname(file)];
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length === 0 ? null : { language: sorted[0][0], count: sorted[0][1], mixed: sorted.length > 1 };
}

function detectDeployment(scan) {
  const found = [];
  for (const entry of DEPLOY_FILES) {
    if (scan.has(entry) || scan.hasDir(entry)) found.push(entry);
  }
  const deployWorkflows = scan.filesMatching(/^\.github\/workflows\/.*\.ya?ml$/).filter((file) => /deploy|release|publish/i.test(file));
  found.push(...deployWorkflows);
  return found;
}

function detectCi(scan) {
  const found = [];
  for (const entry of CI_FILES) {
    if (scan.has(entry) || scan.hasDir(entry)) found.push(entry);
  }
  return found;
}

function detectTests(scan, { devDeps = [], manifests = [] } = {}) {
  const found = [];
  for (const dir of ['tests', 'test', '__tests__', 'spec', 'e2e', 'cypress', 'playwright']) {
    if (scan.hasDir(dir)) found.push(`${dir}/`);
  }

  const testFiles = scan.filesMatching(/(^|\/)(test_[^/]+\.py|[^/]+\.(test|spec)\.[a-z]+|_test\.go)$/);
  if (testFiles.length > 0) found.push(`${testFiles.length} test file(s)`);

  const tooling = devDeps.filter((dep) => TEST_TOOL_DEPS.some((tool) => dep === tool || dep.startsWith(`${tool}/`)));
  if (tooling.length > 0) found.push(`test tooling: ${tooling.slice(0, 2).join(', ')}`);

  for (const manifest of manifests.filter((file) => file.endsWith('package.json'))) {
    const pkg = readJsonFile(scan, manifest);
    const script = pkg?.scripts?.test;
    if (script && !/no test specified/i.test(String(script))) {
      found.push(`${manifest}: test script`);
      break;
    }
  }

  return found;
}

function detectSchemaSignals(scan) {
  const signals = { multiTenant: [], pii: [], destructive: [] };
  const sources = [
    ...scan.filesMatching(/schema\.prisma$|\.sql$|migrations?\//).slice(0, 60),
    ...scan.contentSample.filter((file) => /model|entity|schema/i.test(file)).slice(0, 40)
  ];

  for (const file of new Set(sources)) {
    const text = scan.contents(file).toLowerCase();
    if (/\b(tenant_id|tenantid|organisation_id|organization_id|org_id|workspace_id|account_id)\b/.test(text)) {
      signals.multiTenant.push(`${file}: tenant/org scoping column`);
    }
    if (/\b(email|phone|first_name|last_name|full_name|date_of_birth|address|ssn|tax_id)\b/.test(text)) {
      signals.pii.push(`${file}: personal data column`);
    }
    if (/ondelete:\s*cascade|delete from|hard delete/i.test(text)) {
      signals.destructive.push(`${file}: cascading or hard delete`);
    }
  }

  return {
    multiTenant: [...new Set(signals.multiTenant)].slice(0, 3),
    pii: [...new Set(signals.pii)].slice(0, 3),
    destructive: [...new Set(signals.destructive)].slice(0, 3)
  };
}

function sanitizeName(raw, fallback) {
  const name = String(raw ?? '')
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return /^[a-z0-9][a-z0-9-]{1,60}$/.test(name) ? name : fallback;
}

export function adoptRepo(root) {
  const repoRoot = path.resolve(root);
  const scan = scanRepo(repoRoot);
  const deps = collectDependencies(scan);
  // Runtime dependencies describe what the product is. Dev dependencies describe
  // how it is checked: `express` as a devDependency in a benchmark does not make
  // an HTTP client library an API server.
  const depNames = [...deps.runtime.keys()];
  const devDepNames = [...deps.dev.keys()];
  const evidence = [];
  const questions = [];
  const observations = [];

  const note = (field, value, confidence, why) => evidence.push({ field, value, confidence, evidence: why });

  // ---- identity
  const pkg = [deps.manifests.find((file) => file === 'package.json'), ...deps.manifests.filter((file) => file.endsWith('package.json'))]
    .filter(Boolean)
    .map((file) => readJsonFile(scan, file))
    .find(Boolean) ?? null;
  const pyproject = scan.has('pyproject.toml') ? scan.contents('pyproject.toml') : '';
  const pyName = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const name = sanitizeName(pkg?.name ?? pyName ?? path.basename(repoRoot), 'adopted-project');
  if (pkg?.name || pyName) note('name', name, 'high', [`manifest name: ${pkg?.name ?? pyName}`]);

  // ---- language
  const language = dominantLanguage(scan);
  if (language) {
    note('constraints.stack', language.language, 'high', [`${language.count} source files, ${language.language} dominant`]);
    if (language.mixed) observations.push('More than one language detected; the dominant one is used for stack defaults.');
  } else {
    note('constraints.stack', 'undecided', 'low', ['no source files found']);
  }

  // ---- kind
  const hasDep = (patterns) => depNames.filter((dep) => matches(dep, patterns));
  const hasDevDep = (patterns) => devDepNames.filter((dep) => matches(dep, patterns));
  const webDeps = hasDep(WEB_DEPS);
  const serverDeps = hasDep(SERVER_DEPS);
  const mobileDeps = hasDep(MOBILE_DEPS);
  const pipelineDeps = hasDep(PIPELINE_DEPS);
  const agentDeps = hasDep(AGENT_DEPS);
  const cliDeps = hasDep(CLI_DEPS);
  const hasBin = Boolean(pkg?.bin);
  const publishable = deps.manifests
    .filter((file) => file.endsWith('package.json'))
    .map((file) => readJsonFile(scan, file))
    .some((manifest) => manifest && manifest.version && manifest.private !== true);

  let kind = 'web-app';
  let kindConfidence = 'low';
  let kindWhy = [];

  if (mobileDeps.length > 0) {
    kind = 'mobile'; kindConfidence = 'high'; kindWhy = mobileDeps.map((dep) => `dependency: ${dep}`);
  } else if (pipelineDeps.length > 0) {
    kind = 'data-pipeline'; kindConfidence = 'high'; kindWhy = pipelineDeps.map((dep) => `dependency: ${dep}`);
  } else if (hasBin || (cliDeps.length > 0 && serverDeps.length === 0 && webDeps.length === 0)) {
    kind = 'cli'; kindConfidence = hasBin ? 'high' : 'medium';
    kindWhy = hasBin ? ['package.json declares a bin entry'] : cliDeps.map((dep) => `dependency: ${dep}`);
  } else if (webDeps.length > 0) {
    kind = 'web-app'; kindConfidence = 'high';
    kindWhy = webDeps.slice(0, 3).map((dep) => `dependency: ${dep}`);
  } else if (serverDeps.length > 0) {
    kind = 'api'; kindConfidence = 'high'; kindWhy = serverDeps.slice(0, 3).map((dep) => `dependency: ${dep}`);
  } else if (agentDeps.length > 0) {
    kind = 'agent'; kindConfidence = 'medium'; kindWhy = agentDeps.map((dep) => `dependency: ${dep}`);
  } else if (pkg?.exports || pkg?.main || scan.has('src/index.ts') || scan.has('src/lib.rs')) {
    kind = 'library'; kindConfidence = 'medium';
    kindWhy = ['package exports/main with no server or UI framework'];
  } else if (scan.sourceFiles.length === 0) {
    kind = 'web-app'; kindConfidence = 'low';
    kindWhy = ['no recognisable stack'];
    questions.push('What is this project? No source files or manifests were found, so kind could not be inferred.');
  }
  note('kind', kind, kindConfidence, kindWhy);
  if (kindConfidence === 'low') questions.push('Confirm the project kind: nothing in the repository made it unambiguous.');

  // ---- traits
  const traits = [];
  const traitEvidence = {};
  for (const [trait, patterns] of Object.entries(TRAIT_DEPS)) {
    const hits = depNames.filter((dep) => matches(dep, patterns));
    if (hits.length > 0) {
      traits.push(trait);
      traitEvidence[trait] = hits.slice(0, 3).map((dep) => `dependency: ${dep}`);
    }
  }
  if (kind === 'web-app' && traits.includes('persistence') === false && (serverDeps.length > 0 || webDeps.includes('next'))) {
    // A web app with a server usually persists something, but say so as a question rather than a fact.
    questions.push('Does this product store user data? No ORM or database driver was found.');
  }
  note('traits', traits, 'high', Object.values(traitEvidence).flat().slice(0, 8));

  // ---- risks
  const schema = detectSchemaSignals(scan);
  const deploy = detectDeployment(scan);
  const ci = detectCi(scan);
  const tests = detectTests(scan, { devDeps: devDepNames, manifests: deps.manifests });
  const serviceDeps = depNames.filter((dep) => matches(dep, SERVICE_DEPS));

  const risks = {
    pii: traits.includes('auth') || schema.pii.length > 0,
    payments: traits.includes('payments'),
    regulated: false,
    multiTenant: schema.multiTenant.length > 0,
    destructiveWrites: schema.destructive.length > 0,
    publicFacing: deploy.length > 0,
    integrations: serviceDeps.length > 0
  };

  note('risks.pii', risks.pii, traits.includes('auth') ? 'medium' : 'low', [
    ...(traits.includes('auth') ? ['authentication present, so accounts exist'] : []),
    ...schema.pii
  ]);
  note('risks.payments', risks.payments, risks.payments ? 'high' : 'low', serviceDeps.filter((dep) => matches(dep, TRAIT_DEPS.payments)).map((dep) => `dependency: ${dep}`));
  note('risks.multiTenant', risks.multiTenant, 'medium', schema.multiTenant);
  note('risks.destructiveWrites', risks.destructiveWrites, 'low', schema.destructive);
  note('risks.publicFacing', risks.publicFacing, deploy.length > 0 ? 'medium' : 'low', deploy.length > 0 ? [`deployment config: ${deploy.slice(0, 3).join(', ')}`] : ['no deployment configuration found']);
  note('risks.integrations', risks.integrations, 'medium', serviceDeps.slice(0, 4).map((dep) => `dependency: ${dep}`));

  questions.push('Is this domain regulated (health, finance, minors, employment)? Nothing in the code can establish that, and it changes the tier.');

  // ---- stage
  let stage = 'prototype';
  let stageWhy = [];
  if (deploy.length > 0 || (publishable && tests.length > 0)) {
    // Live is live: deployment or publication decides the stage. Missing tests are
    // a finding, not a lower stage.
    stage = 'production';
    stageWhy = deploy.length > 0
      ? [`deployment config: ${deploy.slice(0, 2).join(', ')}`]
      : ['publishable package with tests'];
    if (tests.length > 0) stageWhy.push('tests present');
    if (ci.length > 0) stageWhy.push(`CI: ${ci[0]}`);
  } else if (tests.length > 0 || ci.length > 0 || scan.sourceFiles.length > 15) {
    stage = 'mvp';
    stageWhy = tests.length > 0 ? [`tests: ${tests.slice(0, 2).join(', ')}`] : ci.length > 0 ? [`CI: ${ci[0]}`] : [`${scan.sourceFiles.length} source files`];
  } else {
    stageWhy = [`${scan.sourceFiles.length} source files, no tests or CI`];
  }
  note('stage', stage, 'medium', stageWhy);

  if (deploy.length > 0 && tests.length === 0) {
    observations.push('Deployment configuration exists but no tests were found. Stage is production, so gate G0-SMOKE and G1-AC-TRACE fail today: the first work item is a test suite around the primary journey.');
  }
  if (deploy.length > 0 && ci.length === 0) observations.push('Deployed without CI. Gate G0-CHECK will fail until a pipeline exists.');
  if (schema.destructive.length > 0) questions.push('Which operations delete data, and is any of it irreversible? Cascading deletes were detected.');

  // ---- stack suggestion
  const mustUse = [...webDeps.slice(0, 2), ...serverDeps.slice(0, 1), ...hasDep(TRAIT_DEPS.persistence).slice(0, 1)].slice(0, 4);

  // ---- existing artifacts
  const existing = {
    packet: ['specs/spec.json', 'spec/spec.json'].find((file) => scan.has(file)) ?? null,
    adr: scan.hasDir('docs/adr') || scan.hasDir('adr'),
    openapi: scan.filesMatching(/openapi|swagger/i).slice(0, 2)
  };
  if (existing.packet) {
    observations.push(`This repository already contains a specification packet at ${existing.packet}. Use \`vld verify ${existing.packet} --repo .\` and \`vld change\` instead of adopting over it.`);
  }

  questions.push('Replace the draft idea with one paragraph: who it is for, what it does, and what they do today instead.');
  questions.push('How many people will use this in the first three months? Nothing in the code implies scale.');
  questions.push('How many engineers will work on it, and for how long?');
  if (risks.pii) questions.push('Which stored fields are personal data, and what is the retention period?');

  const profile = normalizeProfile({
    $comment: `Adopted from ${repoRoot}. Fields marked $adopted are inferences with evidence, not requirements: review them before compiling.`,
    name,
    idea:
      `TODO replace with one paragraph. Adopted draft: ${kind} built with ${language?.language ?? 'an undetected stack'}` +
      `${traits.length ? `, using ${traits.join(', ')}` : ''}${deploy.length ? ', deployed' : ''}. ` +
      'Describe who it is for, what it does, and what they do today instead.',
    kind,
    stage,
    users: { scale: 'small' },
    traits,
    risks,
    constraints: {
      team: 1,
      weeks: stage === 'production' ? 8 : 4,
      stack: language?.language ?? 'undecided',
      mustUse
    },
    $adopted: {
      by: 'vld adopt',
      evidence,
      questions,
      observations
    }
  });

  return {
    repo: repoRoot,
    name,
    profile,
    evidence,
    questions,
    observations,
    existing,
    facts: {
      filesScanned: scan.files.size,
      sourceFiles: scan.sourceFiles.length,
      truncated: scan.truncated,
      manifests: deps.manifests,
      dependencies: depNames.length,
      devDependencies: devDepNames.length,
      deploy,
      ci,
      tests,
      languages: language
    }
  };
}

/** Write the profile, refusing to clobber an existing file without force. */
export function writeAdoptedProfile(report, outPath, { force = false } = {}) {
  const target = path.resolve(outPath);
  if (existsSync(target) && !force) {
    const error = new Error(`${target} already exists. Pass --force to overwrite, or choose another path.`);
    error.code = 'OUTPUT_EXISTS';
    throw error;
  }

  const errors = validateProfile(normalizeProfile(report.profile));
  if (errors.length > 0) {
    const error = new Error(`adoption produced an invalid profile:\n  - ${errors.join('\n  - ')}`);
    error.code = 'INVALID_PROFILE';
    throw error;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report.profile, null, 2)}\n`, 'utf8');
  return target;
}
