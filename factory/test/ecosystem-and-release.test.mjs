/**
 * Phase 4 ecosystem, DX, supply-chain & v0.20.0 release suite (roadmap 0.4, 4.1–4.4):
 *   - 3 self-verifying polyglot production case studies (Go, Python, TS+Go+Rust)
 *   - `vld doctor` environment, packet, sandbox & evidence chain diagnostics
 *   - `vld init --interactive` guided profile creation
 *   - `vld migrate` profile/policy/packet migration with `.bak` backups & evidence chain
 *   - VitePress docs config, archived plan cleanup, <=150-line metric-verified README
 *   - CycloneDX 1.5 zero-dependency SBOM, SHA-pinned `release.yml`, and `SECURITY.md`
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runDoctor } from '../lib/doctor.mjs';
import { migrateProject } from '../lib/migrate.mjs';
import { verifyEvidenceChain } from '../lib/evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

test('4.1 all three polyglot production case studies pass strict assertion verification', () => {
  const studiesRoot = path.join(ROOT, 'examples', 'case-studies');
  const studies = readdirSync(studiesRoot).sort();
  assert.deepEqual(studies, [
    '01-fintech-payout-go',
    '02-clinical-triage-python',
    '03-polyglot-saas-platform'
  ]);
  for (const name of studies) {
    const dir = path.join(studiesRoot, name);
    const out = execFileSync(
      process.execPath,
      [CLI, 'verify', path.join(dir, 'spec'), '--repo', dir, '--strict', '--require-assertions', '--json'],
      { encoding: 'utf8' }
    );
    const report = JSON.parse(out);
    assert.equal(report.ok, true, `${name} failed strict verification: ${JSON.stringify(report.errors)}`);
    assert.equal(report.errors.length, 0);
  }
});

test('4.3 vld doctor and vld init --interactive guide setup and report live environment health', async () => {
  // Run vld doctor on this repo
  const doc = runDoctor({ projectDir: ROOT, profileFile: 'profile.json', packetDir: 'specs' });
  assert.equal(doc.ok, true, `doctor failed: ${JSON.stringify(doc.checks)}`);
  assert.equal(doc.version, '0.20.0');
  for (const id of ['node-runtime', 'git', 'sandbox', 'profile', 'packet', 'telemetry']) {
    assert.ok(doc.checks.some((c) => c.id === id), `missing doctor check ${id}`);
  }

  // Run vld init --interactive via scripted stdin
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vld-init-interactive-'));
  try {
    const answers = [
      'invoice-bot',
      'Automated invoice reminder tool for freelance designers to send overdue notices with receipt tracking instead of manual emails.',
      'api',
      'mvp',
      'small',
      'go',
      'auth,webhooks',
      'y',
      'y',
      'gdpr'
    ].join('\n') + '\n';
    const res = spawnSync(process.execPath, [CLI, 'init', tmp, '--interactive'], {
      input: answers,
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, res.stderr);
    const profile = JSON.parse(readFileSync(path.join(tmp, 'profile.json'), 'utf8'));
    assert.equal(profile.name, 'invoice-bot');
    assert.equal(profile.constraints.stack, 'go');
    assert.equal(profile.risks.pii, true);
    assert.equal(profile.risks.payments, true);
    assert.equal(profile.risks.regulated, true);
    assert.deepEqual(profile.regulation, ['gdpr']);

    // Verify the interactively created profile compiles cleanly!
    execFileSync(process.execPath, [CLI, 'compile', path.join(tmp, 'profile.json'), '-o', path.join(tmp, 'specs')]);
    assert.ok(existsSync(path.join(tmp, 'specs', 'spec.json')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('4.4 vld migrate upgrades legacy profiles, v1 policies and stale packets with backups & audit chain', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vld-migrate-'));
  try {
    // Write a legacy-shaped profile + v1 agent/delivery policies + stale 0.19.0 packet
    writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify({
      name: 'legacy-svc',
      idea: 'Internal metrics service for SRE engineers to record deploy timings and query latency trends instead of shell logs.',
      kind: 'api',
      stage: 'mvp',
      users: { scale: 'small' },
      traits: ['persistence'],
      risks: { pii: false, money: true, regulated: false, multiTenant: false, destructiveWrites: false, publicFacing: false, integrations: false },
      regulations: ['sox'],
      customRules: ['When a metric batch exceeds 500 samples, the collector shall return HTTP 413.'],
      constraints: { team: 2, weeks: 4, stack: 'golang', mustUse: [] }
    }, null, 2));
    mkdirSync(path.join(tmp, '.vld'), { recursive: true });
    writeFileSync(path.join(tmp, '.vld', 'agent-policy.json'), JSON.stringify({
      schemaVersion: 1,
      limits: { durationMs: 30_000, outputBytes: 16_384, retryBudget: 0 },
      adapters: { fake: { enabled: true }, 'local-cli': { enabled: true, command: [process.execPath, 'agent.mjs'] } }
    }, null, 2));
    writeFileSync(path.join(tmp, '.vld', 'delivery-policy.json'), JSON.stringify({
      schemaVersion: 1,
      verification: { checks: ['vld-packet'], strict: true },
      approval: { requireIndependentReviewer: true },
      queue: { mode: 'local-no-merge' }
    }, null, 2));
    mkdirSync(path.join(tmp, 'specs'), { recursive: true });
    writeFileSync(path.join(tmp, 'specs', 'spec.json'), JSON.stringify({ factoryVersion: '0.18.0', requirements: [] }, null, 2));

    // Dry-run does not mutate files
    const preview = migrateProject({ projectDir: tmp, dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.changedCount, 4);
    assert.equal(existsSync(path.join(tmp, 'profile.json.bak')), false);

    // Apply migration
    const applied = migrateProject({ projectDir: tmp, dryRun: false });
    assert.equal(applied.ok, true);
    assert.equal(applied.targetVersion, '0.20.0');
    assert.equal(applied.changedCount, 4);
    assert.ok(existsSync(path.join(tmp, 'profile.json.bak')));
    assert.ok(existsSync(path.join(tmp, '.vld', 'agent-policy.json.bak')));
    assert.ok(existsSync(path.join(tmp, '.vld', 'delivery-policy.json.bak')));
    assert.ok(existsSync(path.join(tmp, 'specs', 'spec.json.bak')));

    const migratedProfile = JSON.parse(readFileSync(path.join(tmp, 'profile.json'), 'utf8'));
    assert.equal(migratedProfile.constraints.stack, 'go');
    assert.equal(migratedProfile.risks.payments, true);
    assert.deepEqual(migratedProfile.regulation, ['sox']);
    assert.equal(migratedProfile.rules.length, 1);

    const migratedAgentPolicy = JSON.parse(readFileSync(path.join(tmp, '.vld', 'agent-policy.json'), 'utf8'));
    assert.equal(migratedAgentPolicy.schemaVersion, 2);
    const migratedDeliveryPolicy = JSON.parse(readFileSync(path.join(tmp, '.vld', 'delivery-policy.json'), 'utf8'));
    assert.equal(migratedDeliveryPolicy.schemaVersion, 2);

    const migratedSpec = JSON.parse(readFileSync(path.join(tmp, 'specs', 'spec.json'), 'utf8'));
    assert.ok(migratedSpec.requirements.some((r) => r.id === 'REQ-C01'));

    const chain = verifyEvidenceChain({ projectDir: tmp });
    assert.equal(chain.ok, true);
    assert.equal(chain.records[0].kind, 'migration');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('0.4, 4.3 & 4.4 VitePress config, archived plans, README metrics, CycloneDX SBOM & SHA-pinned release workflow pass', async () => {
  // VitePress config loads cleanly and covers navigation + sidebar
  const vp = (await import(path.join(ROOT, 'docs', '.vitepress', 'config.mjs'))).default;
  assert.equal(vp.title, 'vibecode-like-a-dev');
  assert.ok(Array.isArray(vp.themeConfig?.sidebar) && vp.themeConfig.sidebar.length >= 3);

  // Historical remediation plans moved out of top-level docs/ into docs/archive/
  const topDocs = readdirSync(path.join(ROOT, 'docs'));
  assert.equal(topDocs.some((f) => /REMEDIATION-PLAN|IMPLEMENTATION-PLAN/.test(f)), false);
  const archived = readdirSync(path.join(ROOT, 'docs', 'archive'));
  assert.ok(archived.length >= 10);

  // README metrics & line-budget guard passes
  const readmeCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-readme-metrics.mjs')], { encoding: 'utf8' });
  assert.equal(readmeCheck.status, 0, readmeCheck.stderr);

  // CycloneDX 1.5 SBOM verifies deterministic zero-dependency package
  const sbomCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-sbom.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(sbomCheck.status, 0, sbomCheck.stderr);
  const sbom = JSON.parse(readFileSync(path.join(ROOT, 'sbom.cdx.json'), 'utf8'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.metadata.component.version, '0.20.0');
  assert.deepEqual(sbom.components, []);

  // release.yml pins every third-party action to a full 40-char SHA and publishes with --provenance
  const releaseYml = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const uses = [...releaseYml.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const ref of uses) {
    assert.match(ref.split('@')[1] ?? '', /^[a-f0-9]{40}$/, `unpinned action in release.yml: ${ref}`);
  }
  assert.match(releaseYml, /--provenance/);
  assert.match(releaseYml, /sbom\.cdx\.json/);

  // SECURITY.md documents supported 0.20.x, disclosure SLA, ADR 0011 sandbox & ADR 0012 audit chain
  const sec = readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(sec, /0\.20\.x/);
  assert.match(sec, /ADR 0011/);
  assert.match(sec, /ADR 0012/);
});
