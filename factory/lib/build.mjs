/**
 * End-to-end autonomous spec-to-verified-candidate orchestrator (`vld build`,
 * ADR 0011, roadmap 2.7).
 *
 * Pipeline:
 *   1. Compile `profileFile` (when supplied) or verify existing `packetDir`.
 *   2. Initialize or validate a dependency-ordered mission DAG covering every
 *      packet requirement.
 *   3. Topologically schedule work packages; allocate an isolated Git worktree
 *      and Runtime lease per package.
 *   4. Run the configured agent adapter (`sandboxed-cli`, `sandboxed-acp`, or
 *      deterministic `fake` in dry/CI mode) inside `factory/lib/sandbox/`.
 *   5. Verify the workspace against the packet drift guard, gate runner,
 *      resourceClaims, and optional sandboxed test command; if checks fail,
 *      drive `runRepairLoop` up to `maxRepairs` bounded iterations.
 *   6. Commit clean changes on the isolated package branch, record a
 *      receipt-gated v2 candidate and integration verification receipt, and
 *      write a canonical `build-report.json` with a tamper-evident digest.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgentAdapter } from './agent-adapters.mjs';
import { harvestTranscripts } from './agent-transcript.mjs';
import { agentPolicyDigest, assertAgentPolicy, defaultFakeAgentPolicy, defaultSandboxedAgentPolicy, defaultSandboxedCliPolicy, FACTORY_ROOT } from './agent-policy.mjs';
import { defaultDeliveryPolicy, defaultSandboxedDeliveryPolicy } from './delivery-policy.mjs';
import { emitPacket } from './emit/index.mjs';
import { digest, ensureProjectDir, extensionError, readJson, writeJsonAtomic } from './extension-utils.mjs';
import { buildIndex } from './indexer.mjs';
import { createMission, planMissionDefinitionFromPacket, readMission } from './missions.mjs';
import { buildPlan, loadPolicy } from './planner.mjs';
import { normalizeProfile, validateProfile } from './profile.mjs';
import { runRepairLoop } from './repair.mjs';
import { allocateRuntimePackage, initializeRuntime, runtimeStatus } from './runtime.mjs';
import { runRuntimeAgent } from './runtime-agent.mjs';
import { submitRuntimeDeliveryCandidate, verifyRuntimeDeliveryCandidateAsync } from './runtime-delivery.mjs';
import { checkResourceClaims, runSandboxed, workspaceTreeDigest } from './sandbox/index.mjs';
import { verifyPacket } from './verify.mjs';
import { createWorkspace } from './workspaces.mjs';

export const BUILD_REPORT_SCHEMA_VERSION = 1;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function worktreeSnapshotTree(worktree) {
  try {
    git(worktree, ['add', '-A']);
    return git(worktree, ['write-tree']);
  } catch {
    return null;
  }
}

function captureRepairDelta(worktree, treeBefore, briefPath) {
  try {
    if (briefPath && existsSync(briefPath)) rmSync(briefPath, { force: true });
    const treeAfter = worktreeSnapshotTree(worktree);
    if (!treeBefore || !treeAfter || treeBefore === treeAfter) return null;
    return git(worktree, ['diff', treeBefore, treeAfter]).slice(0, 8000);
  } catch {
    return null;
  }
}

function topologicalOrder(workPackages) {
  const byId = new Map(workPackages.map((p) => [p.id, p]));
  const visited = new Set();
  const ordered = [];
  const visit = (pkg) => {
    if (visited.has(pkg.id)) return;
    visited.add(pkg.id);
    for (const dep of pkg.dependsOn ?? []) {
      const parent = byId.get(dep);
      if (parent) visit(parent);
    }
    ordered.push(pkg);
  };
  for (const pkg of workPackages) visit(pkg);
  return ordered;
}

async function verifyPackageWorktree({
  worktree,
  packetRel,
  resourceClaims,
  baseCommit,
  sandboxBackend,
  requireOsSandbox,
  testCommand,
  verifyGates,
  requireAssertions
}) {
  const packetAbs = path.join(worktree, packetRel);
  // Parse `git status --porcelain` defensively: the execSync helper trims the
  // whole output, which can strip the first line's leading status space —
  // slicing a fixed 3 chars would then eat the path's first character.
  const statusLines = git(worktree, ['status', '--porcelain'])
    .split(/\r?\n/)
    .map((line) => line.replace(/^.{0,2}\s+/, '').trim())
    .filter(Boolean);
  const committedLines = git(worktree, ['diff', '--name-only', baseCommit])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const changed = [...new Set([...statusLines, ...committedLines])].filter((f) => !f.startsWith('.vld-repair') && !f.startsWith('.vld/'));
  const claims = checkResourceClaims(changed, resourceClaims);

  const driftReport = verifyPacket(packetAbs, {
    repo: worktree,
    strict: true,
    requireAssertions
  });

  // Also execute shipped spec-check.mjs inside the read-only sandbox for parity.
  const specCheckFile = path.join(packetAbs, 'spec-check.mjs');
  let specCheckRun = { ok: true, stdout: '', stderr: '' };
  if (existsSync(specCheckFile)) {
    const scArgs = [specCheckFile, '--repo', worktree, '--strict'];
    if (requireAssertions) scArgs.push('--require-assertions');
    specCheckRun = await runSandboxed({
      executable: process.execPath,
      args: scArgs,
      workspace: worktree,
      mode: 'read-only',
      network: false,
      backend: sandboxBackend,
      requireOs: requireOsSandbox,
      limits: { durationMs: 30_000, outputBytes: 131_072 }
    });
  }

  let gatesRun = { ok: true, stdout: '', stderr: '' };
  const gatesFile = path.join(packetAbs, 'enforcement', 'gates.mjs');
  if (verifyGates && existsSync(gatesFile)) {
    gatesRun = await runSandboxed({
      executable: process.execPath,
      args: [gatesFile, '--repo', worktree, '--strict'],
      workspace: worktree,
      mode: 'read-only',
      network: false,
      backend: sandboxBackend,
      requireOs: requireOsSandbox,
      limits: { durationMs: 30_000, outputBytes: 131_072 }
    });
  }

  let testsRun = null;
  if (testCommand) {
    testsRun = await runSandboxed({
      executable: testCommand.executable,
      args: testCommand.args ?? [],
      workspace: worktree,
      mode: 'read-only',
      network: false,
      allowChildProcess: Boolean(testCommand.allowChildProcess),
      extraReadPaths: testCommand.extraReadPaths ?? [],
      backend: sandboxBackend,
      requireOs: requireOsSandbox,
      limits: { durationMs: testCommand.timeoutMs ?? 60_000, outputBytes: 262_144 }
    });
  }

  const ok = claims.ok && driftReport.ok && specCheckRun.ok && gatesRun.ok && (!testsRun || testsRun.ok);
  return {
    ok,
    resourceClaimViolations: claims.violations,
    drift: {
      ok: driftReport.ok && specCheckRun.ok,
      errors: driftReport.errors ?? [],
      stdout: specCheckRun.stdout
    },
    gates: {
      ok: gatesRun.ok,
      stdout: gatesRun.stdout
    },
    tests: testsRun
      ? { ok: testsRun.ok, outcome: testsRun.outcome, exitCode: testsRun.exitCode, stdout: testsRun.stdout, stderr: testsRun.stderr, receiptDigest: testsRun.receipt.receiptDigest }
      : null
  };
}

/**
 * Execute an end-to-end spec-governed build (`vld build`).
 */
export async function runBuild({
  projectDir = '.',
  profileFile = null,
  packetDir = 'specs',
  missionFile = null,
  adapter = 'sandboxed-cli',
  executable = null,
  args = [],
  sandboxBackend = 'auto',
  requireOsSandbox = false,
  allowChildProcess = false,
  extraReadPaths = [],
  testCommand = null,
  verifyGates = false,
  requireAssertions = true,
  maxRepairs = 2,
  missionOverrides = null,
  dryRun = false,
  reportFile = null,
  model = null,
  cassetteDir = null,
  cassetteMode = null,
  environment = {}
} = {}) {
  const project = ensureProjectDir(projectDir);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const packetAbs = path.resolve(project, packetDir);
  const packetRel = path.relative(project, packetAbs).split(path.sep).join('/');
  if (packetRel.startsWith('..') || path.isAbsolute(packetRel)) {
    throw extensionError('packetDir must be inside projectDir', 'INVALID_BUILD_PACKET');
  }

  // Step 1: Compile profile if requested, then verify packet.
  let compiled = false;
  if (profileFile) {
    const profPath = path.resolve(project, profileFile);
    if (!existsSync(profPath)) throw extensionError(`profile not found: ${profPath}`, 'PROFILE_NOT_FOUND');
    const rawProfile = readJson(profPath);
    const profile = normalizeProfile(rawProfile);
    const profErrors = validateProfile(profile);
    if (profErrors.length > 0) {
      throw extensionError(`profile invalid:\n${profErrors.map((e) => `- ${e}`).join('\n')}`, 'INVALID_PROFILE');
    }
    const index = buildIndex();
    const plan = buildPlan(profile, { index, policy: loadPolicy(), profileDir: path.dirname(profPath) });
    emitPacket(plan, packetAbs, { force: true, packetDir: packetRel });
    compiled = true;
  }

  const packetCheck = verifyPacket(packetAbs, { strict: false });
  if (!packetCheck.ok) {
    throw extensionError(`packet failed verification:\n${packetCheck.errors.map((e) => `- ${e}`).join('\n')}`, 'INVALID_BUILD_PACKET');
  }
  const spec = readJson(path.join(packetAbs, 'spec.json'));

  // Step 2: Load or generate topological mission DAG.
  let resolvedMissionRel = missionFile;
  let mission;
  if (resolvedMissionRel) {
    mission = readMission(resolvedMissionRel, { projectDir: project }).mission;
  } else {
    const def = planMissionDefinitionFromPacket({ packetDir: packetAbs, overrides: missionOverrides });
    if (dryRun) {
      const reportBody = {
        schemaVersion: BUILD_REPORT_SCHEMA_VERSION,
        dryRun: true,
        ok: true,
        compiled,
        startedAt,
        finishedAt: new Date().toISOString(),
        packet: { path: packetRel, digest: digest(readFileSync(path.join(packetAbs, 'spec.json'), 'utf8')) },
        plannedMission: def,
        order: topologicalOrder(def.workPackages).map((p) => p.id),
        packages: []
      };
      return { ...reportBody, reportDigest: digest(reportBody) };
    }
    resolvedMissionRel = path.join('missions', def.id, 'mission.json');
    const created = createMission({
      definition: def,
      packetDir: packetRel,
      outFile: resolvedMissionRel,
      projectDir: project,
      force: true
    });
    mission = created.mission;
  }

  const schedule = topologicalOrder(mission.workPackages);
  if (dryRun) {
    const reportBody = {
      schemaVersion: BUILD_REPORT_SCHEMA_VERSION,
      dryRun: true,
      ok: true,
      compiled,
      startedAt,
      finishedAt: new Date().toISOString(),
      packet: mission.packet,
      missionId: mission.id,
      order: schedule.map((p) => p.id),
      packages: []
    };
    return { ...reportBody, reportDigest: digest(reportBody) };
  }

  // Step 3: Initialize Runtime + materialize reviewed agent & delivery policies.
  initializeRuntime({ missionFile: resolvedMissionRel, projectDir: project });
  const policyDirRel = path.join('.vld', 'build', mission.id);
  const policyDirAbs = path.join(project, policyDirRel);
  mkdirSync(policyDirAbs, { recursive: true });

  const agentPolicyRel = path.join(policyDirRel, 'agent-policy.json');
  const deliveryPolicyRel = path.join(policyDirRel, 'delivery-policy.json');

  const missionBudget = mission.budget ?? null;
  const agentEnvironment = {
    ...environment,
    // Roadmap 4.3: the frozen mission budget bounds every model run — an
    // overrun aborts the run (and with it the mission build).
    ...(missionBudget?.maxCostUsd ? { VLD_MODEL_MAX_COST_USD: String(missionBudget.maxCostUsd) } : {}),
    ...(missionBudget?.maxTokens ? { VLD_MODEL_MAX_TOKENS: String(missionBudget.maxTokens) } : {}),
    ...(model ? { VLD_MODEL_SPEC: model } : {}),
    ...(cassetteDir ? { VLD_MODEL_CASSETTE_DIR: path.resolve(project, cassetteDir) } : {}),
    ...(cassetteMode ? { VLD_MODEL_CASSETTE_MODE: cassetteMode } : {}),
    ...(testCommand ? {
      VLD_TEST_COMMAND: JSON.stringify({
        executable: testCommand.executable,
        args: testCommand.args ?? [],
        timeoutMs: testCommand.timeoutMs ?? 60_000
      })
    } : {})
  };
  const agentExecutable = executable ?? (adapter === 'sandboxed-agent' ? process.execPath : process.execPath);
  const agentArgs = adapter === 'sandboxed-agent' && !executable && args.length === 0
    ? [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'implementer.mjs')]
    : args;

  const agentPolicy = adapter === 'fake'
    ? defaultFakeAgentPolicy()
    : assertAgentPolicy({
        ...(adapter === 'sandboxed-agent'
          ? defaultSandboxedAgentPolicy({
              executable: agentExecutable,
              args: agentArgs,
              mode: 'write-workspace',
              backend: sandboxBackend
            })
          : defaultSandboxedCliPolicy({
              executable: executable ?? process.execPath,
              args,
              mode: 'write-workspace',
              backend: sandboxBackend
            })),
        adapter,
        environment: agentEnvironment,
        sandbox: {
          backend: sandboxBackend,
          requireOs: Boolean(requireOsSandbox),
          allowChildProcess: Boolean(allowChildProcess) || adapter === 'sandboxed-agent',
          extraReadPaths: adapter === 'sandboxed-agent'
            ? [...new Set([...extraReadPaths, FACTORY_ROOT])]
            : [...extraReadPaths]
        }
      });
  writeJsonAtomic(path.join(project, agentPolicyRel), agentPolicy);

  const deliveryPolicy = adapter === 'fake'
    ? defaultDeliveryPolicy()
    : defaultSandboxedDeliveryPolicy({
        sandboxBackend,
        commands: testCommand ? [{
          id: testCommand.id ?? 'project-tests',
          executable: testCommand.executable,
          args: testCommand.args ?? [],
          timeoutMs: testCommand.timeoutMs ?? 60_000,
          ...(testCommand.allowChildProcess ? { allowChildProcess: true } : {}),
          ...(testCommand.extraReadPaths ? { extraReadPaths: testCommand.extraReadPaths } : {})
        }] : []
      });
  if (deliveryPolicy.schemaVersion === 2) {
    deliveryPolicy.verification.verifyDriftGuard = Boolean(requireAssertions);
    deliveryPolicy.verification.verifyGates = Boolean(verifyGates);
    deliveryPolicy.verification.requireOsSandbox = Boolean(requireOsSandbox);
  }
  writeJsonAtomic(path.join(project, deliveryPolicyRel), deliveryPolicy);

  // Step 4-6: Execute, verify, repair, commit, submit & integration-verify per package.
  const packageReports = [];
  let buildOk = true;

  const buildOne = async (pkg) => {
    const wsRes = createWorkspace({ missionFile: resolvedMissionRel, packageId: pkg.id, projectDir: project });
    const worktree = wsRes.allocation.worktree;
    const alloc = allocateRuntimePackage({
      missionFile: resolvedMissionRel,
      packageId: pkg.id,
      assignee: { role: 'implementer', id: `builder-${pkg.id}` },
      projectDir: project
    });
    const leaseToken = alloc.leaseToken;

    const agentRunRes = await runRuntimeAgent({
      missionFile: resolvedMissionRel,
      packageId: pkg.id,
      policyFile: agentPolicyRel,
      leaseToken,
      projectDir: project
    });

    if (!agentRunRes.ok) {
      return {
        ok: false,
        entry: {
          packageId: pkg.id,
          ok: false,
          stage: 'agent-run',
          agentRunId: agentRunRes.agentRun?.id ?? null,
          sandboxReceiptDigest: agentRunRes.agentRun?.sandbox?.receiptDigest ?? null,
          repairsUsed: 0,
          candidateId: null,
          verificationOutcome: null,
          usage: agentRunRes.agentRun?.usage ?? null
        }
      };
    }

    let repairOutcome = null;
    let latestSandboxAfterDigest = agentRunRes.agentRun?.sandbox?.workspaceDigestAfter ?? null;
    const repairBriefPath = path.join(worktree, '.vld-repair-brief.md');

    if (adapter !== 'fake') {
      const pkgReqs = (spec.requirements ?? []).filter((r) => pkg.requirements.includes(r.id));
      repairOutcome = await runRepairLoop({
        packageId: pkg.id,
        requirements: pkgReqs,
        maxRepairs,
        budget: pkg.budget ?? mission.budget ?? null,
        initialUsage: agentRunRes.agentRun?.usage ?? null,
        verify: async () => verifyPackageWorktree({
          worktree,
          packetRel,
          resourceClaims: pkg.resourceClaims?.paths ?? [],
          baseCommit: wsRes.allocation.baseCommit,
          sandboxBackend,
          requireOsSandbox,
          testCommand,
          verifyGates,
          requireAssertions
        }),
        repair: async ({ attempt, prompt }) => {
          const treeBefore = worktreeSnapshotTree(worktree);
          writeFileSync(repairBriefPath, prompt, 'utf8');
          try {
            if (adapter === 'sandboxed-agent') {
              const execution = await executeAgentAdapter({
                spec: {
                  id: `repair-${pkg.id}-a${attempt}`,
                  missionId: mission.id,
                  packageId: pkg.id,
                  packetDigest: agentPolicyDigest(agentPolicy),
                  contextDigest: agentPolicyDigest(agentPolicy),
                  requirementIds: pkg.requirements,
                  resourceClaims: pkg.resourceClaims?.paths ?? [],
                  workspace: worktree
                },
                policy: {
                  ...agentPolicy,
                  environment: {
                    ...agentPolicy.environment,
                    VLD_REPAIR_ATTEMPT: String(attempt),
                    VLD_REPAIR_BRIEF: '.vld-repair-brief.md'
                  }
                }
              });
              if (execution.transcriptDigest !== null && !execution.transcriptVerified) {
                throw extensionError(
                  `repair attempt ${attempt} transcript failed verification: ${(execution.transcriptErrors ?? []).join('; ')}`,
                  'AGENT_TRANSCRIPT_TAMPERED'
                );
              }
              if (execution.transcriptDigest) {
                harvestTranscripts({
                  from: path.join(worktree, '.vld', 'agent-transcripts'),
                  to: path.join(project, '.vld', 'agent-transcripts'),
                  runId: `repair-${pkg.id}-a${attempt}`
                });
              }
              latestSandboxAfterDigest = workspaceTreeDigest(worktree);
              return {
                sandboxReceipt: execution.sandboxReceipt,
                receiptDigest: execution.sandboxReceipt.receiptDigest,
                transcriptDigest: execution.transcriptDigest,
                usage: execution.usage ?? null,
                diffSinceLastAttempt: captureRepairDelta(worktree, treeBefore, repairBriefPath)
              };
            }
            const run = await runSandboxed({
              executable: agentPolicy.command.executable,
              args: agentPolicy.command.args,
              workspace: worktree,
              mode: 'write-workspace',
              network: false,
              allowChildProcess: Boolean(allowChildProcess) || adapter === 'sandboxed-agent',
              extraReadPaths,
              backend: sandboxBackend,
              requireOs: Boolean(requireOsSandbox),
              policyDigest: agentPolicyDigest(agentPolicy),
              env: {
                ...agentPolicy.environment,
                VLD_MISSION_ID: mission.id,
                VLD_PACKAGE_ID: pkg.id,
                VLD_REQUIREMENT_IDS: pkg.requirements.join(','),
                VLD_REPAIR_ATTEMPT: String(attempt),
                VLD_REPAIR_BRIEF: '.vld-repair-brief.md'
              },
              limits: agentPolicy.limits
            });
            latestSandboxAfterDigest = workspaceTreeDigest(worktree);
            return {
              sandboxReceipt: run.receipt,
              receiptDigest: run.receipt.receiptDigest,
              usage: null,
              diffSinceLastAttempt: captureRepairDelta(worktree, treeBefore, repairBriefPath)
            };
          } finally {
            if (existsSync(repairBriefPath)) rmSync(repairBriefPath, { force: true });
          }
        }
      });

      if (existsSync(repairBriefPath)) rmSync(repairBriefPath, { force: true });

      if (!repairOutcome.ok) {
        return {
          ok: false,
          entry: {
            packageId: pkg.id,
            ok: false,
            stage: 'repair-loop',
            agentRunId: agentRunRes.agentRun.id,
            sandboxReceiptDigest: agentRunRes.agentRun.sandbox?.receiptDigest ?? null,
            repairOutcome: repairOutcome.outcome,
            repairsUsed: repairOutcome.repairsUsed,
            repairLedgerDigest: repairOutcome.ledgerDigest,
            failureDigest: repairOutcome.ledger?.at(-1)?.failureDigest ?? null,
            failureKinds: (repairOutcome.ledger?.at(-1)?.failures ?? []).map((f) => `${f.kind}: ${f.detail ?? f.message ?? ''}`),
            escalated: Boolean(repairOutcome.escalated),
            candidateId: null,
            verificationOutcome: 'failed',
            usage: repairOutcome.usage ?? agentRunRes.agentRun?.usage ?? null
          }
        };
      }
    }

    // Commit any clean in-scope workspace changes onto the isolated package branch.
    if (git(worktree, ['status', '--porcelain'])) {
      git(worktree, ['add', '-A']);
      git(worktree, [
        '-c', 'user.name=VLD Builder',
        '-c', 'user.email=vld-build@local.invalid',
        'commit', '-qm', `vld(build): complete ${pkg.id}`
      ]);
    }
    const candidateSha = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']);

    // If a repair attempt updated the workspace after the initial agentRun receipt,
    // use a delivery policy keyed to the repair-verified workspace while retaining
    // every repair sandboxReceiptDigest in the build report.
    let activeDeliveryRel = deliveryPolicyRel;
    if (repairOutcome && repairOutcome.repairsUsed > 0 && latestSandboxAfterDigest !== agentRunRes.agentRun.sandbox?.workspaceDigestAfter) {
      const repairedPolicy = {
        ...deliveryPolicy,
        id: `${deliveryPolicy.id}-repaired`,
        verification: { ...deliveryPolicy.verification, requireSandboxReceipt: false }
      };
      activeDeliveryRel = path.join(policyDirRel, `delivery-policy-${pkg.id}.json`);
      writeJsonAtomic(path.join(project, activeDeliveryRel), repairedPolicy);
    }

    const submitted = submitRuntimeDeliveryCandidate({
      missionFile: resolvedMissionRel,
      packageId: pkg.id,
      candidateSha,
      policyFile: activeDeliveryRel,
      leaseToken,
      adapterRunId: agentRunRes.agentRun.id,
      projectDir: project
    });

    const verified = await verifyRuntimeDeliveryCandidateAsync({
      missionFile: resolvedMissionRel,
      packageId: pkg.id,
      policyFile: activeDeliveryRel,
      projectDir: project
    });

    const pkgPassed = verified.verification.outcome === 'passed';
    return {
      ok: pkgPassed,
      entry: {
        packageId: pkg.id,
        requirements: pkg.requirements,
        ok: pkgPassed,
        stage: pkgPassed ? 'verified' : 'integration-verify',
        agentRunId: agentRunRes.agentRun.id,
        sandboxBackend: agentRunRes.agentRun.sandbox?.backend ?? (adapter === 'fake' ? 'fake' : null),
        confinementClass: agentRunRes.agentRun.sandbox?.confinementClass ?? null,
        sandboxReceiptDigest: agentRunRes.agentRun.sandbox?.receiptDigest ?? null,
        repairOutcome: repairOutcome?.outcome ?? 'not-needed',
        repairsUsed: repairOutcome?.repairsUsed ?? 0,
        repairLedgerDigest: repairOutcome?.ledgerDigest ?? null,
        escalated: Boolean(repairOutcome?.escalated),
        candidateId: submitted.candidate.id,
        candidateSha,
        provenance: submitted.candidate.provenance ?? null,
        verificationId: verified.verification.id,
        verificationOutcome: verified.verification.outcome,
        usage: repairOutcome?.usage ?? agentRunRes.agentRun?.usage ?? null,
        checks: verified.verification.checks.map((c) => ({ id: c.id, kind: c.kind, passed: c.passed }))
      }
    };
  };

  // Run ready packages concurrently up to the mission's worktree cap
  // (roadmap P3.4): a package starts once its dependencies have finished and
  // a slot is free; the first failure stops new launches and drains in flight.
  const concurrencyCap = Math.max(1, Math.min(mission.maxConcurrentWorktrees ?? 1, 4));
  const outcomesById = new Map();
  const completedIds = new Set();
  const inFlight = new Map();
  let failureSeen = false;
  while (!failureSeen) {
    let launched = false;
    for (const candidate of schedule) {
      if (inFlight.size >= concurrencyCap) break;
      if (completedIds.has(candidate.id) || inFlight.has(candidate.id)) continue;
      if (!(candidate.dependsOn ?? []).every((dep) => completedIds.has(dep))) continue;
      launched = true;
      const startedAt = new Date().toISOString();
      const promise = buildOne(candidate)
        .then((result) => ({ result }))
        .catch((error) => ({ error }))
        .then((outcome) => {
          inFlight.delete(candidate.id);
          completedIds.add(candidate.id);
          outcomesById.set(candidate.id, { ...outcome, startedAt, finishedAt: new Date().toISOString() });
          if (outcome.error || !outcome.result.ok) failureSeen = true;
          return outcome;
        });
      inFlight.set(candidate.id, promise);
    }
    if (inFlight.size === 0) break;
    if (!launched && inFlight.size > 0) await Promise.race([...inFlight.values()]);
  }
  if (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
  for (const pkg of schedule) {
    const outcome = outcomesById.get(pkg.id);
    if (outcome) packageReports.push(outcome.result
      ? { ...outcome.result.entry, startedAt: outcome.startedAt, finishedAt: outcome.finishedAt }
      : { packageId: pkg.id, ok: false, stage: 'error', error: String(outcome.error?.message ?? outcome.error ?? 'unknown build error'), startedAt: outcome.startedAt, finishedAt: outcome.finishedAt });
  }
  const firstError = schedule.map((pkg) => outcomesById.get(pkg.id)?.error).find(Boolean);
  if (firstError) throw firstError;
  for (const outcome of outcomesById.values()) if (outcome.error || !outcome.result.ok) buildOk = false;

  const finalStatus = runtimeStatus({ missionFile: resolvedMissionRel, projectDir: project });
  const reportBody = {
    schemaVersion: BUILD_REPORT_SCHEMA_VERSION,
    dryRun: false,
    ok: buildOk,
    compiled,
    adapter,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedMs),
    missionId: mission.id,
    missionFile: resolvedMissionRel,
    packet: mission.packet,
    order: schedule.map((p) => p.id),
    maxConcurrentWorktrees: concurrencyCap,
    packages: packageReports,
    runtimeSequence: finalStatus.runtime.sequence
  };
  const report = { ...reportBody, reportDigest: digest(reportBody) };

  const outReportRel = reportFile ?? path.join(policyDirRel, 'build-report.json');
  writeJsonAtomic(path.join(project, outReportRel), report);

  try {
    const { appendEvidence } = await import('./evidence.mjs');
    appendEvidence({
      projectDir: project,
      kind: 'build',
      actor: 'runtime:vld-build',
      subject: mission.id,
      payload: {
        ok: report.ok,
        adapter,
        packages: packageReports.length,
        verifiedPackages: packageReports.filter((p) => p.ok).length,
        packetDigest: mission.packet?.digest ?? null,
        reportDigest: report.reportDigest,
        // Roadmap 4.3: each model-produced evidence entry records the model id,
        // prompt hash, tool-call transcript digest and token/cost ledger.
        provenance: packageReports
          .filter((entry) => entry.provenance)
          .map((entry) => ({ packageId: entry.packageId, ...entry.provenance }))
      }
    });
  } catch {}

  return { ...report, reportFile: outReportRel };
}
