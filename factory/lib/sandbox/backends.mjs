/**
 * OS and runtime sandbox backend detection, 3-probe mini-conformance preflight,
 * masked-prefix Node binding (`nvm`/`fnm`/`volta`/`asdf`/`/tmp`), brokered
 * socket mounting, and fixed-argv command builders (ADR 0011, roadmap P0.2, 2.2 & P3.2).
 *
 * Every backend builder returns `{ executable, args, cwd, env, seccompDigest, cleanup }`
 * suitable for direct `spawn(executable, args, { shell: false })` — no user or
 * policy value is ever interpolated into a shell command string.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/** Preferred confinement order when preflight conformance scores tie. */
const BACKEND_STRENGTH_RANK = Object.freeze({
  bwrap: 1,
  'linux-ns': 2,
  'darwin-seatbelt': 3,
  oci: 4,
  'node-permission': 5
});

const DEFAULT_OCI_IMAGE = 'node:22-alpine';
const MASKED_TOP_DIRS = ['/home', '/root', '/tmp', '/var/tmp', '/run'];

const probeCache = new Map();
const nodePermFlagCache = new Map();

function safeRealpath(target) {
  try { return realpathSync(target); } catch { return path.resolve(target); }
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

function commandRuns(bin, args, timeout = 3000, options = {}) {
  if (!bin) return false;
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'ignore', 'ignore'], timeout, ...options });
    return true;
  } catch {
    return false;
  }
}

export function isNodeExecutable(executable) {
  const base = path.basename(String(executable ?? '')).toLowerCase();
  const current = path.basename(process.execPath).toLowerCase();
  if (base === current || base === 'node' || base === 'node.exe' || /^node(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(base)) {
    return true;
  }
  try {
    return realpathSync(executable) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}

/**
 * Compute the minimal read-only directory/file paths that must be preserved in
 * namespace/seatbelt sandboxes so `executable` (and its adjacent `lib`/`share`
 * prefix under `~/.nvm`, `~/.local/share/fnm`, `~/.volta`, `~/.asdf`, `/tmp`,
 * `/root`, or `/run`) remains runnable even after `/home`, `/tmp`, `/root`,
 * `/var/tmp`, and `/run` are masked with fresh tmpfs mounts.
 *
 * Never returns a broad container root such as `/`, `/home`, `$HOME`, `/tmp`,
 * `/var/tmp`, `/root`, or `/run`, so sibling host files and credentials remain
 * inaccessible.
 */
export function resolveExecutableBindRoots(executable = process.execPath) {
  if (!executable || typeof executable !== 'string' || !existsSync(executable)) return [];
  const absExec = path.resolve(executable);
  const realExec = safeRealpath(absExec);
  const homeAbs = path.resolve(os.homedir());
  const homeReal = safeRealpath(homeAbs);
  const forbiddenDirs = new Set([
    '/',
    '/home',
    '/Users',
    '/root',
    '/tmp',
    '/private',
    '/private/tmp',
    '/private/var',
    '/var',
    '/var/tmp',
    '/run',
    homeAbs,
    homeReal,
    path.resolve(os.tmpdir()),
    safeRealpath(os.tmpdir()),
    // Never bind manager top-level dirs whole (only the specific version prefix).
    path.join(homeReal, '.nvm'),
    path.join(homeReal, '.nvm', 'versions'),
    path.join(homeReal, '.nvm', 'versions', 'node'),
    path.join(homeReal, '.volta'),
    path.join(homeReal, '.volta', 'tools'),
    path.join(homeReal, '.volta', 'tools', 'image'),
    path.join(homeReal, '.volta', 'tools', 'image', 'node'),
    path.join(homeReal, '.asdf'),
    path.join(homeReal, '.asdf', 'installs'),
    path.join(homeReal, '.asdf', 'installs', 'nodejs'),
    path.join(homeReal, '.local'),
    path.join(homeReal, '.local', 'share'),
    path.join(homeReal, '.local', 'share', 'fnm'),
    path.join(homeReal, '.local', 'share', 'fnm', 'node-versions')
  ]);

  const roots = new Set();
  const addForBinary = (binPath) => {
    const binDir = path.dirname(binPath);
    const candidatePrefix = path.basename(binDir) === 'bin' ? path.dirname(binDir) : binDir;
    if (!forbiddenDirs.has(candidatePrefix)) {
      roots.add(candidatePrefix);
    } else if (!forbiddenDirs.has(binDir)) {
      roots.add(binDir);
    } else {
      roots.add(binPath);
    }
  };

  addForBinary(realExec);
  // If invoked via a symlink (e.g. ~/.volta/bin/node -> ~/.volta/tools/image/node/22.x/bin/node),
  // preserve the symlink path itself as well as the resolved target prefix.
  if (absExec !== realExec) {
    try {
      if (lstatSync(absExec).isSymbolicLink()) {
        const linkDir = path.dirname(absExec);
        if (!forbiddenDirs.has(linkDir)) roots.add(linkDir);
        else roots.add(absExec);
      }
    } catch {}
  }

  return [...roots];
}

/** Check whether a Node executable sits beneath a directory masked by OS namespace sandboxes. */
export function inspectMaskedNodePrefix(executable = process.execPath) {
  if (process.platform === 'win32') return { masked: false, reason: null, realPath: safeRealpath(executable), prefix: path.dirname(safeRealpath(executable)) };
  const realExec = safeRealpath(executable);
  const binDir = path.dirname(realExec);
  const prefix = path.basename(binDir) === 'bin' ? path.dirname(binDir) : binDir;
  const homeReal = safeRealpath(os.homedir());
  if (homeReal && realExec.startsWith(`${homeReal}/`)) {
    return { masked: true, category: 'home', reason: `under $HOME (${homeReal})`, realPath: realExec, prefix };
  }
  for (const dir of MASKED_TOP_DIRS) {
    if (realExec.startsWith(`${dir}/`)) {
      return { masked: true, category: dir.slice(1), reason: `under ${dir}`, realPath: realExec, prefix };
    }
  }
  // The OS tmp root is not always /tmp: macOS uses /var/folders/... (realpath
  // /private/var/folders/...). Node installs there are equally at risk of
  // tmpfs masking inside linux-ns/bwrap sandboxes.
  const tmpReal = safeRealpath(os.tmpdir());
  if (tmpReal && tmpReal !== '/tmp' && realExec.startsWith(`${tmpReal}/`)) {
    return { masked: true, category: 'tmp', reason: `under ${tmpReal}`, realPath: realExec, prefix };
  }
  return { masked: false, category: null, reason: null, realPath: realExec, prefix };
}

/**
 * Resolve the active Node permission-model CLI flag across the full Node >=22 range:
 * Node >=22.13 ships `--permission`; Node 22.0–22.12 ships `--experimental-permission`.
 */
function detectNodePermissionFlag(nodeBin = process.execPath) {
  const key = safeRealpath(nodeBin);
  if (nodePermFlagCache.has(key)) return nodePermFlagCache.get(key);
  const allowRoots = new Set([HERE, ...resolveExecutableBindRoots(nodeBin)]);
  for (const flag of ['--permission', '--experimental-permission']) {
    const readArgs = [...allowRoots].map((r) => `--allow-fs-read=${r}`);
    if (commandRuns(nodeBin, [flag, ...readArgs, '-e', 'process.exit(0)'])) {
      nodePermFlagCache.set(key, flag);
      return flag;
    }
  }
  nodePermFlagCache.set(key, null);
  return null;
}

/** Add Node permission-model defense-in-depth flags when the inner executable is Node. */
function nodePermissionArgs({
  executable = process.execPath,
  workspace,
  mode,
  extraReadPaths = [],
  extraWritePaths = [],
  allowChildProcess = false,
  includeNetDeny = false
}) {
  const permFlag = detectNodePermissionFlag(executable);
  if (!permFlag) return [];
  const absExec = path.resolve(executable);
  const realExec = safeRealpath(absExec);
  const readSet = new Set([
    workspace,
    path.dirname(absExec),
    path.dirname(realExec),
    ...resolveExecutableBindRoots(executable),
    ...extraReadPaths.map(safeRealpath)
  ]);
  if (includeNetDeny) readSet.add(NET_DENY_PRELOAD_PATH);
  const flags = [permFlag];
  for (const allowed of readSet) flags.push(`--allow-fs-read=${allowed}`);
  if (mode === 'write-workspace') flags.push(`--allow-fs-write=${workspace}`);
  for (const writable of extraWritePaths) {
    const rw = safeRealpath(writable);
    flags.push(`--allow-fs-read=${rw}`, `--allow-fs-write=${rw}`);
  }
  if (allowChildProcess) flags.push('--allow-child-process');
  if (includeNetDeny) flags.push('--import', pathToFileURL(NET_DENY_PRELOAD_PATH).href);
  return flags;
}

/**
 * Fixed setup script for `linux-ns`. Receives all parameters strictly via
 * positional arguments:
 *   $1 = workspace
 *   $2 = mode ('read-only' | 'write-workspace')
 *   $3 = colon-separated read-only bind paths (includes Node install prefix in ~/.nvm, /tmp, etc.)
 *   $4 = colon-separated read-write bind paths (optional host broker socket directory)
 *   $5 = extra PATH entry (resolved Node bin directory)
 *   $6.. = target executable and argv
 * Zero user or policy values are interpolated into shell syntax.
 */
const LINUX_NS_SETUP_SCRIPT = [
  'set -eu',
  'ws="$1"; mode="$2"; extra="$3"; rwextra="$4"; binpath="$5"; shift 5',
  'mount --make-rprivate / 2>/dev/null || true',
  'mount -t tmpfs -o size=32m,mode=0755,nosuid,nodev tmpfs /mnt',
  'mkdir -p /mnt/ws /mnt/extra /mnt/rw',
  'mount --rbind "$ws" /mnt/ws',
  'idx=0',
  'OLD_IFS="$IFS"; IFS=":"',
  'for p in $extra; do',
  '  if [ -n "$p" ]; then',
  '    idx=$((idx + 1))',
  '    if [ -L "$p" ]; then',
  '      ln -s "$(readlink "$p")" "/mnt/extra/$idx.link"',
  '    elif [ -d "$p" ]; then',
  '      mkdir -p "/mnt/extra/$idx" && mount --rbind "$p" "/mnt/extra/$idx"',
  '    elif [ -e "$p" ]; then',
  '      : > "/mnt/extra/$idx.file" && mount --bind "$p" "/mnt/extra/$idx.file"',
  '    fi',
  '  fi',
  'done',
  'rwidx=0',
  'for p in $rwextra; do',
  '  if [ -n "$p" ] && [ -d "$p" ]; then',
  '    rwidx=$((rwidx + 1))',
  '    mkdir -p "/mnt/rw/$rwidx" && mount --rbind "$p" "/mnt/rw/$rwidx"',
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
  '    if [ -L "/mnt/extra/$idx.link" ]; then',
  '      mkdir -p "$(dirname "$p")" && ln -sf "$(readlink "/mnt/extra/$idx.link")" "$p"',
  '    elif [ -f "/mnt/extra/$idx.file" ]; then',
  '      mkdir -p "$(dirname "$p")" && : > "$p" && mount --move "/mnt/extra/$idx.file" "$p" && mount -o remount,bind,ro "$p" 2>/dev/null || true',
  '    elif [ -d "/mnt/extra/$idx" ]; then',
  '      mkdir -p "$p" && mount --move "/mnt/extra/$idx" "$p" && mount -o remount,bind,ro "$p" 2>/dev/null || true',
  '    fi',
  '  fi',
  'done',
  'rwidx=0',
  'for p in $rwextra; do',
  '  if [ -n "$p" ] && [ -d "/mnt/rw/$((rwidx + 1))" ]; then',
  '    rwidx=$((rwidx + 1))',
  '    mkdir -p "$p" && mount --move "/mnt/rw/$rwidx" "$p"',
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
  'export HOME=/home/sandbox TMPDIR=/tmp/sandbox-tmp',
  'if [ -n "$binpath" ]; then export PATH="$binpath:/usr/local/bin:/usr/bin:/bin"; else export PATH=/usr/local/bin:/usr/bin:/bin; fi',
  'cd "$ws"',
  'exec "$@"'
].join('\n');

function seatbeltLiteral(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSeatbeltProfile({
  executable = process.execPath,
  workspace,
  mode,
  extraReadPaths = [],
  allowChildProcess = false,
  network = false,
  broker = null
}) {
  const home = os.homedir();
  const bindRoots = resolveExecutableBindRoots(executable);
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
    `(allow file-read* (subpath ${seatbeltLiteral(workspace)}))`
  ];
  for (const root of bindRoots) {
    lines.push(`(allow file-read* (subpath ${seatbeltLiteral(root)}))`);
  }
  for (const extra of extraReadPaths) {
    lines.push(`(allow file-read* (subpath ${seatbeltLiteral(extra)}))`);
  }
  for (const cred of ['.ssh', '.aws', '.gnupg', '.config', '.git-credentials', '.netrc']) {
    const credPath = path.join(home, cred);
    // Never deny the exact Node prefix if the user put a manager under ~/.config (e.g. fnm).
    if (!bindRoots.some((r) => r.startsWith(credPath))) {
      lines.push(`(deny file-read* (subpath ${seatbeltLiteral(credPath)}))`);
    }
  }
  if (mode === 'write-workspace') {
    lines.push(`(allow file-write* (subpath ${seatbeltLiteral(workspace)}))`);
  }
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))');
  if (network) {
    lines.push('(allow network*)');
  } else if (broker?.mode === 'unix-socket' && broker.socketPath) {
    const sockDir = safeRealpath(path.dirname(broker.socketPath));
    const sockReal = path.join(sockDir, path.basename(broker.socketPath));
    lines.push(`(allow file-read* (subpath ${seatbeltLiteral(sockDir)}))`);
    lines.push(`(allow file-write* (subpath ${seatbeltLiteral(sockDir)}))`);
    // Allow both spellings: the child dials the realpath-normalized socket
    // (macOS /var -> /private/var), while callers may hold the original path.
    for (const sockTarget of new Set([broker.socketPath, sockReal])) {
      lines.push(`(allow network-outbound (remote unix-socket (path-literal ${seatbeltLiteral(sockTarget)})))`);
    }
  } else if (broker?.mode === 'loopback-port' && Number.isInteger(broker.port)) {
    lines.push(`(allow network-outbound (remote ip "localhost:${broker.port}"))`);
  } else {
    lines.push('(deny network*)');
  }
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
  extraWritePaths = [],
  broker = null,
  env = {},
  ociImage = DEFAULT_OCI_IMAGE,
  seccompProfile = SECCOMP_DEFAULT_PATH
}) {
  const realWorkspace = realpathSync(workspace);
  const absExec = path.resolve(executable);
  const realExec = safeRealpath(absExec);
  const execBinDir = path.dirname(realExec);

  // Preserve Node install prefix when living under /home ($HOME/.nvm, fnm, volta, asdf),
  // /tmp, /var/tmp, /root, or /run so namespace tmpfs masks never break execution.
  const execBindRoots = resolveExecutableBindRoots(executable).filter((p) => {
    if (p === realWorkspace || p.startsWith(`${realWorkspace}${path.sep}`)) return false;
    return MASKED_TOP_DIRS.some((top) => p.startsWith(`${top}/`));
  });

  const cleanExtra = extraReadPaths
    .filter((p) => typeof p === 'string' && p.length > 0 && existsSync(p))
    .map((p) => safeRealpath(p))
    .filter((p) => p !== realWorkspace && !p.startsWith(`${realWorkspace}${path.sep}`));

  const brokerSocketDir = !network && broker?.mode === 'unix-socket' && typeof broker.socketPath === 'string'
    ? safeRealpath(path.dirname(broker.socketPath))
    : null;
  const brokerSocketPath = brokerSocketDir
    ? path.join(brokerSocketDir, path.basename(broker.socketPath))
    : null;
  const brokerEnv = Object.create(null);
  if (!network && broker) {
    if (broker.mode === 'unix-socket' && brokerSocketPath) {
      brokerEnv.VLD_MODEL_BROKER_SOCKET = brokerSocketPath;
    } else if (broker.mode === 'loopback-port' && Number.isInteger(broker.port)) {
      brokerEnv.VLD_MODEL_BROKER_PORT = String(broker.port);
      brokerEnv.VLD_MODEL_BROKER_URL = `http://127.0.0.1:${broker.port}`;
    }
    if (typeof broker.nonce === 'string' && broker.nonce.length > 0) {
      brokerEnv.VLD_MODEL_BROKER_NONCE = broker.nonce;
    }
  }

  const mergedEnv = { ...env, ...brokerEnv };
  const writeRoots = [...extraWritePaths.map(safeRealpath).filter((p) => existsSync(p)), ...(brokerSocketDir ? [brokerSocketDir] : [])];
  const nodeTarget = isNodeExecutable(executable);

  const innerArgs = nodeTarget
    ? [
        ...nodePermissionArgs({
          executable,
          workspace: realWorkspace,
          mode,
          extraReadPaths: cleanExtra,
          extraWritePaths: writeRoots,
          allowChildProcess,
          includeNetDeny: backend.id === 'node-permission' && !network
        }),
        ...args
      ]
    : [...args];

  if (backend.id === 'linux-ns') {
    const allReadMounts = [...new Set([...execBindRoots, ...cleanExtra])].filter((p) => !p.includes(':'));
    const allWriteMounts = writeRoots.filter((p) => !p.includes(':'));
    const safeBinPath = execBinDir.includes(':') ? '' : execBinDir;
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
        allReadMounts.join(':'),
        allWriteMounts.join(':'),
        safeBinPath,
        executable,
        ...innerArgs
      ],
      cwd: realWorkspace,
      env: mergedEnv,
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
      '--tmpfs', '/run',
      '--dir', '/home/sandbox',
      '--dir', '/tmp/sandbox-tmp',
      '--proc', '/proc',
      '--dev', '/dev'
    ];
    for (const sys of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/alternatives', '/opt']) {
      if (existsSync(sys)) bwrapArgs.push('--ro-bind', sys, sys);
    }
    for (const root of new Set([...execBindRoots, ...cleanExtra])) {
      try {
        if (lstatSync(root).isSymbolicLink()) continue;
        bwrapArgs.push('--ro-bind', root, root);
      } catch {}
    }
    for (const rw of writeRoots) {
      bwrapArgs.push('--bind', rw, rw);
    }
    bwrapArgs.push(mode === 'write-workspace' ? '--bind' : '--ro-bind', realWorkspace, realWorkspace);
    bwrapArgs.push(
      '--setenv', 'HOME', '/home/sandbox',
      '--setenv', 'TMPDIR', '/tmp/sandbox-tmp',
      '--setenv', 'PATH', `${execBinDir}:/usr/local/bin:/usr/bin:/bin`
    );
    for (const [k, v] of Object.entries(mergedEnv)) bwrapArgs.push('--setenv', k, String(v));
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
    for (const rw of writeRoots) {
      ociArgs.push('--mount', `type=bind,source=${rw},target=${rw}`);
    }
    for (const [k, v] of Object.entries(mergedEnv)) {
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
    writeFileSync(profileFile, buildSeatbeltProfile({
      executable,
      workspace: realWorkspace,
      mode,
      extraReadPaths: cleanExtra,
      allowChildProcess,
      network,
      broker
    }), 'utf8');
    return {
      executable: backend.executable,
      args: ['-f', profileFile, executable, ...innerArgs],
      cwd: realWorkspace,
      env: { ...mergedEnv, HOME: realWorkspace, TMPDIR: realWorkspace, PATH: `${execBinDir}:/usr/local/bin:/usr/bin:/bin` },
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
      executable,
      args: innerArgs,
      cwd: realWorkspace,
      env: { ...winSysEnv, ...mergedEnv, HOME: realWorkspace, USERPROFILE: realWorkspace, TMPDIR: tmpValue, TMP: tmpValue, TEMP: tmpValue },
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

function invokeSyncConfined(backend, { executable, args, workspace, mode, network = false }) {
  const invocation = buildSandboxCommand({
    backend,
    executable,
    args,
    workspace,
    mode,
    network,
    allowChildProcess: false,
    env: {}
  });
  try {
    return spawnSync(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4500,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } finally {
    try { invocation.cleanup?.(); } catch {}
  }
}

/**
 * Run the 3-probe mini-conformance (`exec`, `workspace-write`, `network-deny`)
 * against a candidate backend using the real Node executable (`executable`).
 */
function runMiniConformance(backend, nodeExec = process.execPath) {
  let root = null;
  const probes = [];
  try {
    root = safeRealpath(mkdtempSync(path.join(os.tmpdir(), `vld-preflight-${backend.id}-`)));
    const ws = path.join(root, 'ws');
    const outside = path.join(root, 'outside-canary.txt');
    mkdirSync(ws, { recursive: true });
    writeFileSync(outside, 'PREFLIGHT_OUTSIDE_CANARY\n', 'utf8');

    // 1. exec probe: process starts cleanly inside read-only sandbox (catches masked Node prefix!)
    const execScript = path.join(ws, '_pf_exec.mjs');
    writeFileSync(execScript, "process.stdout.write('VLD_PF_EXEC_OK');\n", 'utf8');
    const rExec = invokeSyncConfined(backend, { executable: nodeExec, args: [execScript], workspace: ws, mode: 'read-only' });
    const execOk = rExec.status === 0 && String(rExec.stdout ?? '').includes('VLD_PF_EXEC_OK');
    probes.push({
      id: 'exec',
      passed: execOk,
      status: execOk ? 'passed' : 'launch-failed',
      detail: execOk ? 'Node executed cleanly inside confined root' : `launch-failed (exit=${rExec.status ?? 'signal'})`
    });

    // 2. workspace-write + outside-read isolation probe
    const writeScript = path.join(ws, '_pf_write.mjs');
    writeFileSync(writeScript, "import fs from 'node:fs'; fs.writeFileSync('pf-written.txt', 'VLD_PF_WRITE_OK');\n", 'utf8');
    const outsideScript = path.join(ws, '_pf_outside.mjs');
    writeFileSync(outsideScript, `import fs from 'node:fs'; process.stdout.write(fs.readFileSync(${JSON.stringify(outside)}, 'utf8'));\n`, 'utf8');
    const rWrite = invokeSyncConfined(backend, { executable: nodeExec, args: [writeScript], workspace: ws, mode: 'write-workspace' });
    const wroteInside = rWrite.status === 0
      && existsSync(path.join(ws, 'pf-written.txt'))
      && readFileSync(path.join(ws, 'pf-written.txt'), 'utf8') === 'VLD_PF_WRITE_OK';
    const rOut = invokeSyncConfined(backend, { executable: nodeExec, args: [outsideScript], workspace: ws, mode: 'read-only' });
    const canaryRead = String(rOut.stdout ?? '').includes('PREFLIGHT_OUTSIDE_CANARY');
    const writeOk = wroteInside && rOut.status !== 0 && !canaryRead;
    probes.push({
      id: 'workspace-write',
      passed: writeOk,
      status: writeOk ? 'passed' : canaryRead ? 'leak-detected' : !wroteInside ? 'launch-failed' : 'policy-failed',
      detail: writeOk
        ? 'workspace write succeeded and outside read denied'
        : canaryRead
          ? 'LEAKED outside preflight canary'
          : !wroteInside
            ? `workspace write failed (exit=${rWrite.status ?? 'signal'})`
            : 'outside read exited 0'
    });

    // 3. network-deny probe: attempt outbound loopback TCP against a real ephemeral listener
    const netScript = path.join(ws, '_pf_net.mjs');
    writeFileSync(netScript, [
      "import net from 'node:net';",
      "const port = Number(process.argv[2]);",
      "const sock = net.createConnection({ host: '127.0.0.1', port });",
      "sock.setTimeout(800);",
      "sock.on('connect', () => { process.stdout.write('PREFLIGHT_NET_CONNECTED'); sock.destroy(); process.exit(0); });",
      "sock.on('timeout', () => { sock.destroy(); process.exit(2); });",
      "sock.on('error', () => { process.exit(3); });"
    ].join('\n'), 'utf8');
    const inv = buildSandboxCommand({
      backend,
      executable: nodeExec,
      args: [netScript, '__PORT__'],
      workspace: ws,
      mode: 'read-only',
      network: false,
      allowChildProcess: false,
      env: {}
    });
    let netOk = false;
    let netStatus = 'launch-failed';
    let netDetail = 'network preflight failed';
    try {
      const harnessCode = [
        "import net from 'node:net';",
        "import { spawn } from 'node:child_process';",
        "const cfg = JSON.parse(process.argv[1]);",
        "let reached = false;",
        "const srv = net.createServer((s) => { reached = true; s.destroy(); });",
        "srv.listen(0, '127.0.0.1', () => {",
        "  const port = String(srv.address().port);",
        "  const args = cfg.args.map((a) => a === '__PORT__' ? port : a);",
        "  const child = spawn(cfg.executable, args, { cwd: cfg.cwd, env: cfg.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });",
        "  let out = ''; child.stdout.on('data', (c) => { out += c; });",
        "  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2500);",
        "  child.on('close', (code) => {",
        "    clearTimeout(t);",
        "    srv.close(() => {",
        "      process.stdout.write(JSON.stringify({ code, reached, connected: out.includes('PREFLIGHT_NET_CONNECTED') }));",
        "    });",
        "  });",
        "});"
      ].join('\n');
      const hr = spawnSync(process.execPath, ['--input-type=module', '-e', harnessCode, JSON.stringify({
        executable: inv.executable,
        args: inv.args,
        cwd: inv.cwd,
        env: inv.env
      })], { encoding: 'utf8', windowsHide: true, timeout: 4500, stdio: ['ignore', 'pipe', 'pipe'] });
      if (hr.status === 0 && hr.stdout) {
        const parsed = JSON.parse(hr.stdout);
        const leaked = Boolean(parsed.reached || parsed.connected);
        // Only count network-deny passed if `exec` also succeeded (avoid counting a broken launcher as network denial).
        netOk = execOk && parsed.code !== 0 && !leaked;
        netStatus = netOk ? 'passed' : leaked ? 'leak-detected' : 'launch-failed';
        netDetail = netOk
          ? 'outbound TCP blocked before reaching listener'
          : leaked
            ? 'LEAKED outbound TCP connection to listener'
            : 'launch-failed: cannot verify network denial when exec probe failed';
      }
    } finally {
      try { inv.cleanup?.(); } catch {}
    }
    probes.push({ id: 'network-deny', passed: netOk, status: netStatus, detail: netDetail });
  } catch (err) {
    while (probes.length < 3) {
      const id = ['exec', 'workspace-write', 'network-deny'][probes.length];
      probes.push({ id, passed: false, status: 'launch-failed', detail: `launch-failed: ${err?.message ?? err}` });
    }
  } finally {
    if (root) {
      try { rmSync(root, { recursive: true, force: true }); } catch {}
    }
  }

  const passed = probes.filter((p) => p.passed).length;
  const failedProbes = probes.filter((p) => !p.passed).map((p) => p.id);
  return {
    passed,
    total: 3,
    score: Number((passed / 3).toFixed(4)),
    ok: passed === 3,
    failedProbes,
    probes,
    reason: passed === 3 ? null : `${passed}/3 preflight (${failedProbes.join(', ')} failed)`
  };
}

function emptyPreflight(reason) {
  return {
    passed: 0,
    total: 3,
    score: 0,
    ok: false,
    failedProbes: ['exec', 'workspace-write', 'network-deny'],
    probes: [],
    reason
  };
}

/**
 * Dynamically test and rank sandbox backends using the 3-probe mini-conformance
 * (`exec`, `workspace-write`, `network-deny`) against `executable`.
 *
 * Backends are ranked by conformance score first and confinement strength second.
 * If a higher-strength backend is present on the host but scores below 3/3, it is
 * marked unavailable and recorded in `fallbacks` with the exact failing probe IDs.
 */
export function detectSandboxBackends({
  refresh = false,
  executable = process.execPath,
  preflightRunner = null
} = {}) {
  const nodeExec = isNodeExecutable(executable) && existsSync(executable) ? path.resolve(executable) : process.execPath;
  const cacheKey = safeRealpath(nodeExec);
  if (!refresh && !preflightRunner && probeCache.has(cacheKey)) {
    return probeCache.get(cacheKey);
  }
  const runPf = typeof preflightRunner === 'function' ? preflightRunner : runMiniConformance;

  const candidates = [];

  // 1. OCI container engine (Podman preferred for rootless default, then Docker)
  const podman = resolveSystemBinary('podman');
  const docker = resolveSystemBinary('docker');
  const ociBin = commandRuns(podman, ['info']) ? podman : (commandRuns(docker, ['info']) ? docker : null);
  const ociImageReady = Boolean(ociBin) && commandRuns(ociBin, ['image', 'inspect', DEFAULT_OCI_IMAGE]);
  if (ociBin && ociImageReady) {
    const base = { id: 'oci', confinementClass: SANDBOX_BACKEND_CLASS.oci, binaryFound: true, executable: ociBin };
    const pf = runPf(base, '/usr/local/bin/node');
    candidates.push({
      ...base,
      available: pf.ok,
      preflight: pf,
      detail: pf.ok
        ? `${path.basename(ociBin)} verified (3/3 preflight) with seccomp-default.json`
        : `${path.basename(ociBin)} failed preflight: ${pf.reason}`
    });
  } else {
    candidates.push({
      id: 'oci',
      confinementClass: SANDBOX_BACKEND_CLASS.oci,
      binaryFound: false,
      available: false,
      executable: null,
      preflight: emptyPreflight(ociBin ? `${path.basename(ociBin)} missing local image ${DEFAULT_OCI_IMAGE}` : 'no reachable podman or docker runtime'),
      detail: ociBin ? `${path.basename(ociBin)} reachable (pull ${DEFAULT_OCI_IMAGE} to enable)` : 'no reachable podman or docker runtime'
    });
  }

  // 2. Bubblewrap (Linux unprivileged namespace sandbox)
  const bwrap = process.platform === 'linux' ? resolveSystemBinary('bwrap') : null;
  if (bwrap) {
    const base = { id: 'bwrap', confinementClass: SANDBOX_BACKEND_CLASS.bwrap, binaryFound: true, executable: bwrap };
    const pf = runPf(base, nodeExec);
    candidates.push({
      ...base,
      available: pf.ok,
      preflight: pf,
      detail: pf.ok
        ? 'bwrap user+mount+net+pid namespace verified (3/3 preflight)'
        : `bwrap failed preflight: ${pf.reason}`
    });
  } else {
    candidates.push({
      id: 'bwrap',
      confinementClass: SANDBOX_BACKEND_CLASS.bwrap,
      binaryFound: false,
      available: false,
      executable: null,
      preflight: emptyPreflight('bwrap binary not installed'),
      detail: 'bwrap unavailable or not installed'
    });
  }

  // 3. Linux kernel namespaces via `unshare`
  const unshare = process.platform === 'linux' ? resolveSystemBinary('unshare') : null;
  const sh = process.platform === 'linux' ? resolveSystemBinary('sh') : null;
  if (unshare && sh) {
    const base = {
      id: 'linux-ns',
      confinementClass: SANDBOX_BACKEND_CLASS['linux-ns'],
      binaryFound: true,
      executable: unshare,
      shExecutable: sh
    };
    const pf = runPf(base, nodeExec);
    candidates.push({
      ...base,
      available: pf.ok,
      preflight: pf,
      detail: pf.ok
        ? 'Linux unshare user+net+mount+tmpfs verified (3/3 preflight)'
        : `linux-ns failed preflight: ${pf.reason}`
    });
  } else {
    candidates.push({
      id: 'linux-ns',
      confinementClass: SANDBOX_BACKEND_CLASS['linux-ns'],
      binaryFound: false,
      available: false,
      executable: null,
      preflight: emptyPreflight('unshare unavailable'),
      detail: 'Linux unshare user/net/mount namespaces unavailable'
    });
  }

  // 4. macOS Seatbelt (`sandbox-exec`)
  const seatbelt = process.platform === 'darwin' ? resolveSystemBinary('sandbox-exec') : null;
  if (seatbelt) {
    const base = { id: 'darwin-seatbelt', confinementClass: SANDBOX_BACKEND_CLASS['darwin-seatbelt'], binaryFound: true, executable: seatbelt };
    const pf = runPf(base, nodeExec);
    candidates.push({
      ...base,
      available: pf.ok,
      preflight: pf,
      detail: pf.ok
        ? 'macOS sandbox-exec seatbelt verified (3/3 preflight)'
        : `darwin-seatbelt failed preflight: ${pf.reason}`
    });
  } else {
    candidates.push({
      id: 'darwin-seatbelt',
      confinementClass: SANDBOX_BACKEND_CLASS['darwin-seatbelt'],
      binaryFound: false,
      available: false,
      executable: null,
      preflight: emptyPreflight('sandbox-exec unavailable'),
      detail: 'macOS sandbox-exec unavailable'
    });
  }

  // 5. Portable Node >=22 permission model + network-deny preload
  const nodePermFlag = detectNodePermissionFlag(nodeExec);
  if (nodePermFlag) {
    const base = {
      id: 'node-permission',
      confinementClass: SANDBOX_BACKEND_CLASS['node-permission'],
      binaryFound: true,
      executable: nodeExec,
      permissionFlag: nodePermFlag
    };
    const pf = runPf(base, nodeExec);
    candidates.push({
      ...base,
      available: pf.ok,
      preflight: pf,
      detail: pf.ok
        ? `Node ${nodePermFlag} + network-deny preload verified (3/3 preflight)`
        : `node-permission failed preflight: ${pf.reason}`
    });
  } else {
    candidates.push({
      id: 'node-permission',
      confinementClass: SANDBOX_BACKEND_CLASS['node-permission'],
      binaryFound: false,
      available: false,
      executable: null,
      preflight: emptyPreflight('Node permission model unavailable'),
      detail: 'Node permission model unavailable'
    });
  }

  // Rank by preflight conformance score descending, then confinement strength ascending.
  const ranked = [...candidates].sort((a, b) => {
    const scoreDiff = (b.preflight?.passed ?? 0) - (a.preflight?.passed ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (BACKEND_STRENGTH_RANK[a.id] ?? 99) - (BACKEND_STRENGTH_RANK[b.id] ?? 99);
  });

  const winner = ranked.find((entry) => entry.available && entry.id !== 'oci')
    ?? ranked.find((entry) => entry.available)
    ?? null;
  const preferred = winner?.id ?? null;
  const winnerStrength = preferred ? (BACKEND_STRENGTH_RANK[preferred] ?? 99) : 99;

  // Record every stronger backend that was present on the host yet failed preflight.
  const fallbacks = candidates
    .filter((entry) => entry.binaryFound && !entry.available && (BACKEND_STRENGTH_RANK[entry.id] ?? 99) < winnerStrength)
    .sort((a, b) => (BACKEND_STRENGTH_RANK[a.id] ?? 99) - (BACKEND_STRENGTH_RANK[b.id] ?? 99))
    .map((entry) => ({
      from: entry.id,
      to: preferred,
      passed: entry.preflight.passed,
      total: entry.preflight.total,
      failedProbes: entry.preflight.failedProbes,
      reason: `${entry.id} scored ${entry.preflight.passed}/${entry.preflight.total} (${entry.preflight.failedProbes.join(', ')}); fell back to ${preferred ?? 'none'}`
    }));

  const osCapable = ranked.some((entry) => entry.available && entry.confinementClass !== 'runtime-permission');
  const maskedPrefix = inspectMaskedNodePrefix(nodeExec);
  const result = {
    platform: process.platform,
    nodeVersion: process.versions.node,
    nodeExecutable: cacheKey,
    maskedNodePrefix: maskedPrefix,
    seccompProfile: SECCOMP_DEFAULT_PATH,
    seccompDigest: SECCOMP_DEFAULT_DIGEST,
    osCapable,
    preferred,
    rankedIds: ranked.map((b) => b.id),
    fallbacks,
    backends: ranked
  };

  if (!preflightRunner) probeCache.set(cacheKey, result);
  return result;
}

/** Choose a concrete conformance-verified backend or fail closed. */
export function selectSandboxBackend({
  requested = 'auto',
  executable = process.execPath,
  requireOs = false,
  preflightRunner = null,
  onFallback = null
} = {}) {
  const probe = detectSandboxBackends({ executable, preflightRunner });
  const nodeTarget = isNodeExecutable(executable);

  if (requested && requested !== 'auto') {
    if (!SANDBOX_BACKENDS.includes(requested)) {
      throw extensionError(`unknown sandbox backend "${requested}" (expected one of: auto, ${SANDBOX_BACKENDS.join(', ')})`, 'INVALID_SANDBOX_BACKEND');
    }
    const found = probe.backends.find((b) => b.id === requested);
    if (!found?.available) {
      throw extensionError(`requested sandbox backend "${requested}" failed preflight or is unavailable: ${found?.detail ?? 'not found'}`, 'SANDBOX_UNAVAILABLE');
    }
    if (found.id === 'node-permission' && !nodeTarget) {
      throw extensionError('node-permission backend can only confine Node executables; use oci, bwrap, linux-ns or darwin-seatbelt', 'SANDBOX_UNAVAILABLE');
    }
    if (requireOs && found.confinementClass === 'runtime-permission') {
      throw extensionError('OS-level sandbox confinement was required, but only node-permission is available', 'SANDBOX_UNAVAILABLE');
    }
    return { ...found, fallbackReason: null };
  }

  for (const candidate of probe.backends) {
    if (!candidate.available) continue;
    if (candidate.id === 'node-permission' && (!nodeTarget || requireOs)) continue;
    if (candidate.id === 'oci' && probe.backends.some((b) => b.available && b.id !== 'oci' && (b.id !== 'node-permission' || (nodeTarget && !requireOs)))) {
      continue;
    }
    const relevantFallbacks = probe.fallbacks.filter(
      (f) => (BACKEND_STRENGTH_RANK[f.from] ?? 99) < (BACKEND_STRENGTH_RANK[candidate.id] ?? 99)
    );
    const fallbackReason = relevantFallbacks.length > 0
      ? relevantFallbacks.map((f) => f.reason.replace(/fell back to .+$/, `fell back to ${candidate.id}`)).join('; ')
      : null;
    if (fallbackReason && typeof onFallback === 'function') {
      onFallback(fallbackReason);
    }
    return { ...candidate, fallbackReason };
  }

  const reasons = probe.backends.map((b) => `${b.id}: ${b.preflight?.reason ?? b.detail}`).join('; ');
  throw extensionError(`no compatible sandbox backend passed preflight (${reasons})`, 'SANDBOX_UNAVAILABLE');
}
