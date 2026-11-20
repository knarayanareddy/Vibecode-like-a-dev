#!/usr/bin/env node
/**
 * Records the golden-journey cassettes (intake / implementer / reviewer) against
 * scripted loopback upstreams, replaying the exact P4.1 journey pipeline.
 *
 * Run from the repository root:
 *   node factory/test/fixtures/golden-journey/record.mjs
 *
 * The cassettes land in ./cassettes/{intake,implementer,reviewer}/ and are
 * checked in. The journey test replays them offline with --cassette-mode replay.
 * Because every git commit uses fixed dates (journey-lib gitEnv), the request
 * digests recorded here are byte identical to the replay pass.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLI,
  FIXTURE_DIR,
  INTAKE_REPLY,
  PARAGRAPH,
  REVIEWER_REPLY,
  TEST_CMD,
  git,
  gitEnv,
  implementerScript,
  makeProject,
  runCli,
  singlePackageDefinition,
  startScriptedUpstream
} from './journey-lib.mjs';
import { planMissionDefinitionFromPacket } from '../../../lib/missions.mjs';

export const OVERLAY = {
  id: 'golden-storage',
  layer: 'team',
  title: 'Durable ticket storage',
  why: 'The golden journey must prove that ticket state and repair notes survive restarts.',
  addRequirements: [
    {
      key: 'data.golden-durable-tickets',
      title: 'Tickets and repair notes survive a service restart',
      area: 'data',
      statement: 'When the service restarts, the application shall restore every ticket and its repair note from durable storage.',
      definition: 'Ticket state changes are written through a storage layer that a restart re-reads.',
      failurePath: 'If the store cannot be read back after a restart, the application fails health checks instead of serving an empty ticket list.',
      acceptance: [
        'Given a resolved ticket with a repair note, when the service restarts, then the ticket and note are returned unchanged.',
        'Given a failed store read-back, when the health check runs, then it reports the store as down.'
      ],
      verify: 'automated',
      traits: ['persistence']
    }
  ]
};

/** Profile patch applied after intake accept: the storage overlay carries the
 * persistence trait requirement, so the compiled packet has full trait coverage. */
export function applyStorageOverlay(profileFile) {
  const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
  profile.overlays = ['golden-storage'];
  writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  mkdirSync(path.join(path.dirname(profileFile), 'overlays'), { recursive: true });
  writeFileSync(path.join(path.dirname(profileFile), 'overlays', 'golden-storage.json'), `${JSON.stringify(OVERLAY, null, 2)}\n`, 'utf8');
}

export async function recordCassettes() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-golden-record-'));
  const cassettes = path.join(root, 'cassettes');
  for (const leg of ['intake', 'implementer', 'reviewer']) mkdirSync(path.join(cassettes, leg), { recursive: true });

  try {
    const { project } = await makeProject(root);
    const paragraphFile = path.join(root, 'paragraph.md');
    writeFileSync(paragraphFile, `${PARAGRAPH}\n`, 'utf8');

    // ---- 1. intake (record) -----------------------------------------------
    const intakeUpstream = await startScriptedUpstream([{ content: INTAKE_REPLY }]);
    try {
      const intake = await runCli(
        ['intake', '--file', paragraphFile, '--provider', 'openai', '--model', 'golden-intake',
          '--base-url', `${intakeUpstream.url}/v1`, '--cassette', path.join(cassettes, 'intake'),
          '--cassette-mode', 'record', '-o', 'profile.draft.json', '--json'],
        {
          cwd: project,
          env: { OPENAI_API_KEY: 'sk-record-test' }
        }
      );
      if (intake.code !== 0) throw new Error(`intake record failed: ${intake.stderr}\n${intake.stdout.slice(-800)}`);
      const accept = await runCli(['intake', 'accept', 'profile.draft.json', '-o', 'profile.json', '--answer', 'stage=mvp'], { cwd: project });
      if (accept.code !== 0) throw new Error(`intake accept failed: ${accept.stderr}`);
    } finally {
      await intakeUpstream.close();
    }
    applyStorageOverlay(path.join(project, 'profile.json'));

    // ---- 2. plan/compile + packet commit + mission ------------------------
    const plan = await runCli(['plan', 'profile.json'], { cwd: project });
    if (plan.code !== 0) throw new Error(`plan failed: ${plan.stderr}`);
    const compile = await runCli(['compile', 'profile.json', '-o', 'specs', '--force'], { cwd: project });
    if (compile.code !== 0) throw new Error(`compile failed: ${compile.stderr}`);

    await git(project, ['add', '-A']);
    await git(project, ['commit', '-qm', 'profile + verified packet + storage overlay'], gitEnv(1));

    const definition = singlePackageDefinition(planMissionDefinitionFromPacket({
      packetDir: path.join(project, 'specs'),
      missionId: 'golden-journey',
      title: 'Meridian golden journey'
    }));
    writeFileSync(path.join(project, 'definition.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
    const mission = await runCli(['mission', 'init', 'definition.json', '--packet', 'specs', '--target', 'HEAD', '-o', 'missions/golden.json'], { cwd: project });
    if (mission.code !== 0) throw new Error(`mission init failed: ${mission.stderr}`);

    // ---- 3. implementer via vld build (record) ----------------------------
    const implementerUpstream = await startScriptedUpstream(implementerScript());
    try {
      const build = await runCli(
        ['build', '--mission', 'missions/golden.json', '--adapter', 'sandboxed-agent',
          '--model', `openai:golden-implementer:${implementerUpstream.url}/v1`,
          '--cassette', path.join(cassettes, 'implementer'), '--cassette-mode', 'record',
          '--test-cmd', JSON.stringify(TEST_CMD), '--json'],
        {
          cwd: project,
          // OPENAI_API_KEY feeds the loopback model broker's upstream leg; the
          // agent itself only ever sees the broker nonce.
          env: { VLD_MODEL_TOKEN_ENV: 'VLD_OPENAI_API_KEY', VLD_OPENAI_API_KEY: 'sk-record-test', OPENAI_API_KEY: 'sk-record-test' }
        }
      );
      if (build.code !== 0) {
        let detail = build.stdout.slice(-400);
        try {
          const report = JSON.parse(build.stdout);
          detail = JSON.stringify((report.packages ?? []).map((p) => ({ id: p.packageId, ok: p.ok, stage: p.stage, error: p.error, checks: p.checks, verificationOutcome: p.verificationOutcome })), null, 2);
        } catch {}
        throw new Error(`build record failed: ${build.stderr}\n${detail}`);
      }
    } finally {
      await implementerUpstream.close();
    }

    // ---- 4. reviewer (record) ---------------------------------------------
    const candidateSha = await git(project, ['rev-parse', 'vld/golden-journey/pkg-core']);
    const targetSha = await git(project, ['rev-parse', 'HEAD']);
    const reviewerUpstream = await startScriptedUpstream([{ content: REVIEWER_REPLY }]);
    try {
      const review = await runCli(
        ['review', 'run', '--project', project, '--packet', path.join(project, 'specs'),
          '--base-ref', targetSha, '--head-ref', candidateSha, '--author', 'operator:golden',
          '--provider', 'openai', '--model', 'golden-reviewer',
          '--cassette', path.join(cassettes, 'reviewer'), '--cassette-mode', 'record',
          '--reviewer-id', 'golden-reviewer', '--json'],
        {
          cwd: project,
          env: { VLD_MODEL_BASE_URL: `${reviewerUpstream.url}/v1`, OPENAI_API_KEY: 'sk-record-test' }
        }
      );
      if (review.code !== 0) throw new Error(`review run record failed: ${review.stderr}\n${review.stdout.slice(-1200)}`);
    } finally {
      await reviewerUpstream.close();
    }

    // ---- 5. publish cassettes into the fixture dir -------------------------
    for (const leg of ['intake', 'implementer', 'reviewer']) {
      const from = path.join(cassettes, leg);
      const to = path.join(FIXTURE_DIR, 'cassettes', leg);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      cpSync(from, to, { recursive: true });
      console.log(`${leg}: ${readdirSync(to).length} cassette entr(ies) -> ${path.relative(process.cwd(), to)}`);
    }
  } finally {
    if (process.env.KEEP_GOLDEN_TMP) console.log(`kept tmp project: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`recording golden-journey cassettes via ${CLI}`);
  await recordCassettes();
  console.log('done');
}
