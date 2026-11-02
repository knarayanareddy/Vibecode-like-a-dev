import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initDiscoverabilityReadiness, validateDiscoverabilityReadiness } from '../lib/discoverability-readiness.mjs';
import { digest } from '../lib/extension-utils.mjs';
import { emitPacket } from '../lib/emit/index.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { loadProfile } from '../lib/profile.mjs';

const enabledProfile = {
  name: 'public-discovery-lab',
  idea: 'A public documentation site with an explicit, locally reviewed discovery contract.',
  kind: 'web-app',
  stage: 'mvp',
  risks: { publicFacing: true },
  constraints: { team: 2, weeks: 4, stack: 'typescript', mustUse: [] },
  discoverability: { enabled: true }
};

function project() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'vld-discoverability-'));
  writeFileSync(path.join(directory, 'profile.json'), JSON.stringify(enabledProfile));
  const loaded = loadProfile(path.join(directory, 'profile.json'));
  assert.deepEqual(loaded.errors, []);
  emitPacket(buildPlan(loaded.profile, { index: buildIndex(), profileDir: directory }), path.join(directory, 'specs'));
  return directory;
}

function approvedReadiness(directory) {
  const source = readFileSync(path.join(directory, 'specs', 'spec.json'), 'utf8');
  const spec = JSON.parse(source);
  const requirement = spec.requirements.find((entry) => entry.key === 'web.discoverability');
  assert.ok(requirement, 'the eligible packet includes web.discoverability');
  return `# Discoverability Readiness: ${enabledProfile.name}

**Status:** Approved

This human-authored record is locally checked evidence only; it does not attest to ranking, traffic, third-party indexing, provider acceptance, or AI citation outcomes.

## Packet Authority

- Packet: \`specs/spec.json\`
- Packet SHA-256: \`${digest(source)}\`
- Discoverability requirement: \`${requirement.id}\` — ${requirement.title}

## Scope and Advisory Boundary

This is local evidence, not external-provider authority. It does not assert ranking, traffic, third-party indexing, or citation outcomes.

## Canonical Origin and Locale Policy

- Canonical origin: \`https://docs.example.test\`
- Locale policy: English is the default locale; public routes use lowercase path names and no trailing slash.

## Indexable Route Inventory

| Route class | Representative route | Canonical policy | Sitemap policy | Rendered metadata evidence |
| --- | --- | --- | --- | --- |
| Documentation | /guides/getting-started | one public canonical URL | included | route metadata test |

## Excluded Route Inventory

| Route class | Exclusion policy | Local evidence |
| --- | --- | --- |
| Account and preview | noindex and absent from sitemap | route policy test |

## Metadata and Social Contract

Each public route renders a title, description, canonical URL, and social Open Graph metadata. The route metadata test verifies the rendered contract.

## Structured Data Evidence

JSON-LD structured data is generated from the maintained documentation source. A local rendered-output check verifies each structured data value against that source.

## Local Verification Evidence

- Command: \`npm test -- route-metadata\`
- Outcome: Passed locally on 2026-11-02 after route inventory review.

## Human Review Record

- Reviewer: Documentation platform review group.
- Reviewed on: 2026-11-02
- Decision: Approved.
- Notes: The documented public surface and exclusion rules were reviewed for this packet.

## Requirement Links

- ${requirement.id} — ${requirement.title}
`;
}

test('discoverability readiness initializes a draft linked to an eligible packet and strictly validates a completed record', (t) => {
  const directory = project();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = initDiscoverabilityReadiness({ projectDir: directory });
  assert.equal(initialized.advisory, true);
  assert.match(readFileSync(initialized.file, 'utf8'), /Packet SHA-256: `([a-f0-9]{64})`/);
  const draft = validateDiscoverabilityReadiness({ projectDir: directory, strict: true });
  assert.equal(draft.strictOk, false, 'a generated draft is never an approval');
  assert.ok(draft.warnings.some((warning) => /placeholder|Draft/.test(warning)), draft.warnings.join('\n'));

  writeFileSync(initialized.file, approvedReadiness(directory));
  const validated = validateDiscoverabilityReadiness({ projectDir: directory, strict: true });
  assert.equal(validated.ok, true, validated.errors.join('\n'));
  assert.equal(validated.strictOk, true, validated.warnings.join('\n'));
  assert.equal(validated.advisory, true);
  assert.match(validated.passes.join('\n'), /without asserting external-provider outcomes/);

  writeFileSync(initialized.file, approvedReadiness(directory).replace('Reviewer: Documentation platform review group.', 'Reviewer:'));
  const missingReviewer = validateDiscoverabilityReadiness({ projectDir: directory });
  assert.equal(missingReviewer.ok, false);
  assert.match(missingReviewer.errors.join('\n'), /non-placeholder Reviewer value/);
});

test('discoverability readiness fails closed for absent or explicitly disabled profiles', (t) => {
  const directory = project();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, 'profile.json');
  const absent = { ...enabledProfile };
  delete absent.discoverability;
  writeFileSync(profilePath, JSON.stringify(absent));
  assert.throws(() => initDiscoverabilityReadiness({ projectDir: directory }), /discoverability\.enabled: true/);
  writeFileSync(profilePath, JSON.stringify({ ...enabledProfile, discoverability: { enabled: false } }));
  assert.throws(() => validateDiscoverabilityReadiness({ projectDir: directory }), /discoverability\.enabled: true/);
});

test('discoverability readiness CLI exposes deterministic init and strict validation reports', (t) => {
  const directory = project();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = path.resolve('factory/cli.mjs');
  const initialized = JSON.parse(execFileSync(process.execPath, [cli, 'discoverability-readiness', 'init', '--project', directory, '--packet', 'specs', '--json'], { encoding: 'utf8' }));
  assert.equal(initialized.advisory, true);
  writeFileSync(initialized.file, approvedReadiness(directory));
  const validated = JSON.parse(execFileSync(process.execPath, [cli, 'discoverability-readiness', 'validate', '--project', directory, '--packet', 'specs', '--strict', '--json'], { encoding: 'utf8' }));
  assert.equal(validated.strictOk, true, validated.errors.join('\n'));
  assert.equal(validated.packet, 'specs/spec.json');
});

test('discoverability readiness refuses a symlinked record rather than reading outside the project', { skip: process.platform === 'win32' && 'symlink creation needs elevated Windows privileges' }, (t) => {
  const directory = project();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'vld-discoverability-outside-'));
  t.after(() => { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const initialized = initDiscoverabilityReadiness({ projectDir: directory });
  const externalRecord = path.join(outside, 'readiness.md');
  writeFileSync(externalRecord, approvedReadiness(directory));
  rmSync(initialized.file);
  symlinkSync(externalRecord, initialized.file);
  assert.throws(() => validateDiscoverabilityReadiness({ projectDir: directory }), /symbolic link/);
});

test('discoverability readiness rejects malformed human evidence and detects stale packet content', (t) => {
  const directory = project();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = initDiscoverabilityReadiness({ projectDir: directory });
  writeFileSync(initialized.file, '# Discoverability Readiness: public-discovery-lab\n\n**Status:** Approved\n');
  const malformed = validateDiscoverabilityReadiness({ projectDir: directory, strict: true });
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors.join('\n'), /Packet Authority|Indexable Route Inventory|Human Review Record/);

  writeFileSync(initialized.file, approvedReadiness(directory));
  writeFileSync(path.join(directory, 'specs', 'spec.json'), `${readFileSync(path.join(directory, 'specs', 'spec.json'), 'utf8')}\n`);
  const stale = validateDiscoverabilityReadiness({ projectDir: directory });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join('\n'), /does not match the current compiled packet/);
});
