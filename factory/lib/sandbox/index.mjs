/**
 * Sandboxed command runner and 8-probe live security conformance harness
 * (ADR 0011, roadmap 2.2).
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
  env = {},
  stdin = null,
  policyDigest = null,
  backend: requestedBackend = 'auto',
  requireOs = false,
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
  const selected = selectSandboxBackend({ requested: requestedBackend, executable, requireOs });
  const beforeSnap = snapshotWorkspace(realWorkspace);
  const workspaceDigestBefore = workspaceTreeDigest(beforeSnap);
  const cleanEnv = scrubEnvironment(env);

  const invocation = buildSandboxCommand({
    backend: selected,
    executable,
    args,
    workspace: realWorkspace,
    mode,
    network,
    allowChildProcess,
    extraReadPaths,
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

  const receipt = createSandboxReceipt({
    id,
    backend: selected.id,
    mode,
    network,
    childProcess: allowChildProcess,
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
 * Every probe uses disposable temp files, sentinel credentials and a loopback
 * TCP server inside the current host — no external network access required.
 */
export async function runSandboxConformance({ backend = 'auto' } = {}) {
  const selected = selectSandboxBackend({ requested: backend, executable: process.execPath });
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
  writeFileSync(outsideSecret, 'TOP_SECRET_SENTINEL_42\n', 'utf8');
  writeFileSync(credFile, 'FAKE_SSH_KEY_MATERIAL_99\n', 'utf8');
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

  // Start an ephemeral loopback TCP server on the host to prove network denial.
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
  process.env.AWS_SECRET_ACCESS_KEY = 'HOST_PARENT_AWS_SECRET_DO_NOT_LEAK';

  try {
    // Probe 1: Read outside workspace denied
    const p1 = writeProbe('_p1.mjs', `import fs from 'node:fs';\nconsole.log(fs.readFileSync(${JSON.stringify(outsideSecret)}, 'utf8'));\n`);
    const r1 = await runSandboxed({ backend: selected.id, workspace, mode: 'read-only', args: [p1] });
    probes.push({
      id: 'fs-read-outside-denied',
      passed: !r1.ok && !r1.stdout.includes('TOP_SECRET_SENTINEL_42'),
      detail: !r1.ok ? 'outside-workspace file read blocked' : 'LEAKED outside file'
    });

    // Probe 2: Write outside workspace denied (even in write-workspace mode)
    const p2 = writeProbe('_p2.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(outsideWriteTarget)}, 'pwned');\n`);
    const r2 = await runSandboxed({ backend: selected.id, workspace, mode: 'write-workspace', args: [p2] });
    probes.push({
      id: 'fs-write-outside-denied',
      passed: !r2.ok && !existsSync(outsideWriteTarget),
      detail: !r2.ok && !existsSync(outsideWriteTarget) ? 'outside-workspace file write blocked' : 'WROTE outside workspace'
    });

    // Probe 3: Write inside workspace denied in read-only mode
    const p3 = writeProbe('_p3.mjs', `import fs from 'node:fs';\nfs.writeFileSync('mutated.txt', 'nope');\n`);
    const r3 = await runSandboxed({ backend: selected.id, workspace, mode: 'read-only', args: [p3] });
    probes.push({
      id: 'fs-write-readonly-denied',
      passed: !r3.ok && !existsSync(path.join(workspace, 'mutated.txt')) && r3.receipt.workspaceDigestBefore === r3.receipt.workspaceDigestAfter,
      detail: !r3.ok ? 'read-only workspace mutation blocked' : 'MUTATED read-only workspace'
    });

    // Probe 4: Write inside workspace succeeds in write-workspace mode & receipt captures diff
    const p4 = writeProbe('_p4.mjs', `import fs from 'node:fs';\nfs.writeFileSync('allowed-out.txt', 'verified-write\\n');\n`);
    const r4 = await runSandboxed({ backend: selected.id, workspace, mode: 'write-workspace', args: [p4] });
    const rv4 = verifySandboxReceipt(r4.receipt, { expectedWorkspaceDigestAfter: workspaceTreeDigest(workspace) });
    probes.push({
      id: 'fs-write-workspace-receipt',
      passed: r4.ok && rv4.ok && r4.changedPaths.includes('allowed-out.txt') && readFileSync(path.join(workspace, 'allowed-out.txt'), 'utf8') === 'verified-write\n',
      detail: r4.ok && rv4.ok ? 'workspace mutation permitted and attested in receipt' : `failed: ${rv4.errors.join('; ')}`
    });

    // Probe 5: Host credentials (env secrets + SSH key fixture) denied/scrubbed
    const p5 = writeProbe('_p5.mjs', [
      "import fs from 'node:fs';",
      "const leakedEnv = process.env.AWS_SECRET_ACCESS_KEY || '';",
      `let leakedKey = ''; try { leakedKey = fs.readFileSync(${JSON.stringify(credFile)}, 'utf8'); } catch {}`,
      "let homeSsh = ''; try { homeSsh = fs.readdirSync((process.env.HOME || process.env.USERPROFILE || '') + '/.ssh').join(','); } catch {}",
      "console.log(JSON.stringify({ leakedEnv, leakedKey, homeSsh }));"
    ].join('\n'));
    const r5 = await runSandboxed({
      backend: selected.id,
      workspace,
      mode: 'read-only',
      env: { AWS_SECRET_ACCESS_KEY: 'INJECTED_SECRET', LANG: 'C.UTF-8' },
      args: [p5]
    });
    const parsed5 = r5.ok ? JSON.parse(r5.stdout.trim()) : { leakedEnv: '', leakedKey: '', homeSsh: '' };
    const cleanCreds = r5.ok
      && parsed5.leakedEnv === ''
      && !parsed5.leakedKey.includes('FAKE_SSH_KEY_MATERIAL_99')
      && parsed5.homeSsh === '';
    probes.push({
      id: 'credential-access-denied',
      passed: cleanCreds,
      detail: cleanCreds ? 'parent secrets, injected secrets and SSH fixture all inaccessible' : 'LEAKED credential material'
    });

    // Probe 6: Symlink escape outside workspace denied
    const p6 = writeProbe('_p6.mjs', `import fs from 'node:fs';\nconsole.log(fs.readFileSync(${JSON.stringify(escapeRelPath)}, 'utf8'));\n`);
    const r6 = await runSandboxed({ backend: selected.id, workspace, mode: 'read-only', args: [p6] });
    probes.push({
      id: 'symlink-escape-denied',
      passed: !r6.ok && !r6.stdout.includes('TOP_SECRET_SENTINEL_42'),
      detail: !r6.ok ? 'symlink traversal outside workspace blocked' : 'FOLLOWED outside symlink'
    });

    // Probe 7: Outbound TCP network egress denied
    const p7 = writeProbe('_p7.mjs', [
      "import net from 'node:net';",
      `const sock = net.createConnection({ host: '127.0.0.1', port: ${serverPort} });`,
      "sock.setTimeout(1200);",
      "sock.on('connect', () => { console.log('CONNECTED'); sock.destroy(); process.exit(0); });",
      "sock.on('timeout', () => { sock.destroy(); process.exit(2); });",
      "sock.on('error', () => { process.exit(3); });"
    ].join('\n'));
    const r7 = await runSandboxed({ backend: selected.id, workspace, mode: 'read-only', network: false, limits: { durationMs: 3000 }, args: [p7] });
    probes.push({
      id: 'network-egress-denied',
      passed: !r7.ok && !hostReached && !r7.stdout.includes('CONNECTED'),
      detail: !r7.ok && !hostReached ? 'outbound TCP connection blocked before reaching listener' : 'REACHED host TCP listener'
    });

    // Probe 8: Undeclared child process spawn denied AND runaway process terminated at timeout
    const p8a = writeProbe('_p8a.mjs', `import cp from 'node:child_process';\ncp.execFileSync(process.execPath, ['-e', "console.log('ESCAPED')"]);\n`);
    const r8a = await runSandboxed({ backend: selected.id, workspace, mode: 'read-only', allowChildProcess: false, args: [p8a] });
    const p8b = writeProbe('_p8b.mjs', `setInterval(() => {}, 1000);\n`);
    const r8b = await runSandboxed({ backend: selected.id, workspace, mode: 'read-only', limits: { durationMs: 250 }, args: [p8b] });
    const p8Ok = !r8a.ok && !r8a.stdout.includes('ESCAPED') && r8b.outcome === 'timed-out';
    probes.push({
      id: 'child-exec-and-timeout-enforced',
      passed: p8Ok,
      detail: p8Ok
        ? 'undeclared child spawn denied and runaway process killed on timeout'
        : `spawnOk=${r8a.ok} timeoutOutcome=${r8b.outcome}`
    });
  } finally {
    if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }

  return {
    ok: probes.every((p) => p.passed),
    backend: selected.id,
    confinementClass: selected.confinementClass,
    passed: probes.filter((p) => p.passed).length,
    total: probes.length,
    probes
  };
}
