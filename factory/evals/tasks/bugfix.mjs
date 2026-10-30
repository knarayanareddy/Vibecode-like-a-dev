import assert from 'node:assert/strict';

export const BUGFIX_TASKS = [
  {
    id: 'bug-13-leap-year-billing',
    category: 'bugfix',
    title: 'Fix leap-year and end-of-month subscription proration',
    ticket:
      'Fix `prorateCents(monthlyCents, year, monthIndex0, remainingDays, correlationId)` in `src/index.mjs`. Currently February is hardcoded to 28 days, overcharging leap-year subscribers on 2024/2028 cycles, and `remainingDays > daysInMonth` returns >100% of `monthlyCents`. Compute exact UTC calendar days in month (29 in leap February, including century rule: 2000 leap, 1900 not leap), clamp `0 <= remainingDays <= daysInMonth`, and round half-up to integer cents.',
    profile: {
      name: 'billing-prorator',
      idea: 'A subscription proration module calculating exact integer-cent charges across calendar month boundaries.',
      kind: 'api',
      stage: 'production',
      traits: ['payments'],
      risks: { payments: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function prorateCents(monthlyCents, _year, monthIndex0, remainingDays, correlationId = 'req-0') {
  const dim = DAYS[monthIndex0];
  return { ok: true, cents: Math.round((monthlyCents * remainingDays) / dim), daysInMonth: dim, correlationId };
}\n`
    },
    naive: {
      'src/index.mjs': `const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function prorateCents(monthlyCents, year, monthIndex0, remainingDays, correlationId = 'req-0') {
  const dim = monthIndex0 === 1 && year % 4 === 0 ? 29 : DAYS[monthIndex0];
  return { ok: true, cents: Math.round((monthlyCents * remainingDays) / dim), daysInMonth: dim, correlationId };
}\n`
    },
    reference: {
      'src/index.mjs': `export function daysInCalendarMonth(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

export function prorateCents(monthlyCents, year, monthIndex0, remainingDays, correlationId = 'req-0') {
  if (!Number.isInteger(monthlyCents) || monthlyCents < 0 || monthIndex0 < 0 || monthIndex0 > 11) {
    return { ok: false, error: { code: 'INVALID_BILLING_INPUT', correlationId } };
  }
  const dim = daysInCalendarMonth(year, monthIndex0);
  const clamped = Math.max(0, Math.min(dim, remainingDays));
  const cents = Math.floor((monthlyCents * clamped) / dim + 0.5);
  return { ok: true, cents, daysInMonth: dim, correlationId };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function prorateCents(monthlyCents, year, monthIndex0, remainingDays, correlationId = 'req-0') {
  const dim = monthIndex0 === 1 && year % 4 === 0 ? 29 : DAYS[monthIndex0];
  const clamped = Math.max(0, Math.min(dim, remainingDays));
  return { ok: true, cents: Math.round((monthlyCents * clamped) / dim), daysInMonth: dim, correlationId };
}\n`
    },
    async oracle(mod) {
      const leap = mod.prorateCents(2900, 2024, 1, 10, 'c1');
      assert.equal(leap.daysInMonth, 29);
      assert.equal(leap.cents, 1000);
    },
    defectProbes: [
      {
        id: 'century-non-leap-or-unclamped-days',
        async check(mod) {
          const nonLeapCentury = mod.prorateCents(2800, 2100, 1, 14, 'c1');
          assert.equal(nonLeapCentury.daysInMonth, 28, '2100 is not a leap year');
          const clamped = mod.prorateCents(3000, 2026, 3, 45, 'c2');
          assert.equal(clamped.cents, 3000, 'prorated charge exceeded full monthly price');
        }
      }
    ]
  },
  {
    id: 'bug-14-concurrent-coupon',
    category: 'bugfix',
    title: 'Fix single-use coupon double-redemption across async checkout',
    ticket:
      'Fix `createCouponJar(authorizeOrder)` in `src/index.mjs`. Currently `redeem(code, userId, correlationId)` checks `!used.has(code)`, awaits `authorizeOrder(userId)`, and only then marks `code` used — so two concurrent calls redeem a single-use coupon twice, and a failed `authorizeOrder` leaves a locked coupon permanently burned if locked naively. Reserve in-flight, mark redeemed on success, and release reservation if `authorizeOrder` throws or returns `{ approved: false }`.',
    profile: {
      name: 'promo-checkout',
      idea: 'A checkout promotion service redeeming single-use discount codes safely under concurrent requests.',
      kind: 'api',
      stage: 'mvp',
      traits: ['payments', 'persistence'],
      risks: { payments: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function createCouponJar(authorizeOrder) {
  const coupons = new Set(['SAVE50']);
  const used = new Set();
  return {
    async redeem(code, userId, correlationId = 'req-0') {
      if (!coupons.has(code) || used.has(code)) return { ok: false, error: { code: 'COUPON_UNAVAILABLE', correlationId } };
      const res = await authorizeOrder(userId);
      if (!res?.approved) return { ok: false, error: { code: 'ORDER_DECLINED', correlationId } };
      used.add(code);
      return { ok: true, code, userId, correlationId };
    }
  };
}\n`
    },
    naive: {
      'src/index.mjs': `export function createCouponJar(authorizeOrder) {
  const coupons = new Set(['SAVE50']);
  const used = new Set();
  return {
    async redeem(code, userId, correlationId = 'req-0') {
      if (!coupons.has(code) || used.has(code)) return { ok: false, error: { code: 'COUPON_UNAVAILABLE', correlationId } };
      used.add(code);
      const res = await authorizeOrder(userId);
      if (!res?.approved) return { ok: false, error: { code: 'ORDER_DECLINED', correlationId } };
      return { ok: true, code, userId, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createCouponJar(authorizeOrder) {
  const coupons = new Set(['SAVE50']);
  const used = new Set();
  const inFlight = new Set();

  return {
    async redeem(code, userId, correlationId = 'req-0') {
      if (!coupons.has(code) || used.has(code) || inFlight.has(code)) {
        return { ok: false, error: { code: 'COUPON_UNAVAILABLE', correlationId } };
      }
      inFlight.add(code);
      try {
        const res = await authorizeOrder(userId);
        if (!res?.approved) {
          return { ok: false, error: { code: 'ORDER_DECLINED', correlationId } };
        }
        used.add(code);
        return { ok: true, code, userId, correlationId };
      } finally {
        inFlight.delete(code);
      }
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createCouponJar(authorizeOrder) {
  const coupons = new Set(['SAVE50']);
  const used = new Set();
  return {
    async redeem(code, userId, correlationId = 'req-0') {
      if (!coupons.has(code) || used.has(code)) return { ok: false, error: { code: 'COUPON_UNAVAILABLE', correlationId } };
      used.add(code);
      const res = await authorizeOrder(userId);
      if (!res?.approved) return { ok: false, error: { code: 'ORDER_DECLINED', correlationId } };
      return { ok: true, code, userId, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const jar = mod.createCouponJar(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { approved: true };
      });
      const [a, b] = await Promise.all([jar.redeem('SAVE50', 'u1', 'c1'), jar.redeem('SAVE50', 'u2', 'c2')]);
      assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'concurrent calls both redeemed single-use coupon');
    },
    defectProbes: [
      {
        id: 'declined-or-throwing-checkout-burns-coupon',
        async check(mod) {
          let attempt = 0;
          const jar = mod.createCouponJar(async () => {
            attempt += 1;
            if (attempt === 1) return { approved: false };
            if (attempt === 2) throw new Error('gateway timeout');
            return { approved: true };
          });
          const first = await jar.redeem('SAVE50', 'u1', 'c1');
          assert.equal(first.ok, false);
          await assert.rejects(() => jar.redeem('SAVE50', 'u1', 'c2'));
          const third = await jar.redeem('SAVE50', 'u1', 'c3');
          assert.equal(third.ok, true, 'failed checkout permanently burned single-use coupon');
        }
      }
    ]
  },
  {
    id: 'bug-15-cursor-pagination',
    category: 'bugfix',
    title: 'Fix tie-breaking cursor pagination dropping same-timestamp rows',
    ticket:
      'Fix `paginateEvents(events, { limit, cursor })` in `src/index.mjs`. Currently sorting and cursor filtering only compare `createdAt`, so events sharing the same `createdAt` timestamp are skipped across pages! Sort deterministically by `(createdAt ASC, id ASC)` and encode/decode a composite cursor `${createdAt}:${id}` so paging visits every event once without gaps or duplicates.',
    profile: {
      name: 'event-feed-spike',
      idea: 'A lightweight local event-log paginator prototype for inspecting chronological activity streams.',
      kind: 'cli',
      stage: 'prototype',
      traits: [],
      risks: {},
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function paginateEvents(events, { limit = 2, cursor = null } = {}) {
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt);
  const filtered = cursor === null ? sorted : sorted.filter((e) => e.createdAt > Number(cursor));
  const items = filtered.slice(0, limit);
  const nextCursor = items.length === limit ? String(items[items.length - 1].createdAt) : null;
  return { items, nextCursor };
}\n`
    },
    naive: {
      'src/index.mjs': `export function paginateEvents(events, { limit = 2, cursor = null } = {}) {
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const filtered = cursor === null ? sorted : sorted.filter((e) => e.createdAt >= Number(cursor));
  const items = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit ? String(items[items.length - 1].createdAt) : null;
  return { items, nextCursor };
}\n`
    },
    reference: {
      'src/index.mjs': `export function paginateEvents(events, { limit = 2, cursor = null } = {}) {
  const safeLimit = Math.max(1, Number(limit) || 2);
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  let filtered = sorted;
  if (cursor !== null && cursor !== undefined) {
    const sep = String(cursor).indexOf(':');
    if (sep === -1) throw new Error('INVALID_CURSOR');
    const ts = Number(cursor.slice(0, sep));
    const lastId = cursor.slice(sep + 1);
    filtered = sorted.filter((e) => e.createdAt > ts || (e.createdAt === ts && String(e.id).localeCompare(lastId) > 0));
  }
  const items = filtered.slice(0, safeLimit);
  const hasMore = filtered.length > safeLimit;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? \`\${last.createdAt}:\${last.id}\` : null;
  return { items, nextCursor };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function paginateEvents(events, { limit = 2, cursor = null } = {}) {
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  let filtered = sorted;
  if (cursor) {
    const [ts] = String(cursor).split(':');
    filtered = sorted.filter((e) => e.createdAt > Number(ts));
  }
  const items = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit ? \`\${items[items.length - 1].createdAt}:\${items[items.length - 1].id}\` : null;
  return { items, nextCursor };
}\n`
    },
    async oracle(mod) {
      const feed = [
        { id: 'e1', createdAt: 100 },
        { id: 'e2', createdAt: 100 },
        { id: 'e3', createdAt: 100 },
        { id: 'e4', createdAt: 200 }
      ];
      const p1 = mod.paginateEvents(feed, { limit: 2 });
      const p2 = mod.paginateEvents(feed, { limit: 2, cursor: p1.nextCursor });
      const seen = [...p1.items, ...p2.items].map((e) => e.id);
      assert.deepEqual(seen, ['e1', 'e2', 'e3', 'e4']);
    },
    defectProbes: [
      {
        id: 'duplicate-items-or-trailing-cursor-on-exact-page',
        async check(mod) {
          const feed = [
            { id: 'a', createdAt: 50 },
            { id: 'b', createdAt: 50 },
            { id: 'c', createdAt: 50 },
            { id: 'd', createdAt: 50 }
          ];
          const p1 = mod.paginateEvents(feed, { limit: 2 });
          const p2 = mod.paginateEvents(feed, { limit: 2, cursor: p1.nextCursor });
          assert.deepEqual([...p1.items, ...p2.items].map((e) => e.id), ['a', 'b', 'c', 'd']);
          assert.equal(p2.nextCursor, null, 'exact final page must return null nextCursor');
        }
      }
    ]
  },
  {
    id: 'bug-16-stale-cache-authz',
    category: 'bugfix',
    title: 'Fix stale permission cache allowing reads after role revocation',
    ticket:
      'Fix `createAccessGuard({ ttlMs = 60_000 })` in `src/index.mjs`. Currently `grant(userId, resourceId)` and `canRead(userId, resourceId, nowMs, correlationId)` cache positive grants for `ttlMs`, and `revoke(userId, resourceId)` removes the backing grant without invalidating cached entries for that `(userId, resourceId)` or `revokeAllForUser(userId)`. Ensure revocations take effect immediately at the same millisecond.',
    profile: {
      name: 'permission-guard',
      idea: 'An authorization policy service checking document read grants with low-latency caching and instant revocation.',
      kind: 'api',
      stage: 'production',
      traits: ['auth'],
      risks: { multiTenant: true, pii: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function createAccessGuard({ ttlMs = 60_000 } = {}) {
  const grants = new Set();
  const cache = new Map();
  const key = (u, r) => \`\${u}:\${r}\`;
  return {
    grant(u, r) { grants.add(key(u, r)); },
    revoke(u, r) { grants.delete(key(u, r)); },
    revokeAllForUser(u) {
      for (const entry of grants) if (entry.startsWith(\`\${u}:\`)) grants.delete(entry);
    },
    canRead(u, r, nowMs = Date.now(), correlationId = 'req-0') {
      const k = key(u, r);
      const cached = cache.get(k);
      if (cached && nowMs < cached.expiresAt) return { allowed: cached.allowed, correlationId };
      const allowed = grants.has(k);
      cache.set(k, { allowed, expiresAt: nowMs + ttlMs });
      return { allowed, correlationId };
    }
  };
}\n`
    },
    naive: {
      'src/index.mjs': `export function createAccessGuard({ ttlMs = 60_000 } = {}) {
  const grants = new Set();
  const cache = new Map();
  const key = (u, r) => \`\${u}:\${r}\`;
  return {
    grant(u, r) { grants.add(key(u, r)); },
    revoke(u, r) { grants.delete(key(u, r)); cache.delete(key(u, r)); },
    revokeAllForUser(u) {
      for (const entry of grants) if (entry.startsWith(\`\${u}:\`)) grants.delete(entry);
    },
    canRead(u, r, nowMs = Date.now(), correlationId = 'req-0') {
      const k = key(u, r);
      const cached = cache.get(k);
      if (cached && nowMs < cached.expiresAt) return { allowed: cached.allowed, correlationId };
      const allowed = grants.has(k);
      cache.set(k, { allowed, expiresAt: nowMs + ttlMs });
      return { allowed, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createAccessGuard({ ttlMs = 60_000 } = {}) {
  const grants = new Set();
  const cache = new Map();
  const key = (u, r) => \`\${u}::\${r}\`;

  return {
    grant(u, r) {
      const k = key(u, r);
      grants.add(k);
      cache.delete(k);
    },
    revoke(u, r) {
      const k = key(u, r);
      grants.delete(k);
      cache.delete(k);
    },
    revokeAllForUser(u) {
      const prefix = \`\${u}::\`;
      for (const entry of [...grants]) if (entry.startsWith(prefix)) grants.delete(entry);
      for (const entry of [...cache.keys()]) if (entry.startsWith(prefix)) cache.delete(entry);
    },
    canRead(u, r, nowMs = Date.now(), correlationId = 'req-0') {
      const k = key(u, r);
      const cached = cache.get(k);
      if (cached && nowMs < cached.expiresAt) {
        return { allowed: cached.allowed, correlationId };
      }
      const allowed = grants.has(k);
      cache.set(k, { allowed, expiresAt: nowMs + ttlMs });
      return { allowed, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createAccessGuard({ ttlMs = 60_000 } = {}) {
  const grants = new Set();
  const cache = new Map();
  const key = (u, r) => \`\${u}::\${r}\`;
  return {
    grant(u, r) { grants.add(key(u, r)); cache.delete(key(u, r)); },
    revoke(u, r) { grants.delete(key(u, r)); cache.delete(key(u, r)); },
    revokeAllForUser(u) {
      for (const entry of [...grants]) if (entry.startsWith(\`\${u}::\`)) grants.delete(entry);
    },
    canRead(u, r, nowMs = Date.now(), correlationId = 'req-0') {
      const k = key(u, r);
      const cached = cache.get(k);
      if (cached && nowMs < cached.expiresAt) return { allowed: cached.allowed, correlationId };
      const allowed = grants.has(k);
      cache.set(k, { allowed, expiresAt: nowMs + ttlMs });
      return { allowed, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const g = mod.createAccessGuard({ ttlMs: 60_000 });
      g.grant('u1', 'doc-1');
      assert.equal(g.canRead('u1', 'doc-1', 100).allowed, true);
      g.revoke('u1', 'doc-1');
      assert.equal(g.canRead('u1', 'doc-1', 101).allowed, false, 'single revoke left stale cache entry');
    },
    defectProbes: [
      {
        id: 'bulk-user-deprovision-leaves-cached-grants-or-negative-cache-blocks-regrant',
        async check(mod) {
          const g = mod.createAccessGuard({ ttlMs: 60_000 });
          assert.equal(g.canRead('u1', 'doc-9', 100).allowed, false);
          g.grant('u1', 'doc-9');
          assert.equal(g.canRead('u1', 'doc-9', 105).allowed, true, 'negative cache entry was not invalidated on grant');
          g.revokeAllForUser('u1');
          assert.equal(g.canRead('u1', 'doc-9', 110).allowed, false, 'revokeAllForUser left stale positive cache');
        }
      }
    ]
  }
];
