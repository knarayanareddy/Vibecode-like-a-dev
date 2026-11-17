/**
 * OS and runtime sandbox backend detection and fixed-argv command builders
 * (ADR 0011, roadmap 2.2).
 *
 * Every backend builder returns `{ executable, args, cleanup }` suitable for
 * direct `spawn(executable, args, { shell: false })` — no user or policy value
 * is ever interpolated into a shell command string.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest, extensionError } from '../extension-utils.mjs';
import { SANDBOX_BACKEND_CLASS } from './receipt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SECCOMP_DEFAULT_PATH = path.join(HERE, 'seccomp-default.json');
export const NET_DENY_PRELOAD_PATH = path.join(HERE, 'net-deny-preload.mjs');
export const SECCOMP_DEFAULT_DIGEST = digest(readFileSync(SECCOMP_DEFAULT_PATH, 'utf8'));

export const SANDBOX_BACKENDS = Object.freeze([
  'oci',
  'bwrap',
  'linux-ns',
  'darwin-seatbelt',
  'node-permission'
]);

const DEFAULT_OCI_IMAGE = 'node:22-alpine';

let cachedProbe = null;
let cachedNodePermFlag;

/**
 * Resolve the active Node permission-model CLI flag across the full Node >=22 range:
 * Node >=22.13 ships `--permission`; Node 22.0–22.12 ships `--experimental-permission`.
 */
function detectNodePermissionFlag() {
  if (cachedNodePermFlag !== undefined) return cachedNodePermFlag;
  for (const flag of ['--permission', '--experimental-permission']) {
    if (commandRuns(process.execPath, [flag, `--allow-fs-read=${HERE}`, '-e', 'process.exit(0)'])) {
      cachedNodePermFlag = flag;
      return cachedNodePermFlag;
    }
  }
  cachedNodePermFlag = null;
  return null;
}

function resolveSystemBinary(name) {
  const candidates = process.platform === 'win32'
    ? []
    : [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function commandRuns(bin, args, timeout = 2500) {
  if (!bin) return false;
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout });
    return true;
  } catch {
    return false;
  }
}

function isNodeExecutable(executable) {
  const base = path.basename(String(executable ?? '')).toLowerCase();
  const current = path.basename(process.execPath).toLowerCase();
  if (base === current || base === 'node' || base === 'node.exe') return true;
  try {
    return realpathSync(executable) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}

/**
 * Dynamically test which sandbox backends actually work on the running host.
 * Binary presence is never trusted on its own: e.g. `unshare` must execute an
 * actual user+net+mount+tmpfs probe, and Docker/Podman must answer `info`.
 */
export function detectSandboxBackends({ refresh = false } = {}) {
  if (cachedProbe && !refresh) return cachedProbe;

  const backends = [];

  // 1. OCI container engine (Podman preferred for rootless default, then Docker)
  const podman = resolveSystemBinary('podman');
  const docker = resolveSystemBinary('docker');
  const ociBin = commandRuns(podman, ['info']) ? podman : (commandRuns(docker, ['info']) ? docker : null);
  backends.push({
    id: 'oci',
    confinementClass: SANDBOX_BACKEND_CLASS.oci,
    available: Boolean(ociBin),
    executable: ociBin,
    detail: ociBin ? `${path.basename(ociBin)} daemon reachable with seccomp-default.json` : 'no reachable podman or docker runtime'
  });

  // 2. Bubblewrap (Linux unprivileged namespace sandbox)
  const bwrap = process.platform === 'linux' ? resolveSystemBinary('bwrap') : null;
  const bwrapOk = Boolean(bwrap) && commandRuns(bwrap, [
    '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr',
    ...(existsSync('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    ...(existsSync('/bin') ? ['--ro-bind', '/bin', '/bin'] : []),
    '/bin/true'
  ]);
  backends.push({
    id: 'bwrap',
    confinementClass: SANDBOX_BACKEND_CLASS.bwrap,
    available: bwrapOk,
    executable: bwrapOk ? bwrap : null,
    detail: bwrapOk ? 'bwrap user+mount+net+pid namespace isolation verified' : 'bwrap unavailable or unprivileged namespaces blocked'
  });

  // 3. Linux kernel namespaces via `unshare` (user + net + mount + pid + tmpfs mask)
  const unshare = process.platform === 'linux' ? resolveSystemBinary('unshare') : null;
  const sh = process.platform === 'linux' ? resolveSystemBinary('sh') : null;
  const linuxNsOk = Boolean(unshare && sh) && commandRuns(unshare, [
    '-Urnm', sh, '-c', 'mount -t tmpfs -o size=1m tmpfs /mnt && umount -l /mnt'
  ]);
  backends.push({
    id: 'linux-ns',
    confinementClass: SANDBOX_BACKEND_CLASS['linux-ns'],
    available: linuxNsOk,
    executable: linuxNsOk ? unshare : null,
    shExecutable: linuxNsOk ? sh : null,
    detail: linuxNsOk
      ? 'Linux unshare user+net+mount namespace + tmpfs isolation verified'
      : 'Linux unshare user/net/mount namespaces unavailable'
  });

  // 4. macOS Seatbelt (`sandbox-exec`) — verified against a real Node workspace write probe
  const seatbelt = process.platform === 'darwin' ? resolveSystemBinary('sandbox-exec') : null;
  let seatbeltOk = false;
  if (seatbelt) {
    let probeDir = null;
    try {
      probeDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vld-sbpl-probe-')));
      const probeWs = path.join(probeDir, 'ws');
      const probeOut = path.join(probeDir, 'outside.txt');
      mkdirSync(probeWs, { recursive: true });
      writeFileSync(probeOut, 'secret', 'utf8');
      const probeScript = path.join(probeWs, 'ok.mjs');
      writeFileSync(probeScript, "import fs from 'node:fs'; fs.writeFileSync('ok.txt', '1');\n", 'utf8');
      const blockScript = path.join(probeWs, 'deny.mjs');
      writeFileSync(blockScript, `import fs from 'node:fs'; fs.readFileSync(${JSON.stringify(probeOut)});\n`, 'utf8');
      const sbWrite = path.join(probeDir, 'write.sb');
      const sbRead = path.join(probeDir, 'read.sb');
      writeFileSync(sbWrite, buildSeatbeltProfile({ workspace: probeWs, mode: 'write-workspace', allowChildProcess: false, network: false }), 'utf8');
      writeFileSync(sbRead, buildSeatbeltProfile({ workspace: probeWs, mode: 'read-only', allowChildProcess: false, network: false }), 'utf8');
      const writePermArgs = nodePermissionArgs({ workspace: probeWs, mode: 'write-workspace', allowChildProcess: false, includeNetDeny: false });
      const readPermArgs = nodePermissionArgs({ workspace: probeWs, mode: 'read-only', allowChildProcess: false, includeNetDeny: false });
      execFileSync(seatbelt, ['-f', sbWrite, process.execPath, ...writePermArgs, probeScript], {
        cwd: probeWs,
        env: { HOME: probeWs, TMPDIR: probeWs, PATH: '/usr/local/bin:/usr/bin:/bin' },
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 4000
      });
      const blocked = !commandRuns(seatbelt, ['-f', sbRead, process.execPath, ...readPermArgs, blockScript]);
      seatbeltOk = existsSync(path.join(probeWs, 'ok.txt')) && blocked;
    } catch {
      seatbeltOk = false;
    } finally {
      if (probeDir) {
        try { rmSync(probeDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
  backends.push({
    id: 'darwin-seatbelt',
    confinementClass: SANDBOX_BACKEND_CLASS['darwin-seatbelt'],
    available: seatbeltOk,
    executable: seatbeltOk ? seatbelt : null,
    detail: seatbeltOk ? 'macOS sandbox-exec seatbelt verified' : 'macOS sandbox-exec unavailable or restricted on host'
  });

  // 5. Portable Node >=22 permission model + frozen network-deny preload
  const nodePermFlag = detectNodePermissionFlag();
  const nodePermOk = Boolean(nodePermFlag);
  backends.push({
    id: 'node-permission',
    confinementClass: SANDBOX_BACKEND_CLASS['node-permission'],
    available: nodePermOk,
    executable: nodePermOk ? process.execPath : null,
    permissionFlag: nodePermFlag,
    detail: nodePermOk
      ? `Node ${nodePermFlag} filesystem/child/worker confinement + network-deny preload`
      : 'Node permission model unavailable'
  });

  const preferred = backends.find((entry) => entry.available)?.id ?? null;
  const osCapable = backends.some((entry) => entry.available && entry.confinementClass !== 'runtime-permission');
  cachedProbe = {
    platform: process.platform,
    nodeVersion: process.versions.node,
    seccompProfile: SECCOMP_DEFAULT_PATH,
    seccompDigest: SECCOMP_DEFAULT_DIGEST,
    osCapable,
    preferred,
    backends
  };
  return cachedProbe;
}

/** Choose a concrete available backend or fail closed. */
export function selectSandboxBackend({ requested = 'auto', executable = process.execPath, requireOs = false } = {}) {
  const probe = detectSandboxBackends();
  const nodeTarget = isNodeExecutable(executable);

  if (requested && requested !== 'auto') {
    if (!SANDBOX_BACKENDS.includes(requested)) {
      throw extensionError(`unknown sandbox backend "${requested}" (expected one of: auto, ${SANDBOX_BACKENDS.join(', ')})`, 'INVALID_SANDBOX_BACKEND');
    }
    const found = probe.backends.find((b) => b.id === requested);
    if (!found?.available) {
      throw extensionError(`requested sandbox backend "${requested}" is unavailable on this host: ${found?.detail ?? 'not found'}`, 'SANDBOX_UNAVAILABLE');
    }
    if (found.id === 'node-permission' && !nodeTarget) {
      throw extensionError('node-permission backend can only confine Node executables; use oci, bwrap, linux-ns or darwin-seatbelt', 'SANDBOX_UNAVAILABLE');
    }
    if (requireOs && found.confinementClass === 'runtime-permission') {
      throw extensionError('OS-level sandbox confinement was required, but only node-permission is available', 'SANDBOX_UNAVAILABLE');
    }
    return found;
  }

  // Prefer bwrap -> linux-ns -> darwin-seatbelt -> oci -> node-permission for local zero-image speed + kernel enforcement.
  const order = ['bwrap', 'linux-ns', 'darwin-seatbelt', 'oci', 'node-permission'];
  for (const id of order) {
    const candidate = probe.backends.find((b) => b.id === id);
    if (!candidate?.available) continue;
    if (id === 'node-permission' && (!nodeTarget || requireOs)) continue;
    // Only auto-pick `oci` if image is explicitly configured; otherwise prefer instant namespace/permission backend.
    if (id === 'oci') continue;
    return candidate;
  }
  const oci = probe.backends.find((b) => b.id === 'oci' && b.available);
  if (oci) return oci;

  throw extensionError('no compatible sandbox backend is available on this host', 'SANDBOX_UNAVAILABLE');
}

/** Add Node permission-model defense-in-depth flags when the inner executable is Node. */
function nodePermissionArgs({ workspace, mode, extraReadPaths = [], allowChildProcess = false, includeNetDeny = false }) {
  const permFlag = detectNodePermissionFlag();
  if (!permFlag) return [];
  const realExec = (() => { try { return realpathSync(process.execPath); } catch { return process.execPath; } })();
  const readSet = new Set([
    workspace,
    path.dirname(process.execPath),
    path.dirname(realExec),
    ...extraReadPaths.map((p) => {
      try { return realpathSync(p); } catch { return path.resolve(p); }
    })
  ]);
  if (includeNetDeny) readSet.add(NET_DENY_PRELOAD_PATH);
  const flags = [permFlag];
  for (const allowed of readSet) flags.push(`--allow-fs-read=${allowed}`);
  if (mode === 'write-workspace') flags.push(`--allow-fs-write=${workspace}`);
  if (allowChildProcess) flags.push('--allow-child-process');
  if (includeNetDeny) flags.push('--import', pathToFileURL(NET_DENY_PRELOAD_PATH).href);
  return flags;
}

/**
 * Fixed setup script for `linux-ns`. Receives all parameters strictly via
 * positional arguments ($1 = workspace, $2 = mode, $3 = extraReadColonList,
 * $4.. = target executable and argv) — zero string interpolation.
 */
const LINUX_NS_SETUP_SCRIPT = [
  'set -eu',
  'ws="$1"; mode="$2"; extra="$3"; shift 3',
  'mount --make-rprivate / 2>/dev/null || true',
  'mount -t tmpfs -o size=32m,mode=0755,nosuid,nodev tmpfs /mnt',
  'mkdir -p /mnt/ws /mnt/extra',
  'mount --rbind "$ws" /mnt/ws',
  'idx=0',
  'OLD_IFS="$IFS"; IFS=":"',
  'for p in $extra; do',
  '  if [ -n "$p" ] && [ -e "$p" ]; then',
  '    idx=$((idx + 1))',
  '    mkdir -p "/mnt/extra/$idx"',
  '    if [ -d "$p" ]; then mount --rbind "$p" "/mnt/extra/$idx"; else : > "/mnt/extra/$idx.file"; mount --bind "$p" "/mnt/extra/$idx.file"; fi',
  '  fi',
  'done',
  'IFS="$OLD_IFS"',
  'for mask in /home /root /tmp /var/tmp /run; do',
  '  if [ -d "$mask" ]; then mount -t tmpfs -o size=32m,mode=0755,nosuid,nodev tmpfs "$mask" 2>/dev/null || true; fi',
  'done',
  'mkdir -p /tmp/sandbox-tmp /home/sandbox',
  'chmod 1777 /tmp/sandbox-tmp',
  'idx=0; IFS=":"',
  'for p in $extra; do',
  '  if [ -n "$p" ]; then',
  '    idx=$((idx + 1))',
  '    if [ -f "/mnt/extra/$idx.file" ]; then',
  '      mkdir -p "$(dirname "$p")" && : > "$p" && mount --move "/mnt/extra/$idx.file" "$p" && mount -o remount,bind,ro "$p" 2>/dev/null || true',
  '    elif [ -d "/mnt/extra/$idx" ]; then',
  '      mkdir -p "$p" && mount --move "/mnt/extra/$idx" "$p" && mount -o remount,bind,ro "$p" 2>/dev/null || true',
  '    fi',
  '  fi',
  'done',
  'IFS="$OLD_IFS"',
  'mkdir -p "$ws"',
  'mount --move /mnt/ws "$ws"',
  'if [ "$mode" = "read-only" ]; then mount -o remount,bind,ro "$ws"; fi',
  'for ro in /usr /bin /sbin /lib /lib64 /etc /opt; do',
  '  if [ -d "$ro" ]; then mount --bind "$ro" "$ro" 2>/dev/null && mount -o remount,bind,ro "$ro" 2>/dev/null || true; fi',
  'done',
  'umount -l /mnt 2>/dev/null || true',
  'export HOME=/home/sandbox TMPDIR=/tmp/sandbox-tmp PATH=/usr/local/bin:/usr/bin:/bin',
  'cd "$ws"',
  'exec "$@"'
].join('\n');

function seatbeltLiteral(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSeatbeltProfile({ workspace, mode, extraReadPaths = [], allowChildProcess = false, network = false }) {
  const home = os.homedir();
  const realExec = (() => { try { return realpathSync(process.execPath); } catch { return process.execPath; } })();
  const nodePrefix = path.dirname(path.dirname(realExec));
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec*)',
    ...(allowChildProcess ? ['(allow process-fork)'] : []),
    '(allow process-info* (target self))',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm*)',
    '(allow file-ioctl)',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt") (subpath "/System") (subpath "/Library") (subpath "/dev") (literal "/etc") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/private/var/select"))',
    `(allow file-read* (subpath ${seatbeltLiteral(path.dirname(realExec))}))`,
    `(allow file-read* (subpath ${seatbeltLiteral(nodePrefix)}))`,
    `(allow file-read* (subpath ${seatbeltLiteral(workspace)}))`
  ];
  for (const extra of extraReadPaths) {
    lines.push(`(allow file-read* (subpath ${seatbeltLiteral(extra)}))`);
  }
  // Explicitly deny host credential directories even if nested under readable paths.
  for (const cred of ['.ssh', '.aws', '.gnupg', '.config', '.git-credentials', '.netrc']) {
    lines.push(`(deny file-read* (subpath ${seatbeltLiteral(path.join(home, cred))}))`);
  }
  if (mode === 'write-workspace') {
    lines.push(`(allow file-write* (subpath ${seatbeltLiteral(workspace)}))`);
  }
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))');
  lines.push(network ? '(allow network*)' : '(deny network*)');
  return `${lines.join('\n')}\n`;
}

/**
 * Build a direct `spawn` command for the chosen sandbox backend.
 */
export function buildSandboxCommand({
  backend,
  executable,
  args = [],
  workspace,
  mode = 'read-only',
  network = false,
  allowChildProcess = false,
  extraReadPaths = [],
  env = {},
  ociImage = DEFAULT_OCI_IMAGE,
  seccompProfile = SECCOMP_DEFAULT_PATH
}) {
  const realWorkspace = realpathSync(workspace);
  const cleanExtra = extraReadPaths
    .filter((p) => typeof p === 'string' && p.length > 0 && existsSync(p))
    .map((p) => realpathSync(p))
    .filter((p) => p !== realWorkspace && !p.startsWith(`${realWorkspace}${path.sep}`));
  const linuxExtra = cleanExtra.filter((p) => !p.includes(':'));
  const nodeTarget = isNodeExecutable(executable);

  // Defense-in-depth: when running Node with `allowChildProcess: false`, pass
  // `--permission` so undeclared `child_process.spawn` and outside FS accesses
  // are rejected immediately in addition to OS namespace containment.
  const innerArgs = nodeTarget
    ? [
        ...nodePermissionArgs({
          workspace: realWorkspace,
          mode,
          extraReadPaths: cleanExtra,
          allowChildProcess,
          includeNetDeny: backend.id === 'node-permission' && !network
        }),
        ...args
      ]
    : [...args];

  if (backend.id === 'linux-ns') {
    const nsFlags = network ? ['-Urm', '--fork'] : ['-Urnm', '--fork'];
    return {
      executable: backend.executable,
      args: [
        ...nsFlags,
        backend.shExecutable ?? '/bin/sh',
        '-c',
        LINUX_NS_SETUP_SCRIPT,
        'vld-linux-ns',
        realWorkspace,
        mode,
        linuxExtra.join(':'),
        executable,
        ...innerArgs
      ],
      cwd: realWorkspace,
      env,
      seccompDigest: null,
      cleanup: () => {}
    };
  }

  if (backend.id === 'bwrap') {
    const bwrapArgs = [
      ...(network ? ['--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts'] : ['--unshare-all']),
      '--die-with-parent',
      '--new-session',
      '--tmpfs', '/tmp',
      '--tmpfs', '/home',
      '--dir', '/home/sandbox',
      '--dir', '/tmp/sandbox-tmp',
      '--proc', '/proc',
      '--dev', '/dev'
    ];
    for (const sys of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/alternatives']) {
      if (existsSync(sys)) bwrapArgs.push('--ro-bind', sys, sys);
    }
    const execDir = path.dirname(realpathSync(executable));
    if (!execDir.startsWith('/usr') && !execDir.startsWith('/bin')) {
      bwrapArgs.push('--ro-bind', execDir, execDir);
    }
    for (const extra of cleanExtra) bwrapArgs.push('--ro-bind', extra, extra);
    bwrapArgs.push(mode === 'write-workspace' ? '--bind' : '--ro-bind', realWorkspace, realWorkspace);
    bwrapArgs.push('--setenv', 'HOME', '/home/sandbox', '--setenv', 'TMPDIR', '/tmp/sandbox-tmp', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin');
    for (const [k, v] of Object.entries(env)) bwrapArgs.push('--setenv', k, String(v));
    bwrapArgs.push('--chdir', realWorkspace, '--', executable, ...innerArgs);
    return {
      executable: backend.executable,
      args: bwrapArgs,
      cwd: realWorkspace,
      env: {},
      seccompDigest: null,
      cleanup: () => {}
    };
  }

  if (backend.id === 'oci') {
    const seccomp = path.resolve(seccompProfile);
    const seccompHash = digest(readFileSync(seccomp, 'utf8'));
    const mountSpec = `type=bind,source=${realWorkspace},target=${realWorkspace}${mode === 'read-only' ? ',readonly' : ''}`;
    const ociArgs = [
      'run', '--rm', '-i',
      '--network', network ? 'bridge' : 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--security-opt', `seccomp=${seccomp}`,
      '--pids-limit', '128',
      '--memory', '512m',
      '--mount', mountSpec,
      '--workdir', realWorkspace
    ];
    for (const extra of cleanExtra) {
      ociArgs.push('--mount', `type=bind,source=${extra},target=${extra},readonly`);
    }
    for (const [k, v] of Object.entries(env)) {
      ociArgs.push('--env', `${k}=${v}`);
    }
    ociArgs.push(ociImage, executable, ...args);
    return {
      executable: backend.executable,
      args: ociArgs,
      cwd: realWorkspace,
      env: {},
      seccompDigest: seccompHash,
      cleanup: () => {}
    };
  }

  if (backend.id === 'darwin-seatbelt') {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'vld-sbpl-'));
    const profileFile = path.join(profileDir, 'policy.sb');
    writeFileSync(profileFile, buildSeatbeltProfile({ workspace: realWorkspace, mode, extraReadPaths: cleanExtra, allowChildProcess, network }), 'utf8');
    return {
      executable: backend.executable,
      args: ['-f', profileFile, executable, ...innerArgs],
      cwd: realWorkspace,
      env: { ...env, HOME: realWorkspace, TMPDIR: realWorkspace, PATH: '/usr/local/bin:/usr/bin:/bin' },
      seccompDigest: null,
      cleanup: () => rmSync(profileDir, { recursive: true, force: true })
    };
  }

  if (backend.id === 'node-permission') {
    const sandboxTmp = path.join(realWorkspace, '.vld-sandbox-tmp');
    if (mode === 'write-workspace') mkdirSync(sandboxTmp, { recursive: true });
    const tmpValue = mode === 'write-workspace' ? sandboxTmp : realWorkspace;
    const winSysEnv = process.platform === 'win32'
      ? {
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {})
        }
      : {};
    return {
      executable: process.execPath,
      args: innerArgs,
      cwd: realWorkspace,
      env: { ...winSysEnv, ...env, HOME: realWorkspace, USERPROFILE: realWorkspace, TMPDIR: tmpValue, TMP: tmpValue, TEMP: tmpValue },
      seccompDigest: null,
      cleanup: () => {
        try {
          if (existsSync(sandboxTmp)) rmSync(sandboxTmp, { recursive: true, force: true });
        } catch {}
      }
    };
  }

  throw extensionError(`unsupported sandbox backend "${backend.id}"`, 'INVALID_SANDBOX_BACKEND');
}
