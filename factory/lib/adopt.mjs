/**
 * Adoption: derive a profile from an existing repository (local path or Git URL).
 *
 * The point is not to guess perfectly. It is to move the starting line from
 * "describe your project in a questionnaire" to "here is what we saw, with the
 * evidence, and here are the six things only you can answer".
 *
 * Three rules keep it honest:
 *   1. Every inferred value carries the observation that produced it.
 *   2. Multi-channel evidence (manifests, docker-compose service images, committed
 *      .env.example keys, and schema/migration DDL) prevents single-channel blind spots
 *      while never reading live .env secret values.
 *   3. Nothing legal or organisational is inferred from code. Regulation,
 *      user scale and team size become questions, never assertions.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, scanRepo } from './scan.mjs';
import { normalizeProfile, validateProfile } from './profile.mjs';

const WEB_DEPS = ['next', 'react', 'vue', 'svelte', '@sveltejs/kit', 'nuxt', '@remix-run/react', 'astro', 'solid-js', '@angular/core', 'gatsby', 'qwik', '@builder.io/qwik'];
const SERVER_DEPS = ['express', 'fastify', 'hono', 'koa', '@nestjs/core', 'django', 'fastapi', 'flask', 'rails', 'laravel/framework', 'spring-boot', 'actix-web', 'axum', 'gin', 'echo', 'fiber', 'chi', 'phoenix'];
const MOBILE_DEPS = ['expo', 'react-native', 'flutter', '@capacitor/core', 'nativescript', '@ionic/react'];
const PIPELINE_DEPS = ['dbt-core', 'apache-airflow', 'dagster', 'prefect', 'pyspark', 'dlt', 'meltano', 'confluent-kafka', 'kafka-python', 'airbyte'];
const AGENT_DEPS = ['langgraph', 'crewai', 'autogen', '@langchain/langgraph', 'llama-index', '@openai/agents', 'pydantic-ai', 'google-adk'];
const CLI_DEPS = ['commander', 'yargs', 'ink', 'clap', 'cobra', 'typer', 'click', 'thor', 'oclif', '@oclif/core'];

const TRAIT_DEPS = {
  auth: ['next-auth', '@auth/core', '@auth/', '@clerk/', 'clerk', 'passport', 'lucia', 'better-auth', 'auth0', '@azure/msal-node', 'supertokens', 'workos', 'firebase-admin', '@supabase/auth-helpers', 'jsonwebtoken', 'jose', 'bcrypt', 'argon2', 'pyjwt', 'python-jose', 'passlib', 'pwdlib', 'authlib', 'flask-login', 'flask-security', 'django-allauth', 'djangorestframework-simplejwt', 'devise', 'bcrypt-ruby', 'golang-jwt', 'gorilla/sessions', 'nextauth'],
  payments: ['stripe', '@stripe/', 'paddle', '@paddle/', 'lemonsqueezy', '@lemonsqueezy/', 'revenuecat', 'braintree', 'paypal', '@paypal/', 'square'],
  persistence: ['prisma', '@prisma/', 'drizzle-orm', 'knex', 'typeorm', 'sequelize', 'mongoose', '@mikro-orm/core', 'pg', 'pgx', 'sqlx', 'ent', 'mysql2', 'better-sqlite3', 'sqlite3', 'sqlalchemy', 'sqlmodel', 'tortoise-orm', 'peewee', 'alembic', 'psycopg', 'psycopg2', 'asyncpg', 'gorm', 'diesel', 'sea-orm', 'rusqlite', 'activerecord', 'ecto', 'sequel'],
  realtime: ['socket.io', 'ws', 'pusher', 'ably', 'liveblocks', '@supabase/realtime', 'channels', 'phoenix'],
  search: ['algolia', 'meilisearch', 'elasticsearch', '@elastic/', 'typesense', 'opensearch', 'pgvector', 'turbopuffer'],
  upload: ['multer', 'cloudinary', 'uploadthing', '@aws-sdk/client-s3', 'tus-js-client', 'shrine', 'carrierwave', 'filepond'],
  notifications: ['nodemailer', 'resend', 'sendgrid', '@sendgrid/', 'postmark', 'twilio', 'expo-notifications', 'onesignal', 'novu'],
  webhooks: ['svix', '@octokit/webhooks', 'standardwebhooks', 'stripe'],
  offline: ['workbox-', 'dexie', 'idb', 'serviceworker', 'react-native-mmkv'],
  ai: ['openai', 'anthropic', '@anthropic-ai/', 'anthropic-sdk-go', '@google/genai', 'google-generativeai', 'langchain', '@langchain/', 'ai', '@ai-sdk/', 'ollama', 'transformers', 'cohere-ai', 'groq-sdk', 'mistralai'],
  i18n: ['i18next', 'react-i18next', 'react-intl', 'vue-i18n', '@formatjs/', 'next-intl', 'fluent'],
  'background-jobs': ['bullmq', 'bull', 'celery', 'sidekiq', 'rq', 'dramatiq', 'temporal', '@temporalio/', 'inngest', 'trigger.dev', '@trigger.dev/', 'agenda', 'asynq', 'river', 'machinery', 'oban']
};

const SERVICE_DEPS = ['stripe', '@stripe/', 'twilio', 'sendgrid', '@sendgrid/', 'slack', '@slack/', '@octokit/', 'openai', 'anthropic', '@anthropic-ai/', 'anthropic-sdk-go', '@google/genai', 'google-generativeai', 'segment', '@segment/', 'algolia', 'auth0', 'clerk', '@clerk/', 'resend', 'postmark', 'serpapi', 'mapbox', 'google-maps'];

const LANGUAGE_BY_EXT = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rb': 'ruby', '.java': 'java', '.kt': 'kotlin',
  '.cs': 'csharp', '.php': 'php', '.rs': 'rust', '.ex': 'elixir', '.exs': 'elixir',
  '.swift': 'swift', '.dart': 'dart', '.vue': 'typescript', '.svelte': 'typescript'
};

const DEPLOY_FILES = ['Dockerfile', 'docker-compose.yml', 'fly.toml', 'render.yaml', 'vercel.json', 'netlify.toml', 'app.yaml', 'Procfile', 'k8s', 'helm', 'terraform', 'infra'];
const CI_FILES = ['.github/workflows', '.gitlab-ci.yml', 'circle.yml', '.circleci', 'Jenkinsfile', 'azure-pipelines.yml'];

/**
 * Segment-aware dependency matching across ecosystems (npm scoped packages,
 * Go module paths with /vN major suffixes, Composer vendor/pkg, Python/Rust/Ruby).
 * Leading `@` is stripped symmetrically so `@anthropic-ai/` matches `@anthropic-ai/sdk`
 * and `pgx` matches `github.com/jackc/pgx/v5` without matching `apgx`.
 */
function matches(name, patterns) {
  return patterns.some((rawPattern) => {
    const clean = String(rawPattern).toLowerCase().replace(/^@/, '');
    if (!clean) return false;
    if (clean.endsWith('/')) return name.startsWith(clean) || name.includes(`/${clean}`);
    if (clean.endsWith('-')) return name.startsWith(clean) || name.includes(`/${clean}`);
    return (
      name === clean ||
      name.startsWith(`${clean}/`) ||
      name.endsWith(`/${clean}`) ||
      name.includes(`/${clean}/`)
    );
  });
}

const MANIFEST_PATTERN = /(^|\/)(package\.json|pyproject\.toml|requirements(-[\w.]+)?\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|pubspec\.yaml)$/;
const TEST_TOOL_DEPS = [
  'vitest', 'jest', 'mocha', 'ava', 'pytest', 'hypothesis', 'playwright', '@playwright/test',
  'cypress', 'coverage', 'uvu', 'tap', 'phpunit', 'flutter_test', 'rspec', 'rspec-rails',
  'minitest', 'testify'
];

/**
 * Manifests live at the root in small projects and up to three levels down in
 * monorepo layouts (backend/, apps/web/, packages/core/api/). Missing one
 * produces a confidently wrong profile.
 */
function discoverManifests(scan) {
  return [...scan.files]
    .filter((file) => MANIFEST_PATTERN.test(file) && file.split('/').length <= 4)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function pythonBlocks(text) {
  // Quote- and comment-aware TOML array scanner so both single-line and multi-line
  // PEP 621 arrays (`dependencies = ["psycopg[binary]>=3.1", "anthropic>=0.39"]`)
  // parse cleanly without stopping on bracketed extras inside quoted specifiers.
  const blocks = [];
  for (const header of text.matchAll(/^[ \t]*([a-z0-9_-]+)[ \t]*=[ \t]*\[/gim)) {
    const name = header[1].toLowerCase();
    const start = header.index + header[0].length;
    let quote = null;
    let inComment = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inComment) {
        if (ch === '\n') inComment = false;
        continue;
      }
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '#') { inComment = true; continue; }
      if (ch === ']') { end = i; break; }
    }
    if (end !== -1) blocks.push({ name, body: text.slice(start, end) });
  }
  return blocks;
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
    if (!name || name.length > 80 || !/^[a-z0-9@/_.-]+$/.test(name)) return;
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
      let scope = runtime;
      for (const line of scan.contents(file).split('\n')) {
        const trimmed = line.trim();
        if (/^group\b/.test(trimmed)) {
          scope = /:test\b/.test(trimmed) ? dev : runtime;
          continue;
        }
        if (trimmed === 'end') { scope = runtime; continue; }
        const gemMatch = trimmed.match(/^gem\s+["']([^"']+)["']/);
        if (gemMatch) {
          const gemName = gemMatch[1];
          const bucket = /^(rspec|rspec-rails|minitest|capybara)$/i.test(gemName) ? dev : scope;
          add(bucket, gemName, file);
        }
      }
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
  const composeFiles = scan.filesMatching(/^(docker-)?compose([.-][\w-]+)?\.ya?ml$/);
  found.push(...composeFiles);
  const deployWorkflows = scan.filesMatching(/^\.github\/workflows\/.*\.ya?ml$/).filter((file) => /deploy|release|publish/i.test(file));
  found.push(...deployWorkflows);
  return [...new Set(found)];
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

  const testFiles = scan.filesMatching(
    /(^|\/)(test_[^/]+\.[a-z]+|[^/]+\.(test|spec)\.[a-z]+|[^/]+_test\.(go|rs|rb|py|dart|exs)|[^/]+Tests?\.(java|kt|cs|php))$/
  );
  if (testFiles.length > 0) found.push(`${testFiles.length} test file(s)`);

  const tooling = devDeps.filter((dep) => matches(dep, TEST_TOOL_DEPS));
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

const DOCKER_SERVICE_TRAITS = [
  { trait: 'persistence', pattern: /(^|\/|-)(postgres|postgis|mysql|mariadb|mongo|mongodb|cockroach|clickhouse|timescale)/i },
  { trait: 'background-jobs', pattern: /(^|\/|-)(redis|valkey|rabbitmq|nats|kafka|redpanda|temporal)/i },
  { trait: 'search', pattern: /(^|\/|-)(elasticsearch|opensearch|meilisearch|typesense|qdrant|weaviate)/i },
  { trait: 'upload', pattern: /(^|\/|-)(minio|localstack)/i }
];

const ENV_KEY_RULES = [
  { trait: 'persistence', integration: false, pattern: /^(DATABASE_URL|POSTGRES_|PGHOST|MYSQL_|MONGODB_URI|SUPABASE_DB)/ },
  { trait: 'payments', integration: true, pattern: /^(STRIPE_|PADDLE_|LEMONSQUEEZY_|BRAINTREE_|PAYPAL_)/ },
  { trait: 'ai', integration: true, pattern: /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|COHERE_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY)/ },
  { trait: 'auth', integration: false, pattern: /^(CLERK_|AUTH0_|NEXTAUTH_|BETTER_AUTH_|WORKOS_|JWT_SECRET)/ },
  { trait: 'notifications', integration: true, pattern: /^(SENDGRID_|RESEND_|POSTMARK_|TWILIO_)/ },
  { trait: 'upload', integration: true, pattern: /^(S3_BUCKET|AWS_S3_|R2_BUCKET|UPLOADTHING_|CLOUDINARY_)/ }
];

/**
 * Inspect docker-compose*.yml service images (`specfy/stack-analyser` pattern).
 * Many repositories run Postgres, Redis or Meilisearch in compose while keeping
 * thin client wrappers in code; reading `image:` recovers those traits safely.
 */
function detectDockerServices(scan) {
  const traits = new Map();
  const files = scan.filesMatching(/(^|\/)(docker-)?compose([.-][\w-]+)?\.ya?ml$/).slice(0, 10);
  for (const file of files) {
    const text = scan.contents(file);
    for (const match of text.matchAll(/^\s*image\s*:\s*["']?([^\s"'#]+)["']?/gm)) {
      const rawImage = match[1].trim();
      if (!rawImage || rawImage.startsWith('$')) continue;
      const imageName = rawImage.split(':')[0].split('@')[0].toLowerCase();
      for (const rule of DOCKER_SERVICE_TRAITS) {
        if (rule.pattern.test(imageName)) {
          if (!traits.has(rule.trait)) traits.set(rule.trait, []);
          traits.get(rule.trait).push(`${file}: image ${imageName}`);
        }
      }
    }
  }
  return traits;
}

/**
 * Inspect committed `.env.example` / `.env.sample` / `.env.template` key names ONLY.
 * Live `.env` files are never opened so secret values cannot leak into evidence.
 */
function detectEnvSignals(scan) {
  const traits = new Map();
  const integrations = [];
  const files = scan.filesMatching(/(^|\/)\.env\.(example|sample|template|defaults|dist)$/).slice(0, 10);
  for (const file of files) {
    const text = scan.contents(file);
    for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm)) {
      const key = match[1];
      for (const rule of ENV_KEY_RULES) {
        if (rule.pattern.test(key)) {
          if (!traits.has(rule.trait)) traits.set(rule.trait, []);
          traits.get(rule.trait).push(`${file}: ${key}`);
          if (rule.integration) integrations.push(`${file}: ${key}`);
        }
      }
    }
  }
  return { traits, integrations: [...new Set(integrations)].slice(0, 4) };
}

function detectSchemaSignals(scan) {
  const signals = { multiTenant: [], pii: [], destructive: [] };
  const sources = [
    ...scan.filesMatching(/schema\.prisma$|\.sql$|migrations?\//).slice(0, 60),
    ...scan.contentSample.filter((file) => /model|entity|schema/i).slice(0, 40)
  ];

  for (const file of new Set(sources)) {
    const text = scan.contents(file).toLowerCase();
    if (
      /\b([a-z0-9]+_)?(tenant|organisation|organization|workspace)(_[a-z0-9]+)*_id\b|\b(tenantid|org_id|org_[a-z0-9]+_id|account_id)\b/.test(
        text
      )
    ) {
      signals.multiTenant.push(`${file}: tenant/org scoping column`);
    }
    if (
      /\b([a-z0-9]+_)?(email|phone|first_name|last_name|full_name|date_of_birth|birth_date|address|ssn|tax_id|iban|passport|passport_number|national_id)(_[a-z0-9]+)*\b/.test(
        text
      )
    ) {
      signals.pii.push(`${file}: personal data column`);
    }
    if (
      /\bon\s+delete\s+cascade\b|ondelete\s*[:=]\s*['"]?cascade\b|delete-orphan|passive_deletes\s*=\s*true|dependent:\s*:(?:destroy|delete_all)|\b(?:drop|truncate)\s+table\b|\bdelete\s+from\b|\bhard[_ -]?delete\b/i.test(
        text
      )
    ) {
      signals.destructive.push(`${file}: cascading or hard delete`);
    }
  }

  return {
    multiTenant: [...new Set(signals.multiTenant)].slice(0, 3),
    pii: [...new Set(signals.pii)].slice(0, 3),
    destructive: [...new Set(signals.destructive)].slice(0, 3)
  };
}

function redactRemoteUrl(raw) {
  return String(raw).replace(/^(https?:\/\/)([^/@\s]+@)/i, '$1');
}

/**
 * True when `target` names a remote Git repository rather than a local directory.
 */
export function isRemoteRepo(target) {
  const value = String(target ?? '').trim();
  if (!value || value.startsWith('-')) return false;
  return /^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/|github:[a-z0-9_.-]+\/[a-z0-9_.-]+)/i.test(value);
}

/**
 * Parse a remote repository reference into a safe `git clone` specification.
 * Supports HTTPS URLs (including GitHub `/tree/<branch>` links), SSH (`git@host:org/repo`),
 * `github:owner/repo#branch` shorthand, and `file:///path` URLs for offline Git repos.
 */
export function parseRemoteRepo(target) {
  const raw = String(target ?? '').trim();
  if (!raw || raw.startsWith('-')) {
    const error = new Error(`Invalid repository reference: ${raw || '(empty)'}`);
    error.code = 'INVALID_REMOTE_URL';
    throw error;
  }

  const ghShort = raw.match(/^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#([A-Za-z0-9_./-]+))?$/i);
  if (ghShort) {
    const [, owner, repo, branch] = ghShort;
    if (branch?.startsWith('-')) {
      const error = new Error(`Invalid branch name in repository reference: ${branch}`);
      error.code = 'INVALID_REMOTE_URL';
      throw error;
    }
    const cleanUrl = `https://github.com/${owner}/${repo}`;
    return { cloneUrl: `${cleanUrl}.git`, displayUrl: cleanUrl, name: repo, branch: branch ?? null };
  }

  const ghTree = raw.match(/^(https?:\/\/(?:[^/@\s]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?))(?:\.git)?(?:\/tree\/([A-Za-z0-9_./-]+))?\/?$/i);
  if (ghTree) {
    const [, baseUrl, , repo, branch] = ghTree;
    if (branch?.startsWith('-')) {
      const error = new Error(`Invalid branch name in repository URL: ${branch}`);
      error.code = 'INVALID_REMOTE_URL';
      throw error;
    }
    const displayUrl = redactRemoteUrl(baseUrl);
    return { cloneUrl: `${baseUrl}.git`, displayUrl, name: repo, branch: branch ?? null };
  }

  if (/^(?:https?:\/\/|ssh:\/\/|file:\/\/|git@)/i.test(raw)) {
    const displayUrl = redactRemoteUrl(raw).replace(/\/+$/, '');
    const tail = displayUrl.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/i, '') ?? 'adopted-project';
    return { cloneUrl: raw, displayUrl, name: tail, branch: null };
  }

  const error = new Error(`Unsupported repository URL: ${raw}`);
  error.code = 'INVALID_REMOTE_URL';
  throw error;
}

function cloneRemoteRepo(remote) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'vld-remote-'));
  const checkoutDir = path.join(tempRoot, remote.name || 'repo');
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (remote.branch) args.push('--branch', remote.branch);
  args.push('--', remote.cloneUrl, checkoutDir);

  try {
    execFileSync('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
      timeout: 45_000
    });
    return {
      checkoutDir,
      cleanup: () => rmSync(tempRoot, { recursive: true, force: true })
    };
  } catch (cause) {
    rmSync(tempRoot, { recursive: true, force: true });
    const stderr = String(cause?.stderr ?? cause?.message ?? '').trim();
    const error = new Error(`Failed to clone ${remote.displayUrl}${stderr ? `: ${redactRemoteUrl(stderr.split('\n')[0])}` : ''}`);
    error.code = 'REMOTE_CLONE_FAILED';
    throw error;
  }
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

export function adoptRepo(root, options = {}) {
  if (isRemoteRepo(root)) {
    const remote = parseRemoteRepo(root);
    const cloned = cloneRemoteRepo(remote);
    try {
      return adoptLocalRepo(cloned.checkoutDir, {
        ...options,
        repoLabel: remote.displayUrl,
        remote: true,
        fallbackName: remote.name
      });
    } finally {
      cloned.cleanup();
    }
  }
  return adoptLocalRepo(path.resolve(root), options);
}

function adoptLocalRepo(repoRoot, options = {}) {
  const repoLabel = options.repoLabel ?? repoRoot;
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
  const goModFile = deps.manifests.find((file) => file.endsWith('go.mod'));
  const goModName = goModFile ? scan.contents(goModFile).match(/^\s*module\s+([^\s]+)/m)?.[1]?.split('/').filter((seg) => !/^v\d+$/.test(seg)).pop() : null;
  const cargoFile = deps.manifests.find((file) => file.endsWith('Cargo.toml'));
  const cargoName = cargoFile ? scan.contents(cargoFile).match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] : null;
  const manifestName = pkg?.name ?? pyName ?? goModName ?? cargoName ?? null;
  const explicitName = typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : null;
  const explicitIdea = typeof options.idea === 'string' && options.idea.trim() !== '' ? options.idea.trim() : null;
  const name = explicitName ?? sanitizeName(manifestName ?? options.fallbackName ?? path.basename(repoRoot), 'adopted-project');
  if (explicitName) note('name', name, 'high', ['supplied via --name']);
  else if (manifestName) note('name', name, 'high', [`manifest name: ${manifestName}`]);

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
    kind = 'api'; kindConfidence = 'high';
    kindWhy = serverDeps.slice(0, 3).map((dep) => `dependency: ${dep}`);
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

  // ---- traits (multi-channel: dependency manifests + docker-compose images + .env.example keys)
  const dockerTraits = detectDockerServices(scan);
  const envSignals = detectEnvSignals(scan);
  const traits = [];
  const traitEvidence = {};
  for (const [trait, patterns] of Object.entries(TRAIT_DEPS)) {
    const depHits = depNames.filter((dep) => matches(dep, patterns)).slice(0, 3).map((dep) => `dependency: ${dep}`);
    const dockerHits = (dockerTraits.get(trait) ?? []).slice(0, 2);
    const envHits = (envSignals.traits.get(trait) ?? []).slice(0, 2);
    const combined = [...depHits, ...dockerHits, ...envHits];
    if (combined.length > 0) {
      traits.push(trait);
      traitEvidence[trait] = combined.slice(0, 3);
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
  const integrationEvidence = [
    ...serviceDeps.slice(0, 4).map((dep) => `dependency: ${dep}`),
    ...envSignals.integrations
  ].slice(0, 4);

  const risks = {
    pii: traits.includes('auth') || schema.pii.length > 0,
    payments: traits.includes('payments'),
    regulated: false,
    multiTenant: schema.multiTenant.length > 0,
    destructiveWrites: schema.destructive.length > 0,
    publicFacing: deploy.length > 0,
    integrations: integrationEvidence.length > 0
  };

  const paymentDepEvidence = serviceDeps.filter((dep) => matches(dep, TRAIT_DEPS.payments)).map((dep) => `dependency: ${dep}`);
  const paymentEvidence = [...paymentDepEvidence, ...(envSignals.traits.get('payments') ?? [])];
  note('risks.pii', risks.pii, traits.includes('auth') ? 'medium' : 'low', [
    ...(traits.includes('auth') ? ['authentication present, so accounts exist'] : []),
    ...schema.pii
  ]);
  note('risks.payments', risks.payments, risks.payments ? 'high' : 'low', paymentEvidence);
  note('risks.multiTenant', risks.multiTenant, 'medium', schema.multiTenant);
  note('risks.destructiveWrites', risks.destructiveWrites, 'low', schema.destructive);
  note('risks.publicFacing', risks.publicFacing, deploy.length > 0 ? 'medium' : 'low', deploy.length > 0 ? [`deployment config: ${deploy.slice(0, 3).join(', ')}`] : ['no deployment configuration found']);
  note('risks.integrations', risks.integrations, 'medium', integrationEvidence);

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

  if (!explicitIdea) {
    questions.push('Replace the draft idea with one paragraph: who it is for, what it does, and what they do today instead.');
  }
  questions.push('How many people will use this in the first three months? Nothing in the code implies scale.');
  questions.push('How many engineers will work on it, and for how long?');
  if (risks.pii) questions.push('Which stored fields are personal data, and what is the retention period?');

  const draftIdea =
    `TODO replace with one paragraph. Adopted draft: ${kind} built with ${language?.language ?? 'an undetected stack'}` +
    `${traits.length ? `, using ${traits.join(', ')}` : ''}${deploy.length ? ', deployed' : ''}. ` +
    'Describe who it is for, what it does, and what they do today instead.';

  const profile = normalizeProfile({
    $comment: `Adopted from ${repoLabel}. Fields marked $adopted are inferences with evidence, not requirements: review them before compiling.`,
    name,
    idea: explicitIdea ?? draftIdea,
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
    repo: repoLabel,
    remote: Boolean(options.remote),
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
