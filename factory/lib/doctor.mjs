/**
 * `vld doctor` — zero-dependency workspace, environment, packet, live 8/8
 * sandbox conformance, and governance health check (roadmap P0.2 & 4.3).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { telemetryStatus, verifyEvidenceChain } from './evidence.mjs';
import { loadProfile } from './profile.mjs';
import { scanRiskHints } from './risk-hints.mjs';
import { detectSandboxBackends, inspectMaskedNodePrefix } from './sandbox/index.mjs';
import { verifyPacket } from './verify.mjs';
import { PACKAGE_VERSION } from './version.mjs';

const SANDBOX_MODULE_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox', 'index.mjs')
).href;

function parseNodeMajor(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10) || 0;
}

function checkGit(project) {
  try {
    const ver = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let inside = false;
    try {
      inside = execFileSync('git', ['-C', project, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim() === 'true';
    } catch {}
    return {
      id: 'git',
      status: 'pass',
      detail: `${ver}${inside ? ' · inside Git repository' : ' · directory is not yet a Git repository'}`,
      remediation: inside ? null : 'Run `git init` before using mission, workspace or build commands.'
    };
  } catch {
    return {
      id: 'git',
      status: 'warn',
      detail: 'git executable not found on PATH',
      remediation: 'Install Git 2.38+ to enable drift diffs, worktrees and `vld build`.'
    };
  }
}

/** Execute the full 8-probe live sandbox conformance suite synchronously for `runDoctor`. */
function runLiveConformanceSync(backend, executable = process.execPath) {
  const script = [
    `import { runSandboxConformance } from ${JSON.stringify(SANDBOX_MODULE_URL)};`,
    `const report = await runSandboxConformance({ backend: ${JSON.stringify(backend)}, executable: ${JSON.stringify(executable)} });`,
    'process.stdout.write(JSON.stringify(report));'
  ].join('\n');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (run.status !== 0 || !run.stdout) {
    const snippet = String(run.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      ok: false,
      backend,
      passed: 0,
      total: 8,
      failingProbes: ['conformance-launch'],
      probes: [{ id: 'conformance-launch', passed: false, status: 'launch-failed', detail: snippet || `exit ${run.status}` }]
    };
  }
  return JSON.parse(run.stdout);
}

/**
 * Run all workspace diagnostic probes without mutating project state.
 * Fails loudly (`ok: false`, `status: 'fail'`) when the preferred sandbox
 * backend scores below 8/8 on the live conformance harness.
 */
export function runDoctor({
  projectDir = '.',
  profileFile = 'profile.json',
  packetDir = 'specs',
  executable = process.execPath,
  sandboxDetector = detectSandboxBackends,
  conformanceRunner = runLiveConformanceSync
} = {}) {
  const project = path.resolve(projectDir);
  const checks = [];

  // 1. Node runtime + masked-prefix note
  const major = parseNodeMajor();
  const masked = inspectMaskedNodePrefix(executable);
  const hasPermFlag = typeof process.permission === 'object' || major >= 22;
  const prefixSuffix = masked.masked ? ` · prefix=${masked.prefix} (${masked.reason}; bound read-only)` : ` · prefix=${masked.prefix}`;
  checks.push({
    id: 'node-runtime',
    status: major >= 22 ? 'pass' : 'fail',
    detail: `Node v${process.versions.node} (requires >=22.0.0; --permission ${hasPermFlag ? 'available' : 'unavailable'})${prefixSuffix}`,
    remediation: major >= 22 ? null : 'Install Node.js 22 LTS under /usr/local (`bash scripts/bootstrap.sh` or `.devcontainer`).'
  });

  // 2. Git
  checks.push(checkGit(project));

  // 3. Sandbox backends — must pass full 8/8 conformance (roadmap P0.2)
  const sandbox = sandboxDetector({ executable });
  const availableIds = sandbox.backends.filter((b) => b.available).map((b) => b.id);
  const fallbackNote = Array.isArray(sandbox.fallbacks) && sandbox.fallbacks.length > 0
    ? ` · fallback: ${sandbox.fallbacks.map((f) => f.reason).join('; ')}`
    : '';
  if (!sandbox.preferred) {
    const failedBackends = sandbox.backends
      .filter((b) => b.binaryFound)
      .map((b) => `${b.id} (${b.preflight?.reason ?? b.detail})`);
    checks.push({
      id: 'sandbox',
      status: 'fail',
      failingProbes: ['preflight'],
      detail: `FAIL · no sandbox backend passed preflight${failedBackends.length ? ` [${failedBackends.join('; ')}]` : ''}`,
      remediation: 'Run `vld experimental sandbox conformance` and `bash scripts/bootstrap.sh` to diagnose confinement prerequisites.'
    });
  } else {
    const conf = conformanceRunner(sandbox.preferred, executable);
    const total = Number.isInteger(conf?.total) && conf.total > 0 ? conf.total : 8;
    const passed = Number.isInteger(conf?.passed) ? conf.passed : 0;
    const failingProbes = Array.isArray(conf?.failingProbes)
      ? conf.failingProbes
      : (conf?.probes ?? []).filter((p) => !p.passed).map((p) => p.id);
    const fullPass = passed === total && failingProbes.length === 0;
    checks.push({
      id: 'sandbox',
      status: fullPass ? 'pass' : 'fail',
      conformance: { backend: sandbox.preferred, passed, total, failingProbes },
      failingProbes,
      detail: fullPass
        ? `preferred=${sandbox.preferred} (${passed}/${total} conformance · ${sandbox.osCapable ? 'OS confinement' : 'runtime confinement'}) · available=[${availableIds.join(', ')}]${fallbackNote}`
        : `FAIL · ${sandbox.preferred} scored ${passed}/${total} conformance — failing probes: ${failingProbes.join(', ')}${fallbackNote}`,
      remediation: fullPass
        ? (sandbox.osCapable ? null : 'Install `bubblewrap` (`bwrap`), Podman/Docker, or enable unprivileged user namespaces for full OS-level isolation.')
        : `Failing sandbox probe(s): ${failingProbes.join(', ')}. Run \`vld experimental sandbox conformance --backend ${sandbox.preferred}\` or switch to the devcontainer.`
    });
  }

  // 4. Profile
  const profPath = path.resolve(project, profileFile);
  if (existsSync(profPath)) {
    try {
      const loaded = loadProfile(profPath);
      if (loaded.errors.length > 0) {
        checks.push({
          id: 'profile',
          status: 'fail',
          detail: `${profileFile} invalid: ${loaded.errors[0]}`,
          remediation: `Fix ${profileFile} or run \`vld migrate --profile ${profileFile}\`.`
        });
      } else {
        const profile = loaded.profile;
        const hints = scanRiskHints(profile);
        const hintCount = (hints.unflaggedRisks?.length ?? 0) + (hints.suggestedRegimes?.length ?? 0);
        checks.push({
          id: 'profile',
          status: hintCount === 0 ? 'pass' : 'warn',
          detail: `${path.relative(project, profPath) || profileFile} valid (${profile.kind} · ${profile.stage}${hintCount > 0 ? ` · ${hintCount} undeclared risk hint(s)` : ''})`,
          remediation: hintCount > 0 ? `Review risk hints with \`vld plan ${profileFile}\`.` : null
        });
      }
    } catch (error) {
      checks.push({
        id: 'profile',
        status: 'fail',
        detail: `${profileFile} failed validation: ${String(error?.message ?? error).split('\n')[0]}`,
        remediation: `Fix ${profileFile} or run \`vld migrate --profile ${profileFile}\`.`
      });
    }
  } else {
    checks.push({
      id: 'profile',
      status: 'info',
      detail: `no ${profileFile} found`,
      remediation: 'Run `vld intake "<idea>"` or `vld init . --interactive` to create a project profile.'
    });
  }

  // 5. Compiled packet
  const packetAbs = path.resolve(project, packetDir);
  const specPath = path.join(packetAbs, 'spec.json');
  if (existsSync(specPath)) {
    const ver = verifyPacket(packetAbs);
    let specVer = null;
    try { specVer = JSON.parse(readFileSync(specPath, 'utf8')).factoryVersion ?? null; } catch {}
    const outdated = specVer && specVer !== PACKAGE_VERSION;
    checks.push({
      id: 'packet',
      status: !ver.ok ? 'fail' : outdated ? 'warn' : 'pass',
      detail: !ver.ok
        ? `${packetDir} failed verification (${ver.errors.length} error(s): ${ver.errors[0]})`
        : outdated
          ? `${packetDir} verified (compiled with v${specVer}; current CLI is v${PACKAGE_VERSION})`
          : `${packetDir} verified`,
      remediation: !ver.ok
        ? `Run \`vld verify ${packetDir}\` to inspect errors.`
        : outdated
          ? `Run \`vld migrate --project ${project}\` to refresh the compiled packet.`
          : null
    });
  } else {
    checks.push({
      id: 'packet',
      status: 'info',
      detail: `no compiled packet at ${packetDir}/spec.json`,
      remediation: existsSync(profPath) ? `Run \`vld compile ${profileFile} -o ${packetDir}\`.` : null
    });
  }

  // 6. Evidence ledger (when present)
  const evidenceFile = path.join(project, '.vld', 'evidence', 'evidence.jsonl');
  if (existsSync(evidenceFile)) {
    const chain = verifyEvidenceChain({ projectDir: project });
    checks.push({
      id: 'evidence',
      status: chain.ok ? 'pass' : 'fail',
      detail: chain.ok
        ? `hash chain verified (${chain.count} record(s), head ${String(chain.headHash ?? '').slice(0, 12)})`
        : `hash chain INVALID: ${chain.errors[0]}`,
      remediation: chain.ok ? null : 'Inspect `.vld/evidence/evidence.jsonl` for tampering or truncation.'
    });
  }

  // 7. Telemetry posture
  const tel = telemetryStatus({ projectDir: project });
  checks.push({
    id: 'telemetry',
    status: 'pass',
    detail: tel.enabled ? 'opt-in enabled (local summary metrics only)' : 'disabled (default; zero data recorded)',
    remediation: null
  });

  const failures = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  return {
    ok: failures === 0,
    version: PACKAGE_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    failures,
    warnings,
    checks
  };
}
