import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/**
 * Ten harder, realistic Phase 0.4 outcome evaluation tasks (tasks 25–34):
 * financial ledgers, autonomous-agent safety gates, multi-tenant isolation,
 * cryptographic webhook replay defense, OAuth2 PKCE, optimistic concurrency,
 * GDPR erasure cascades, circuit breakers, partitioned outbox ordering, and
 * hash-chained compliance logs.
 */
export const ADVANCED_TASKS = [
  {
    id: 'adv-25-double-entry-ledger',
    category: 'greenfield',
    title: 'Idempotent double-entry ledger rejecting overdrafts and currency mismatch',
    ticket:
      'Implement `createLedger(initialAccounts)` in `src/index.mjs` where each account is `{ id, currency, balanceCents }`. Expose `balance(id)`, `entries()`, and `transfer({ idempotencyKey, from, to, amountCents, currency })`. Reject non-positive or non-integer amounts, self-transfers, currency mismatches, and insufficient funds without mutating balances. Repeating the same `idempotencyKey` with identical parameters returns the cached receipt without double-debiting; reusing the same key with different parameters returns `{ ok: false, code: "IDEMPOTENCY_CONFLICT" }`. Every committed transfer records balanced debit and credit legs (`sum === 0`).',
    profile: {
      name: 'core-ledger',
      idea: 'Double-entry ledger service for finance operations to post idempotent account transfers and verify balances instead of manual spreadsheets.',
      kind: 'api',
      stage: 'production',
      traits: ['persistence'],
      risks: { payments: true, destructiveWrites: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createLedger() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createLedger(initial = []) {
  const accounts = new Map(initial.map((a) => [a.id, { ...a }]));
  const log = [];
  return {
    balance: (id) => accounts.get(id)?.balanceCents ?? 0,
    entries: () => log,
    transfer({ from, to, amountCents }) {
      accounts.get(from).balanceCents -= amountCents;
      accounts.get(to).balanceCents += amountCents;
      log.push({ from, to, amountCents });
      return { ok: true, debit: -amountCents, credit: amountCents };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createLedger(initial = []) {
  const accounts = new Map(initial.map((a) => [a.id, { id: a.id, currency: a.currency, balanceCents: a.balanceCents }]));
  const seen = new Map();
  const legs = [];
  return {
    balance: (id) => accounts.get(id)?.balanceCents ?? null,
    entries: () => legs.map((l) => ({ ...l })),
    transfer({ idempotencyKey, from, to, amountCents, currency } = {}) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey) return { ok: false, code: 'MISSING_IDEMPOTENCY_KEY' };
      const fingerprint = JSON.stringify([from, to, amountCents, currency]);
      if (seen.has(idempotencyKey)) {
        const prior = seen.get(idempotencyKey);
        if (prior.fingerprint !== fingerprint) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        return { ...prior.receipt, replayed: true };
      }
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, code: 'INVALID_AMOUNT' };
      if (!from || !to || from === to) return { ok: false, code: 'INVALID_ACCOUNTS' };
      const src = accounts.get(from);
      const dst = accounts.get(to);
      if (!src || !dst) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };
      if (src.currency !== currency || dst.currency !== currency) return { ok: false, code: 'CURRENCY_MISMATCH' };
      if (src.balanceCents < amountCents) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
      src.balanceCents -= amountCents;
      dst.balanceCents += amountCents;
      legs.push({ idempotencyKey, account: from, deltaCents: -amountCents, currency });
      legs.push({ idempotencyKey, account: to, deltaCents: amountCents, currency });
      const receipt = { ok: true, idempotencyKey, amountCents, currency, fromBalance: src.balanceCents, toBalance: dst.balanceCents, replayed: false };
      seen.set(idempotencyKey, { fingerprint, receipt });
      return receipt;
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createLedger(initial = []) {
  const accounts = new Map(initial.map((a) => [a.id, { ...a }]));
  const legs = [];
  return {
    balance: (id) => accounts.get(id)?.balanceCents ?? null,
    entries: () => [...legs],
    transfer({ idempotencyKey, from, to, amountCents, currency } = {}) {
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || from === to) return { ok: false, code: 'INVALID' };
      const src = accounts.get(from); const dst = accounts.get(to);
      if (!src || !dst || src.currency !== currency || dst.currency !== currency || src.balanceCents < amountCents) return { ok: false, code: 'REJECTED' };
      src.balanceCents -= amountCents; dst.balanceCents += amountCents;
      legs.push({ idempotencyKey, account: from, deltaCents: -amountCents }, { idempotencyKey, account: to, deltaCents: amountCents });
      return { ok: true, idempotencyKey, amountCents, currency };
    }
  };
}\n`
    },
    async oracle(mod) {
      const ledger = mod.createLedger([
        { id: 'a', currency: 'EUR', balanceCents: 1000 },
        { id: 'b', currency: 'EUR', balanceCents: 200 },
        { id: 'c', currency: 'USD', balanceCents: 500 }
      ]);
      const r1 = ledger.transfer({ idempotencyKey: 'k1', from: 'a', to: 'b', amountCents: 400, currency: 'EUR' });
      assert.equal(r1.ok, true);
      assert.equal(ledger.balance('a'), 600);
      assert.equal(ledger.balance('b'), 600);
      const sum = ledger.entries().reduce((acc, l) => acc + l.deltaCents, 0);
      assert.equal(sum, 0);
    },
    defectProbes: [
      {
        id: 'duplicate-idempotency-key-double-debits',
        async check(mod) {
          const flagged = await (async () => {
          const ledger = mod.createLedger([{ id: 'a', currency: 'EUR', balanceCents: 1000 }, { id: 'b', currency: 'EUR', balanceCents: 0 }]);
          ledger.transfer({ idempotencyKey: 'dup', from: 'a', to: 'b', amountCents: 300, currency: 'EUR' });
          ledger.transfer({ idempotencyKey: 'dup', from: 'a', to: 'b', amountCents: 300, currency: 'EUR' });
          const conflict = ledger.transfer({ idempotencyKey: 'dup', from: 'a', to: 'b', amountCents: 999, currency: 'EUR' });
          return ledger.balance('a') !== 700 || conflict?.code !== 'IDEMPOTENCY_CONFLICT';
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      },
      {
        id: 'overdraft-or-currency-mismatch-allowed',
        async check(mod) {
          const flagged = await (async () => {
          const ledger = mod.createLedger([{ id: 'a', currency: 'EUR', balanceCents: 100 }, { id: 'b', currency: 'EUR', balanceCents: 0 }, { id: 'c', currency: 'USD', balanceCents: 0 }]);
          const over = ledger.transfer({ idempotencyKey: 'o1', from: 'a', to: 'b', amountCents: 250, currency: 'EUR' });
          const fx = ledger.transfer({ idempotencyKey: 'fx1', from: 'a', to: 'c', amountCents: 50, currency: 'EUR' });
          return over?.ok === true || fx?.ok === true || ledger.balance('a') !== 100;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-26-eu-ai-act-autonomy-gate',
    category: 'greenfield',
    title: 'Bounded AI tool dispatcher enforcing step budget, human approval and stop switch',
    ticket:
      'Implement `createAgentGate({ maxSteps, highRiskTools, tools })` in `src/index.mjs`. Expose `invoke({ tool, args, approvalToken, actor })`, `halt(reason)`, and `auditLog()`. Refuse unknown tools, refuse all calls after `halt()` with `AGENT_HALTED`, enforce `maxSteps` across attempted executions (`BUDGET_EXCEEDED`), and require a non-empty single-use `approvalToken` when `highRiskTools.includes(tool)` (`APPROVAL_REQUIRED` / `APPROVAL_REPLAYED`). Record every allowed and denied decision in `auditLog()`.',
    profile: {
      name: 'ops-copilot',
      idea: 'Autonomous runbook agent for SRE engineers to diagnose alerts and run gated remediation tools with human approval instead of ad-hoc scripts.',
      kind: 'agent',
      stage: 'production',
      traits: ['ai', 'auth'],
      risks: { destructiveWrites: true, regulated: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createAgentGate() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createAgentGate({ tools }) {
  const log = [];
  return {
    halt() {},
    auditLog: () => log,
    async invoke({ tool, args }) {
      const result = await tools[tool](args);
      log.push({ tool, allowed: true });
      return { ok: true, result };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createAgentGate({ maxSteps = 5, highRiskTools = [], tools = {} } = {}) {
  const risky = new Set(highRiskTools);
  const usedApprovals = new Set();
  const log = [];
  let steps = 0;
  let haltedReason = null;
  const record = (entry) => { log.push({ seq: log.length + 1, ...entry }); };
  return {
    halt(reason = 'operator-stop') { haltedReason = String(reason); record({ tool: null, allowed: false, code: 'HALTED', reason: haltedReason }); },
    auditLog: () => log.map((e) => ({ ...e })),
    async invoke({ tool, args = {}, approvalToken = null, actor = 'agent' } = {}) {
      if (haltedReason) { record({ tool, actor, allowed: false, code: 'AGENT_HALTED' }); return { ok: false, code: 'AGENT_HALTED' }; }
      if (!Object.hasOwn(tools, tool) || typeof tools[tool] !== 'function') { record({ tool, actor, allowed: false, code: 'TOOL_NOT_ALLOWED' }); return { ok: false, code: 'TOOL_NOT_ALLOWED' }; }
      if (steps >= maxSteps) { record({ tool, actor, allowed: false, code: 'BUDGET_EXCEEDED' }); return { ok: false, code: 'BUDGET_EXCEEDED' }; }
      if (risky.has(tool)) {
        if (typeof approvalToken !== 'string' || approvalToken.trim().length < 6) {
          record({ tool, actor, allowed: false, code: 'APPROVAL_REQUIRED' });
          return { ok: false, code: 'APPROVAL_REQUIRED' };
        }
        if (usedApprovals.has(approvalToken)) {
          record({ tool, actor, allowed: false, code: 'APPROVAL_REPLAYED' });
          return { ok: false, code: 'APPROVAL_REPLAYED' };
        }
        usedApprovals.add(approvalToken);
      }
      steps += 1;
      const result = await tools[tool](args);
      record({ tool, actor, allowed: true, code: 'EXECUTED' });
      return { ok: true, result, remainingSteps: maxSteps - steps };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createAgentGate({ maxSteps = 5, tools = {} } = {}) {
  const log = []; let steps = 0; let halted = false;
  return {
    halt() { halted = true; },
    auditLog: () => [...log],
    async invoke({ tool, args = {} } = {}) {
      if (halted) return { ok: false, code: 'AGENT_HALTED' };
      if (!Object.hasOwn(tools, tool)) return { ok: false, code: 'TOOL_NOT_ALLOWED' };
      if (steps >= maxSteps) return { ok: false, code: 'BUDGET_EXCEEDED' };
      steps += 1;
      log.push({ tool, allowed: true });
      return { ok: true, result: await tools[tool](args) };
    }
  };
}\n`
    },
    async oracle(mod) {
      const gate = mod.createAgentGate({
        maxSteps: 3,
        highRiskTools: ['deleteDb'],
        tools: { readMetrics: async () => 'cpu=12%', deleteDb: async () => 'dropped' }
      });
      const r = await gate.invoke({ tool: 'readMetrics', args: {} });
      assert.equal(r.ok, true);
      assert.equal(r.result, 'cpu=12%');
      assert.ok(gate.auditLog().length >= 1);
    },
    defectProbes: [
      {
        id: 'high-risk-tool-runs-without-fresh-human-approval',
        async check(mod) {
          const flagged = await (async () => {
          const gate = mod.createAgentGate({ maxSteps: 5, highRiskTools: ['deleteDb'], tools: { deleteDb: async () => 'dropped' } });
          const noTok = await gate.invoke({ tool: 'deleteDb' });
          const first = await gate.invoke({ tool: 'deleteDb', approvalToken: 'approve-001' });
          const replay = await gate.invoke({ tool: 'deleteDb', approvalToken: 'approve-001' });
          return noTok?.ok === true || first?.ok !== true || replay?.ok === true;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      },
      {
        id: 'budget-or-halt-bypassed',
        async check(mod) {
          const flagged = await (async () => {
          const gate = mod.createAgentGate({ maxSteps: 1, highRiskTools: [], tools: { ping: async () => 'pong' } });
          await gate.invoke({ tool: 'ping' });
          const over = await gate.invoke({ tool: 'ping' });
          gate.halt('emergency');
          const afterHalt = await gate.invoke({ tool: 'ping' });
          return over?.code !== 'BUDGET_EXCEEDED' || afterHalt?.code !== 'AGENT_HALTED';
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-27-tenant-scoped-search',
    category: 'brownfield',
    title: 'Multi-tenant document search blocking cross-tenant leaks and soft-deleted hits',
    ticket:
      'Extend `createSearchIndex()` in `src/index.mjs` with `index(doc)`, `softDelete(tenantId, docId)`, and `query({ tenantId, term, limit })`. Return only non-deleted documents belonging strictly to `tenantId` matching `term` as a literal case-insensitive substring (never compile untrusted `term` as a RegExp), clamped to `1..50` results.',
    profile: {
      name: 'tenant-docs',
      idea: 'Multi-tenant knowledge base for customer support teams to index and search internal articles per workspace instead of shared folders.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'search', 'persistence'],
      risks: { pii: true, multiTenant: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function createSearchIndex() {
  const docs = [];
  return {
    index(doc) { docs.push(doc); },
    softDelete() {},
    query() { return []; }
  };
}\n`
    },
    naive: {
      'src/index.mjs': `export function createSearchIndex() {
  const docs = [];
  return {
    index(doc) { docs.push(doc); },
    softDelete(_t, id) { const d = docs.find((x) => x.id === id); if (d) d.deleted = true; },
    query({ term, limit = 10 }) {
      const re = new RegExp(term, 'i');
      return docs.filter((d) => re.test(d.body)).slice(0, limit);
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createSearchIndex() {
  const docs = new Map();
  const keyOf = (t, id) => \`\${t}::\${id}\`;
  return {
    index({ tenantId, id, title = '', body = '' } = {}) {
      if (!tenantId || !id) throw new Error('tenantId and id required');
      docs.set(keyOf(tenantId, id), { tenantId, id, title: String(title), body: String(body), deleted: false });
    },
    softDelete(tenantId, id) {
      const item = docs.get(keyOf(tenantId, id));
      if (!item || item.tenantId !== tenantId) return false;
      item.deleted = true;
      return true;
    },
    query({ tenantId, term, limit = 20 } = {}) {
      if (typeof tenantId !== 'string' || !tenantId) return [];
      const needle = String(term ?? '').trim().toLowerCase();
      if (!needle) return [];
      const cap = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, 50));
      const out = [];
      for (const doc of docs.values()) {
        if (doc.deleted || doc.tenantId !== tenantId) continue;
        if (doc.title.toLowerCase().includes(needle) || doc.body.toLowerCase().includes(needle)) {
          out.push({ id: doc.id, tenantId: doc.tenantId, title: doc.title });
          if (out.length >= cap) break;
        }
      }
      return out;
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createSearchIndex() {
  const docs = [];
  return {
    index(doc) { docs.push({ ...doc, deleted: false }); },
    softDelete(_t, id) { const d = docs.find((x) => x.id === id); if (d) d.deleted = true; },
    query({ term, limit = 20 } = {}) {
      const needle = String(term ?? '').toLowerCase();
      return docs.filter((d) => d.body.toLowerCase().includes(needle)).slice(0, Math.min(limit, 50));
    }
  };
}\n`
    },
    async oracle(mod) {
      const idx = mod.createSearchIndex();
      idx.index({ tenantId: 't1', id: 'd1', title: 'Runbook', body: 'Rotate keys monthly' });
      const hits = idx.query({ tenantId: 't1', term: 'rotate' });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, 'd1');
    },
    defectProbes: [
      {
        id: 'cross-tenant-search-or-delete-leak',
        async check(mod) {
          const flagged = await (async () => {
          const idx = mod.createSearchIndex();
          idx.index({ tenantId: 't1', id: 'd1', title: 'Secret', body: 'payroll alpha' });
          idx.index({ tenantId: 't2', id: 'd2', title: 'Secret', body: 'payroll beta' });
          idx.softDelete('t2', 'd1');
          const t2Hits = idx.query({ tenantId: 't2', term: 'payroll' });
          const t1Hits = idx.query({ tenantId: 't1', term: 'payroll' });
          return t2Hits.some((h) => h.id === 'd1') || t1Hits.length !== 1;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      },
      {
        id: 'regex-wildcard-or-soft-delete-exposure',
        async check(mod) {
          const flagged = await (async () => {
          const idx = mod.createSearchIndex();
          idx.index({ tenantId: 't1', id: 'd1', title: 'Doc', body: 'confidential record' });
          try {
            const wild = idx.query({ tenantId: 't1', term: '.*([unclosed' });
            if (wild.length > 0) return true;
          } catch {
            return true;
          }
          idx.softDelete('t1', 'd1');
          return idx.query({ tenantId: 't1', term: 'confidential' }).length > 0;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-28-webhook-replay-guard',
    category: 'brownfield',
    title: 'HMAC-SHA256 webhook verifier enforcing clock window and replay cache',
    ticket:
      'Implement `createWebhookVerifier({ secret, toleranceSec = 300 })` in `src/index.mjs`. `verify({ rawBody, timestampSec, signatureHex, eventId, nowSec })` verifies `HMAC-SHA256(secret, timestampSec + "." + rawBody)` with `crypto.timingSafeEqual`, rejects timestamps outside `toleranceSec` of `nowSec`, and rejects duplicate `eventId` deliveries within the window.',
    profile: {
      name: 'billing-hooks',
      idea: 'Webhook ingestion service for SaaS billing receivers to verify signed payment events and prevent replay attacks instead of trusting raw payloads.',
      kind: 'api',
      stage: 'production',
      traits: ['webhooks', 'payments'],
      risks: { payments: true, integrations: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createWebhookVerifier() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createWebhookVerifier({ secret }) {
  return {
    verify({ rawBody, timestampSec, signatureHex }) {
      const expected = crypto.createHmac('sha256', secret).update(\`\${timestampSec}.\${rawBody}\`).digest('hex');
      return expected === signatureHex ? { ok: true } : { ok: false, code: 'BAD_SIG' };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createWebhookVerifier({ secret, toleranceSec = 300 } = {}) {
  const seen = new Map();
  return {
    verify({ rawBody, timestampSec, signatureHex, eventId, nowSec } = {}) {
      if (typeof rawBody !== 'string' || !Number.isFinite(timestampSec) || !Number.isFinite(nowSec)) return { ok: false, code: 'INVALID_INPUT' };
      if (typeof eventId !== 'string' || !eventId) return { ok: false, code: 'MISSING_EVENT_ID' };
      if (Math.abs(nowSec - timestampSec) > toleranceSec) return { ok: false, code: 'STALE_TIMESTAMP' };
      if (typeof signatureHex !== 'string' || !/^[a-f0-9]{64}$/i.test(signatureHex)) return { ok: false, code: 'BAD_SIGNATURE' };
      const expected = crypto.createHmac('sha256', secret).update(\`\${timestampSec}.\${rawBody}\`).digest();
      const provided = Buffer.from(signatureHex, 'hex');
      if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return { ok: false, code: 'BAD_SIGNATURE' };
      for (const [id, ts] of seen) if (nowSec - ts > toleranceSec) seen.delete(id);
      if (seen.has(eventId)) return { ok: false, code: 'REPLAY_DETECTED' };
      seen.set(eventId, nowSec);
      return { ok: true, eventId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createWebhookVerifier({ secret }) {
  return {
    verify({ rawBody, timestampSec, signatureHex, eventId } = {}) {
      if (typeof signatureHex !== 'string' || signatureHex.length !== 64) return { ok: false, code: 'BAD_SIGNATURE' };
      const expected = crypto.createHmac('sha256', secret).update(\`\${timestampSec}.\${rawBody}\`).digest();
      const provided = Buffer.from(signatureHex, 'hex');
      return crypto.timingSafeEqual(expected, provided) ? { ok: true, eventId } : { ok: false, code: 'BAD_SIGNATURE' };
    }
  };
}\n`
    },
    async oracle(mod) {
      const secret = 'whsec_test_key';
      const v = mod.createWebhookVerifier({ secret, toleranceSec: 300 });
      const body = '{"type":"invoice.paid"}';
      const sig = crypto.createHmac('sha256', secret).update(`1000.${body}`).digest('hex');
      assert.equal(v.verify({ rawBody: body, timestampSec: 1000, signatureHex: sig, eventId: 'evt_1', nowSec: 1050 }).ok, true);
      assert.equal(v.verify({ rawBody: body, timestampSec: 1000, signatureHex: '0'.repeat(64), eventId: 'evt_2', nowSec: 1050 }).ok, false);
    },
    defectProbes: [
      {
        id: 'stale-or-replayed-webhook-accepted',
        async check(mod) {
          const flagged = await (async () => {
          const secret = 'whsec_test_key';
          const v = mod.createWebhookVerifier({ secret, toleranceSec: 300 });
          const body = '{"amount":500}';
          const sig = crypto.createHmac('sha256', secret).update(`1000.${body}`).digest('hex');
          const stale = v.verify({ rawBody: body, timestampSec: 1000, signatureHex: sig, eventId: 'evt_old', nowSec: 2000 });
          v.verify({ rawBody: body, timestampSec: 1000, signatureHex: sig, eventId: 'evt_dup', nowSec: 1100 });
          const replay = v.verify({ rawBody: body, timestampSec: 1000, signatureHex: sig, eventId: 'evt_dup', nowSec: 1101 });
          return stale?.ok === true || replay?.ok === true;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-29-oauth-pkce-state',
    category: 'bugfix',
    title: 'OAuth2 PKCE S256 token exchange blocking plain downgrade, CSRF state mismatch and code replay',
    ticket:
      'Fix `createPkceServer()` in `src/index.mjs` (`authorize({ clientId, redirectUri, state, codeChallenge, method })` and `exchange({ code, clientId, redirectUri, state, codeVerifier })`). Require `method === "S256"` (reject `"plain"`), bind `clientId`, `redirectUri`, and `state`, verify `base64url(sha256(codeVerifier)) === codeChallenge`, and invalidate every authorization code on first exchange attempt.',
    profile: {
      name: 'auth-broker',
      idea: 'OAuth2 authorization service for mobile and CLI clients to exchange PKCE codes for session tokens safely.',
      kind: 'api',
      stage: 'production',
      traits: ['auth'],
      risks: { pii: true, publicFacing: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createPkceServer() { return { authorize: () => ({ ok: false }), exchange: () => ({ ok: false }) }; }\n'
    },
    naive: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createPkceServer() {
  const codes = new Map();
  let n = 0;
  return {
    authorize({ clientId, redirectUri, state, codeChallenge, method = 'S256' }) {
      const code = \`code_\${++n}\`;
      codes.set(code, { clientId, redirectUri, state, codeChallenge, method });
      return { ok: true, code };
    },
    exchange({ code, codeVerifier }) {
      const rec = codes.get(code);
      if (!rec) return { ok: false };
      const check = rec.method === 'plain' ? codeVerifier : crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      return check === rec.codeChallenge ? { ok: true, accessToken: \`tok_\${code}\` } : { ok: false };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createPkceServer() {
  const codes = new Map();
  let seq = 0;
  return {
    authorize({ clientId, redirectUri, state, codeChallenge, method } = {}) {
      if (method !== 'S256') return { ok: false, code: 'UNSUPPORTED_PKCE_METHOD' };
      if (!clientId || !redirectUri || !state || typeof codeChallenge !== 'string' || codeChallenge.length < 32) {
        return { ok: false, code: 'INVALID_REQUEST' };
      }
      const code = \`code_\${++seq}_\${crypto.randomBytes(6).toString('hex')}\`;
      codes.set(code, { clientId, redirectUri, state, codeChallenge });
      return { ok: true, code, state };
    },
    exchange({ code, clientId, redirectUri, state, codeVerifier } = {}) {
      const rec = codes.get(code);
      codes.delete(code);
      if (!rec) return { ok: false, code: 'INVALID_GRANT' };
      if (rec.clientId !== clientId || rec.redirectUri !== redirectUri || rec.state !== state) {
        return { ok: false, code: 'BINDING_MISMATCH' };
      }
      if (typeof codeVerifier !== 'string' || codeVerifier.length < 43) return { ok: false, code: 'INVALID_VERIFIER' };
      const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      if (computed !== rec.codeChallenge) return { ok: false, code: 'PKCE_MISMATCH' };
      return { ok: true, accessToken: \`at_\${crypto.randomBytes(8).toString('hex')}\` };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createPkceServer() {
  const codes = new Map(); let seq = 0;
  return {
    authorize({ clientId, redirectUri, state, codeChallenge, method } = {}) {
      if (method !== 'S256') return { ok: false, code: 'UNSUPPORTED_PKCE_METHOD' };
      const code = \`code_\${++seq}\`; codes.set(code, { clientId, redirectUri, state, codeChallenge });
      return { ok: true, code, state };
    },
    exchange({ code, codeVerifier } = {}) {
      const rec = codes.get(code); if (!rec) return { ok: false, code: 'INVALID_GRANT' };
      const computed = crypto.createHash('sha256').update(String(codeVerifier)).digest('base64url');
      return computed === rec.codeChallenge ? { ok: true, accessToken: 'at_1' } : { ok: false, code: 'PKCE_MISMATCH' };
    }
  };
}\n`
    },
    async oracle(mod) {
      const srv = mod.createPkceServer();
      const verifier = 'v'.repeat(48);
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const auth = srv.authorize({ clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'st1', codeChallenge: challenge, method: 'S256' });
      assert.equal(auth.ok, true);
      const tok = srv.exchange({ code: auth.code, clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'st1', codeVerifier: verifier });
      assert.equal(tok.ok, true);
    },
    defectProbes: [
      {
        id: 'plain-downgrade-state-mismatch-or-code-replay',
        async check(mod) {
          const flagged = await (async () => {
          const srv = mod.createPkceServer();
          const plain = srv.authorize({ clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 's', codeChallenge: 'plain_secret_value_1234567890123456', method: 'plain' });
          if (plain?.ok === true) return true;
          const verifier = 'w'.repeat(48);
          const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          const a1 = srv.authorize({ clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'good', codeChallenge: challenge, method: 'S256' });
          const badState = srv.exchange({ code: a1.code, clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'evil', codeVerifier: verifier });
          const a2 = srv.authorize({ clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'good', codeChallenge: challenge, method: 'S256' });
          srv.exchange({ code: a2.code, clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'good', codeVerifier: verifier });
          const replay = srv.exchange({ code: a2.code, clientId: 'cli', redirectUri: 'http://127.0.0.1/cb', state: 'good', codeVerifier: verifier });
          return badState?.ok === true || replay?.ok === true;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-30-optimistic-lock-retry',
    category: 'bugfix',
    title: 'Optimistic concurrency inventory store preventing lost updates and negative stock',
    ticket:
      'Fix `createInventory(initial)` in `src/index.mjs` (`read(sku)` -> `{ sku, available, version }`, `reserve({ sku, qty, expectedVersion })`). Reject stale `expectedVersion` with `{ ok: false, code: "VERSION_CONFLICT", currentVersion }`, reject non-positive integers or oversells (`INSUFFICIENT_STOCK`), and atomically increment `version` only on successful reservation.',
    profile: {
      name: 'stock-service',
      idea: 'Warehouse inventory reservation API for fulfillment workers to allocate stock with optimistic locking instead of overselling orders.',
      kind: 'api',
      stage: 'production',
      traits: ['persistence'],
      risks: { destructiveWrites: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createInventory() { return { read: () => null, reserve: () => ({ ok: false }) }; }\n'
    },
    naive: {
      'src/index.mjs': `export function createInventory(initial = {}) {
  const map = new Map(Object.entries(initial).map(([sku, available]) => [sku, { sku, available, version: 1 }]));
  return {
    read: (sku) => ({ ...map.get(sku) }),
    reserve({ sku, qty }) {
      const item = map.get(sku);
      item.available -= qty;
      item.version += 1;
      return { ok: true, available: item.available, version: item.version };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createInventory(initial = {}) {
  const map = new Map(Object.entries(initial).map(([sku, available]) => [sku, { sku, available, version: 1 }]));
  return {
    read: (sku) => (map.has(sku) ? { ...map.get(sku) } : null),
    reserve({ sku, qty, expectedVersion } = {}) {
      const item = map.get(sku);
      if (!item) return { ok: false, code: 'SKU_NOT_FOUND' };
      if (!Number.isSafeInteger(qty) || qty <= 0) return { ok: false, code: 'INVALID_QTY' };
      if (expectedVersion !== item.version) return { ok: false, code: 'VERSION_CONFLICT', currentVersion: item.version };
      if (item.available < qty) return { ok: false, code: 'INSUFFICIENT_STOCK', available: item.available };
      item.available -= qty;
      item.version += 1;
      return { ok: true, sku, available: item.available, version: item.version };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createInventory(initial = {}) {
  const map = new Map(Object.entries(initial).map(([sku, available]) => [sku, { sku, available, version: 1 }]));
  return {
    read: (sku) => (map.has(sku) ? { ...map.get(sku) } : null),
    reserve({ sku, qty } = {}) {
      const item = map.get(sku);
      if (!item || !Number.isSafeInteger(qty) || qty <= 0 || item.available < qty) return { ok: false, code: 'REJECTED' };
      item.available -= qty; item.version += 1;
      return { ok: true, sku, available: item.available, version: item.version };
    }
  };
}\n`
    },
    async oracle(mod) {
      const inv = mod.createInventory({ 'SKU-1': 10 });
      const snap = inv.read('SKU-1');
      const res = inv.reserve({ sku: 'SKU-1', qty: 4, expectedVersion: snap.version });
      assert.equal(res.ok, true);
      assert.equal(inv.read('SKU-1').available, 6);
      assert.equal(inv.read('SKU-1').version, 2);
    },
    defectProbes: [
      {
        id: 'stale-version-or-oversell-accepted',
        async check(mod) {
          const flagged = await (async () => {
          const inv = mod.createInventory({ 'SKU-1': 5 });
          inv.reserve({ sku: 'SKU-1', qty: 3, expectedVersion: 1 });
          const stale = inv.reserve({ sku: 'SKU-1', qty: 1, expectedVersion: 1 });
          const over = inv.reserve({ sku: 'SKU-1', qty: 9, expectedVersion: 2 });
          return stale?.code !== 'VERSION_CONFLICT' || over?.ok === true || inv.read('SKU-1').available !== 2;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-31-gdpr-erasure-cascade',
    category: 'refactor',
    title: 'GDPR erasure scrubbing user PII across sessions and invoices while preserving accounting totals',
    ticket:
      'Refactor `createAccountStore()` in `src/index.mjs` (`addUser`, `addSession`, `addInvoice`, `eraseUser(userId)`, `snapshot()`). `eraseUser` must delete all active sessions for `userId`, remove name/email/ip PII from user and invoice records (replacing customer reference with `erased:<sha256-prefix>`), preserve immutable invoice `amountCents` and `id` for statutory tax retention, and be idempotent on repeated calls.',
    profile: {
      name: 'eu-billing',
      idea: 'Subscription customer directory for European SaaS operators to manage profiles, invoices and GDPR erasure requests cleanly.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'payments', 'persistence'],
      risks: { pii: true, payments: true, regulated: true, destructiveWrites: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createAccountStore() { throw new Error("not implemented"); }\n'
    },
    naive: {
      'src/index.mjs': `export function createAccountStore() {
  const users = new Map(); const sessions = []; const invoices = [];
  return {
    addUser: (u) => users.set(u.id, { ...u }),
    addSession: (s) => sessions.push({ ...s }),
    addInvoice: (inv) => invoices.push({ ...inv }),
    eraseUser: (id) => { users.delete(id); return { ok: true }; },
    snapshot: () => ({ users: [...users.values()], sessions, invoices })
  };
}\n`
    },
    reference: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createAccountStore() {
  const users = new Map();
  let sessions = [];
  const invoices = [];
  const pseudo = (id) => \`erased:\${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}\`;
  return {
    addUser: (u) => users.set(u.id, { id: u.id, name: u.name, email: u.email }),
    addSession: (s) => sessions.push({ token: s.token, userId: s.userId, ip: s.ip }),
    addInvoice: (inv) => invoices.push({ id: inv.id, userId: inv.userId, customerEmail: inv.customerEmail, customerName: inv.customerName, amountCents: inv.amountCents }),
    eraseUser(userId) {
      const marker = pseudo(userId);
      const existed = users.delete(userId);
      const before = sessions.length;
      sessions = sessions.filter((s) => s.userId !== userId);
      let scrubbedInvoices = 0;
      for (const inv of invoices) {
        if (inv.userId === userId) {
          inv.userId = marker;
          inv.customerEmail = null;
          inv.customerName = null;
          scrubbedInvoices += 1;
        }
      }
      return { ok: true, existed, revokedSessions: before - sessions.length, scrubbedInvoices, subjectRef: marker };
    },
    snapshot: () => ({
      users: [...users.values()].map((u) => ({ ...u })),
      sessions: sessions.map((s) => ({ ...s })),
      invoices: invoices.map((i) => ({ ...i }))
    })
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createAccountStore() {
  const users = new Map(); let sessions = []; let invoices = [];
  return {
    addUser: (u) => users.set(u.id, { ...u }),
    addSession: (s) => sessions.push({ ...s }),
    addInvoice: (i) => invoices.push({ ...i }),
    eraseUser(userId) {
      users.delete(userId);
      sessions = sessions.filter((s) => s.userId !== userId);
      invoices = invoices.filter((i) => i.userId !== userId);
      return { ok: true };
    },
    snapshot: () => ({ users: [...users.values()], sessions, invoices })
  };
}\n`
    },
    async oracle(mod) {
      const store = mod.createAccountStore();
      store.addUser({ id: 'u1', name: 'Ada', email: 'ada@example.eu' });
      store.addSession({ token: 's1', userId: 'u1', ip: '192.0.2.9' });
      store.addInvoice({ id: 'inv-1', userId: 'u1', customerEmail: 'ada@example.eu', customerName: 'Ada', amountCents: 4900 });
      store.eraseUser('u1');
      assert.equal(store.snapshot().users.length, 0);
    },
    defectProbes: [
      {
        id: 'pii-remains-or-statutory-invoice-total-lost',
        async check(mod) {
          const flagged = await (async () => {
          const store = mod.createAccountStore();
          store.addUser({ id: 'u1', name: 'Ada Lovelace', email: 'ada@example.eu' });
          store.addSession({ token: 's1', userId: 'u1', ip: '192.0.2.9' });
          store.addInvoice({ id: 'inv-1', userId: 'u1', customerEmail: 'ada@example.eu', customerName: 'Ada Lovelace', amountCents: 4900 });
          store.eraseUser('u1');
          store.eraseUser('u1');
          const snap = store.snapshot();
          const dumped = JSON.stringify(snap);
          if (dumped.includes('ada@example.eu') || dumped.includes('Ada Lovelace') || dumped.includes('192.0.2.9')) return true;
          if (snap.sessions.length !== 0) return true;
          return snap.invoices.length !== 1 || snap.invoices[0].amountCents !== 4900;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-32-circuit-breaker-bulkhead',
    category: 'refactor',
    title: 'Per-dependency circuit breaker with half-open probe guard and isolated upstream states',
    ticket:
      'Implement `createBreakerRegistry({ failureThreshold = 3, cooldownMs = 5000 })` in `src/index.mjs`. `execute(upstreamId, fn, nowMs)` tracks independent state (`closed`, `open`, `half-open`) per `upstreamId`, trips `open` after `failureThreshold` consecutive failures, fast-fails with `CIRCUIT_OPEN` during `cooldownMs`, allows a single trial in `half-open` after cooldown (closing on success, reopening on failure), and never trips healthy upstream B when upstream A fails.',
    profile: {
      name: 'gateway-breaker',
      idea: 'API gateway resilience library for backend teams to isolate failing upstream services with per-dependency circuit breakers.',
      kind: 'library',
      stage: 'production',
      traits: ['webhooks'],
      risks: { integrations: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createBreakerRegistry() { throw new Error("not implemented"); }\n'
    },
    naive: {
      'src/index.mjs': `export function createBreakerRegistry({ failureThreshold = 3 } = {}) {
  let failures = 0;
  return {
    state: () => (failures >= failureThreshold ? 'open' : 'closed'),
    async execute(_id, fn) {
      if (failures >= failureThreshold) return { ok: false, code: 'CIRCUIT_OPEN' };
      try { const value = await fn(); failures = 0; return { ok: true, value }; }
      catch { failures += 1; return { ok: false, code: 'UPSTREAM_ERROR' }; }
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createBreakerRegistry({ failureThreshold = 3, cooldownMs = 5000 } = {}) {
  const slots = new Map();
  const slot = (id) => {
    if (!slots.has(id)) slots.set(id, { state: 'closed', failures: 0, openedAt: 0, probing: false });
    return slots.get(id);
  };
  return {
    state: (id) => slot(id).state,
    async execute(upstreamId, fn, nowMs = Date.now()) {
      const s = slot(upstreamId);
      if (s.state === 'open') {
        if (nowMs - s.openedAt < cooldownMs) return { ok: false, code: 'CIRCUIT_OPEN' };
        s.state = 'half-open';
      }
      if (s.state === 'half-open' && s.probing) return { ok: false, code: 'CIRCUIT_OPEN' };
      if (s.state === 'half-open') s.probing = true;
      try {
        const value = await fn();
        s.state = 'closed'; s.failures = 0; s.probing = false;
        return { ok: true, value };
      } catch {
        s.probing = false;
        s.failures += 1;
        if (s.state === 'half-open' || s.failures >= failureThreshold) {
          s.state = 'open';
          s.openedAt = nowMs;
        }
        return { ok: false, code: 'UPSTREAM_ERROR' };
      }
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createBreakerRegistry({ failureThreshold = 3 } = {}) {
  const slots = new Map();
  const slot = (id) => { if (!slots.has(id)) slots.set(id, { failures: 0 }); return slots.get(id); };
  return {
    state: (id) => (slot(id).failures >= failureThreshold ? 'open' : 'closed'),
    async execute(id, fn) {
      const s = slot(id);
      if (s.failures >= failureThreshold) return { ok: false, code: 'CIRCUIT_OPEN' };
      try { const value = await fn(); s.failures = 0; return { ok: true, value }; }
      catch { s.failures += 1; return { ok: false, code: 'UPSTREAM_ERROR' }; }
    }
  };
}\n`
    },
    async oracle(mod) {
      const reg = mod.createBreakerRegistry({ failureThreshold: 2, cooldownMs: 1000 });
      await reg.execute('a', async () => { throw new Error('boom'); }, 100);
      await reg.execute('a', async () => { throw new Error('boom'); }, 200);
      const blocked = await reg.execute('a', async () => 'ok', 300);
      assert.equal(blocked.code, 'CIRCUIT_OPEN');
    },
    defectProbes: [
      {
        id: 'cross-upstream-bleed-or-broken-half-open-recovery',
        async check(mod) {
          const flagged = await (async () => {
          const reg = mod.createBreakerRegistry({ failureThreshold: 2, cooldownMs: 1000 });
          await reg.execute('bad', async () => { throw new Error('x'); }, 10);
          await reg.execute('bad', async () => { throw new Error('x'); }, 20);
          const healthy = await reg.execute('good', async () => 'alive', 30);
          if (healthy?.ok !== true) return true;
          const failProbe = await reg.execute('bad', async () => { throw new Error('still down'); }, 1200);
          const mustReopen = await reg.execute('bad', async () => 'nope', 1300);
          const recover = await reg.execute('bad', async () => 'back', 2500);
          return failProbe?.ok === true || mustReopen?.code !== 'CIRCUIT_OPEN' || recover?.value !== 'back';
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-33-outbox-relay-ordering',
    category: 'systems',
    title: 'Partitioned transactional outbox preserving per-aggregate FIFO without head-of-line blocking',
    ticket:
      'Implement `createOutboxRelay({ maxAttempts = 3 })` in `src/index.mjs` (`enqueue({ id, aggregateId, payload })`, `flush(publish)`, `deadLetters()`). Deliver events in strict FIFO order per `aggregateId`: if event #1 for aggregate `A` fails, do NOT publish event #2 for aggregate `A`, yet continue publishing ready events for aggregate `B`. Move an event to `deadLetters()` once its failed attempts reach `maxAttempts`.',
    profile: {
      name: 'event-outbox',
      idea: 'Transactional outbox relay for distributed microservices to publish ordered domain events with isolated retry and dead-letter queues.',
      kind: 'data-pipeline',
      stage: 'production',
      traits: ['background-jobs', 'persistence'],
      risks: { integrations: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createOutboxRelay() { throw new Error("not implemented"); }\n'
    },
    naive: {
      'src/index.mjs': `export function createOutboxRelay() {
  const q = [];
  return {
    enqueue: (e) => q.push(e),
    deadLetters: () => [],
    async flush(publish) {
      while (q.length) {
        const ev = q.shift();
        try { await publish(ev); } catch {}
      }
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createOutboxRelay({ maxAttempts = 3 } = {}) {
  const queue = [];
  const dead = [];
  return {
    enqueue(ev) { queue.push({ ...ev, attempts: 0 }); },
    deadLetters: () => dead.map((d) => ({ ...d })),
    async flush(publish) {
      const blockedAggregates = new Set();
      const remaining = [];
      let delivered = 0;
      for (const ev of queue) {
        if (blockedAggregates.has(ev.aggregateId)) {
          remaining.push(ev);
          continue;
        }
        try {
          await publish({ id: ev.id, aggregateId: ev.aggregateId, payload: ev.payload });
          delivered += 1;
        } catch (err) {
          ev.attempts += 1;
          blockedAggregates.add(ev.aggregateId);
          if (ev.attempts >= maxAttempts) {
            dead.push({ id: ev.id, aggregateId: ev.aggregateId, attempts: ev.attempts, error: String(err?.message ?? err) });
          } else {
            remaining.push(ev);
          }
        }
      }
      queue.length = 0;
      queue.push(...remaining);
      return { delivered, pending: queue.length, deadLetters: dead.length };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createOutboxRelay({ maxAttempts = 3 } = {}) {
  const queue = []; const dead = [];
  return {
    enqueue(ev) { queue.push({ ...ev, attempts: 0 }); },
    deadLetters: () => [...dead],
    async flush(publish) {
      const rem = [];
      for (const ev of queue) {
        try { await publish(ev); }
        catch { ev.attempts += 1; if (ev.attempts >= maxAttempts) dead.push(ev); else rem.push(ev); }
      }
      queue.length = 0; queue.push(...rem);
    }
  };
}\n`
    },
    async oracle(mod) {
      const relay = mod.createOutboxRelay({ maxAttempts: 2 });
      const seen = [];
      relay.enqueue({ id: 'e1', aggregateId: 'ord-1', payload: 'created' });
      relay.enqueue({ id: 'e2', aggregateId: 'ord-1', payload: 'paid' });
      await relay.flush(async (ev) => seen.push(ev.id));
      assert.deepEqual(seen, ['e1', 'e2']);
    },
    defectProbes: [
      {
        id: 'out-of-order-aggregate-delivery-or-missing-dlq',
        async check(mod) {
          const flagged = await (async () => {
          const relay = mod.createOutboxRelay({ maxAttempts: 2 });
          const delivered = [];
          relay.enqueue({ id: 'a1', aggregateId: 'A', payload: 1 });
          relay.enqueue({ id: 'a2', aggregateId: 'A', payload: 2 });
          relay.enqueue({ id: 'b1', aggregateId: 'B', payload: 1 });
          const pub = async (ev) => { if (ev.id === 'a1') throw new Error('poison'); delivered.push(ev.id); };
          await relay.flush(pub);
          if (delivered.includes('a2') || !delivered.includes('b1')) return true;
          await relay.flush(pub);
          return relay.deadLetters().length !== 1 || relay.deadLetters()[0].id !== 'a1';
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  },
  {
    id: 'adv-34-hash-chain-audit-log',
    category: 'systems',
    title: 'Tamper-evident SHA-256 hash-chained audit store detecting mutation and redacting secrets',
    ticket:
      'Implement `createAuditChain()` in `src/index.mjs` (`append({ actor, action, meta })`, `exportLines()`, `verify(lines)`). Redact any `token`/`secret`/`password` field inside `meta` to `"[REDACTED]"`, link each entry `prevHash` to the prior SHA-256 `hash` (genesis `"0".repeat(64)`), and make `verify(lines)` return `{ ok: false, brokenSeq }` on any modified, deleted, or reordered line.',
    profile: {
      name: 'audit-vault',
      idea: 'Compliance audit log store for regulated financial systems to seal tamper-evident hash-chained events and verify integrity.',
      kind: 'api',
      stage: 'production',
      traits: ['persistence'],
      risks: { regulated: true, destructiveWrites: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createAuditChain() { throw new Error("not implemented"); }\n'
    },
    naive: {
      'src/index.mjs': `export function createAuditChain() {
  const rows = [];
  return {
    append(e) { rows.push({ seq: rows.length + 1, ...e }); },
    exportLines: () => rows.map((r) => JSON.stringify(r)),
    verify: (lines) => ({ ok: lines.length >= 0, brokenSeq: null })
  };
}\n`
    },
    reference: {
      'src/index.mjs': `import crypto from 'node:crypto';
const GENESIS = '0'.repeat(64);
const hashOf = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
function scrub(meta = {}) {
  const out = {};
  for (const key of Object.keys(meta).sort()) {
    out[key] = /^(?:token|secret|password)$/i.test(key) ? '[REDACTED]' : meta[key];
  }
  return out;
}
export function createAuditChain() {
  const rows = [];
  let head = GENESIS;
  return {
    append({ actor, action, meta = {} } = {}) {
      const body = { seq: rows.length + 1, actor: String(actor), action: String(action), meta: scrub(meta), prevHash: head };
      const hash = hashOf(body);
      const entry = { ...body, hash };
      rows.push(entry);
      head = hash;
      return entry;
    },
    exportLines: () => rows.map((r) => JSON.stringify(r)),
    verify(lines = []) {
      let prev = GENESIS;
      for (let i = 0; i < lines.length; i += 1) {
        const expectedSeq = i + 1;
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { return { ok: false, brokenSeq: expectedSeq }; }
        const body = { seq: rec.seq, actor: rec.actor, action: rec.action, meta: rec.meta, prevHash: rec.prevHash };
        if (rec.seq !== expectedSeq || rec.prevHash !== prev || hashOf(body) !== rec.hash) {
          return { ok: false, brokenSeq: expectedSeq };
        }
        prev = rec.hash;
      }
      return { ok: true, brokenSeq: null, entries: lines.length, headHash: prev };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `import crypto from 'node:crypto';
export function createAuditChain() {
  const rows = [];
  return {
    append({ actor, action, meta = {} } = {}) {
      const body = { seq: rows.length + 1, actor, action, meta };
      const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      rows.push({ ...body, hash });
    },
    exportLines: () => rows.map((r) => JSON.stringify(r)),
    verify(lines = []) {
      for (let i = 0; i < lines.length; i += 1) {
        const r = JSON.parse(lines[i]);
        const h = crypto.createHash('sha256').update(JSON.stringify({ seq: r.seq, actor: r.actor, action: r.action, meta: r.meta })).digest('hex');
        if (h !== r.hash) return { ok: false, brokenSeq: i + 1 };
      }
      return { ok: true, brokenSeq: null };
    }
  };
}\n`
    },
    async oracle(mod) {
      const c = mod.createAuditChain();
      c.append({ actor: 'alice', action: 'deploy', meta: { version: '1.0' } });
      c.append({ actor: 'bob', action: 'approve', meta: { version: '1.0' } });
      assert.equal(c.verify(c.exportLines()).ok, true);
    },
    defectProbes: [
      {
        id: 'tampering-deletion-or-secret-leak-undetected',
        async check(mod) {
          const flagged = await (async () => {
          const c = mod.createAuditChain();
          c.append({ actor: 'a', action: 'login', meta: { token: 'raw_secret_xyz' } });
          c.append({ actor: 'b', action: 'edit', meta: { id: 2 } });
          c.append({ actor: 'c', action: 'close', meta: { id: 3 } });
          const lines = c.exportLines();
          if (lines.join('\n').includes('raw_secret_xyz')) return true;
          const mutated = [lines[0], lines[1].replace('"edit"', '"forged"'), lines[2]];
          const deleted = [lines[0], lines[2]];
          return c.verify(mutated)?.ok !== false || c.verify(deleted)?.ok !== false;
          })();
          assert.equal(flagged, false, "defect probe triggered");
        }
      }
    ]
  }
];
