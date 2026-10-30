import assert from 'node:assert/strict';

export const BROWNFIELD_TASKS = [
  {
    id: 'bf-07-board-csv-export',
    category: 'brownfield',
    title: 'Retro board facilitator-only CSV export',
    ticket:
      'Existing `createBoard(facilitatorId)` in `src/index.mjs` supports `addCard(authorId, column, text)` and `vote(voterId, cardId)`. Add `exportCsv(actorId, correlationId)`: only `facilitatorId` may export (`FORBIDDEN` otherwise); return `{ ok: true, csv, correlationId }` with header `id,column,text,votes`, RFC-4180 CSV escaping for commas, double quotes and newlines in `text`, and a header-only string when the board has zero cards.',
    profile: {
      name: 'retro-board',
      idea: 'A retrospective board where a team adds cards, votes on priorities and exports actions after the session.',
      kind: 'web-app',
      stage: 'mvp',
      traits: ['auth', 'persistence'],
      risks: { pii: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    change: {
      id: 'add-csv-export',
      title: 'Facilitators can export a board as CSV',
      why: 'Teams copy cards by hand into trackers after each retro.',
      risk: 'medium',
      add: [
        {
          key: 'feature.csv-export',
          title: 'Facilitator CSV export',
          area: 'api',
          statement: 'When the facilitator exports a board, the application shall return an RFC-4180 CSV containing one row per card and reject non-facilitators.',
          failurePath: 'A non-facilitator receives FORBIDDEN; an empty board returns only the header row.',
          acceptance: ['Given cards with commas and quotes, when the facilitator exports, then the CSV preserves every field and vote count.'],
          verify: 'automated'
        }
      ],
      probe: ['Export a two-card board and parse back four columns per row.'],
      rollback: 'Remove exportCsv method; card storage is unchanged.'
    },
    starter: {
      'src/index.mjs': `export function createBoard(facilitatorId) {
  const cards = [];
  let seq = 0;
  return {
    addCard(authorId, column, text) {
      const card = { id: \`c-\${++seq}\`, authorId, column, text, votes: 0 };
      cards.push(card);
      return card;
    },
    vote(_voterId, cardId) {
      const card = cards.find((c) => c.id === cardId);
      if (card) card.votes += 1;
      return card ?? null;
    },
    listCards: () => [...cards]
  };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard } from '../src/index.mjs';

test('existing card creation and voting still work', () => {
  const b = createBoard('fac-1');
  const card = b.addCard('u1', 'keep', 'Fast CI');
  b.vote('u2', card.id);
  assert.equal(b.listCards()[0].votes, 1);
});\n`
    },
    naive: {
      'src/index.mjs': `export function createBoard(facilitatorId) {
  const cards = [];
  let seq = 0;
  return {
    addCard(authorId, column, text) {
      const card = { id: \`c-\${++seq}\`, authorId, column, text, votes: 0 };
      cards.push(card);
      return card;
    },
    vote(_voterId, cardId) {
      const card = cards.find((c) => c.id === cardId);
      if (card) card.votes += 1;
      return card ?? null;
    },
    listCards: () => [...cards],
    exportCsv(_actorId, correlationId = 'req-0') {
      const lines = ['id,column,text,votes', ...cards.map((c) => \`\${c.id},\${c.column},\${c.text},\${c.votes}\`)];
      return { ok: true, csv: lines.join('\\n'), correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `function csvCell(value) {
  const str = String(value ?? '');
  return /[",\\r\\n]/.test(str) ? \`"\${str.replace(/"/g, '""')}"\` : str;
}

export function createBoard(facilitatorId) {
  const cards = [];
  let seq = 0;
  return {
    addCard(authorId, column, text) {
      const card = { id: \`c-\${++seq}\`, authorId, column, text, votes: 0 };
      cards.push(card);
      return card;
    },
    vote(_voterId, cardId) {
      const card = cards.find((c) => c.id === cardId);
      if (card) card.votes += 1;
      return card ?? null;
    },
    listCards: () => [...cards],
    exportCsv(actorId, correlationId = 'req-0') {
      if (actorId !== facilitatorId) {
        return { ok: false, error: { code: 'FORBIDDEN', correlationId } };
      }
      const rows = ['id,column,text,votes'];
      for (const c of cards) {
        rows.push([c.id, c.column, c.text, c.votes].map(csvCell).join(','));
      }
      return { ok: true, csv: rows.join('\\n'), correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createBoard(facilitatorId) {
  const cards = [];
  let seq = 0;
  return {
    addCard(authorId, column, text) {
      const card = { id: \`c-\${++seq}\`, authorId, column, text, votes: 0 };
      cards.push(card);
      return card;
    },
    vote(_voterId, cardId) {
      const card = cards.find((c) => c.id === cardId);
      if (card) card.votes += 1;
      return card ?? null;
    },
    listCards: () => [...cards],
    exportCsv(actorId, correlationId = 'req-0') {
      if (actorId !== facilitatorId) return { ok: false, error: { code: 'FORBIDDEN', correlationId } };
      return { ok: true, csv: ['id,column,text,votes', ...cards.map((c) => \`\${c.id},\${c.column},\${c.text},\${c.votes}\`)].join('\\n'), correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const b = mod.createBoard('fac-1');
      assert.equal(b.exportCsv('fac-1', 'c0').csv, 'id,column,text,votes');
      const card = b.addCard('u1', 'start', 'Pair review');
      b.vote('u2', card.id);
      const out = b.exportCsv('fac-1', 'c1');
      assert.equal(out.ok, true);
      assert.match(out.csv, /c-1,start,Pair review,1/);
    },
    defectProbes: [
      {
        id: 'non-facilitator-can-export',
        async check(mod) {
          const b = mod.createBoard('fac-1');
          const res = b.exportCsv('participant-9', 'c2');
          assert.equal(res.ok, false);
          assert.equal(res.error.code, 'FORBIDDEN');
        }
      },
      {
        id: 'unquoted-commas-corrupt-csv',
        async check(mod) {
          const b = mod.createBoard('fac-1');
          b.addCard('u1', 'stop', 'Fix "flaky", slow tests');
          const res = b.exportCsv('fac-1', 'c3');
          assert.ok(res.csv.includes('"Fix ""flaky"", slow tests"'), 'CSV failed RFC-4180 escaping');
        }
      }
    ]
  },
  {
    id: 'bf-08-invoice-refunds',
    category: 'brownfield',
    title: 'Partial invoice refunds capped at remaining captured cents',
    ticket:
      'Existing `createInvoices()` in `src/index.mjs` supports `capture(invoiceId, cents)`. Add `refund(invoiceId, cents, refundKey, correlationId)`: support multiple partial refunds up to captured cents (`REFUND_EXCEEDS_CAPTURED` if total refunded would exceed captured, `INVALID_AMOUNT` for non-positive/non-integer cents), deduplicate repeated `refundKey` values, and preserve `remainingCents(invoiceId)`.',
    profile: {
      name: 'invoice-service',
      idea: 'A billing API that captures customer invoices and processes partial refunds without over-refunding.',
      kind: 'api',
      stage: 'production',
      traits: ['auth', 'payments', 'persistence'],
      risks: { payments: true, pii: true },
      constraints: { stack: 'javascript' }
    },
    change: {
      id: 'add-partial-refunds',
      title: 'Support idempotent partial refunds on captured invoices',
      why: 'Support currently refunds full invoices when only one item was cancelled.',
      risk: 'high',
      add: [
        {
          key: 'payments.partial-refund',
          title: 'Bounded idempotent partial refunds',
          area: 'core',
          statement: 'When a refund is requested for a captured invoice, the service shall deduct at most the remaining captured cents and return the prior receipt on duplicate refund keys.',
          failurePath: 'Over-refunds fail with REFUND_EXCEEDS_CAPTURED and leave remaining cents unchanged.',
          acceptance: ['Given a 1000-cent invoice with a 600-cent refund, when a second 500-cent refund arrives, then it is rejected.'],
          verify: 'automated'
        }
      ],
      probe: ['Run two partial refunds and verify remainingCents equals captured minus sum of refunds.'],
      rollback: 'Disable refund endpoint; captured invoice records remain intact.'
    },
    starter: {
      'src/index.mjs': `export function createInvoices() {
  const invoices = new Map();
  return {
    capture(invoiceId, cents) {
      invoices.set(invoiceId, { captured: cents, refunded: 0 });
      return { ok: true, captured: cents };
    },
    remainingCents(invoiceId) {
      const inv = invoices.get(invoiceId);
      return inv ? inv.captured - inv.refunded : 0;
    }
  };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvoices } from '../src/index.mjs';

test('capturing an invoice records its remaining balance', () => {
  const s = createInvoices();
  s.capture('inv-1', 2500);
  assert.equal(s.remainingCents('inv-1'), 2500);
});\n`
    },
    naive: {
      'src/index.mjs': `export function createInvoices() {
  const invoices = new Map();
  return {
    capture(invoiceId, cents) {
      invoices.set(invoiceId, { captured: cents, refunded: 0 });
      return { ok: true, captured: cents };
    },
    remainingCents(invoiceId) {
      const inv = invoices.get(invoiceId);
      return inv ? inv.captured - inv.refunded : 0;
    },
    refund(invoiceId, cents, refundKey, correlationId = 'req-0') {
      const inv = invoices.get(invoiceId);
      if (!inv) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      if (cents > inv.captured) return { ok: false, error: { code: 'REFUND_EXCEEDS_CAPTURED', correlationId } };
      inv.refunded += cents;
      return { ok: true, refundKey, remaining: inv.captured - inv.refunded, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createInvoices() {
  const invoices = new Map();
  const keys = new Map();
  return {
    capture(invoiceId, cents) {
      invoices.set(invoiceId, { captured: cents, refunded: 0 });
      return { ok: true, captured: cents };
    },
    remainingCents(invoiceId) {
      const inv = invoices.get(invoiceId);
      return inv ? inv.captured - inv.refunded : 0;
    },
    refund(invoiceId, cents, refundKey, correlationId = 'req-0') {
      if (!Number.isInteger(cents) || cents <= 0 || !refundKey) {
        return { ok: false, error: { code: 'INVALID_AMOUNT', correlationId } };
      }
      if (keys.has(refundKey)) return keys.get(refundKey);
      const inv = invoices.get(invoiceId);
      if (!inv) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      if (inv.refunded + cents > inv.captured) {
        return { ok: false, error: { code: 'REFUND_EXCEEDS_CAPTURED', correlationId } };
      }
      inv.refunded += cents;
      const receipt = { ok: true, refundKey, remaining: inv.captured - inv.refunded, correlationId };
      keys.set(refundKey, receipt);
      return receipt;
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createInvoices() {
  const invoices = new Map();
  const keys = new Map();
  return {
    capture(invoiceId, cents) {
      invoices.set(invoiceId, { captured: cents, refunded: 0 });
      return { ok: true, captured: cents };
    },
    remainingCents(invoiceId) {
      const inv = invoices.get(invoiceId);
      return inv ? inv.captured - inv.refunded : 0;
    },
    refund(invoiceId, cents, refundKey, correlationId = 'req-0') {
      if (!Number.isInteger(cents) || cents <= 0) return { ok: false, error: { code: 'INVALID_AMOUNT', correlationId } };
      if (keys.has(refundKey)) return keys.get(refundKey);
      const inv = invoices.get(invoiceId);
      if (!inv) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      if (cents > inv.captured) return { ok: false, error: { code: 'REFUND_EXCEEDS_CAPTURED', correlationId } };
      inv.refunded += cents;
      const receipt = { ok: true, refundKey, remaining: inv.captured - inv.refunded, correlationId };
      keys.set(refundKey, receipt);
      return receipt;
    }
  };
}\n`
    },
    async oracle(mod) {
      const s = mod.createInvoices();
      s.capture('inv-1', 1000);
      const r1 = s.refund('inv-1', 400, 'rk-1', 'c1');
      assert.equal(r1.ok, true);
      assert.equal(s.remainingCents('inv-1'), 600);
    },
    defectProbes: [
      {
        id: 'cumulative-partial-refunds-exceed-captured',
        async check(mod) {
          const s = mod.createInvoices();
          s.capture('inv-1', 1000);
          s.refund('inv-1', 600, 'rk-1', 'c1');
          const over = s.refund('inv-1', 600, 'rk-2', 'c2');
          assert.equal(over.ok, false);
          assert.equal(over.error.code, 'REFUND_EXCEEDS_CAPTURED');
          assert.equal(s.remainingCents('inv-1'), 400);
        }
      },
      {
        id: 'duplicate-refund-key-double-refunds',
        async check(mod) {
          const s = mod.createInvoices();
          s.capture('inv-1', 1000);
          s.refund('inv-1', 300, 'rk-dup', 'c1');
          s.refund('inv-1', 300, 'rk-dup', 'c1');
          assert.equal(s.remainingCents('inv-1'), 700);
        }
      }
    ]
  },
  {
    id: 'bf-09-apikey-rotation',
    category: 'brownfield',
    title: 'Overlapped API key rotation with grace window and emergency revoke',
    ticket:
      'Existing `createKeyStore()` in `src/index.mjs` issues one key per client via `issue(clientId, nowMs)` and checks `verify(token, nowMs, correlationId)`. Add `rotate(clientId, graceMs, nowMs)` and `revokeClient(clientId)`: rotating issues a new active token while keeping the previous token valid only until `nowMs + graceMs`; `revokeClient` immediately invalidates both current and grace tokens (`UNAUTHORIZED`).',
    profile: {
      name: 'apikey-service',
      idea: 'An API authentication service that issues client keys and rotates credentials without downtime.',
      kind: 'api',
      stage: 'production',
      traits: ['auth', 'persistence'],
      risks: { publicFacing: true, multiTenant: true },
      constraints: { stack: 'javascript' }
    },
    change: {
      id: 'add-key-rotation',
      title: 'Zero-downtime API key rotation with grace expiry',
      why: 'Clients currently suffer downtime when rotating static keys.',
      risk: 'high',
      add: [
        {
          key: 'auth.key-rotation',
          title: 'Grace-window key rotation',
          area: 'security',
          statement: 'When a client rotates its key, the service shall accept the retiring key until the grace window elapses and reject all keys immediately upon client revocation.',
          failurePath: 'A retiring key presented after graceMs fails with UNAUTHORIZED.',
          acceptance: ['Given a 60s grace window, when the old key is used at 61s, then verification returns UNAUTHORIZED.'],
          verify: 'automated'
        }
      ],
      probe: ['Rotate a key, verify both during grace, then verify old fails after grace.'],
      rollback: 'Issue a fresh single key for affected clients.'
    },
    starter: {
      'src/index.mjs': `export function createKeyStore() {
  const byToken = new Map();
  let seq = 0;
  return {
    issue(clientId) {
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId });
      return token;
    },
    verify(token, _nowMs = Date.now(), correlationId = 'req-0') {
      const rec = byToken.get(token);
      return rec ? { ok: true, clientId: rec.clientId, correlationId } : { ok: false, error: { code: 'UNAUTHORIZED', correlationId } };
    }
  };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyStore } from '../src/index.mjs';

test('issued token verifies for its client', () => {
  const ks = createKeyStore();
  const tok = ks.issue('c1');
  assert.equal(ks.verify(tok).ok, true);
});\n`
    },
    naive: {
      'src/index.mjs': `export function createKeyStore() {
  const byToken = new Map();
  let seq = 0;
  return {
    issue(clientId) {
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId, expiresAt: Infinity });
      return token;
    },
    rotate(clientId, _graceMs, _nowMs = Date.now()) {
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId, expiresAt: Infinity });
      return token;
    },
    revokeClient(clientId) {
      for (const [tok, rec] of byToken) if (rec.clientId === clientId) byToken.delete(tok);
    },
    verify(token, _nowMs = Date.now(), correlationId = 'req-0') {
      const rec = byToken.get(token);
      return rec ? { ok: true, clientId: rec.clientId, correlationId } : { ok: false, error: { code: 'UNAUTHORIZED', correlationId } };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createKeyStore() {
  const byToken = new Map();
  let seq = 0;
  return {
    issue(clientId) {
      for (const [tok, rec] of byToken) {
        if (rec.clientId === clientId) byToken.delete(tok);
      }
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId, expiresAt: Infinity });
      return token;
    },
    rotate(clientId, graceMs, nowMs = Date.now()) {
      for (const [, rec] of byToken) {
        if (rec.clientId === clientId && rec.expiresAt === Infinity) {
          rec.expiresAt = nowMs + Math.max(0, graceMs);
        }
      }
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId, expiresAt: Infinity });
      return token;
    },
    revokeClient(clientId) {
      for (const [tok, rec] of byToken) {
        if (rec.clientId === clientId) byToken.delete(tok);
      }
    },
    verify(token, nowMs = Date.now(), correlationId = 'req-0') {
      const rec = byToken.get(token);
      if (!rec || nowMs >= rec.expiresAt) {
        return { ok: false, error: { code: 'UNAUTHORIZED', correlationId } };
      }
      return { ok: true, clientId: rec.clientId, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createKeyStore() {
  const byToken = new Map();
  let seq = 0;
  return {
    issue(clientId) {
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId, expiresAt: Infinity });
      return token;
    },
    rotate(clientId, graceMs, nowMs = Date.now()) {
      for (const [, rec] of byToken) if (rec.clientId === clientId) rec.expiresAt = nowMs + graceMs;
      const token = \`key_\${clientId}_\${++seq}\`;
      byToken.set(token, { clientId, expiresAt: Infinity });
      return token;
    },
    revokeClient(clientId) {
      for (const [tok, rec] of byToken) if (rec.clientId === clientId && rec.expiresAt === Infinity) byToken.delete(tok);
    },
    verify(token, nowMs = Date.now(), correlationId = 'req-0') {
      const rec = byToken.get(token);
      if (!rec || nowMs >= rec.expiresAt) return { ok: false, error: { code: 'UNAUTHORIZED', correlationId } };
      return { ok: true, clientId: rec.clientId, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const ks = mod.createKeyStore();
      const oldTok = ks.issue('c1');
      const newTok = ks.rotate('c1', 1000, 500);
      assert.equal(ks.verify(oldTok, 900).ok, true);
      assert.equal(ks.verify(newTok, 2000).ok, true);
    },
    defectProbes: [
      {
        id: 'old-key-never-expires-or-survives-revoke',
        async check(mod) {
          const ks = mod.createKeyStore();
          const oldTok = ks.issue('c1');
          ks.rotate('c1', 1000, 500);
          assert.equal(ks.verify(oldTok, 1600).ok, false, 'rotated key stayed valid past grace window');
          const old2 = ks.issue('c2');
          ks.rotate('c2', 10_000, 100);
          ks.revokeClient('c2');
          assert.equal(ks.verify(old2, 200).ok, false, 'grace key survived emergency revoke');
        }
      }
    ]
  },
  {
    id: 'bf-10-job-retry-backoff',
    category: 'brownfield',
    title: 'Queue worker bounded retries with exponential backoff and dead-letter',
    ticket:
      'Existing `createQueue()` in `src/index.mjs` runs `enqueue(job)` and `processNext(nowMs, handler)`. Add bounded retries: `createQueue({ maxAttempts = 3, baseDelayMs = 1000 })`. When `handler(job)` throws `{ retryable: false }`, move straight to `deadLetters()` without retry. Otherwise retry with delay `baseDelayMs * 2**(attempt - 1)` until `maxAttempts` is reached, then move to `deadLetters()`. Do not execute jobs whose `availableAt > nowMs`.',
    profile: {
      name: 'job-worker',
      idea: 'A background job processor for webhook deliveries with exponential backoff and a dead-letter queue.',
      kind: 'automation',
      stage: 'mvp',
      traits: ['webhooks', 'persistence'],
      risks: { integrations: true },
      constraints: { stack: 'javascript' }
    },
    change: {
      id: 'add-bounded-retries',
      title: 'Bounded exponential backoff and dead-letter isolation',
      why: 'Transient downstream errors currently drop jobs while permanent 400s loop.',
      risk: 'medium',
      add: [
        {
          key: 'queue.bounded-retry',
          title: 'Bounded retry and dead-letter routing',
          area: 'reliability',
          statement: 'When a job fails, the worker shall retry retryable errors with exponential backoff up to maxAttempts and route non-retryable or exhausted jobs to deadLetters.',
          failurePath: 'Non-retryable errors enter deadLetters after attempt 1 without blocking ready jobs.',
          acceptance: ['Given maxAttempts 3, when a job fails three times, then deadLetters contains one entry and queue is empty.'],
          verify: 'automated'
        }
      ],
      probe: ['Fail a retryable job 3 times and assert scheduled timestamps follow 1x and 2x baseDelayMs.'],
      rollback: 'Set maxAttempts to 1 while retaining deadLetters inspection.'
    },
    starter: {
      'src/index.mjs': `export function createQueue() {
  const ready = [];
  return {
    enqueue(job, nowMs = 0) { ready.push({ job, availableAt: nowMs, attempts: 0 }); },
    async processNext(nowMs, handler) {
      const item = ready.shift();
      if (!item) return null;
      await handler(item.job);
      return { status: 'completed' };
    },
    deadLetters: () => []
  };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueue } from '../src/index.mjs';

test('happy-path job runs once', async () => {
  const q = createQueue();
  let ran = 0;
  q.enqueue({ id: 1 }, 0);
  await q.processNext(0, async () => { ran += 1; });
  assert.equal(ran, 1);
});\n`
    },
    naive: {
      'src/index.mjs': `export function createQueue({ maxAttempts = 3 } = {}) {
  const ready = [];
  const dead = [];
  return {
    enqueue(job, nowMs = 0) { ready.push({ job, availableAt: nowMs, attempts: 0 }); },
    async processNext(_nowMs, handler) {
      const item = ready.shift();
      if (!item) return null;
      item.attempts += 1;
      try {
        await handler(item.job);
        return { status: 'completed' };
      } catch (err) {
        if (item.attempts >= maxAttempts) dead.push({ job: item.job, attempts: item.attempts });
        else ready.push(item);
        return { status: 'failed' };
      }
    },
    deadLetters: () => [...dead]
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createQueue({ maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  const items = [];
  const dead = [];
  return {
    enqueue(job, nowMs = 0) {
      items.push({ job, availableAt: nowMs, attempts: 0 });
    },
    async processNext(nowMs, handler, correlationId = 'req-0') {
      const idx = items.findIndex((entry) => entry.availableAt <= nowMs);
      if (idx === -1) return null;
      const [item] = items.splice(idx, 1);
      item.attempts += 1;
      try {
        await handler(item.job);
        return { status: 'completed', attempts: item.attempts, correlationId };
      } catch (err) {
        if (err?.retryable === false || item.attempts >= maxAttempts) {
          dead.push({ job: item.job, attempts: item.attempts, reason: err?.message ?? 'failed', correlationId });
          return { status: 'dead-lettered', attempts: item.attempts, correlationId };
        }
        const delay = baseDelayMs * 2 ** (item.attempts - 1);
        item.availableAt = nowMs + delay;
        items.push(item);
        return { status: 'scheduled-retry', nextAttemptAt: item.availableAt, correlationId };
      }
    },
    deadLetters: () => [...dead]
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createQueue({ maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  const items = [];
  const dead = [];
  return {
    enqueue(job, nowMs = 0) { items.push({ job, availableAt: nowMs, attempts: 0 }); },
    async processNext(nowMs, handler, correlationId = 'req-0') {
      const idx = items.findIndex((entry) => entry.availableAt <= nowMs);
      if (idx === -1) return null;
      const [item] = items.splice(idx, 1);
      item.attempts += 1;
      try {
        await handler(item.job);
        return { status: 'completed', correlationId };
      } catch (err) {
        if (item.attempts >= maxAttempts) {
          dead.push({ job: item.job, attempts: item.attempts, correlationId });
          return { status: 'dead-lettered', correlationId };
        }
        item.availableAt = nowMs + baseDelayMs;
        items.push(item);
        return { status: 'scheduled-retry', correlationId };
      }
    },
    deadLetters: () => [...dead]
  };
}\n`
    },
    async oracle(mod) {
      const q = mod.createQueue({ maxAttempts: 2, baseDelayMs: 500 });
      q.enqueue({ id: 'j1' }, 0);
      await q.processNext(0, async () => { throw new Error('boom'); });
      assert.equal(q.deadLetters().length, 0);
      await q.processNext(600, async () => { throw new Error('boom'); });
      assert.equal(q.deadLetters().length, 1);
    },
    defectProbes: [
      {
        id: 'backoff-delay-or-non-retryable-ignored',
        async check(mod) {
          const q = mod.createQueue({ maxAttempts: 3, baseDelayMs: 1000 });
          q.enqueue({ id: 'j1' }, 0);
          await q.processNext(0, async () => { throw new Error('transient'); });
          const premature = await q.processNext(500, async () => {});
          assert.equal(premature, null, 'retried before backoff window elapsed');

          q.enqueue({ id: 'j-fatal' }, 0);
          await q.processNext(0, async () => { throw Object.assign(new Error('400'), { retryable: false }); });
          assert.equal(q.deadLetters().some((d) => d.job.id === 'j-fatal' && d.attempts === 1), true, 'retried non-retryable error');
        }
      }
    ]
  },
  {
    id: 'bf-11-upload-quarantine',
    category: 'brownfield',
    title: 'Attachment upload magic-byte, size and path-traversal guard',
    ticket:
      'Existing `createUploadStore()` in `src/index.mjs` stores `{ filename, mime, bytes }` (`bytes` is `Uint8Array`). Harden `accept({ filename, mime, bytes }, correlationId)` for max `maxBytes = 1024 * 1024`: allow only `image/png` (magic `0x89 0x50 0x4e 0x47`) and `application/pdf` (`%PDF-`, `0x25 0x50 0x44 0x46`); reject mismatched magic bytes (`MIME_MISMATCH`), oversized payloads (`FILE_TOO_LARGE`), and filenames with `..`, `/` or `\\` (`INVALID_FILENAME`). Return a generated storage key rather than trusting `filename`.',
    profile: {
      name: 'attachment-store',
      idea: 'A customer support attachment service accepting user-uploaded PNG screenshots and PDF receipts.',
      kind: 'web-app',
      stage: 'mvp',
      traits: ['auth', 'uploads', 'persistence'],
      risks: { pii: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    change: {
      id: 'harden-upload-validation',
      title: 'Validate magic bytes, size ceiling and storage key generation on uploads',
      why: 'Client-supplied filenames and Content-Type headers are untrusted.',
      risk: 'high',
      add: [
        {
          key: 'uploads.magic-validation',
          title: 'Magic-byte and filename sanitization',
          area: 'security',
          statement: 'When a file is uploaded, the store shall verify magic bytes against the allowlisted MIME type, enforce maxBytes and store under a generated key.',
          failurePath: 'Disguised executables or traversal filenames are rejected before storage.',
          acceptance: ['Given an HTML payload labelled image/png, when uploaded, then MIME_MISMATCH is returned.'],
          verify: 'automated'
        }
      ],
      probe: ['Upload a valid PNG header and a spoofed HTML buffer and assert only the PNG is stored.'],
      rollback: 'Route uploads to read-only maintenance error while preserving existing keys.'
    },
    starter: {
      'src/index.mjs': `export function createUploadStore() {
  const stored = new Map();
  return {
    accept({ filename, mime, bytes }) {
      stored.set(filename, { mime, size: bytes.length });
      return { ok: true, key: filename };
    },
    count: () => stored.size
  };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadStore } from '../src/index.mjs';

test('valid png upload succeeds', () => {
  const s = createUploadStore();
  const res = s.accept({ filename: 'shot.png', mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]) });
  assert.equal(res.ok, true);
});\n`
    },
    naive: {
      'src/index.mjs': `export function createUploadStore({ maxBytes = 1024 * 1024 } = {}) {
  const stored = new Map();
  return {
    accept({ filename, mime, bytes }, correlationId = 'req-0') {
      if (bytes.length > maxBytes) return { ok: false, error: { code: 'FILE_TOO_LARGE', correlationId } };
      if (!['image/png', 'application/pdf'].includes(mime)) return { ok: false, error: { code: 'MIME_MISMATCH', correlationId } };
      stored.set(filename, { mime, size: bytes.length });
      return { ok: true, key: filename, correlationId };
    },
    count: () => stored.size
  };
}\n`
    },
    reference: {
      'src/index.mjs': `const MAGIC = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d]
};

export function createUploadStore({ maxBytes = 1024 * 1024 } = {}) {
  const stored = new Map();
  let seq = 0;

  return {
    accept({ filename, mime, bytes }, correlationId = 'req-0') {
      if (!filename || /(?:\\.\\.|[\\/\\\\])/.test(filename)) {
        return { ok: false, error: { code: 'INVALID_FILENAME', correlationId } };
      }
      if (!bytes || bytes.length === 0 || bytes.length > maxBytes) {
        return { ok: false, error: { code: 'FILE_TOO_LARGE', correlationId } };
      }
      const sig = MAGIC[mime];
      if (!sig || bytes.length < sig.length || sig.some((b, i) => bytes[i] !== b)) {
        return { ok: false, error: { code: 'MIME_MISMATCH', correlationId } };
      }
      const ext = mime === 'image/png' ? 'png' : 'pdf';
      const key = \`obj-\${++seq}.\${ext}\`;
      stored.set(key, { originalName: filename, mime, size: bytes.length });
      return { ok: true, key, correlationId };
    },
    count: () => stored.size
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createUploadStore({ maxBytes = 1024 * 1024 } = {}) {
  const stored = new Map();
  let seq = 0;
  return {
    accept({ filename, mime, bytes }, correlationId = 'req-0') {
      if (!filename || filename.includes('..')) return { ok: false, error: { code: 'INVALID_FILENAME', correlationId } };
      if (!bytes || bytes.length > maxBytes) return { ok: false, error: { code: 'FILE_TOO_LARGE', correlationId } };
      if (!['image/png', 'application/pdf'].includes(mime)) return { ok: false, error: { code: 'MIME_MISMATCH', correlationId } };
      const key = \`obj-\${++seq}\`;
      stored.set(key, { mime, size: bytes.length });
      return { ok: true, key, correlationId };
    },
    count: () => stored.size
  };
}\n`
    },
    async oracle(mod) {
      const s = mod.createUploadStore({ maxBytes: 100 });
      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
      assert.equal(s.accept({ filename: 'doc.pdf', mime: 'application/pdf', bytes: pdf }, 'c1').ok, true);
      const huge = new Uint8Array(200);
      assert.equal(s.accept({ filename: 'big.pdf', mime: 'application/pdf', bytes: huge }, 'c2').ok, false);
    },
    defectProbes: [
      {
        id: 'spoofed-script-with-png-mime-or-traversal-accepted',
        async check(mod) {
          const s = mod.createUploadStore();
          const html = new TextEncoder().encode('<script>alert(1)</script>');
          const spoof = s.accept({ filename: 'x.png', mime: 'image/png', bytes: html }, 'c1');
          assert.equal(spoof.ok, false);
          assert.equal(spoof.error.code, 'MIME_MISMATCH');
          const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
          const trav = s.accept({ filename: '../../etc/passwd', mime: 'image/png', bytes: png }, 'c2');
          assert.equal(trav.ok, false);
          assert.equal(trav.error.code, 'INVALID_FILENAME');
        }
      }
    ]
  },
  {
    id: 'bf-12-agent-tool-guard',
    category: 'brownfield',
    title: 'Support agent tool dispatcher allowlist and destructive confirmation gate',
    ticket:
      'Existing `createToolDispatcher(tools)` in `src/index.mjs` invokes `dispatch({ tool, args, confirmed, correlationId })`. Harden it: reject tools not declared in `tools` (`TOOL_NOT_ALLOWED`); validate `args` against `toolDef.requiredArgs` (`INVALID_TOOL_ARGS`); if `toolDef.destructive === true` and `confirmed !== true`, refuse execution without calling `run` and return `{ ok: false, error: { code: "CONFIRMATION_REQUIRED", correlationId } }`.',
    profile: {
      name: 'support-assistant',
      idea: 'A customer-support AI agent that reads tickets and invokes internal account tools safely.',
      kind: 'agent',
      stage: 'production',
      traits: ['ai', 'auth'],
      risks: { pii: true, destructiveWrites: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    change: {
      id: 'add-tool-guardrails',
      title: 'Gate agent tool execution with allowlist and confirmation',
      why: 'Prompt-injected ticket text could trick the model into invoking destructive actions.',
      risk: 'high',
      add: [
        {
          key: 'agent.tool-confirmation',
          title: 'Allowlist and destructive-tool confirmation',
          area: 'security',
          statement: 'When the agent dispatches a tool call, the dispatcher shall verify the tool is allowlisted, check required arguments and block unconfirmed destructive tools.',
          failurePath: 'Unconfirmed destructive calls return CONFIRMATION_REQUIRED before invoking the underlying handler.',
          acceptance: ['Given a destructive deleteAccount tool, when dispatched with confirmed false, then handler does not run.'],
          verify: 'automated'
        }
      ],
      probe: ['Dispatch an unconfirmed destructive call and assert side-effect counter stays zero.'],
      rollback: 'Restrict tools registry to read-only lookup tools.'
    },
    starter: {
      'src/index.mjs': `export function createToolDispatcher(tools) {
  return {
    async dispatch({ tool, args }) {
      const out = await tools[tool].run(args);
      return { ok: true, result: out };
    }
  };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolDispatcher } from '../src/index.mjs';

test('read-only lookup tool executes', async () => {
  const d = createToolDispatcher({
    lookupOrder: { destructive: false, requiredArgs: ['orderId'], run: async ({ orderId }) => ({ orderId }) }
  });
  const res = await d.dispatch({ tool: 'lookupOrder', args: { orderId: 'o1' } });
  assert.equal(res.ok, true);
});\n`
    },
    naive: {
      'src/index.mjs': `export function createToolDispatcher(tools) {
  return {
    async dispatch({ tool, args, correlationId = 'req-0' }) {
      if (!tools[tool]) return { ok: false, error: { code: 'TOOL_NOT_ALLOWED', correlationId } };
      const out = await tools[tool].run(args ?? {});
      return { ok: true, result: out, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createToolDispatcher(tools) {
  return {
    async dispatch({ tool, args = {}, confirmed = false, correlationId = 'req-0' }) {
      if (!Object.prototype.hasOwnProperty.call(tools, tool)) {
        return { ok: false, error: { code: 'TOOL_NOT_ALLOWED', correlationId } };
      }
      const def = tools[tool];
      const missing = (def.requiredArgs ?? []).filter(
        (key) => !Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined || args[key] === null || args[key] === ''
      );
      if (missing.length > 0) {
        return { ok: false, error: { code: 'INVALID_TOOL_ARGS', missing, correlationId } };
      }
      if (def.destructive === true && confirmed !== true) {
        return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', correlationId } };
      }
      const out = await def.run(args);
      return { ok: true, result: out, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createToolDispatcher(tools) {
  return {
    async dispatch({ tool, args = {}, correlationId = 'req-0' }) {
      if (!Object.prototype.hasOwnProperty.call(tools, tool)) {
        return { ok: false, error: { code: 'TOOL_NOT_ALLOWED', correlationId } };
      }
      const def = tools[tool];
      if ((def.requiredArgs ?? []).some((k) => args[k] === undefined)) {
        return { ok: false, error: { code: 'INVALID_TOOL_ARGS', correlationId } };
      }
      const out = await def.run(args);
      return { ok: true, result: out, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      let deleted = 0;
      const d = mod.createToolDispatcher({
        getTicket: { destructive: false, requiredArgs: ['id'], run: async ({ id }) => ({ id }) },
        wipeAccount: { destructive: true, requiredArgs: ['userId'], run: async () => { deleted += 1; return true; } }
      });
      assert.equal((await d.dispatch({ tool: 'unknownTool', args: {}, correlationId: 'c1' })).error.code, 'TOOL_NOT_ALLOWED');
      assert.equal((await d.dispatch({ tool: 'wipeAccount', args: { userId: 'u1' }, confirmed: true, correlationId: 'c2' })).ok, true);
      assert.equal(deleted, 1);
    },
    defectProbes: [
      {
        id: 'unconfirmed-destructive-tool-or-prototype-bypass',
        async check(mod) {
          let sideEffects = 0;
          const d = mod.createToolDispatcher({
            wipeAccount: { destructive: true, requiredArgs: ['userId'], run: async () => { sideEffects += 1; } }
          });
          const unconfirmed = await d.dispatch({ tool: 'wipeAccount', args: { userId: 'u1' }, confirmed: false, correlationId: 'c1' });
          assert.equal(unconfirmed.ok, false);
          assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
          assert.equal(sideEffects, 0, 'destructive tool executed without confirmation');
          const proto = await d.dispatch({ tool: 'toString', args: {}, correlationId: 'c2' });
          assert.equal(proto.ok, false);
        }
      }
    ]
  }
];
