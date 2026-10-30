import assert from 'node:assert/strict';

export const GREENFIELD_TASKS = [
  {
    id: 'gf-01-payout-ledger',
    category: 'greenfield',
    title: 'Idempotent seller payout ledger',
    ticket:
      'Implement `createLedger()` in `src/index.mjs` with `credit(sellerId, cents)` and `payout(sellerId, cents, idempotencyKey, correlationId)`. Balances are integer cents. Replaying the same `idempotencyKey` for the same seller and amount must return the original receipt without deducting twice; reusing a key with a different amount or seller must return `{ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", correlationId } }`. Reject non-positive or non-integer amounts (`INVALID_AMOUNT`) and insufficient balance (`INSUFFICIENT_FUNDS`).',
    profile: {
      name: 'payout-ledger',
      idea: 'An API that credits marketplace sellers and executes payouts with idempotency keys so retries never pay twice.',
      kind: 'api',
      stage: 'production',
      traits: ['auth', 'payments', 'persistence'],
      risks: { payments: true, regulated: true, multiTenant: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createLedger() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createLedger() {
  const balances = new Map();
  return {
    balance(sellerId) { return balances.get(sellerId) ?? 0; },
    credit(sellerId, cents) {
      balances.set(sellerId, (balances.get(sellerId) ?? 0) + cents);
      return { ok: true, balance: balances.get(sellerId) };
    },
    payout(sellerId, cents, idempotencyKey, correlationId = 'req-0') {
      const current = balances.get(sellerId) ?? 0;
      if (current < cents) return { ok: false, error: { code: 'INSUFFICIENT_FUNDS', correlationId } };
      balances.set(sellerId, current - cents);
      return { ok: true, txId: \`tx-\${idempotencyKey}\`, amount: cents, balance: current - cents, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createLedger() {
  const balances = new Map();
  const seenKeys = new Map();

  function validCents(cents) {
    return Number.isInteger(cents) && cents > 0;
  }

  return {
    balance(sellerId) {
      return balances.get(sellerId) ?? 0;
    },
    credit(sellerId, cents, correlationId = 'req-0') {
      if (!sellerId || !validCents(cents)) {
        return { ok: false, error: { code: 'INVALID_AMOUNT', correlationId } };
      }
      const next = (balances.get(sellerId) ?? 0) + cents;
      balances.set(sellerId, next);
      return { ok: true, balance: next, correlationId };
    },
    payout(sellerId, cents, idempotencyKey, correlationId = 'req-0') {
      if (!sellerId || !validCents(cents) || !idempotencyKey) {
        return { ok: false, error: { code: 'INVALID_AMOUNT', correlationId } };
      }
      if (seenKeys.has(idempotencyKey)) {
        const prior = seenKeys.get(idempotencyKey);
        if (prior.sellerId !== sellerId || prior.cents !== cents) {
          return { ok: false, error: { code: 'IDEMPOTENCY_CONFLICT', correlationId } };
        }
        return prior.receipt;
      }
      const current = balances.get(sellerId) ?? 0;
      if (current < cents) {
        return { ok: false, error: { code: 'INSUFFICIENT_FUNDS', correlationId } };
      }
      const next = current - cents;
      balances.set(sellerId, next);
      const receipt = { ok: true, txId: \`tx-\${seenKeys.size + 1}\`, amount: cents, balance: next, correlationId };
      seenKeys.set(idempotencyKey, { sellerId, cents, receipt });
      return receipt;
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createLedger() {
  const balances = new Map();
  const seenKeys = new Map();
  return {
    balance(sellerId) { return balances.get(sellerId) ?? 0; },
    credit(sellerId, cents, correlationId = 'req-0') {
      if (!Number.isInteger(cents) || cents > 0 === false) return { ok: false, error: { code: 'INVALID_AMOUNT', correlationId } };
      balances.set(sellerId, (balances.get(sellerId) ?? 0) + cents);
      return { ok: true, balance: balances.get(sellerId), correlationId };
    },
    payout(sellerId, cents, idempotencyKey, correlationId = 'req-0') {
      if (!Number.isInteger(cents) || cents <= 0) return { ok: false, error: { code: 'INVALID_AMOUNT', correlationId } };
      if (seenKeys.has(idempotencyKey)) return seenKeys.get(idempotencyKey).receipt;
      const current = balances.get(sellerId) ?? 0;
      if (current < cents) return { ok: false, error: { code: 'INSUFFICIENT_FUNDS', correlationId } };
      balances.set(sellerId, current - cents);
      const receipt = { ok: true, txId: \`tx-\${seenKeys.size + 1}\`, amount: cents, balance: current - cents, correlationId };
      seenKeys.set(idempotencyKey, { sellerId, cents, receipt });
      return receipt;
    }
  };
}\n`
    },
    async oracle(mod) {
      const ledger = mod.createLedger();
      ledger.credit('s1', 5000);
      const r1 = ledger.payout('s1', 2000, 'k1', 'corr-1');
      assert.equal(r1.ok, true);
      assert.equal(ledger.balance('s1'), 3000);
      const over = ledger.payout('s1', 4000, 'k2', 'corr-2');
      assert.equal(over.ok, false);
      assert.equal(over.error.code, 'INSUFFICIENT_FUNDS');
    },
    defectProbes: [
      {
        id: 'double-debit-on-retry',
        async check(mod) {
          const ledger = mod.createLedger();
          ledger.credit('s1', 5000);
          const first = ledger.payout('s1', 2000, 'dup-key', 'c1');
          const second = ledger.payout('s1', 2000, 'dup-key', 'c1');
          assert.equal(first.txId, second.txId);
          assert.equal(ledger.balance('s1'), 3000, 'retry deducted twice');
        }
      },
      {
        id: 'idempotency-key-parameter-mismatch',
        async check(mod) {
          const ledger = mod.createLedger();
          ledger.credit('s1', 5000);
          ledger.payout('s1', 1000, 'same-key', 'c1');
          const conflict = ledger.payout('s1', 2500, 'same-key', 'c2');
          assert.equal(conflict.ok, false);
          assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
        }
      },
      {
        id: 'negative-or-float-payout',
        async check(mod) {
          const ledger = mod.createLedger();
          ledger.credit('s1', 1000);
          assert.equal(ledger.payout('s1', -500, 'neg', 'c3').ok, false);
          assert.equal(ledger.payout('s1', 12.5, 'flt', 'c4').ok, false);
          assert.equal(ledger.balance('s1'), 1000);
        }
      }
    ]
  },
  {
    id: 'gf-02-tenant-notes',
    category: 'greenfield',
    title: 'Multi-tenant team notes store with deny-by-default reads',
    ticket:
      'Implement `createNotesStore()` in `src/index.mjs` with `create(actor, { title, body })`, `read(actor, noteId, correlationId)`, and `remove(actor, noteId, correlationId)`. `actor` has `{ userId, tenantId, role }` (`"member"` or `"admin"`). Cross-tenant reads or deletes must fail with `{ ok: false, error: { code: "NOT_FOUND", correlationId } }` so note IDs do not leak across tenants. Within a tenant, only the author or `"admin"` may `remove` (`FORBIDDEN` otherwise).',
    profile: {
      name: 'tenant-notes',
      idea: 'A multi-tenant workspace notes service where teams store internal notes and tenants can never read or probe each other.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'persistence'],
      risks: { pii: true, multiTenant: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createNotesStore() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createNotesStore() {
  const notes = new Map();
  let seq = 0;
  return {
    create(actor, { title, body }) {
      const id = \`note-\${++seq}\`;
      const note = { id, tenantId: actor.tenantId, authorId: actor.userId, title, body };
      notes.set(id, note);
      return { ok: true, note };
    },
    read(_actor, noteId, correlationId = 'req-0') {
      const note = notes.get(noteId);
      if (!note) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      return { ok: true, note };
    },
    remove(_actor, noteId, correlationId = 'req-0') {
      if (!notes.has(noteId)) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      notes.delete(noteId);
      return { ok: true };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createNotesStore() {
  const notes = new Map();
  let seq = 0;
  return {
    create(actor, { title, body } = {}, correlationId = 'req-0') {
      if (!actor?.tenantId || !actor?.userId || !title) {
        return { ok: false, error: { code: 'INVALID_INPUT', correlationId } };
      }
      const id = \`note-\${++seq}\`;
      const note = { id, tenantId: actor.tenantId, authorId: actor.userId, title: String(title), body: String(body ?? '') };
      notes.set(id, note);
      return { ok: true, note: { ...note }, correlationId };
    },
    read(actor, noteId, correlationId = 'req-0') {
      const note = notes.get(noteId);
      if (!note || !actor?.tenantId || note.tenantId !== actor.tenantId) {
        return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      }
      return { ok: true, note: { ...note }, correlationId };
    },
    remove(actor, noteId, correlationId = 'req-0') {
      const note = notes.get(noteId);
      if (!note || !actor?.tenantId || note.tenantId !== actor.tenantId) {
        return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      }
      if (note.authorId !== actor.userId && actor.role !== 'admin') {
        return { ok: false, error: { code: 'FORBIDDEN', correlationId } };
      }
      notes.delete(noteId);
      return { ok: true, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createNotesStore() {
  const notes = new Map();
  let seq = 0;
  return {
    create(actor, { title, body } = {}, correlationId = 'req-0') {
      const id = \`note-\${++seq}\`;
      const note = { id, tenantId: actor.tenantId, authorId: actor.userId, title, body: body ?? '' };
      notes.set(id, note);
      return { ok: true, note, correlationId };
    },
    read(actor, noteId, correlationId = 'req-0') {
      const note = notes.get(noteId);
      if (!note || note.tenantId !== actor.tenantId) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      return { ok: true, note, correlationId };
    },
    remove(actor, noteId, correlationId = 'req-0') {
      const note = notes.get(noteId);
      if (!note || note.tenantId !== actor.tenantId) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      notes.delete(noteId);
      return { ok: true, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const store = mod.createNotesStore();
      const alice = { userId: 'u1', tenantId: 't1', role: 'member' };
      const created = store.create(alice, { title: 'Retro', body: 'Ship small' });
      assert.equal(created.ok, true);
      const got = store.read(alice, created.note.id, 'c1');
      assert.equal(got.ok, true);
      assert.equal(got.note.title, 'Retro');
    },
    defectProbes: [
      {
        id: 'cross-tenant-idor-read',
        async check(mod) {
          const store = mod.createNotesStore();
          const created = store.create({ userId: 'u1', tenantId: 't1', role: 'member' }, { title: 'Secret', body: 'Plan' });
          const leak = store.read({ userId: 'u9', tenantId: 't2', role: 'admin' }, created.note.id, 'c2');
          assert.equal(leak.ok, false);
          assert.equal(leak.error.code, 'NOT_FOUND');
        }
      },
      {
        id: 'same-tenant-non-owner-delete',
        async check(mod) {
          const store = mod.createNotesStore();
          const created = store.create({ userId: 'u1', tenantId: 't1', role: 'member' }, { title: 'Keep', body: 'x' });
          const denied = store.remove({ userId: 'u2', tenantId: 't1', role: 'member' }, created.note.id, 'c3');
          assert.equal(denied.ok, false);
          assert.equal(denied.error.code, 'FORBIDDEN');
        }
      }
    ]
  },
  {
    id: 'gf-03-webhook-ingest',
    category: 'greenfield',
    title: 'Signed webhook receiver with replay window and dead-letter queue',
    ticket:
      'Implement `createWebhookReceiver({ secret, toleranceMs = 300_000 })` in `src/index.mjs` with `sign(timestampMs, rawBody)` (HMAC-SHA256 hex over `${timestampMs}.${rawBody}`), `receive({ eventId, timestampMs, rawBody, signature, nowMs, correlationId })`, and `deadLetters()`. Reject bad signatures (`INVALID_SIGNATURE`) and timestamps outside `toleranceMs` (`STALE_TIMESTAMP`). Deduplicate repeated `eventId` values (`{ ok: true, duplicate: true }`). Route malformed JSON payloads with valid signatures into `deadLetters()` and return `{ ok: false, error: { code: "DEAD_LETTERED", correlationId } }`.',
    profile: {
      name: 'webhook-ingest',
      idea: 'An API endpoint that receives signed third-party billing webhooks, rejects replays, deduplicates events and isolates poison payloads.',
      kind: 'api',
      stage: 'mvp',
      traits: ['webhooks', 'persistence'],
      risks: { integrations: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createWebhookReceiver() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `import { createHmac } from 'node:crypto';
export function createWebhookReceiver({ secret }) {
  const dead = [];
  const sign = (ts, body) => createHmac('sha256', secret).update(\`\${ts}.\${body}\`).digest('hex');
  return {
    sign,
    deadLetters: () => dead,
    receive({ timestampMs, rawBody, signature, correlationId = 'req-0' }) {
      if (sign(timestampMs, rawBody) !== signature) return { ok: false, error: { code: 'INVALID_SIGNATURE', correlationId } };
      const parsed = JSON.parse(rawBody);
      return { ok: true, duplicate: false, event: parsed, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `import { createHmac, timingSafeEqual } from 'node:crypto';

export function createWebhookReceiver({ secret, toleranceMs = 300_000 }) {
  const processed = new Set();
  const dead = [];
  const sign = (ts, body) => createHmac('sha256', secret).update(\`\${ts}.\${body}\`).digest('hex');

  function validSig(expected, actual) {
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(actual ?? ''));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  return {
    sign,
    deadLetters: () => [...dead],
    receive({ eventId, timestampMs, rawBody, signature, nowMs = Date.now(), correlationId = 'req-0' }) {
      if (!validSig(sign(timestampMs, rawBody), signature)) {
        return { ok: false, error: { code: 'INVALID_SIGNATURE', correlationId } };
      }
      if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > toleranceMs) {
        return { ok: false, error: { code: 'STALE_TIMESTAMP', correlationId } };
      }
      if (processed.has(eventId)) {
        return { ok: true, duplicate: true, correlationId };
      }
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        dead.push({ eventId, rawBody, correlationId });
        return { ok: false, error: { code: 'DEAD_LETTERED', correlationId } };
      }
      processed.add(eventId);
      return { ok: true, duplicate: false, event: parsed, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `import { createHmac } from 'node:crypto';
export function createWebhookReceiver({ secret }) {
  const processed = new Set();
  const dead = [];
  const sign = (ts, body) => createHmac('sha256', secret).update(\`\${ts}.\${body}\`).digest('hex');
  return {
    sign,
    deadLetters: () => [...dead],
    receive({ eventId, timestampMs, rawBody, signature, correlationId = 'req-0' }) {
      if (sign(timestampMs, rawBody) !== signature) return { ok: false, error: { code: 'INVALID_SIGNATURE', correlationId } };
      if (processed.has(eventId)) return { ok: true, duplicate: true, correlationId };
      try {
        const event = JSON.parse(rawBody);
        processed.add(eventId);
        return { ok: true, duplicate: false, event, correlationId };
      } catch {
        dead.push({ eventId, rawBody, correlationId });
        return { ok: false, error: { code: 'DEAD_LETTERED', correlationId } };
      }
    }
  };
}\n`
    },
    async oracle(mod) {
      const rx = mod.createWebhookReceiver({ secret: 'whsec-demo', toleranceMs: 60_000 });
      const body = JSON.stringify({ type: 'invoice.paid' });
      const sig = rx.sign(1000, body);
      const ok = rx.receive({ eventId: 'ev-1', timestampMs: 1000, rawBody: body, signature: sig, nowMs: 1500, correlationId: 'c1' });
      assert.equal(ok.ok, true);
      const bad = rx.receive({ eventId: 'ev-2', timestampMs: 1000, rawBody: body, signature: 'wrong', nowMs: 1500, correlationId: 'c2' });
      assert.equal(bad.ok, false);
      assert.equal(bad.error.code, 'INVALID_SIGNATURE');
    },
    defectProbes: [
      {
        id: 'replay-outside-window-accepted',
        async check(mod) {
          const rx = mod.createWebhookReceiver({ secret: 'whsec-demo', toleranceMs: 60_000 });
          const body = '{"ok":1}';
          const sig = rx.sign(1000, body);
          const stale = rx.receive({ eventId: 'ev-old', timestampMs: 1000, rawBody: body, signature: sig, nowMs: 500_000, correlationId: 'c3' });
          assert.equal(stale.ok, false);
          assert.equal(stale.error.code, 'STALE_TIMESTAMP');
        }
      },
      {
        id: 'duplicate-or-poison-unhandled',
        async check(mod) {
          const rx = mod.createWebhookReceiver({ secret: 'whsec-demo', toleranceMs: 60_000 });
          const body = '{"ok":1}';
          const sig = rx.sign(1000, body);
          rx.receive({ eventId: 'ev-dup', timestampMs: 1000, rawBody: body, signature: sig, nowMs: 1200 });
          const dup = rx.receive({ eventId: 'ev-dup', timestampMs: 1000, rawBody: body, signature: sig, nowMs: 1300 });
          assert.equal(dup.duplicate, true);
          const badSig = rx.sign(1000, '{broken-json');
          const dead = rx.receive({ eventId: 'ev-bad', timestampMs: 1000, rawBody: '{broken-json', signature: badSig, nowMs: 1200 });
          assert.equal(dead.ok, false);
          assert.equal(rx.deadLetters().length, 1);
        }
      }
    ]
  },
  {
    id: 'gf-04-booking-holds',
    category: 'greenfield',
    title: 'Appointment slot booking with expiring holds',
    ticket:
      'Implement `createSlotScheduler({ holdTtlMs = 300_000 })` in `src/index.mjs` with `hold(slotId, patientId, nowMs, correlationId)` and `confirm(holdId, patientId, nowMs, correlationId)`. A slot cannot be held or confirmed by another patient while an unexpired hold or confirmed booking exists (`SLOT_TAKEN`), but once `nowMs >= expiresAt` an unconfirmed hold releases automatically so another patient can book it. Confirming an expired hold returns `HOLD_EXPIRED`.',
    profile: {
      name: 'booking-holds',
      idea: 'A physiotherapy appointment booking app where patients place short holds on therapist slots and confirm without double-booking.',
      kind: 'web-app',
      stage: 'mvp',
      traits: ['auth', 'persistence'],
      risks: { pii: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createSlotScheduler() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createSlotScheduler({ holdTtlMs = 300_000 } = {}) {
  const slots = new Map();
  let seq = 0;
  return {
    hold(slotId, patientId, nowMs = Date.now(), correlationId = 'req-0') {
      if (slots.has(slotId)) return { ok: false, error: { code: 'SLOT_TAKEN', correlationId } };
      const holdId = \`hold-\${++seq}\`;
      slots.set(slotId, { holdId, patientId, expiresAt: nowMs + holdTtlMs, confirmed: false });
      return { ok: true, holdId, expiresAt: nowMs + holdTtlMs, correlationId };
    },
    confirm(holdId, patientId, _nowMs = Date.now(), correlationId = 'req-0') {
      for (const [, entry] of slots) {
        if (entry.holdId === holdId && entry.patientId === patientId) {
          entry.confirmed = true;
          return { ok: true, correlationId };
        }
      }
      return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createSlotScheduler({ holdTtlMs = 300_000 } = {}) {
  const slots = new Map();
  const holds = new Map();
  let seq = 0;

  return {
    hold(slotId, patientId, nowMs = Date.now(), correlationId = 'req-0') {
      const current = slots.get(slotId);
      if (current && (current.confirmed || nowMs < current.expiresAt)) {
        return { ok: false, error: { code: 'SLOT_TAKEN', correlationId } };
      }
      const holdId = \`hold-\${++seq}\`;
      const record = { holdId, slotId, patientId, expiresAt: nowMs + holdTtlMs, confirmed: false };
      slots.set(slotId, record);
      holds.set(holdId, record);
      return { ok: true, holdId, expiresAt: record.expiresAt, correlationId };
    },
    confirm(holdId, patientId, nowMs = Date.now(), correlationId = 'req-0') {
      const record = holds.get(holdId);
      if (!record || record.patientId !== patientId) {
        return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      }
      if ( slots.get(record.slotId) !== record || (!record.confirmed && nowMs >= record.expiresAt) ) {
        return { ok: false, error: { code: 'HOLD_EXPIRED', correlationId } };
      }
      record.confirmed = true;
      return { ok: true, slotId: record.slotId, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createSlotScheduler({ holdTtlMs = 300_000 } = {}) {
  const slots = new Map();
  const holds = new Map();
  let seq = 0;
  return {
    hold(slotId, patientId, nowMs = Date.now(), correlationId = 'req-0') {
      const current = slots.get(slotId);
      if (current && current.confirmed) return { ok: false, error: { code: 'SLOT_TAKEN', correlationId } };
      const holdId = \`hold-\${++seq}\`;
      const record = { holdId, slotId, patientId, expiresAt: nowMs + holdTtlMs, confirmed: false };
      slots.set(slotId, record);
      holds.set(holdId, record);
      return { ok: true, holdId, expiresAt: record.expiresAt, correlationId };
    },
    confirm(holdId, patientId, _nowMs = Date.now(), correlationId = 'req-0') {
      const record = holds.get(holdId);
      if (!record || record.patientId !== patientId) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      record.confirmed = true;
      return { ok: true, slotId: record.slotId, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const sched = mod.createSlotScheduler({ holdTtlMs: 1000 });
      const h1 = sched.hold('09:00', 'p1', 100);
      assert.equal(h1.ok, true);
      const conflict = sched.hold('09:00', 'p2', 500);
      assert.equal(conflict.ok, false);
      assert.equal(sched.confirm(h1.holdId, 'p1', 600).ok, true);
    },
    defectProbes: [
      {
        id: 'expired-hold-permanently-locks-slot',
        async check(mod) {
          const sched = mod.createSlotScheduler({ holdTtlMs: 1000 });
          const first = sched.hold('10:00', 'p1', 100);
          const second = sched.hold('10:00', 'p2', 1200);
          assert.equal(second.ok, true, 'expired hold was not released');
          const lateConfirm = sched.confirm(first.holdId, 'p1', 1300);
          assert.equal(lateConfirm.ok, false);
          assert.equal(lateConfirm.error.code, 'HOLD_EXPIRED');
        }
      }
    ]
  },
  {
    id: 'gf-05-account-erasure',
    category: 'greenfield',
    title: 'GDPR user export and complete cross-table erasure',
    ticket:
      'Implement `createDirectory()` in `src/index.mjs` with `register(userId, profile)`, `addSession(userId, token)`, `addDocument(userId, doc)`, `exportUser(userId, correlationId)`, and `eraseUser(userId, correlationId)`. `eraseUser` must delete the profile, every session and every owned document for `userId` without touching other users, record an anonymised audit tombstone `{ erasedAt: true }` without PII, and make subsequent `exportUser(userId)` return `NOT_FOUND`.',
    profile: {
      name: 'account-erasure',
      idea: 'A customer account directory storing personal profiles, active sessions and uploaded documents with self-serve export and erasure.',
      kind: 'api',
      stage: 'production',
      traits: ['auth', 'persistence'],
      risks: { pii: true, regulated: true, destructiveWrites: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createDirectory() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createDirectory() {
  const users = new Map();
  const sessions = [];
  const documents = [];
  return {
    register(userId, profile) { users.set(userId, profile); },
    addSession(userId, token) { sessions.push({ userId, token }); },
    addDocument(userId, doc) { documents.push({ userId, doc }); },
    exportUser(userId, correlationId = 'req-0') {
      if (!users.has(userId)) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      return { ok: true, profile: users.get(userId), documents: documents.filter((d) => d.userId === userId) };
    },
    eraseUser(userId) {
      users.delete(userId);
      return { ok: true };
    },
    _sessions: () => sessions,
    _documents: () => documents,
    _audit: () => []
  };
}\n`
    },
    reference: {
      'src/index.mjs': `import { createHash } from 'node:crypto';

export function createDirectory() {
  const users = new Map();
  let sessions = [];
  let documents = [];
  const audit = [];

  return {
    register(userId, profile) {
      users.set(userId, { ...profile });
    },
    addSession(userId, token) {
      sessions.push({ userId, token });
    },
    addDocument(userId, doc) {
      documents.push({ userId, doc });
    },
    exportUser(userId, correlationId = 'req-0') {
      if (!users.has(userId)) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      return {
        ok: true,
        profile: { ...users.get(userId) },
        sessions: sessions.filter((s) => s.userId === userId).map((s) => s.token),
        documents: documents.filter((d) => d.userId === userId).map((d) => d.doc),
        correlationId
      };
    },
    eraseUser(userId, correlationId = 'req-0') {
      if (!users.has(userId)) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      users.delete(userId);
      sessions = sessions.filter((s) => s.userId !== userId);
      documents = documents.filter((d) => d.userId !== userId);
      const subjectHash = createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
      audit.push({ subjectHash, erasedAt: true, correlationId });
      return { ok: true, subjectHash, correlationId };
    },
    _sessions: () => [...sessions],
    _documents: () => [...documents],
    _audit: () => [...audit]
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createDirectory() {
  const users = new Map();
  const sessions = [];
  let documents = [];
  const audit = [];
  return {
    register(userId, profile) { users.set(userId, { ...profile }); },
    addSession(userId, token) { sessions.push({ userId, token }); },
    addDocument(userId, doc) { documents.push({ userId, doc }); },
    exportUser(userId, correlationId = 'req-0') {
      if (!users.has(userId)) return { ok: false, error: { code: 'NOT_FOUND', correlationId } };
      return { ok: true, profile: users.get(userId), documents: documents.filter((d) => d.userId === userId).map((d) => d.doc), correlationId };
    },
    eraseUser(userId, correlationId = 'req-0') {
      users.delete(userId);
      documents = documents.filter((d) => d.userId !== userId);
      audit.push({ userId, erasedAt: true, correlationId });
      return { ok: true, correlationId };
    },
    _sessions: () => sessions,
    _documents: () => documents,
    _audit: () => audit
  };
}\n`
    },
    async oracle(mod) {
      const dir = mod.createDirectory();
      dir.register('u1', { email: 'a@example.com' });
      dir.addDocument('u1', 'tax.pdf');
      const exp = dir.exportUser('u1', 'c1');
      assert.equal(exp.ok, true);
      dir.eraseUser('u1', 'c2');
      assert.equal(dir.exportUser('u1', 'c3').ok, false);
    },
    defectProbes: [
      {
        id: 'orphaned-sessions-or-documents-after-erasure',
        async check(mod) {
          const dir = mod.createDirectory();
          dir.register('u1', { email: 'alice@example.com' });
          dir.register('u2', { email: 'bob@example.com' });
          dir.addSession('u1', 'sess-1');
          dir.addDocument('u1', 'passport.png');
          dir.addDocument('u2', 'keep.png');
          dir.eraseUser('u1', 'c1');
          assert.equal(dir._sessions().filter((s) => s.userId === 'u1').length, 0, 'sessions survived erasure');
          assert.equal(dir._documents().filter((d) => d.userId === 'u1').length, 0, 'documents survived erasure');
          assert.equal(dir._documents().filter((d) => d.userId === 'u2').length, 1, 'erasure deleted neighbour user data');
          assert.ok(!JSON.stringify(dir._audit()).includes('alice@example.com'), 'PII leaked into audit tombstone');
        }
      }
    ]
  },
  {
    id: 'gf-06-rate-limiter',
    category: 'greenfield',
    title: 'Per-key sliding-window rate limiter with structured retry envelope',
    ticket:
      'Implement `createRateLimiter({ limit, windowMs })` in `src/index.mjs` with `check(key, nowMs, correlationId)`. Allow at most `limit` calls per `key` inside `(nowMs - windowMs, nowMs]`. Denied calls must not consume quota and must return `{ allowed: false, error: { code: "RATE_LIMITED", retryAfterMs, correlationId } }` where `retryAfterMs > 0` equals the exact milliseconds until the oldest active timestamp expires.',
    profile: {
      name: 'edge-rate-limiter',
      idea: 'A public API gateway guard that rate-limits callers per key and returns deterministic retry-after envelopes.',
      kind: 'api',
      stage: 'mvp',
      traits: ['auth'],
      risks: { publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createRateLimiter() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    check(key, nowMs = Date.now(), correlationId = 'req-0') {
      const list = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
      list.push(nowMs);
      hits.set(key, list);
      if (list.length > limit) {
        return { allowed: false, error: { code: 'RATE_LIMITED', retryAfterMs: windowMs, correlationId } };
      }
      return { allowed: true, remaining: limit - list.length, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    check(key, nowMs = Date.now(), correlationId = 'req-0') {
      const active = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
      if (active.length >= limit) {
        hits.set(key, active);
        const oldest = active[0];
        const retryAfterMs = Math.max(1, windowMs - (nowMs - oldest));
        return { allowed: false, error: { code: 'RATE_LIMITED', retryAfterMs, correlationId } };
      }
      active.push(nowMs);
      hits.set(key, active);
      return { allowed: true, remaining: limit - active.length, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    check(key, nowMs = Date.now(), correlationId = 'req-0') {
      const active = (hits.get(key) ?? []).filter((t) => nowMs - t < windowMs);
      active.push(nowMs);
      hits.set(key, active);
      if (active.length > limit) {
        return { allowed: false, error: { code: 'RATE_LIMITED', retryAfterMs: windowMs, correlationId } };
      }
      return { allowed: true, remaining: limit - active.length, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const rl = mod.createRateLimiter({ limit: 2, windowMs: 1000 });
      assert.equal(rl.check('k1', 100, 'c1').allowed, true);
      assert.equal(rl.check('k1', 200, 'c2').allowed, true);
      const blocked = rl.check('k1', 300, 'c3');
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.error.code, 'RATE_LIMITED');
    },
    defectProbes: [
      {
        id: 'denied-requests-consume-sliding-window-quota',
        async check(mod) {
          const rl = mod.createRateLimiter({ limit: 2, windowMs: 1000 });
          rl.check('k1', 100, 'c1');
          rl.check('k1', 200, 'c2');
          const denied = rl.check('k1', 900, 'c3');
          assert.equal(denied.allowed, false);
          assert.equal(denied.error.retryAfterMs, 200, 'retryAfterMs must reflect oldest active request');
          const afterExpiry = rl.check('k1', 1100, 'c4');
          assert.equal(afterExpiry.allowed, true, 'denied request consumed quota and starved recovery');
        }
      }
    ]
  }
];
