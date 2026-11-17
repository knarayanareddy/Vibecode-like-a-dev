/**
 * `vld doctor` — zero-dependency workspace, environment, packet, sandbox, and
 * governance health check (roadmap 4.3).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { telemetryStatus, verifyEvidenceChain } from './evidence.mjs';
import { loadProfile } from './profile.mjs';
import { scanRiskHints } from './risk-hints.mjs';
import { detectSandboxBackends } from './sandbox/index.mjs';
import { verifyPacket } from './verify.mjs';
import { PACKAGE_VERSION } from './version.mjs';

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

/** Run all workspace diagnostic probes without mutating project state. */
export function runDoctor({
  projectDir = '.',
  profileFile = 'profile.json',
  packetDir = 'specs'
} = {}) {
  const project = path.resolve(projectDir);
  const checks = [];

  // 1. Node runtime
  const major = parseNodeMajor();
  const hasPermFlag = typeof process.permission === 'object' || major >= 22;
  checks.push({
    id: 'node-runtime',
    status: major >= 22 ? 'pass' : 'fail',
    detail: `Node v${process.versions.node} (requires >=22.0.0; --permission ${hasPermFlag ? 'available' : 'unavailable'})`,
    remediation: major >= 22 ? null : 'Install Node.js 22 LTS (`nvm use` against `.nvmrc`).'
  });

  // 2. Git
  checks.push(checkGit(project));

  // 3. Sandbox backends
  const sandbox = detectSandboxBackends();
  const availableIds = sandbox.backends.filter((b) => b.available).map((b) => b.id);
  checks.push({
    id: 'sandbox',
    status: sandbox.preferred ? 'pass' : 'warn',
    detail: sandbox.preferred
      ? `preferred=${sandbox.preferred} (${sandbox.osCapable ? 'OS confinement available' : 'runtime confinement only'}) · available=[${availableIds.join(', ')}]`
      : 'no sandbox backend available',
    remediation: sandbox.osCapable
      ? null
      : 'Install `bubblewrap` (`bwrap`), Podman/Docker, or enable unprivileged user namespaces for full OS-level isolation.'
  });

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
        const hintCount = (hints.undeclaredFlags?.length ?? 0) + (hints.suggestedRegimes?.length ?? 0);
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
      remediation: 'Run `vld init . --interactive` or `vld adopt .` to create a project profile.'
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
      detail: `${packetDir} ${ver.ok ? 'verified' : `invalid (${ver.errors.length} error(s))`}${specVer ? ` · factory v${specVer}` : ''}`,
      remediation: !ver.ok
        ? `Run \`vld verify ${packetDir}\` to inspect errors.`
        : outdated
          ? `Run \`vld migrate --packet ${packetDir}\` to refresh packet to v${PACKAGE_VERSION}.`
          : null
    });
  } else {
    checks.push({
      id: 'packet',
      status: 'info',
      detail: `no compiled packet at ${packetDir}`,
      remediation: existsSync(profPath) ? `Run \`vld compile ${profileFile} -o ${packetDir}\`.` : null
    });
  }

  // 6. Evidence chain integrity
  const chain = verifyEvidenceChain({ projectDir: project });
  if (chain.exists) {
    checks.push({
      id: 'evidence-chain',
      status: chain.ok ? 'pass' : 'fail',
      detail: chain.ok
        ? `verified (${chain.entries} entries · head ${chain.headHash.slice(0, 12)})`
        : `BROKEN at seq ${chain.firstBrokenSeq}: ${chain.errors[0]}`,
      remediation: chain.ok ? null : 'Inspect `.vld/evidence/evidence.jsonl` in Git history to locate unauthorized modification.'
    });
  }

  // 7. Telemetry status
  const telemetry = telemetryStatus({ projectDir: project });
  checks.push({
    id: 'telemetry',
    status: 'pass',
    detail: telemetry.enabled
      ? `opt-in local enabled (${telemetry.recordedEvents} anonymous event(s); zero automatic network calls)`
      : 'disabled (default; zero data recorded)',
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
