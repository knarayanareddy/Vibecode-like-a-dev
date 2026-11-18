/**
 * Sandboxed command runner and 8-probe live security conformance harness
 * (ADR 0011, roadmap P0.2, 2.2 & P3.2).
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { extensionError } from '../extension-utils.mjs';
import {
  buildSandboxCommand,
  detectSandboxBackends,
  inspectMaskedNodePrefix,
  resolveExecutableBindRoots,
  SECCOMP_DEFAULT_DIGEST,
  SECCOMP_DEFAULT_PATH,
  selectSandboxBackend
} from './backends.mjs';
import {
  assertWriteReceipt,
  checkResourceClaims,
  createSandboxReceipt,
  diffWorkspaceSnapshots,
  snapshotWorkspace,
  verifySandboxReceipt,
  workspaceTreeDigest
} from './receipt.mjs';

export {
  assertWriteReceipt,
  checkResourceClaims,
  createSandboxReceipt,
  detectSandboxBackends,
  inspectMaskedNodePrefix,
  resolveExecutableBindRoots,
  SECCOMP_DEFAULT_DIGEST,
  SECCOMP_DEFAULT_PATH,
  selectSandboxBackend,
  snapshotWorkspace,
  verifySandboxReceipt,
  workspaceTreeDigest
};

const SAFE_ENV_KEYS = new Set(['LANG', 'LC_ALL', 'TZ', 'NO_COLOR', 'CI', 'FORCE_COLOR']);
const VLD_ENV_PREFIX = 'VLD_';
const SECRET_ENV = /(?:token|secret|password|credential|authorization|api[_-]?key)/i;
const KILL_GRACE_MS = 250;

function terminateTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {}
  const killer = setTimeout(() => {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
  }, KILL_GRACE_MS);
  killer.unref?.();
}

function scrubEnvironment(env = {}) {
  const clean = Object.create(null);
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!SAFE_ENV_KEYS.has(key) && !key.startsWith(VLD_ENV_PREFIX)) continue;
    if (SECRET_ENV.test(key) || SECRET_ENV.test(String(value ?? ''))) continue;
    const text = String(value ?? '');
    if (/[\r\n\0]/.test(text) || text.length > 2048) continue;
    clean[key] = text;
  }
  return clean;
}

/**
 * Classify a conformance probe result, strictly distinguishing `launch-failed`
 * from `leak-detected` so `'LEAKED'` is ONLY reported when a canary sentinel
 * was actually read, written outside, or transmitted.
 */
export function classifyConformanceProbe({
  id,
  expectSuccess = false,
  runOk,
  canaryRead = false,
  policyOk = true,
  exitCode = null,
  stderr = '',
  passedDetail,
  leakDetail,
  policyFailedDetail = null
}) {
  if (canaryRead) {
    return {
      id,
      passed: false,
      status: 'leak-detected',
      canaryRead: true,
      detail: `LEAKED: ${leakDetail}`
    };
  }
  if (expectSuccess) {
    if (!runOk) {
      const snippet = String(stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return {
        id,
        passed: false,
        status: 'launch-failed',
        canaryRead: false,
        detail: `launch-failed: probe exited ${exitCode ?? 'non-zero'} without reading canary${snippet ? ` (${snippet})` : ''}`
      };
    }
    if (!policyOk) {
      return {
        id,
        passed: false,
        status: 'policy-failed',
        canaryRead: false,
        detail: policyFailedDetail ?? 'policy-failed: probe output or receipt did not satisfy contract'
      };
    }
    return {
      id,
      passed: true,
      status: 'passed',
      canaryRead: false,
      detail: passedDetail
    };
  }
  // Negative probe: expects confined process to be blocked (`!runOk`) and `canaryRead === false`.
  if (runOk || !policyOk) {
    return {
      id,
      passed: false,
      status: 'policy-failed',
      canaryRead: false,
      detail: policyFailedDetail ?? 'policy-failed: restricted operation exited 0 without reading canary'
    };
  }
  return {
    id,
    passed: true,
    status: 'passed',
    canaryRead: false,
    detail: passedDetail
  };
}

/**
 * Execute one fixed-argv command inside the selected sandbox backend and return
 * both bounded stdout/stderr and a cryptographically digested `receipt`.
 */
export async function runSandboxed({
  id,
  executable = process.execPath,
  args = [],
  workspace,
  mode = 'read-only',
  network = false,
  allowChildProcess = false,
  extraReadPaths = [],
  broker = null,
  env = {},
  stdin = null,
  policyDigest = null,
  backend: requestedBackend = 'auto',
  requireOs = false,
  onFallback = null,
  ociImage,
  seccompProfile = SECCOMP_DEFAULT_PATH,
  limits = {},
  signal = null,
  onChunk = null
} = {}) {
  if (!workspace || !existsSync(workspace)) {
    throw extensionError('sandbox workspace does not exist', 'SANDBOX_WORKSPACE_MISSING');
  }
  const stats = lstatSync(workspace);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw extensionError('sandbox workspace must be a real directory, not a symbolic link', 'SANDBOX_WORKSPACE_INVALID');
  }
  if (!['read-only', 'write-workspace'].includes(mode)) {
    throw extensionError('sandbox mode must be read-only or write-workspace', 'INVALID_SANDBOX_MODE');
  }

  const durationMs = Number.isSafeInteger(limits.durationMs) && limits.durationMs >= 50
    ? Math.min(limits.durationMs, 15 * 60 * 1_000)
    : 30_000;
  const outputBytesCap = Number.isSafeInteger(limits.outputBytes) && limits.outputBytes >= 512
    ? Math.min(limits.outputBytes, 2 * 1024 * 1024)
    : 256 * 1024;

  const realWorkspace = realpathSync(workspace);
  const selected = selectSandboxBackend({ requested: requestedBackend, executable, requireOs, onFallback });
  const beforeSnap = snapshotWorkspace(realWorkspace);
  const workspaceDigestBefore = workspaceTreeDigest(beforeSnap);
  const cleanEnv = scrubEnvironment(env);

  const brokerBinding = broker && typeof broker.binding === 'function'
    ? broker.binding()
    : broker;

  const invocation = buildSandboxCommand({
    backend: selected,
    executable,
    args,
    workspace: realWorkspace,
    mode,
    network,
    allowChildProcess,
    extraReadPaths,
    broker: brokerBinding,
    env: cleanEnv,
    ociImage,
    seccompProfile
  });

  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const outHash = createHash('sha256');
  let totalBytes = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutRetained = 0;
  let stderrRetained = 0;

  let execution;
  try {
    execution = await new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ outcome: 'cancelled', exitCode: null, signal: 'SIGTERM' });
        return;
      }
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let overflowed = false;

      const child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const onAbort = () => {
        cancelled = true;
        terminateTree(child);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        terminateTree(child);
      }, durationMs);

      const handleData = (stream, chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outHash.update(buf);
        totalBytes += buf.length;
        if (stream === 'stdout' && stdoutRetained < outputBytesCap) {
          const slice = buf.subarray(0, outputBytesCap - stdoutRetained);
          stdoutChunks.push(slice);
          stdoutRetained += slice.length;
        } else if (stream === 'stderr' && stderrRetained < outputBytesCap) {
          const slice = buf.subarray(0, outputBytesCap - stderrRetained);
          stderrChunks.push(slice);
          stderrRetained += slice.length;
        }
        if (typeof onChunk === 'function') {
          try { onChunk(stream, buf); } catch {}
        }
        if (totalBytes > outputBytesCap * 2) {
          overflowed = true;
          terminateTree(child);
        }
      };

      child.stdout?.on('data', (c) => handleData('stdout', c));
      child.stderr?.on('data', (c) => handleData('stderr', c));
      if (stdin !== null && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(stdin);
      }

      child.on('error', () => {
        finish({ outcome: 'failed', exitCode: null, signal: null });
      });
      child.on('close', (exitCode, exitSignal) => {
        const outcome = cancelled
          ? 'cancelled'
          : timedOut
            ? 'timed-out'
            : overflowed
              ? 'failed'
              : exitCode === 0
                ? 'completed'
                : 'failed';
        finish({ outcome, exitCode, signal: exitSignal ?? null });
      });
    });
  } finally {
    try { invocation.cleanup?.(); } catch {}
  }

  const finishedMs = Date.now();
  const finishedAt = new Date(finishedMs).toISOString();
  const afterSnap = snapshotWorkspace(realWorkspace);
  const workspaceDigestAfter = workspaceTreeDigest(afterSnap);
  const changedPaths = diffWorkspaceSnapshots(beforeSnap, afterSnap);
  const outputDigest = outHash.digest('hex');

  const brokerPolicy = broker && typeof broker.receiptPolicy === 'function'
    ? broker.receiptPolicy()
    : (broker?.policySummary ?? null);

  const receipt = createSandboxReceipt({
    id,
    backend: selected.id,
    mode,
    network,
    childProcess: allowChildProcess,
    brokerPolicy,
    policyDigest,
    seccompDigest: invocation.seccompDigest,
    workspaceDigestBefore,
    workspaceDigestAfter,
    changedPaths,
    outcome: execution.outcome,
    exitCode: execution.exitCode,
    signal: execution.signal,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedMs - startedMs),
    outputDigest,
    outputBytes: totalBytes
  });

  return {
    ok: execution.outcome === 'completed',
    outcome: execution.outcome,
    exitCode: execution.exitCode,
    signal: execution.signal,
    backend: selected.id,
    confinementClass: selected.confinementClass,
    fallbackReason: selected.fallbackReason ?? null,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    outputBytes: totalBytes,
    outputDigest,
    changedPaths,
    receipt
  };
}

/**
 * Execute all 8 ADR-0011 live confinement conformance probes against a backend.
 * Every probe reports `status: 'passed' | 'launch-failed' | 'leak-detected' | 'policy-failed'`
 * and only emits `'LEAKED'` when the canary sentinel was genuinely read or reached.
 */
export async function runSandboxConformance({
  backend = 'auto',
  executable = process.execPath,
  onFallback = null
} = {}) {
  const selected = selectSandboxBackend({ requested: backend, executable, onFallback });
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vld-sbx-conf-')));
  const workspace = path.join(root, 'workspace');
  const outsideDir = path.join(root, 'outside');
  const fakeCredDir = path.join(root, 'cred-home', '.ssh');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(fakeCredDir, { recursive: true });

  const outsideSecret = path.join(outsideDir, 'sentinel.txt');
  const outsideWriteTarget = path.join(outsideDir, 'escaped.txt');
  const credFile = path.join(fakeCredDir, 'id_ed25519');
  const OUTSIDE_CANARY = 'TOP_SECRET_SENTINEL_42';
  const SSH_CANARY = 'FAKE_SSH_KEY_MATERIAL_99';
  const PARENT_ENV_CANARY = 'HOST_PARENT_AWS_CANARY_77';
  const INJECTED_ENV_CANARY = 'INJECTED_AWS_CANARY_88';
  writeFileSync(outsideSecret, `${OUTSIDE_CANARY}\n`, 'utf8');
  writeFileSync(credFile, `${SSH_CANARY}\n`, 'utf8');
  writeFileSync(path.join(workspace, 'seed.txt'), 'initial\n', 'utf8');
  let escapeRelPath = 'escape-link.txt';
  try {
    symlinkSync(outsideSecret, path.join(workspace, 'escape-link.txt'));
  } catch (err) {
    if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'ENOTSUP')) {
      symlinkSync(outsideDir, path.join(workspace, 'escape-dir'), 'junction');
      escapeRelPath = path.join('escape-dir', 'sentinel.txt');
    } else {
      throw err;
    }
  }

  const writeProbe = (name, code) => {
    const file = path.join(workspace, name);
    writeFileSync(file, code, 'utf8');
    return file;
  };

  // Sanity check that the runtime itself launches inside the sandbox so negative
  // probes never misclassify a broken launcher as "blocked".
  const pBoot = writeProbe('_p0_boot.mjs', "process.stdout.write('BOOT_OK');\n");
  const rBoot = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', args: [pBoot] });
  const bootOk = rBoot.ok && rBoot.stdout.includes('BOOT_OK');

  const server = net.createServer((socket) => {
    socket.end('HOST_REACHED');
  });
  let serverPort = 0;
  let hostReached = false;
  server.on('connection', () => { hostReached = true; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    resolve();
  }));

  const probes = [];
  const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = PARENT_ENV_CANARY;

  const pushNegative = (id, run, canaryRead, passedDetail, leakDetail, extraPolicyOk = true) => {
    if (!bootOk && !canaryRead) {
      probes.push({
        id,
        passed: false,
        status: 'launch-failed',
        canaryRead: false,
        detail: `launch-failed: sandbox runtime failed baseline exec (${rBoot.exitCode ?? 'non-zero'}); no canary read`
      });
      return;
    }
    probes.push(classifyConformanceProbe({
      id,
      expectSuccess: false,
      runOk: run.ok,
      canaryRead,
      policyOk: extraPolicyOk,
      exitCode: run.exitCode,
      stderr: run.stderr,
      passedDetail,
      leakDetail
    }));
  };

  try {
    // Probe 1: Read outside workspace denied
    const p1 = writeProbe('_p1.mjs', `import fs from 'node:fs';\nconsole.log(fs.readFileSync(${JSON.stringify(outsideSecret)}, 'utf8'));\n`);
    const r1 = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', args: [p1] });
    pushNegative(
      'fs-read-outside-denied',
      r1,
      r1.stdout.includes(OUTSIDE_CANARY),
      'outside-workspace file read blocked',
      'outside-workspace sentinel canary was read'
    );

    // Probe 2: Write outside workspace denied (even in write-workspace mode)
    const p2 = writeProbe('_p2.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(outsideWriteTarget)}, 'ESCAPE_WRITE_CANARY');\n`);
    const r2 = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'write-workspace', args: [p2] });
    pushNegative(
      'fs-write-outside-denied',
      r2,
      existsSync(outsideWriteTarget),
      'outside-workspace file write blocked',
      'outside-workspace sentinel file was created'
    );

    // Probe 3: Write inside workspace denied in read-only mode
    const p3 = writeProbe('_p3.mjs', `import fs from 'node:fs';\nfs.writeFileSync('mutated.txt', 'RO_MUTATION_CANARY');\n`);
    const r3 = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', args: [p3] });
    pushNegative(
      'fs-write-readonly-denied',
      r3,
      existsSync(path.join(workspace, 'mutated.txt')),
      'read-only workspace mutation blocked',
      'read-only workspace file was created',
      r3.receipt.workspaceDigestBefore === r3.receipt.workspaceDigestAfter
    );

    // Probe 4: Write inside workspace succeeds in write-workspace mode & receipt captures diff
    const p4 = writeProbe('_p4.mjs', `import fs from 'node:fs';\nfs.writeFileSync('allowed-out.txt', 'verified-write\\n');\n`);
    const r4 = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'write-workspace', args: [p4] });
    const rv4 = verifySandboxReceipt(r4.receipt, { expectedWorkspaceDigestAfter: workspaceTreeDigest(workspace) });
    const wroteAllowed = existsSync(path.join(workspace, 'allowed-out.txt'))
      && readFileSync(path.join(workspace, 'allowed-out.txt'), 'utf8') === 'verified-write\n';
    probes.push(classifyConformanceProbe({
      id: 'fs-write-workspace-receipt',
      expectSuccess: true,
      runOk: r4.ok,
      canaryRead: false,
      policyOk: rv4.ok && r4.changedPaths.includes('allowed-out.txt') && wroteAllowed,
      exitCode: r4.exitCode,
      stderr: r4.stderr,
      passedDetail: 'workspace mutation permitted and attested in receipt',
      leakDetail: '',
      policyFailedDetail: `receipt/write mismatch: ${rv4.errors.join('; ') || 'missing allowed-out.txt'}`
    }));

    // Probe 5: Host credentials (env secrets + SSH key fixture) denied/scrubbed.
    // Strictly separates `launch-failed` (!r5.ok, no canary seen) from `leak-detected` (canary actually read).
    const p5 = writeProbe('_p5.mjs', [
      "import fs from 'node:fs';",
      "const leakedEnv = process.env.AWS_SECRET_ACCESS_KEY || '';",
      `let leakedKey = ''; try { leakedKey = fs.readFileSync(${JSON.stringify(credFile)}, 'utf8'); } catch {}`,
      "let homeSsh = ''; try { homeSsh = fs.readdirSync((process.env.HOME || process.env.USERPROFILE || '') + '/.ssh').join(','); } catch {}",
      "console.log(JSON.stringify({ ok: true, leakedEnv, leakedKey, homeSsh }));"
    ].join('\n'));
    const r5 = await runSandboxed({
      backend: selected.id,
      executable,
      workspace,
      mode: 'read-only',
      env: { AWS_SECRET_ACCESS_KEY: INJECTED_ENV_CANARY, LANG: 'C.UTF-8' },
      args: [p5]
    });
    let parsed5 = null;
    if (r5.ok) {
      try { parsed5 = JSON.parse(r5.stdout.trim()); } catch { parsed5 = null; }
    }
    const rawOut5 = `${r5.stdout}\n${r5.stderr}`;
    const credCanaryRead = rawOut5.includes(SSH_CANARY)
      || rawOut5.includes(PARENT_ENV_CANARY)
      || rawOut5.includes(INJECTED_ENV_CANARY)
      || Boolean(parsed5 && (parsed5.leakedEnv !== '' || parsed5.homeSsh !== ''));
    probes.push(classifyConformanceProbe({
      id: 'credential-access-denied',
      expectSuccess: true,
      runOk: r5.ok,
      canaryRead: credCanaryRead,
      policyOk: Boolean(parsed5?.ok === true && parsed5.leakedEnv === '' && parsed5.leakedKey === '' && parsed5.homeSsh === ''),
      exitCode: r5.exitCode,
      stderr: r5.stderr,
      passedDetail: 'parent secrets, injected secrets and SSH fixture all inaccessible',
      leakDetail: 'credential canary was read inside sandbox',
      policyFailedDetail: 'credential probe returned malformed payload (no canary read)'
    }));

    // Probe 6: Symlink escape outside workspace denied
    const p6 = writeProbe('_p6.mjs', `import fs from 'node:fs';\nconsole.log(fs.readFileSync(${JSON.stringify(escapeRelPath)}, 'utf8'));\n`);
    const r6 = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', args: [p6] });
    pushNegative(
      'symlink-escape-denied',
      r6,
      r6.stdout.includes(OUTSIDE_CANARY),
      'symlink traversal outside workspace blocked',
      'outside sentinel canary was read via symlink'
    );

    // Probe 7: Outbound TCP network egress denied
    const p7 = writeProbe('_p7.mjs', [
      "import net from 'node:net';",
      `const sock = net.createConnection({ host: '127.0.0.1', port: ${serverPort} });`,
      "sock.setTimeout(1200);",
      "sock.on('connect', () => { console.log('CONNECTED'); sock.destroy(); process.exit(0); });",
      "sock.on('timeout', () => { sock.destroy(); process.exit(2); });",
      "sock.on('error', () => { process.exit(3); });"
    ].join('\n'));
    const r7 = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', network: false, limits: { durationMs: 3000 }, args: [p7] });
    pushNegative(
      'network-egress-denied',
      r7,
      hostReached || r7.stdout.includes('CONNECTED'),
      'outbound TCP connection blocked before reaching listener',
      'outbound TCP socket reached host listener'
    );

    // Probe 8: Undeclared child process spawn denied AND runaway process terminated at timeout
    const p8a = writeProbe('_p8a.mjs', `import cp from 'node:child_process';\ncp.execFileSync(process.execPath, ['-e', "console.log('CHILD_SPAWN_CANARY')"]);\n`);
    const r8a = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', allowChildProcess: false, args: [p8a] });
    const p8b = writeProbe('_p8b.mjs', `setInterval(() => {}, 1000);\n`);
    const r8b = await runSandboxed({ backend: selected.id, executable, workspace, mode: 'read-only', limits: { durationMs: 250 }, args: [p8b] });
    const childCanary = r8a.stdout.includes('CHILD_SPAWN_CANARY');
    if (!bootOk && !childCanary) {
      probes.push({
        id: 'child-exec-and-timeout-enforced',
        passed: false,
        status: 'launch-failed',
        canaryRead: false,
        detail: `launch-failed: sandbox runtime failed baseline exec (${rBoot.exitCode ?? 'non-zero'}); no canary read`
      });
    } else {
      probes.push(classifyConformanceProbe({
        id: 'child-exec-and-timeout-enforced',
        expectSuccess: false,
        runOk: r8a.ok,
        canaryRead: childCanary,
        policyOk: r8b.outcome === 'timed-out',
        exitCode: r8a.exitCode,
        stderr: r8a.stderr,
        passedDetail: 'undeclared child spawn denied and runaway process killed on timeout',
        leakDetail: 'undeclared child process executed and printed canary',
        policyFailedDetail: `policy-failed: spawnOk=${r8a.ok} timeoutOutcome=${r8b.outcome}`
      }));
    }
  } finally {
    if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }

  const failingProbes = probes.filter((p) => !p.passed).map((p) => p.id);
  return {
    ok: failingProbes.length === 0,
    backend: selected.id,
    confinementClass: selected.confinementClass,
    fallbackReason: selected.fallbackReason ?? null,
    passed: probes.length - failingProbes.length,
    total: probes.length,
    failingProbes,
    probes
  };
}
