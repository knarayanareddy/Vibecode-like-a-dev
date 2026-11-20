/**
 * `vld migrate` — safe, reversible forward migration for profiles, sandboxed
 * runtime policies, and compiled specification packets across VLD releases
 * (roadmap 4.4).
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultSandboxedCliPolicy } from './agent-policy.mjs';
import { defaultSandboxedDeliveryPolicy } from './delivery-policy.mjs';
import { emitPacket } from './emit/index.mjs';
import { appendEvidence } from './evidence.mjs';
import { loadIndex } from './indexer.mjs';
import { buildPlan, loadPolicy } from './planner.mjs';
import { loadProfile } from './profile.mjs';
import { PACKAGE_VERSION } from './version.mjs';

const LEGACY_STACK_ALIASES = Object.freeze({
  node: 'javascript',
  nodejs: 'javascript',
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  golang: 'go',
  dotnet: 'csharp',
  'c#': 'csharp',
  rails: 'ruby',
  laravel: 'php'
});

function writeWithBackup(file, content, dryRun) {
  if (dryRun) return;
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  writeFileSync(file, content, 'utf8');
}

/**
 * Inspect and migrate `profile.json`, `.vld/agent-policy.json`,
 * `.vld/delivery-policy.json`, and the compiled packet directory to the
 * current VLD schema and version.
 */
export function migrateProject({
  projectDir = '.',
  profileFile = 'profile.json',
  packetDir = 'specs',
  dryRun = false,
  recordEvidence = true
} = {}) {
  const project = path.resolve(projectDir);
  const actions = [];

  // 1. Migrate profile.json
  const profPath = path.resolve(project, profileFile);
  if (existsSync(profPath)) {
    const raw = JSON.parse(readFileSync(profPath, 'utf8'));
    const updated = structuredClone(raw);
    const changes = [];

    if (typeof updated?.constraints?.stack === 'string') {
      const lowered = updated.constraints.stack.trim().toLowerCase();
      if (LEGACY_STACK_ALIASES[lowered]) {
        updated.constraints.stack = LEGACY_STACK_ALIASES[lowered];
        changes.push(`constraints.stack "${raw.constraints.stack}" -> "${updated.constraints.stack}"`);
      }
    }
    if (Array.isArray(updated.regulations) && !updated.regulation) {
      updated.regulation = updated.regulations;
      delete updated.regulations;
      if (updated.risks && typeof updated.risks === 'object') updated.risks.regulated = true;
      changes.push('renamed `regulations` -> `regulation`');
    }
    if (updated.risks && typeof updated.risks === 'object' && 'money' in updated.risks && !('payments' in updated.risks)) {
      updated.risks.payments = Boolean(updated.risks.money);
      delete updated.risks.money;
      changes.push('renamed legacy `risks.money` -> `risks.payments`');
    }
    if (Array.isArray(updated.customRules) && !updated.rules) {
      updated.rules = updated.customRules;
      delete updated.customRules;
      changes.push('renamed legacy `customRules` -> `rules`');
    }

    if (changes.length > 0) {
      writeWithBackup(profPath, `${JSON.stringify(updated, null, 2)}\n`, dryRun);
      actions.push({ target: profileFile, kind: 'profile-upgraded', changes, backup: dryRun ? null : `${profileFile}.bak` });
    } else {
      actions.push({ target: profileFile, kind: 'up-to-date', changes: [] });
    }
  }

  // 2. Migrate `.vld/agent-policy.json` (schemaVersion 1 -> 2)
  const agentPolicyPath = path.join(project, '.vld', 'agent-policy.json');
  if (existsSync(agentPolicyPath)) {
    const raw = JSON.parse(readFileSync(agentPolicyPath, 'utf8'));
    if (raw.schemaVersion === 1) {
      const cliCfg = raw.adapters?.['local-cli'];
      const upgraded = cliCfg?.enabled && Array.isArray(cliCfg.command) && cliCfg.command.length > 0
        ? defaultSandboxedCliPolicy({
            executable: cliCfg.command[0],
            args: cliCfg.command.slice(1),
            backend: 'auto',
            timeoutMs: raw.limits?.durationMs ?? 120_000,
            outputBytes: raw.limits?.outputBytes ?? 65_536,
            retryBudget: raw.limits?.retryBudget ?? 0
          })
        : {
            ...raw,
            schemaVersion: 2,
            sandbox: {
              backend: 'auto',
              requireOsSandbox: false,
              allowNetwork: false,
              readOnlyWorkspace: false,
              allowReadPaths: [],
              allowWritePaths: [],
              allowedExecutables: [],
              passEnv: [],
              timeoutMs: raw.limits?.durationMs ?? 120_000
            }
          };
      writeWithBackup(agentPolicyPath, `${JSON.stringify(upgraded, null, 2)}\n`, dryRun);
      actions.push({
        target: '.vld/agent-policy.json',
        kind: 'policy-upgraded',
        changes: ['upgraded agent policy schemaVersion 1 -> 2 with sandbox confinement defaults'],
        backup: dryRun ? null : '.vld/agent-policy.json.bak'
      });
    }
  }

  // 3. Migrate `.vld/delivery-policy.json` (schemaVersion 1 -> 2)
  const deliveryPolicyPath = path.join(project, '.vld', 'delivery-policy.json');
  if (existsSync(deliveryPolicyPath)) {
    const raw = JSON.parse(readFileSync(deliveryPolicyPath, 'utf8'));
    if (raw.schemaVersion === 1) {
      const upgraded = defaultSandboxedDeliveryPolicy({
        requireAssertions: true,
        verifyGates: false,
        backend: 'auto'
      });
      writeWithBackup(deliveryPolicyPath, `${JSON.stringify(upgraded, null, 2)}\n`, dryRun);
      actions.push({
        target: '.vld/delivery-policy.json',
        kind: 'policy-upgraded',
        changes: ['upgraded delivery policy schemaVersion 1 -> 2 (sandbox receipt & resource-claim verification enabled)'],
        backup: dryRun ? null : '.vld/delivery-policy.json.bak'
      });
    }
  }

  // 4. Recompile packet when profile + packet both exist and factoryVersion is older
  const packetAbs = path.resolve(project, packetDir);
  const specPath = path.join(packetAbs, 'spec.json');
  if (existsSync(profPath) && existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const fromVersion = spec.factoryVersion ?? spec.meta?.factoryVersion ?? 'unknown';
    const needsRecompile = fromVersion !== PACKAGE_VERSION || actions.some((a) => a.target === profileFile && a.kind === 'profile-upgraded');
    if (needsRecompile) {
      if (!dryRun) {
        copyFileSync(specPath, `${specPath}.bak`);
        const { profile, errors } = loadProfile(profPath);
        if (errors.length > 0) throw new Error(`migrated profile invalid: ${errors.join('; ')}`);
        const plan = buildPlan(profile, { index: loadIndex(), policy: loadPolicy(), profileDir: path.dirname(profPath) });
        plan.profileLabel = profileFile.split(path.sep).join('/');
        emitPacket(plan, packetAbs, { force: true });
      }
      actions.push({
        target: packetDir,
        kind: 'packet-recompiled',
        changes: [`recompiled packet from v${fromVersion} -> v${PACKAGE_VERSION}`],
        backup: dryRun ? null : `${packetDir}/spec.json.bak`
      });
    } else {
      actions.push({ target: packetDir, kind: 'up-to-date', changes: [] });
    }
  }

  const changedCount = actions.filter((a) => a.kind !== 'up-to-date').length;
  if (!dryRun && recordEvidence && changedCount > 0) {
    try {
      appendEvidence({
        projectDir: project,
        kind: 'migration',
        actor: 'operator:vld-migrate',
        subject: `v${PACKAGE_VERSION}`,
        payload: {
          targetVersion: PACKAGE_VERSION,
          changedCount,
          targets: actions.filter((a) => a.kind !== 'up-to-date').map((a) => a.target)
        }
      });
    } catch {}
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    targetVersion: PACKAGE_VERSION,
    changedCount,
    actions
  };
}
