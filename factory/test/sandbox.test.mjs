/**
 * Roadmap P0.1 & P0.2 baseline & sandbox preflight regression suite:
 *   - `scripts/bootstrap.sh` warns on masked Node prefixes ($HOME, /tmp) and enforces --strict-prefix
 *   - 3-probe mini-conformance (`exec`, `workspace-write`, `network-deny`) ranks backends by score and falls through with reasons
 *   - Node installed under `$HOME/.nvm`, `$HOME/.local/share/fnm`, `$HOME/.volta`, `$HOME/.asdf`, and `/tmp` passes 8/8 on `linux-ns` and `node-permission`
 *   - Probe classification splits `launch-failed` vs `leak-detected`; never prints `LEAKED` unless canary read
 *   - `vld doctor` FAILs loudly (non-zero) with exact failing probe IDs whenever best backend scores < 8/8
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../lib/doctor.mjs';
import {
  classifyConformanceProbe,
  detectSandboxBackends,
  inspectMaskedNodePrefix,
  resolveExecutableBindRoots,
  runSandboxConformance,
  runSandboxed,
  selectSandboxBackend,
  verifySandboxReceipt
} from '../lib/sandbox/index.mjs';
import { createModelBroker, probeBrokerConformance } from '../lib/sandbox/broker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Stage a real runnable copy/hardlink of process.execPath at targetBin. */
function stageNodeBinary(targetBin) {
  mkdirSync(path.dirname(targetBin), { recursive: true });
  const src = realpathSync(process.execPath);
  try {
    linkSync(src, targetBin);
  } catch {
    copyFileSync(src, targetBin);
    chmodSync(targetBin, 0o755);
  }
  return targetBin;
}

test('P0.1 devcontainer and bootstrap.sh exist and warn when Node sits under /tmp or $HOME', { skip: process.platform === 'win32' }, (t) => {
  const devcontainer = JSON.parse(readFileSync(path.join(ROOT, '.devcontainer', 'devcontainer.json'), 'utf8'));
  assert.match(devcontainer.image, /22/);
  assert.match(devcontainer.onCreateCommand, /bubblewrap/);
  assert.match(devcontainer.onCreateCommand, /podman/);
  assert.match(devcontainer.postCreateCommand, /bootstrap\.sh/);

  const contrib = readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  for (const token of ['linux-ns', 'bwrap', 'oci', 'node-permission', 'bootstrap.sh']) {
    assert.ok(contrib.includes(token), `CONTRIBUTING.md mentions ${token}`);
  }

  const tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vld-boot-node-')));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const tmpNode = stageNodeBinary(path.join(tmpRoot, 'v22.22.0', 'bin', 'node'));

  const warnRun = spawnSync('bash', [path.join(ROOT, 'scripts', 'bootstrap.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, VLD_NODE_BIN: tmpNode }
  });
  assert.equal(warnRun.status, 0, `${warnRun.stdout}\n${warnRun.stderr}`);
  assert.match(warnRun.stderr, /WARNING: Node install prefix/);
  assert.match(warnRun.stderr, /\/usr\/local/);

  const strictRun = spawnSync('bash', [path.join(ROOT, 'scripts', 'bootstrap.sh'), '--strict-prefix'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, VLD_NODE_BIN: tmpNode }
  });
  assert.equal(strictRun.status, 2);
});

test('P0.2 detectSandboxBackends runs 3-probe mini-conformance, ranks by score, and falls through with reason', () => {
  const realProbe = detectSandboxBackends({ refresh: true });
  assert.ok(realProbe.preferred, 'at least one backend passes 3/3 preflight');
  const winner = realProbe.backends.find((b) => b.id === realProbe.preferred);
  assert.equal(winner.preflight.passed, 3);
  assert.equal(winner.preflight.total, 3);
  assert.deepEqual(winner.preflight.probes.map((p) => p.id), ['exec', 'workspace-write', 'network-deny']);

  // Simulate higher-strength OS backends scoring 1/3 while node-permission scores 3/3:
  // ranking must fall through to node-permission and surface the exact fallback reason.
  const fallbackMessages = [];
  const selected = selectSandboxBackend({
    requested: 'auto',
    onFallback: (msg) => fallbackMessages.push(msg),
    preflightRunner: (backend) => {
      if (backend.id === 'node-permission') {
        return {
          passed: 3,
          total: 3,
          score: 1,
          ok: true,
          failedProbes: [],
          probes: [
            { id: 'exec', passed: true, status: 'passed', detail: 'ok' },
            { id: 'workspace-write', passed: true, status: 'passed', detail: 'ok' },
            { id: 'network-deny', passed: true, status: 'passed', detail: 'ok' }
          ],
          reason: null
        };
      }
      return {
        passed: 1,
        total: 3,
        score: 0.3333,
        ok: false,
        failedProbes: ['workspace-write', 'network-deny'],
        probes: [
          { id: 'exec', passed: true, status: 'passed', detail: 'ok' },
          { id: 'workspace-write', passed: false, status: 'launch-failed', detail: 'fail' },
          { id: 'network-deny', passed: false, status: 'launch-failed', detail: 'fail' }
        ],
        reason: '1/3 preflight (workspace-write, network-deny failed)'
      };
    }
  });
  assert.equal(selected.id, 'node-permission');
  if (process.platform === 'linux' && realProbe.backends.some((b) => b.id === 'linux-ns' && b.binaryFound)) {
    assert.equal(fallbackMessages.length, 1);
    assert.match(fallbackMessages[0], /linux-ns scored 1\/3 \(workspace-write, network-deny\); fell back to node-permission/);
  }
});

test('P0.2 probe classifier splits launch-failed vs leak-detected and never prints LEAKED unless canary was read', () => {
  const launchFail = classifyConformanceProbe({
    id: 'credential-access-denied',
    expectSuccess: true,
    runOk: false,
    canaryRead: false,
    exitCode: 127,
    stderr: '/home/user/.nvm/versions/node/v22/bin/node: not found',
    passedDetail: 'ok',
    leakDetail: 'credential canary was read'
  });
  assert.equal(launchFail.passed, false);
  assert.equal(launchFail.status, 'launch-failed');
  assert.equal(launchFail.canaryRead, false);
  assert.doesNotMatch(launchFail.detail, /LEAKED/i);
  assert.match(launchFail.detail, /launch-failed/);

  const realLeak = classifyConformanceProbe({
    id: 'credential-access-denied',
    expectSuccess: true,
    runOk: true,
    canaryRead: true,
    exitCode: 0,
    stderr: '',
    passedDetail: 'ok',
    leakDetail: 'credential canary was read'
  });
  assert.equal(realLeak.passed, false);
  assert.equal(realLeak.status, 'leak-detected');
  assert.equal(realLeak.canaryRead, true);
  assert.match(realLeak.detail, /^LEAKED:/);

  const policyFail = classifyConformanceProbe({
    id: 'fs-read-outside-denied',
    expectSuccess: false,
    runOk: true,
    canaryRead: false,
    exitCode: 0,
    passedDetail: 'blocked',
    leakDetail: 'sentinel read'
  });
  assert.equal(policyFail.passed, false);
  assert.equal(policyFail.status, 'policy-failed');
  assert.doesNotMatch(policyFail.detail, /LEAKED/i);
});

test('P0.2 vld doctor reports FAIL + exact failing probe IDs when best backend scores below 8/8', () => {
  const degraded = runDoctor({
    projectDir: ROOT,
    conformanceRunner: (backend) => ({
      ok: false,
      backend,
      passed: 5,
      total: 8,
      failingProbes: ['fs-write-workspace-receipt', 'credential-access-denied', 'network-egress-denied'],
      probes: []
    })
  });
  assert.equal(degraded.ok, false, 'doctor must FAIL when conformance < 8/8');
  const sbxCheck = degraded.checks.find((c) => c.id === 'sandbox');
  assert.equal(sbxCheck.status, 'fail');
  assert.match(sbxCheck.detail, /5\/8/);
  for (const id of ['fs-write-workspace-receipt', 'credential-access-denied', 'network-egress-denied']) {
    assert.ok(sbxCheck.detail.includes(id), `doctor detail lists failing probe ${id}`);
    assert.ok(sbxCheck.failingProbes.includes(id));
  }
});

test('P0.2 nvm, fnm, volta, asdf ($HOME) and /tmp Node layouts pass 8/8 conformance without exposing $HOME siblings', { skip: process.platform === 'win32' }, async (t) => {
  const homeReal = realpathSync(os.homedir());
  const suffix = `v22.99.0-vldtest-${process.pid}`;
  const createdDirs = [];
  const registerCleanup = (dir) => {
    createdDirs.push(dir);
  };
  t.after(() => {
    for (const dir of createdDirs.reverse()) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  // Emulate real version-manager installation layouts under $HOME and /tmp.
  const nvmRoot = path.join(homeReal, '.nvm', 'versions', 'node', suffix);
  const fnmRoot = path.join(homeReal, '.local', 'share', 'fnm', 'node-versions', suffix);
  const voltaRoot = path.join(homeReal, '.volta', 'tools', 'image', 'node', suffix);
  const voltaShimDir = path.join(homeReal, `.vld-volta-shim-${process.pid}`, 'bin');
  const asdfRoot = path.join(homeReal, '.asdf', 'installs', 'nodejs', suffix);
  const tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vld-tmp-node-')));

  for (const d of [nvmRoot, fnmRoot, voltaRoot, path.dirname(voltaShimDir), asdfRoot, tmpRoot]) {
    registerCleanup(d);
  }

  // Also stage a sibling canary right inside $HOME to prove binding the Node prefix
  // never unmasks the rest of $HOME!
  const homeCanary = path.join(homeReal, `.vld-home-canary-${process.pid}`);
  writeFileSync(homeCanary, 'HOME_SIBLING_CANARY_SECRET\n', 'utf8');
  t.after(() => { try { rmSync(homeCanary, { force: true }); } catch {} });

  const voltaRealBin = stageNodeBinary(path.join(voltaRoot, 'bin', 'node'));
  mkdirSync(voltaShimDir, { recursive: true });
  const voltaShimBin = path.join(voltaShimDir, 'node');
  symlinkSync(voltaRealBin, voltaShimBin);

  const layouts = [
    { name: 'nvm', bin: stageNodeBinary(path.join(nvmRoot, 'bin', 'node')), expectedCategory: 'home' },
    { name: 'fnm', bin: stageNodeBinary(path.join(fnmRoot, 'installation', 'bin', 'node')), expectedCategory: 'home' },
    { name: 'volta', bin: voltaShimBin, expectedCategory: 'home' },
    { name: 'asdf', bin: stageNodeBinary(path.join(asdfRoot, 'bin', 'node')), expectedCategory: 'home' },
    { name: 'tmp', bin: stageNodeBinary(path.join(tmpRoot, 'node-v22', 'bin', 'node')), expectedCategory: 'tmp' }
  ];

  const hostProbe = detectSandboxBackends();
  const hasLinuxNs = hostProbe.backends.some((b) => b.id === 'linux-ns' && b.available);

  for (const layout of layouts) {
    const masked = inspectMaskedNodePrefix(layout.bin);
    assert.equal(masked.masked, true, `${layout.name} detected as masked`);
    assert.equal(masked.category, layout.expectedCategory);

    const bindRoots = resolveExecutableBindRoots(layout.bin);
    assert.ok(!bindRoots.includes(homeReal), `${layout.name} never binds $HOME directly`);
    assert.ok(!bindRoots.includes('/home'), `${layout.name} never binds /home directly`);
    assert.ok(!bindRoots.includes('/tmp'), `${layout.name} never binds /tmp directly`);

    if (hasLinuxNs) {
      const report = await runSandboxConformance({ backend: 'linux-ns', executable: layout.bin });
      assert.equal(report.passed, 8, `${layout.name} on linux-ns failed: ${JSON.stringify(report.probes, null, 2)}`);
      assert.equal(report.ok, true);
      for (const p of report.probes) {
        assert.equal(p.status, 'passed');
        assert.doesNotMatch(p.detail, /LEAKED/i);
      }
    } else {
      const report = await runSandboxConformance({ backend: 'node-permission', executable: layout.bin });
      assert.equal(report.passed, 8, `${layout.name} on node-permission failed: ${JSON.stringify(report.probes, null, 2)}`);
      assert.equal(report.ok, true);
    }
  }

  // Ensure empty parent version-manager folders are removed if we created them during the test.
  for (const maybeEmpty of [
    path.join(homeReal, '.nvm', 'versions', 'node'),
    path.join(homeReal, '.nvm', 'versions'),
    path.join(homeReal, '.nvm'),
    path.join(homeReal, '.local', 'share', 'fnm', 'node-versions'),
    path.join(homeReal, '.local', 'share', 'fnm'),
    path.join(homeReal, '.volta', 'tools', 'image', 'node'),
    path.join(homeReal, '.volta', 'tools', 'image'),
    path.join(homeReal, '.volta', 'tools'),
    path.join(homeReal, '.volta'),
    path.join(homeReal, '.asdf', 'installs', 'nodejs'),
    path.join(homeReal, '.asdf', 'installs'),
    path.join(homeReal, '.asdf')
  ]) {
    try {
      if (existsSync(maybeEmpty)) rmdirSync(maybeEmpty);
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Roadmap P3.2 — brokered model egress for the sandbox.
// ---------------------------------------------------------------------------

const CANARY_KEY = 'sk-test-canary-key-never-log-me-42';

function startFakeUpstream() {
  const calls = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      const payload = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ calls, port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function brokerRequest({ broker, provider = 'openai', urlPath = '/v1/chat/completions', token = null, headers = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const options = broker.mode === 'unix-socket'
      ? { socketPath: broker.binding().socketPath, path: urlPath, method: 'POST' }
      : { hostname: '127.0.0.1', port: broker.binding().port, path: urlPath, method: 'POST' };
    options.headers = {
      'content-type': 'application/json',
      'x-vld-provider': provider,
      'x-vld-broker-token': token === null ? broker.nonce : token,
      'content-length': Buffer.byteLength(raw),
      ...headers
    };
    // eslint-disable-next-line no-undef
    const req = httpRequest(options, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, bodyText: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

test('P3.2 model broker forwards only allow-listed POSTs, injects the key host-side, and logs redacted digests', async (t) => {
  const upstream = await startFakeUpstream();
  const broker = createModelBroker({
    mode: 'unix-socket',
    providers: { openai: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, tokenEnv: 'TEST_BROKER_CANARY' } },
    env: { TEST_BROKER_CANARY: CANARY_KEY },
    budget: { maxCalls: 8, maxTokens: 100000, maxCostUsd: 5 }
  });
  await broker.start();
  t.after(() => broker.stop());
  t.after(() => upstream.close());

  const res = await brokerRequest({
    broker,
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ultra-secret-prompt' }] },
    headers: { authorization: 'Bearer attacker-supplied', 'x-api-key': 'attacker-supplied-too' }
  });
  assert.equal(res.status, 200);
  assert.match(res.bodyText, /prompt_tokens/);

  assert.equal(upstream.calls.length, 1);
  const forwarded = upstream.calls[0];
  assert.equal(forwarded.url, '/v1/chat/completions');
  assert.equal(forwarded.headers.authorization, `Bearer ${CANARY_KEY}`, 'the broker injects the key host-side');
  assert.equal(forwarded.headers['x-api-key'], undefined, 'smuggled credentials never reach upstream');
  assert.match(forwarded.body, /ultra-secret-prompt/);

  const logs = broker.logs();
  assert.equal(logs.length, 1);
  assert.match(logs[0].requestDigest, /^[0-9a-f]{64}$/);
  assert.match(logs[0].responseDigest, /^[0-9a-f]{64}$/);
  assert.equal(logs[0].inputTokens, 10);
  assert.equal(logs[0].outputTokens, 5);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(CANARY_KEY), false, 'logs never contain the API key');
  assert.equal(serialized.includes('ultra-secret-prompt'), false, 'logs never contain prompt content');

  const policy = broker.receiptPolicy();
  assert.deepEqual(policy.allowedProviders, ['openai']);
  assert.equal(policy.callCount, 1);
  assert.equal(policy.totalTokens, 15);
  assert.match(policy.logDigest, /^[0-9a-f]{64}$/);
  assert.equal(policy.maxSteps, 8);
});

test('P3.2 model broker denies wrong nonce, unknown providers, stray paths, unlisted models, and exhausted budgets', async (t) => {
  const upstream = await startFakeUpstream();
  const broker = createModelBroker({
    mode: 'loopback-port',
    providers: { openai: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, tokenEnv: 'TEST_BROKER_CANARY' } },
    allowModels: ['gpt-4o-mini'],
    budget: { maxCalls: 1 },
    env: { TEST_BROKER_CANARY: CANARY_KEY }
  });
  await broker.start();
  t.after(() => broker.stop());
  t.after(() => upstream.close());

  const good = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
  const badNonce = await brokerRequest({ broker, body: good, token: 'wrong-nonce' });
  assert.equal(badNonce.status, 401);
  assert.match(badNonce.bodyText, /BROKER_AUTH/);

  const badProvider = await brokerRequest({ broker, provider: 'anthropic', body: good });
  assert.equal(badProvider.status, 403);
  assert.match(badProvider.bodyText, /BROKER_PROVIDER_DENIED/);

  const badPath = await brokerRequest({ broker, urlPath: '/admin', body: good });
  assert.equal(badPath.status, 403);
  assert.match(badPath.bodyText, /BROKER_PATH_DENIED/);

  const badModel = await brokerRequest({ broker, body: { ...good, model: 'gpt-4o' } });
  assert.equal(badModel.status, 403);
  assert.match(badModel.bodyText, /BROKER_MODEL_DENIED/);

  const first = await brokerRequest({ broker, body: good });
  assert.equal(first.status, 200);
  const second = await brokerRequest({ broker, body: good });
  assert.equal(second.status, 429);
  assert.match(second.bodyText, /MODEL_BUDGET_EXCEEDED/);
  assert.equal(upstream.calls.length, 1, 'denied requests never reach the model API');
});

test('P3.2 sandbox receipts bind the broker policy and still verify', async (t) => {
  const upstream = await startFakeUpstream();
  const broker = createModelBroker({
    mode: 'unix-socket',
    providers: { openai: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, tokenEnv: 'TEST_BROKER_CANARY' } },
    env: { TEST_BROKER_CANARY: CANARY_KEY }
  });
  await broker.start();
  t.after(() => broker.stop());
  t.after(() => upstream.close());

  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-broker-rcpt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = await runSandboxed({
    id: 'broker-receipt',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    workspace: root,
    mode: 'read-only',
    network: false,
    broker,
    limits: { durationMs: 15_000, outputBytes: 65536 }
  });
  assert.equal(run.ok, true, run.stderr);
  const policy = run.receipt.brokerPolicy;
  assert.ok(policy, 'receipt lists the broker policy');
  assert.equal(policy.mode, 'unix-socket');
  assert.deepEqual(policy.allowedProviders, ['openai']);
  assert.equal(policy.endpoint, broker.binding().socketPath);
  const verified = verifySandboxReceipt(run.receipt, { requireNoNetwork: true, allowBroker: true });
  assert.equal(verified.ok, true, verified.errors?.join('; '));
});

test('P3.2 broker conformance: egress denied elsewhere, only the broker answers, the key never leaks', async (t) => {
  const upstream = await startFakeUpstream();
  const broker = createModelBroker({
    mode: 'unix-socket',
    providers: { openai: { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, tokenEnv: 'TEST_BROKER_CANARY' } },
    env: { TEST_BROKER_CANARY: CANARY_KEY }
  });
  await broker.start();
  t.after(() => broker.stop());
  t.after(() => upstream.close());

  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-broker-conf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await probeBrokerConformance({ broker, workspace: root, canaryKeyValue: CANARY_KEY });
  assert.equal(result.ok, true, JSON.stringify(result.probes, null, 2));
  assert.equal(result.leakDetected, false);
  assert.equal(result.probes.length, 3);
  for (const probe of result.probes) {
    assert.equal(probe.passed, true, `${probe.id}: ${probe.detail}`);
    assert.equal(probe.detail.includes('LEAKED'), false);
  }
  assert.deepEqual(result.probes.map((p) => p.id), ['broker-egress-denied', 'broker-only-egress', 'broker-key-never-visible']);
});
