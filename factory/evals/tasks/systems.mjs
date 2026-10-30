import assert from 'node:assert/strict';

export const SYSTEMS_TASKS = [
  {
    id: 'pipe-21-checkpoint-shipper',
    category: 'systems',
    title: 'Log shipper advancing checkpoint only after sink acknowledgement',
    ticket:
      'Implement `createShipper(sink)` in `src/index.mjs` with `shipBatch(lines, correlationId)`, `checkpoint()`, and `deadLetters()`. Each line is JSON with `{ offset, message }`. Parse valid lines, route malformed JSON lines to `deadLetters()` without aborting the batch, send valid records to `await sink(records)`, and advance `checkpoint()` to the highest shipped `offset` **only if `sink` resolves `{ ack: true }`**. If `sink` throws or returns `{ ack: false }`, keep the previous `checkpoint()`.',
    profile: {
      name: 'log-shipper',
      idea: 'A log-shipping data pipeline forwarding NDJSON batches to an analytics sink with at-least-once offset checkpoints.',
      kind: 'data-pipeline',
      stage: 'mvp',
      traits: ['persistence'],
      risks: { integrations: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createShipper() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createShipper(sink) {
  let offset = 0;
  const dead = [];
  return {
    checkpoint: () => offset,
    deadLetters: () => dead,
    async shipBatch(lines, correlationId = 'req-0') {
      const records = lines.map((l) => JSON.parse(l));
      offset = Math.max(offset, ...records.map((r) => r.offset));
      await sink(records);
      return { ok: true, shipped: records.length, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createShipper(sink) {
  let offset = 0;
  const dead = [];
  return {
    checkpoint: () => offset,
    deadLetters: () => [...dead],
    async shipBatch(lines, correlationId = 'req-0') {
      const records = [];
      for (const raw of lines) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed?.offset === 'number') records.push(parsed);
          else dead.push({ raw, correlationId });
        } catch {
          dead.push({ raw, correlationId });
        }
      }
      if (records.length === 0) return { ok: true, shipped: 0, checkpoint: offset, correlationId };
      try {
        const res = await sink(records);
        if (!res?.ack) return { ok: false, error: { code: 'SINK_NACK', correlationId }, checkpoint: offset };
        offset = Math.max(offset, ...records.map((r) => r.offset));
        return { ok: true, shipped: records.length, checkpoint: offset, correlationId };
      } catch {
        return { ok: false, error: { code: 'SINK_FAILED', correlationId }, checkpoint: offset };
      }
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createShipper(sink) {
  let offset = 0;
  const dead = [];
  return {
    checkpoint: () => offset,
    deadLetters: () => [...dead],
    async shipBatch(lines, correlationId = 'req-0') {
      const records = [];
      for (const raw of lines) {
        try { records.push(JSON.parse(raw)); } catch { dead.push({ raw, correlationId }); }
      }
      offset = Math.max(offset, ...records.map((r) => r.offset));
      const res = await sink(records);
      if (!res?.ack) return { ok: false, error: { code: 'SINK_NACK', correlationId } };
      return { ok: true, shipped: records.length, checkpoint: offset, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const s = mod.createShipper(async () => ({ ack: true }));
      const out = await s.shipBatch(['{"offset":1,"message":"a"}', '{"offset":2,"message":"b"}'], 'c1');
      assert.equal(out.ok, true);
      assert.equal(s.checkpoint(), 2);
    },
    defectProbes: [
      {
        id: 'checkpoint-advances-before-ack-or-malformed-line-crashes-batch',
        async check(mod) {
          let shouldAck = false;
          const s = mod.createShipper(async () => ({ ack: shouldAck }));
          await s.shipBatch(['{"offset":10,"message":"x"}', 'not-json'], 'c1');
          assert.equal(s.checkpoint(), 0, 'checkpoint advanced despite sink NACK');
          assert.equal(s.deadLetters().length, 1);
          shouldAck = true;
          await s.shipBatch(['{"offset":10,"message":"x"}'], 'c2');
          assert.equal(s.checkpoint(), 10);
        }
      }
    ]
  },
  {
    id: 'cli-22-exit-codes-json',
    category: 'systems',
    title: 'CLI runner separating stdout JSON, stderr diagnostics and exit codes',
    ticket:
      'Implement `runCli(argv, checkFn)` in `src/index.mjs` returning `{ code, stdout, stderr }`. Support `--help` (`code: 0`), `--version` (`code: 0`), and `check [--json] <target>`. Unknown flags or missing `<target>` must write usage to `stderr`, leave `stdout` empty, and return `code: 2`. When `--json` is passed, `stdout` must be valid parseable JSON with zero human banner text mixed in; `code` is `0` when `checkFn(target)` returns `{ ok: true }` and `1` when `{ ok: false, findings }`.',
    profile: {
      name: 'release-gate-cli',
      idea: 'A command-line release verifier with machine-readable JSON stdout, clean stderr diagnostics and predictable exit codes.',
      kind: 'cli',
      stage: 'production',
      traits: [],
      risks: {},
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function runCli() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function runCli(argv, checkFn) {
  if (argv.includes('--help')) return { code: 0, stdout: 'Usage: check <target>\\n', stderr: '' };
  if (argv.includes('--version')) return { code: 0, stdout: '1.0.0\\n', stderr: '' };
  const target = argv.find((a) => !a.startsWith('-') && a !== 'check');
  if (!target) return { code: 1, stdout: 'Error: missing target\\n', stderr: '' };
  const res = checkFn(target);
  return { code: res.ok ? 0 : 1, stdout: \`Checking \${target}...\\n\${JSON.stringify(res)}\\n\`, stderr: '' };
}\n`
    },
    reference: {
      'src/index.mjs': `const ALLOWED_FLAGS = new Set(['--help', '--version', '--json']);

export function runCli(argv = [], checkFn = () => ({ ok: true, findings: [] }), correlationId = 'req-0') {
  const unknown = argv.filter((arg) => arg.startsWith('-') && !ALLOWED_FLAGS.has(arg));
  if (unknown.length > 0) {
    return { code: 2, stdout: '', stderr: \`Unknown flag: \${unknown[0]}\\nUsage: cli check [--json] <target>\\n\`, correlationId };
  }
  if (argv.includes('--help')) {
    return { code: 0, stdout: 'Usage: cli check [--json] <target>\\n', stderr: '', correlationId };
  }
  if (argv.includes('--version')) {
    return { code: 0, stdout: '1.0.0\\n', stderr: '', correlationId };
  }
  const cmd = argv.find((arg) => !arg.startsWith('-'));
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const target = cmd === 'check' ? positional[1] : null;
  if (cmd !== 'check' || !target) {
    return { code: 2, stdout: '', stderr: 'Usage: cli check [--json] <target>\\n', correlationId };
  }
  const res = checkFn(target);
  const asJson = argv.includes('--json');
  const stdout = asJson
    ? \`\${JSON.stringify({ target, ok: Boolean(res.ok), findings: res.findings ?? [], correlationId })}\\n\`
    : \`\${res.ok ? 'PASS' : 'FAIL'} \${target}\\n\`;
  return { code: res.ok ? 0 : 1, stdout, stderr: '', correlationId };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function runCli(argv = [], checkFn = () => ({ ok: true, findings: [] }), correlationId = 'req-0') {
  if (argv.includes('--help')) return { code: 0, stdout: 'Usage\\n', stderr: '', correlationId };
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional[0] !== 'check' || !positional[1]) return { code: 1, stdout: 'Usage\\n', stderr: '', correlationId };
  const res = checkFn(positional[1]);
  return { code: res.ok ? 0 : 1, stdout: JSON.stringify(res), stderr: '', correlationId };
}\n`
    },
    async oracle(mod) {
      const ok = mod.runCli(['check', 'dist'], () => ({ ok: true, findings: [] }));
      assert.equal(ok.code, 0);
      const fail = mod.runCli(['check', 'dist'], () => ({ ok: false, findings: ['missing-license'] }));
      assert.equal(fail.code, 1);
    },
    defectProbes: [
      {
        id: 'invalid-flag-pollutes-stdout-or-json-is-unparseable',
        async check(mod) {
          const bad = mod.runCli(['check', '--bogus'], () => ({ ok: true }));
          assert.equal(bad.code, 2);
          assert.equal(bad.stdout, '', 'usage error wrote to stdout instead of stderr');
          assert.ok(bad.stderr.length > 0);
          const jsonOut = mod.runCli(['check', '--json', 'pkg'], () => ({ ok: false, findings: ['x'] }));
          assert.equal(jsonOut.code, 1);
          const parsed = JSON.parse(jsonOut.stdout);
          assert.equal(parsed.ok, false);
        }
      }
    ]
  },
  {
    id: 'lib-23-semver-compat',
    category: 'systems',
    title: 'Backwards-compatible schema validator library without input mutation',
    ticket:
      'Extend `validatePayload(input, requiredFields, options)` in `src/index.mjs`. Existing callers pass `(input, ["email", "name"])` and expect `{ valid: boolean, errors: string[] }`. Add optional `{ trimStrings = false, rejectUnknown = false }` without breaking positional two-argument callers, and **never mutate the caller\'s `input` object** when trimming — return normalized values on `result.value` instead.',
    profile: {
      name: 'tiny-validator',
      idea: 'A zero-dependency object validation library used by downstream packages with strict backwards compatibility.',
      kind: 'library',
      stage: 'prototype',
      traits: [],
      risks: {},
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': `export function validatePayload(input, requiredFields = []) {
  const errors = requiredFields.filter((f) => !input?.[f]).map((f) => \`missing \${f}\`);
  return { valid: errors.length === 0, errors };
}\n`,
      'tests/smoke.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePayload } from '../src/index.mjs';

test('two-argument positional call stays compatible', () => {
  assert.equal(validatePayload({ email: 'a@b.c' }, ['email']).valid, true);
});\n`
    },
    naive: {
      'src/index.mjs': `export function validatePayload(input, requiredFields = [], options = {}) {
  if (options.trimStrings && input) {
    for (const [k, v] of Object.entries(input)) if (typeof v === 'string') input[k] = v.trim();
  }
  const errors = requiredFields.filter((f) => !input?.[f]).map((f) => \`missing \${f}\`);
  return { valid: errors.length === 0, errors, value: input };
}\n`
    },
    reference: {
      'src/index.mjs': `export function validatePayload(input, requiredFields = [], options = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const { trimStrings = false, rejectUnknown = false } = options ?? {};
  const copy = {};
  for (const [k, v] of Object.entries(src)) {
    copy[k] = trimStrings && typeof v === 'string' ? v.trim() : v;
  }
  const errors = [];
  for (const field of requiredFields) {
    const val = copy[field];
    if (val === undefined || val === null || val === '') errors.push(\`missing \${field}\`);
  }
  if (rejectUnknown) {
    const allowed = new Set(requiredFields);
    for (const key of Object.keys(copy)) {
      if (!allowed.has(key)) errors.push(\`unknown \${key}\`);
    }
  }
  return { valid: errors.length === 0, errors, value: copy };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function validatePayload(input, requiredFields = [], options = {}) {
  if (options.trimStrings && input) {
    for (const [k, v] of Object.entries(input)) if (typeof v === 'string') input[k] = v.trim();
  }
  const errors = requiredFields.filter((f) => !input?.[f]).map((f) => \`missing \${f}\`);
  if (options.rejectUnknown) {
    for (const k of Object.keys(input ?? {})) if (!requiredFields.includes(k)) errors.push(\`unknown \${k}\`);
  }
  return { valid: errors.length === 0, errors, value: input };
}\n`
    },
    async oracle(mod) {
      const legacy = mod.validatePayload({ name: 'Ada' }, ['name']);
      assert.equal(legacy.valid, true);
      const unknown = mod.validatePayload({ name: 'Ada', extra: 1 }, ['name'], { rejectUnknown: true });
      assert.equal(unknown.valid, false);
    },
    defectProbes: [
      {
        id: 'mutates-caller-input-or-accepts-whitespace-only-when-trimmed',
        async check(mod) {
          const raw = Object.freeze({ name: '  Ada  ' });
          const res = mod.validatePayload(raw, ['name'], { trimStrings: true });
          assert.equal(res.valid, true);
          assert.equal(res.value.name, 'Ada');
          const blank = mod.validatePayload({ name: '   ' }, ['name'], { trimStrings: true });
          assert.equal(blank.valid, false, 'whitespace-only field passed after trimStrings');
        }
      }
    ]
  },
  {
    id: 'sync-24-offline-outbox',
    category: 'systems',
    title: 'Offline mutation outbox preserving FIFO order and surfacing version conflicts',
    ticket:
      'Implement `createOutbox()` in `src/index.mjs` with `enqueue({ opId, docId, baseVersion, patch })`, `sync(applyRemote, correlationId)`, and `conflicts()`. Replay queued mutations strictly in FIFO order, deduplicating repeated `opId`s. When `await applyRemote(entry)` returns `{ status: "conflict", serverDoc }`, record `{ opId, docId, serverDoc }` in `conflicts()` instead of overwriting or silently dropping the user\'s edit, and continue syncing independent documents.',
    profile: {
      name: 'field-notes-sync',
      idea: 'A mobile field-inspection app queuing offline edits locally and reconciling version conflicts when connectivity returns.',
      kind: 'mobile',
      stage: 'mvp',
      traits: ['offline', 'persistence', 'auth'],
      risks: { pii: true },
      constraints: { stack: 'javascript' }
    },
    starter: {
      'src/index.mjs': 'export function createOutbox() {\n  throw new Error("not implemented");\n}\n'
    },
    naive: {
      'src/index.mjs': `export function createOutbox() {
  const queue = [];
  return {
    enqueue(op) { queue.push(op); },
    conflicts: () => [],
    async sync(applyRemote, correlationId = 'req-0') {
      let applied = 0;
      while (queue.length > 0) {
        await applyRemote(queue.shift());
        applied += 1;
      }
      return { ok: true, applied, correlationId };
    }
  };
}\n`
    },
    reference: {
      'src/index.mjs': `export function createOutbox() {
  const queue = [];
  const seenOpIds = new Set();
  const conflictList = [];

  return {
    enqueue(op) {
      if (seenOpIds.has(op.opId)) return false;
      seenOpIds.add(op.opId);
      queue.push({ ...op });
      return true;
    },
    conflicts: () => [...conflictList],
    async sync(applyRemote, correlationId = 'req-0') {
      let applied = 0;
      const blockedDocs = new Set();
      const remaining = [];

      while (queue.length > 0) {
        const entry = queue.shift();
        if (blockedDocs.has(entry.docId)) {
          remaining.push(entry);
          continue;
        }
        const res = await applyRemote(entry);
        if (res?.status === 'conflict') {
          conflictList.push({ opId: entry.opId, docId: entry.docId, patch: entry.patch, serverDoc: res.serverDoc, correlationId });
          blockedDocs.add(entry.docId);
        } else {
          applied += 1;
        }
      }
      queue.push(...remaining);
      return { ok: conflictList.length === 0, applied, conflicts: conflictList.length, correlationId };
    }
  };
}\n`
    },
    semanticDrift: {
      'src/index.mjs': `export function createOutbox() {
  const queue = [];
  const conflictList = [];
  return {
    enqueue(op) { queue.push(op); },
    conflicts: () => [...conflictList],
    async sync(applyRemote, correlationId = 'req-0') {
      let applied = 0;
      while (queue.length > 0) {
        const entry = queue.shift();
        const res = await applyRemote(entry);
        if (res?.status === 'conflict') conflictList.push({ opId: entry.opId, docId: entry.docId });
        else applied += 1;
      }
      return { ok: conflictList.length === 0, applied, correlationId };
    }
  };
}\n`
    },
    async oracle(mod) {
      const order = [];
      const box = mod.createOutbox();
      box.enqueue({ opId: 'o1', docId: 'd1', baseVersion: 1, patch: 'a' });
      box.enqueue({ opId: 'o2', docId: 'd2', baseVersion: 1, patch: 'b' });
      await box.sync(async (e) => { order.push(e.opId); return { status: 'applied' }; }, 'c1');
      assert.deepEqual(order, ['o1', 'o2']);
    },
    defectProbes: [
      {
        id: 'duplicate-opid-replayed-or-conflict-silently-dropped',
        async check(mod) {
          const box = mod.createOutbox();
          box.enqueue({ opId: 'dup-1', docId: 'd1', baseVersion: 1, patch: 'edit-1' });
          box.enqueue({ opId: 'dup-1', docId: 'd1', baseVersion: 1, patch: 'edit-1' });
          box.enqueue({ opId: 'ok-2', docId: 'd2', baseVersion: 1, patch: 'edit-2' });
          let calls = 0;
          await box.sync(async (entry) => {
            calls += 1;
            if (entry.docId === 'd1') return { status: 'conflict', serverDoc: { version: 3 } };
            return { status: 'applied' };
          }, 'c1');
          assert.equal(calls, 2, 'duplicate opId was sent twice');
          assert.equal(box.conflicts().length, 1, 'version conflict was silently dropped');
        }
      }
    ]
  }
];
