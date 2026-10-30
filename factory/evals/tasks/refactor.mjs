import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const REFACTOR_TASKS = [
  {
    id: 'ref-17-domain-purity',
    category: 'refactor',
    title: 'Extract pure invoice discount domain module free of fs/http imports',
    ticket:
      'Refactor `src/index.mjs`: extract the pricing rule `calculateTotal({ subtotalCents, tier, taxBps })` into `src/domain/pricing.mjs` with zero `node:fs`, `node:http` or adapter imports, while preserving `quoteFromFile(jsonPath, correlationId)` in `src/index.mjs`. `calculateTotal` must reject negative `subtotalCents` (`INVALID_SUBTOTAL`) and apply tier discounts (`"gold"` 10%, `"silver"` 5%, `"standard"` 0%) before adding `taxBps` basis points.',
    profile: {
      name: 'quote-engine',
      idea: 'A B2B quote pricing service separating pure discount and tax domain calculations from file and transport adapters.',
      kind: 'api',
      stage: 'mvp',
      traits: ['payments'],
      risks: { payments: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `import { readFileSync } from 'node:fs';
export function quoteFromFile(jsonPath, correlationId = 'req-0') {
  const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const disc = data.tier === 'gold' ? 0.9 : data.tier === 'silver' ? 0.95 : 1;
  const discounted = Math.round(data.subtotalCents * disc);
  const totalCents = discounted + Math.round((discounted * (data.taxBps ?? 0)) / 10_000);
  return { ok: true, totalCents, correlationId };
}\n`
    },
    naive: {
      'src/domain/pricing.mjs': `import { readFileSync } from 'node:fs';
export function calculateTotal({ subtotalCents, tier, taxBps = 0 }) {
  const disc = tier === 'gold' ? 0.9 : tier === 'silver' ? 0.95 : 1;
  const discounted = Math.round(subtotalCents * disc);
  return { ok: true, totalCents: discounted + Math.round((discounted * taxBps) / 10_000) };
}
export const _unused = readFileSync;\n`,
      'src/index.mjs': `import { readFileSync } from 'node:fs';
import { calculateTotal } from './domain/pricing.mjs';
export { calculateTotal };
export function quoteFromFile(jsonPath, correlationId = 'req-0') {
  const res = calculateTotal(JSON.parse(readFileSync(jsonPath, 'utf8')));
  return { ...res, correlationId };
}\n`
    },
    reference: {
      'src/domain/pricing.mjs': `export function calculateTotal({ subtotalCents, tier = 'standard', taxBps = 0 }) {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0 || taxBps < 0) {
    return { ok: false, error: { code: 'INVALID_SUBTOTAL' } };
  }
  const rateBps = tier === 'gold' ? 9000 : tier === 'silver' ? 9500 : 10_000;
  const discounted = Math.round((subtotalCents * rateBps) / 10_000);
  const tax = Math.round((discounted * taxBps) / 10_000);
  return { ok: true, totalCents: discounted + tax };
}\n`,
      'src/index.mjs': `import { readFileSync } from 'node:fs';
import { calculateTotal } from './domain/pricing.mjs';

export { calculateTotal };

export function quoteFromFile(jsonPath, correlationId = 'req-0') {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const result = calculateTotal(raw);
  if (!result.ok) return { ok: false, error: { ...result.error, correlationId } };
  return { ok: true, totalCents: result.totalCents, correlationId };
}\n`
    },
    semanticDrift: {
      'src/domain/pricing.mjs': `export function calculateTotal({ subtotalCents, tier = 'standard', taxBps = 0 }) {
  const rateBps = tier === 'gold' ? 9000 : tier === 'silver' ? 9500 : 10_000;
  const discounted = Math.round((subtotalCents * rateBps) / 10_000);
  return { ok: true, totalCents: discounted + Math.round((discounted * taxBps) / 10_000) };
}\n`
    },
    async oracle(mod, repoDir) {
      assert.equal(typeof mod.calculateTotal, 'function', 'calculateTotal must be exported');
      assert.ok(existsSync(path.join(repoDir, 'src/domain/pricing.mjs')), 'src/domain/pricing.mjs missing');
      const res = mod.calculateTotal({ subtotalCents: 10_000, tier: 'gold', taxBps: 1000 });
      assert.equal(res.totalCents, 9900);
    },
    defectProbes: [
      {
        id: 'domain-imports-io-or-accepts-negative-subtotal',
        async check(mod, repoDir) {
          const domainSrc = readFileSync(path.join(repoDir, 'src/domain/pricing.mjs'), 'utf8');
          assert.ok(!/node:(fs|http|https|net)/.test(domainSrc), 'domain module still imports Node IO adapter');
          assert.equal(mod.calculateTotal({ subtotalCents: -100, tier: 'gold', taxBps: 0 }).ok, false);
        }
      }
    ]
  },
  {
    id: 'ref-18-error-envelope',
    category: 'refactor',
    title: 'Unify ad-hoc string throws into typed error envelopes without stack leaks',
    ticket:
      'Refactor `handleTransfer(req, correlationId)` in `src/index.mjs`. Currently invalid inputs throw raw strings or return `{ err: ... }` inconsistently and unexpected dependency exceptions leak stack traces. Standardize every failure to `{ ok: false, status, error: { code, message, correlationId } }` (`400 INVALID_TRANSFER`, `403 FORBIDDEN`, `502 UPSTREAM_ERROR` with sanitized message and never `stack`), while keeping `{ ok: true, status: 200, data, correlationId }` unchanged.',
    profile: {
      name: 'transfer-gateway',
      idea: 'An internal HTTP gateway normalizing account transfer responses and error envelopes across downstream services.',
      kind: 'api',
      stage: 'mvp',
      traits: ['auth'],
      risks: { integrations: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export async function handleTransfer(req, sendUpstream) {
  if (!req.actorId) return { err: 'forbidden' };
  if (!req.cents || req.cents <= 0) throw 'bad amount';
  const out = await sendUpstream(req);
  return { ok: true, status: 200, data: out };
}\n`
    },
    naive: {
      'src/index.mjs': `export async function handleTransfer(req, sendUpstream, correlationId = 'req-0') {
  if (!req.actorId) return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden', correlationId } };
  if (!req.cents || req.cents <= 0) return { ok: false, status: 400, error: { code: 'INVALID_TRANSFER', message: 'Invalid amount', correlationId } };
  try {
    const out = await sendUpstream(req);
    return { ok: true, status: 200, data: out, correlationId };
  } catch (err) {
    return { ok: false, status: 502, error: { code: 'UPSTREAM_ERROR', message: err.stack || err.message, correlationId } };
  }
}\n`
    },
    reference: {
      'src/index.mjs': `function fail(status, code, message, correlationId) {
  return { ok: false, status, error: { code, message, correlationId } };
}

export async function handleTransfer(req = {}, sendUpstream, correlationId = 'req-0') {
  if (!req.actorId) {
    return fail(403, 'FORBIDDEN', 'Authenticated actor required.', correlationId);
  }
  if (!Number.isInteger(req.cents) || req.cents <= 0 || !req.toAccount) {
    return fail(400, 'INVALID_TRANSFER', 'Transfer requires positive integer cents and destination.', correlationId);
  }
  try {
    const data = await sendUpstream(req);
    return { ok: true, status: 200, data, correlationId };
  } catch {
    return fail(502, 'UPSTREAM_ERROR', 'Downstream transfer provider unavailable.', correlationId);
  }
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export async function handleTransfer(req = {}, sendUpstream, correlationId = 'req-0') {
  if (!req.actorId) return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Denied', correlationId } };
  if (!req.cents || req.cents <= 0) return { ok: false, status: 400, error: { code: 'INVALID_TRANSFER', message: 'Bad', correlationId } };
  try {
    const data = await sendUpstream(req);
    return { ok: true, status: 200, data, correlationId };
  } catch (e) {
    return { ok: false, status: 502, error: { code: 'UPSTREAM_ERROR', message: String(e.stack), correlationId } };
  }
}\n`
    },
    async oracle(mod) {
      const ok = await mod.handleTransfer({ actorId: 'u1', toAccount: 'a2', cents: 500 }, async () => ({ id: 't1' }), 'c1');
      assert.equal(ok.ok, true);
      const bad = await mod.handleTransfer({ actorId: 'u1', toAccount: 'a2', cents: -5 }, async () => ({}), 'c2');
      assert.equal(bad.ok, false);
      assert.equal(bad.error.code, 'INVALID_TRANSFER');
    },
    defectProbes: [
      {
        id: 'upstream-exception-leaks-internal-stack-trace',
        async check(mod) {
          const upstreamErr = await mod.handleTransfer(
            { actorId: 'u1', toAccount: 'a2', cents: 500 },
            async () => {
              throw new Error('ECONNREFUSED postgres://internal-host:5432/prod');
            },
            'c3'
          );
          assert.equal(upstreamErr.status, 502);
          assert.equal(upstreamErr.error.code, 'UPSTREAM_ERROR');
          assert.ok(!/internal-host|at\s+\S+/.test(upstreamErr.error.message), 'internal host or stack leaked into public error envelope');
        }
      }
    ]
  },
  {
    id: 'ref-19-forward-migration',
    category: 'refactor',
    title: 'Replace destructive schema reset with ordered forward-only migration runner',
    ticket:
      'Refactor `migrate(db, migrations, correlationId)` in `src/index.mjs`. Currently schema updates wipe `db.rows` and recreate defaults! Implement an ordered, idempotent forward-only runner: sort `migrations` by numeric `version`, skip already-applied versions recorded in `db.appliedVersions`, check checksums so an edited historical migration fails with `MIGRATION_CHECKSUM_MISMATCH` without running later steps, and preserve existing `db.rows`.',
    profile: {
      name: 'schema-runner',
      idea: 'A database migration runner applying versioned forward-only schema transforms safely without losing existing tenant records.',
      kind: 'data-pipeline',
      stage: 'production',
      traits: ['persistence'],
      risks: { destructiveWrites: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function migrate(db, migrations) {
  db.rows = [];
  for (const m of migrations) m.up(db);
  return { ok: true };
}\n`
    },
    naive: {
      'src/index.mjs': `export function migrate(db, migrations, correlationId = 'req-0') {
  db.applied = db.applied ?? new Set();
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (db.applied.has(m.version)) continue;
    m.up(db);
    db.applied.add(m.version);
  }
  return { ok: true, correlationId };
}\n`
    },
    reference: {
      'src/index.mjs': `import { createHash } from 'node:crypto';

function checksum(migration) {
  return createHash('sha256').update(\`\${migration.version}:\${migration.name}:\${migration.up.toString()}\`).digest('hex').slice(0, 16);
}

export function migrate(db, migrations, correlationId = 'req-0') {
  db.appliedVersions = db.appliedVersions ?? new Map();
  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  for (const m of ordered) {
    const sum = checksum(m);
    if (db.appliedVersions.has(m.version)) {
      if (db.appliedVersions.get(m.version) !== sum) {
        return { ok: false, error: { code: 'MIGRATION_CHECKSUM_MISMATCH', version: m.version, correlationId } };
      }
      continue;
    }
    m.up(db);
    db.appliedVersions.set(m.version, sum);
  }
  return { ok: true, appliedCount: db.appliedVersions.size, correlationId };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function migrate(db, migrations, correlationId = 'req-0') {
  db.appliedVersions = db.appliedVersions ?? new Map();
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (db.appliedVersions.has(m.version)) continue;
    m.up(db);
    db.appliedVersions.set(m.version, 'ok');
  }
  return { ok: true, appliedCount: db.appliedVersions.size, correlationId };
}\n`
    },
    async oracle(mod) {
      const db = { rows: [{ id: 1, name: 'Ada' }] };
      const res = mod.migrate(db, [
        { version: 2, name: 'add-active', up: (d) => d.rows.forEach((r) => { r.active = true; }) },
        { version: 1, name: 'add-role', up: (d) => d.rows.forEach((r) => { r.role = r.active ? 'wrong-order' : 'member'; }) }
      ]);
      assert.equal(res.ok, true);
      assert.equal(db.rows.length, 1, 'migration wiped existing rows');
      assert.equal(db.rows[0].role, 'member', 'migrations ran out of version order');
    },
    defectProbes: [
      {
        id: 'rewritten-applied-migration-silently-ignored',
        async check(mod) {
          const db = { rows: [{ id: 1 }] };
          mod.migrate(db, [{ version: 1, name: 'v1', up: (d) => { d.rows[0].v = 1; } }]);
          const tampered = mod.migrate(db, [{ version: 1, name: 'v1', up: (d) => { d.rows[0].v = 999; } }]);
          assert.equal(tampered.ok, false);
          assert.equal(tampered.error.code, 'MIGRATION_CHECKSUM_MISMATCH');
        }
      }
    ]
  },
  {
    id: 'ref-20-config-env-validation',
    category: 'refactor',
    title: 'Replace hardcoded secret fallback with fail-fast startup env validation',
    ticket:
      'Refactor `loadConfig(env, correlationId)` in `src/index.mjs`. Remove the hardcoded default signing key fallback, collect *every* missing or invalid variable (`DATABASE_URL`, `SIGNING_KEY` min 16 chars, `PORT` integer 1..65535) in a single pass rather than failing one variable at a time, and return `{ ok: false, error: { code: "INVALID_CONFIG", missing: [...], correlationId } }` when any check fails.',
    profile: {
      name: 'service-bootstrap',
      idea: 'A backend service configuration loader validating required environment variables at startup without secret fallbacks.',
      kind: 'api',
      stage: 'mvp',
      traits: ['auth', 'persistence'],
      risks: { publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function loadConfig(env = {}) {
  return {
    ok: true,
    config: {
      databaseUrl: env.DATABASE_URL || 'postgres://localhost/dev',
      signingKey: env.SIGNING_KEY || 'default-dev-signing-key',
      port: Number(env.PORT || 3000)
    }
  };
}\n`
    },
    naive: {
      'src/index.mjs': `export function loadConfig(env = {}, correlationId = 'req-0') {
  if (!env.DATABASE_URL) return { ok: false, error: { code: 'INVALID_CONFIG', missing: ['DATABASE_URL'], correlationId } };
  if (!env.SIGNING_KEY) return { ok: false, error: { code: 'INVALID_CONFIG', missing: ['SIGNING_KEY'], correlationId } };
  return { ok: true, config: { databaseUrl: env.DATABASE_URL, signingKey: env.SIGNING_KEY, port: Number(env.PORT || 3000) }, correlationId };
}\n`
    },
    reference: {
      'src/index.mjs': `export function loadConfig(env = {}, correlationId = 'req-0') {
  const missing = [];
  if (!env.DATABASE_URL || !/^postgres(ql)?:\\/\\//.test(env.DATABASE_URL)) missing.push('DATABASE_URL');
  if (!env.SIGNING_KEY || String(env.SIGNING_KEY).length < 16) missing.push('SIGNING_KEY');
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) missing.push('PORT');

  if (missing.length > 0) {
    return { ok: false, error: { code: 'INVALID_CONFIG', missing, correlationId } };
  }
  return {
    ok: true,
    config: { databaseUrl: env.DATABASE_URL, signingKey: env.SIGNING_KEY, port },
    correlationId
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function loadConfig(env = {}, correlationId = 'req-0') {
  if (!env.DATABASE_URL) return { ok: false, error: { code: 'INVALID_CONFIG', missing: ['DATABASE_URL'], correlationId } };
  if (!env.SIGNING_KEY) return { ok: false, error: { code: 'INVALID_CONFIG', missing: ['SIGNING_KEY'], correlationId } };
  return { ok: true, config: { databaseUrl: env.DATABASE_URL, signingKey: env.SIGNING_KEY, port: Number(env.PORT ?? 3000) }, correlationId };
}\n`
    },
    async oracle(mod) {
      const empty = mod.loadConfig({}, 'c1');
      assert.equal(empty.ok, false);
      const valid = mod.loadConfig({ DATABASE_URL: 'postgres://db/app', SIGNING_KEY: '0123456789abcdef0123', PORT: '8080' }, 'c2');
      assert.equal(valid.ok, true);
      assert.equal(valid.config.port, 8080);
    },
    defectProbes: [
      {
        id: 'reports-only-first-missing-var-or-accepts-weak-key-and-bad-port',
        async check(mod) {
          const allBad = mod.loadConfig({ PORT: '99999', SIGNING_KEY: 'short' }, 'c1');
          assert.equal(allBad.ok, false);
          assert.deepEqual(allBad.error.missing.sort(), ['DATABASE_URL', 'PORT', 'SIGNING_KEY']);
        }
      }
    ]
  }
];
