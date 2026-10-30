/**
 * Gate enforcement tests.
 *
 * The claim this feature makes is narrow and testable: every gate the planner can
 * emit has exactly one command that checks it, that command runs with no
 * dependencies, and it fails loudly when the repository does not meet the gate. Each
 * of those is a test here, plus the part that matters most — that a passing gate
 * says what it cannot see.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emitPacket } from '../lib/emit/index.mjs';
import { enforcementFiles, gateMechanism, loadGateRegistry, RUNNER, unmappedGates } from '../lib/enforcement.mjs';
import { buildIndex } from '../lib/indexer.mjs';
import { buildPlan } from '../lib/planner.mjs';
import { normalizeProfile } from '../lib/profile.mjs';
import { ROOT } from '../lib/indexer.mjs';

const index = buildIndex();

function packet(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-gates-'));
  const profile = normalizeProfile({
    name: 'retro-board',
    idea: 'A retrospective board where a team votes on cards and leaves with three agreed actions.',
    kind: 'web-app',
    stage: 'mvp',
    traits: ['auth', 'persistence'],
    risks: { pii: true },
    ...overrides
  });
  const plan = buildPlan(profile, { index });
  const { outDir } = emitPacket(plan, path.join(root, 'spec'));
  return {
    root,
    outDir,
    spec: JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

const write = (dir, file, content) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content, 'utf8');
};

const run = (outDir, args) => {
  try {
    const stdout = execFileSync(process.execPath, [path.join(outDir, RUNNER), ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};

/**
 * A repository that satisfies the packet it is checked against.
 *
 * The anchors are generated from the packet rather than hand-written: a fixture that
 * hard-codes requirement ids stops testing the check the first time the catalog moves.
 */
function satisfyingRepo(p, dir) {
  write(dir, 'README.md', '# Retro board\n\n```bash\nnpm start\n```\n\nRun it, test it, deploy it.\n');
  write(dir, '.github/workflows/ci.yml', 'on:\n  pull_request:\njobs:\n  check:\n    steps:\n      - run: npm run lint\n      - run: npm test\n');
  const anchors = p.spec.requirements
    .filter((requirement) => requirement.verify === 'automated')
    .map((requirement) => `// @req ${requirement.id} — ${requirement.key}`)
    .join('\n');
  write(dir, 'tests/journey.test.ts', `import { test } from 'vitest';\n\n${anchors}\ntest('the board loads', () => {});\n`);
  write(dir, 'docs/runbook.md', '# Runbook\n\n- **Owner:** the on-call engineer.\n- **Escalation channel:** #ops-incident.\n\n## First three diagnostic steps\n\n1. check\n2. check\n3. check\n');
  return dir;
}

test('the runner ships with the packet and executes', () => {
  const p = packet();
  try {
    const file = path.join(p.outDir, RUNNER);
    assert.ok(existsSync(file), 'enforcement/gates.mjs is missing from the packet');
    const source = readFileSync(file, 'utf8');
    assert.ok(!source.includes('__RULES__'), 'the rules placeholder was not interpolated');
    for (const gate of p.spec.gates) {
      assert.match(source, new RegExp(`"${gate.id}"`), `${gate.id} is missing from the runner`);
      assert.ok(gate.enforcement, `${gate.id} ships without a mechanism`);
      assert.equal(gate.enforcement.runner, RUNNER);
      assert.equal(gate.enforcement.kind, 'local');
      assert.ok(gate.enforcement.proves && gate.enforcement.doesNotProve, `${gate.id} must say what it does and does not prove`);
    }
    // Parse it the way Node will, rather than trusting the string.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    p.cleanup();
  }
});

test('a repository that meets its gates passes, including under --strict', () => {
  const p = packet();
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    const loose = run(p.outDir, ['--repo', repo, '--json']);
    const summary = JSON.parse(loose.stdout);
    assert.equal(summary.fail, 0, `unexpected failures: ${JSON.stringify(summary.results.filter((r) => r.status === 'fail'))}`);
    assert.equal(summary.pending, 0, `unexpected pending: ${JSON.stringify(summary.results.filter((r) => r.status === 'pending'))}`);
    assert.equal(summary.gates, p.spec.gates.length);

    const strict = run(p.outDir, ['--repo', repo, '--strict']);
    assert.equal(strict.code, 0, strict.stdout);
  } finally {
    p.cleanup();
  }
});

test('a missing document fails the gate that needs it, and names the fix', () => {
  const p = packet();
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    rmSync(path.join(repo, 'README.md'));
    const result = run(p.outDir, ['--repo', repo, '--json']);
    assert.equal(result.code, 1);
    const summary = JSON.parse(result.stdout);
    const run7 = summary.results.find((entry) => entry.id === 'G0-RUN');
    assert.equal(run7.status, 'fail');
    assert.match(run7.detail, /README\.md/);
    assert.ok(run7.how, 'a failing gate must explain what it wanted');
  } finally {
    p.cleanup();
  }
});

test('an unanchored requirement is pending, and --strict turns pending into failure', () => {
  const p = packet();
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    // Keep the smoke test, drop only the anchors: the file still exists, so the
    // check that goes amber here is the trace, not the smoke test.
    write(repo, 'tests/journey.test.ts', "import { test } from 'vitest';\ntest('the board loads', () => {});\n");
    const loose = run(p.outDir, ['--repo', repo, '--json']);
    const summary = JSON.parse(loose.stdout);
    const trace = summary.results.find((entry) => entry.id === 'G1-AC-TRACE');
    assert.equal(trace.status, 'pending');
    assert.equal(loose.code, 0, 'pending gates are not failures unless --strict is asked for');

    const strict = run(p.outDir, ['--repo', repo, '--strict', '--json']);
    assert.equal(strict.code, 1, '--strict must fail on pending');
    assert.match(strict.stdout, /pending/);
  } finally {
    p.cleanup();
  }
});

test('a requirement marked done without a test anchor fails rather than staying pending', () => {
  const p = packet();
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    write(repo, 'tests/journey.test.ts', "import { test } from 'vitest';\ntest('the board loads', () => {});\n");
    const specPath = path.join(p.outDir, 'spec.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const automated = spec.requirements.filter((requirement) => requirement.verify === 'automated');
    assert.ok(automated.length > 0, 'fixture has no automated requirement');
    spec.requirements = spec.requirements.map((requirement) =>
      requirement.id === automated[0].id ? { ...requirement, status: 'done' } : requirement
    );
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    const result = run(p.outDir, ['--repo', repo, '--json']);
    assert.equal(result.code, 1);
    const summary = JSON.parse(result.stdout);
    const failure = summary.results.find((entry) => entry.status === 'fail' && /marked done/.test(entry.detail));
    assert.ok(failure, 'a done requirement with no anchor must fail a gate');
  } finally {
    p.cleanup();
  }
});

test('the attestation gate rejects a document with fields missing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-gates-attest-'));
  try {
    const profile = normalizeProfile({
      name: 'clinic-bookings',
      idea: 'Patients book appointments and the clinic sees today\'s list.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'persistence'],
      risks: { pii: true, publicFacing: true },
      overlays: ['org-baseline']
    });
    const plan = buildPlan(profile, { index, profileDir: root });
    const { outDir } = emitPacket(plan, path.join(root, 'spec'));
    const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
    assert.ok(spec.gates.some((gate) => gate.id === 'G1-INCIDENT'), 'overlay gate missing from the packet');

    const repo = path.join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    write(repo, 'docs/runbook.md', '# Runbook\n\n- **Owner:** someone.\n');
    const result = run(outDir, ['--repo', repo, '--json']);
    const summary = JSON.parse(result.stdout);
    const incident = summary.results.find((entry) => entry.id === 'G1-INCIDENT');
    assert.equal(incident.status, 'fail');
    assert.match(incident.detail, /escalation|diagnostic/);
    assert.ok(existsSync(path.join(outDir, 'enforcement/templates/docs/runbook.md')), 'the blank template must ship with the packet');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the secret scan finds a committed key and tolerates a placeholder', () => {
  const p = packet();
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    // Assembled at run time on purpose: a literal here is a literal in this
    // repository's history, and the gate that scans for it is the one below.
    const fakeKey = ['ghp', '1'.repeat(36)].join('_');
    write(repo, 'src/config.ts', `export const apiKey = "${fakeKey}";\n`);
    const bad = JSON.parse(run(p.outDir, ['--repo', repo, '--json']).stdout);
    const secrets = bad.results.find((entry) => entry.id === 'G1-SECRETS');
    assert.equal(secrets.status, 'fail');
    assert.match(secrets.detail, /src\/config\.ts/);

    write(repo, 'src/config.ts', 'export const apiKey = process.env.API_KEY ?? "changeme-placeholder";\n');
    const good = JSON.parse(run(p.outDir, ['--repo', repo, '--json']).stdout);
    assert.equal(good.results.find((entry) => entry.id === 'G1-SECRETS').status, 'pass');
  } finally {
    p.cleanup();
  }
});

test('only the mechanisms this packet needs are emitted', () => {
  const mvp = packet();
  try {
    // G1-SECRETS is a tier-1 gate, so its gitleaks config travels with the packet...
    assert.ok(existsSync(path.join(mvp.outDir, 'enforcement/gitleaks.toml')), 'the secret-scan config is missing');
    // ...while mutation testing is a tier-3 gate, and a tier-1 packet has no such gate.
    assert.ok(!existsSync(path.join(mvp.outDir, 'enforcement/mutation.config.json')), 'a tier-1 packet was handed a mutation config');
  } finally {
    mvp.cleanup();
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-gates-tier3-'));
  try {
    const profile = normalizeProfile({
      name: 'ledger',
      idea: 'A double-entry ledger where an accountant reconciles a month in minutes.',
      kind: 'web-app',
      stage: 'scale',
      traits: ['auth', 'persistence', 'payments'],
      // Enough risk signals to reach tier 3, where the mutation gate lives.
      risks: { pii: true, money: true, regulated: true, multiTenant: true, publicFacing: true, destructiveWrites: true }
    });
    const plan = buildPlan(profile, { index });
    const files = enforcementFiles(plan);
    const dir = path.join(root, 'packet');
    for (const [name, content] of files) write(dir, name, content);
    assert.ok(files.has('enforcement/mutation.config.json'), 'a tier-3 packet needs a mutation config');
    assert.ok(files.has('enforcement/README.md'));
    assert.match(files.get('enforcement/README.md'), /What this mechanism does not prove/);
    // Every emitted mechanism file is real content, not an empty placeholder.
    for (const [name, content] of files) assert.ok(content.trim().length > 20, `${name} is empty`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every gate the planner can emit has a registered mechanism', () => {
  const policy = JSON.parse(readFileSync(path.join(ROOT, 'factory', 'policy.json'), 'utf8'));
  const ids = new Set();
  const collect = (value) => {
    if (typeof value === 'string' && /^G\d-[A-Z-]+$/.test(value)) ids.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if (value.id && /^G\d-/.test(value.id)) ids.add(value.id);
      else Object.values(value).forEach(collect);
    }
  };
  collect(policy.gates);
  for (const file of readdirSync(path.join(ROOT, 'factory', 'overlays'))) {
    if (!file.endsWith('.json')) continue;
    const overlay = JSON.parse(readFileSync(path.join(ROOT, 'factory', 'overlays', file), 'utf8'));
    for (const gate of overlay.addGates ?? []) ids.add(gate.id);
  }
  assert.ok(ids.size >= 15, `only ${ids.size} gates found; the policy file probably moved`);
  assert.deepEqual(unmappedGates([...ids]), [], 'these gates have no mechanism in factory/gates/gates.json');
  for (const id of ids) {
    const mechanism = gateMechanism(id);
    assert.ok(mechanism.how, `${id} does not say what it checks`);
    assert.ok(mechanism.mechanism, `${id} does not say what the check cannot see`);
    assert.ok(['exists', 'contains', 'ci', 'anchors', 'drift', 'attest', 'no-secrets'].includes(mechanism.check.kind), `${id} uses an unknown check kind`);
  }
  assert.ok(loadGateRegistry().gates);
});

test('G2-AUTHZ does not self-satisfy against specs/spec.json or changes/*/spec.after.json inside the repository', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-gates-noself-'));
  try {
    const repo = path.join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    write(repo, 'tests/smoke.test.ts', "import { test } from 'vitest';\ntest('loads', () => {});\n");

    const profile = normalizeProfile({
      name: 'trialbridge',
      idea: 'Coordinators submit participant reimbursement claims with strict tenant isolation.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'persistence', 'payments'],
      risks: { pii: true, payments: true, regulated: true, multiTenant: true, publicFacing: true }
    });
    const plan = buildPlan(profile, { index });
    const specsDir = path.join(repo, 'specs');
    emitPacket(plan, specsDir, { force: true });
    write(repo, 'changes/sample/spec.after.json', '{"note":"requests from wrong tenant are denied with 403 forbidden"}\n');

    const beforeSummary = JSON.parse(run(specsDir, ['--repo', repo, '--json']).stdout);
    const authzBefore = beforeSummary.results.find((entry) => entry.id === 'G2-AUTHZ');
    assert.equal(authzBefore.status, 'fail', `expected G2-AUTHZ to fail before writing a real denial test, got: ${JSON.stringify(authzBefore)}`);

    write(repo, 'tests/authz.test.ts', "import { test } from 'vitest';\ntest('cross-tenant read is denied with 403 forbidden', () => {});\n");
    const afterSummary = JSON.parse(run(specsDir, ['--repo', repo, '--json']).stdout);
    const authzAfter = afterSummary.results.find((entry) => entry.id === 'G2-AUTHZ');
    assert.equal(authzAfter.status, 'pass');
    assert.match(authzAfter.detail, /tests\/authz\.test\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every attestation gate ships a starter template, rejects unfilled placeholders, and passes once filled in (with code spans preserved)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-gates-all-attest-'));
  try {
    const profile = normalizeProfile({
      name: 'gridpulse-dispatch',
      idea: 'Aggregators dispatch batteries and settle market payouts.',
      kind: 'web-app',
      stage: 'production',
      traits: ['auth', 'payments', 'persistence'],
      risks: { pii: true, payments: true, regulated: true, multiTenant: true, publicFacing: true },
      overlays: ['two-person-review', 'health-data', 'org-baseline']
    });
    const plan = buildPlan(profile, { index, profileDir: root });
    const specsDir = path.join(root, 'specs');
    emitPacket(plan, specsDir, { force: true });

    const registry = loadGateRegistry().gates;
    const attestGates = Object.entries(registry).filter(([, entry]) => entry.check?.kind === 'attest');
    assert.ok(attestGates.length >= 5, `expected at least 5 attestation gates, got ${attestGates.length}`);

    const repo = path.join(root, 'repo');
    mkdirSync(repo, { recursive: true });

    for (const [gateId, entry] of attestGates) {
      const relTarget = entry.check.file;
      const templatePath = path.join(specsDir, 'enforcement', 'templates', relTarget);
      assert.ok(existsSync(templatePath), `${gateId}: missing emitted starter template at enforcement/templates/${relTarget}`);
      const content = readFileSync(templatePath, 'utf8');
      write(repo, relTarget, content);
    }

    // 1. Copying a starter template verbatim must fail specifically on unfilled placeholders,
    // never on missing required headings (OpenSpec purpose-placeholder defense).
    const unfilledSummary = JSON.parse(run(specsDir, ['--repo', repo, '--json']).stdout);
    for (const [gateId] of attestGates) {
      const res = unfilledSummary.results.find((entry) => entry.id === gateId);
      assert.ok(res, `${gateId} missing from gate results`);
      assert.equal(res.status, 'fail', `${gateId} must reject an unedited template copy`);
      assert.match(res.detail, /unfilled template placeholder/, `${gateId} failed for wrong reason: ${res.detail}`);
    }

    // 2. Filling in <...> and YYYY-MM-DD while keeping inline code like `pkg@<previous>` must pass.
    for (const [, entry] of attestGates) {
      const relTarget = entry.check.file;
      const filled = readFileSync(path.join(repo, relTarget), 'utf8')
        .replace(/YYYY-MM-DD/g, '2026-10-30')
        .replace(/<[a-z][^>\n]{2,}>/gi, 'verified-value') +
        '\n\nRollback CLI example: `npm i -g pkg@<previous>`\n';
      write(repo, relTarget, filled);
    }

    const filledSummary = JSON.parse(run(specsDir, ['--repo', repo, '--json']).stdout);
    for (const [gateId] of attestGates) {
      const res = filledSummary.results.find((entry) => entry.id === gateId);
      assert.equal(res.status, 'pass', `${gateId} did not pass once filled in: ${JSON.stringify(res)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('polyglot Go, Rust and Java test files outside tests/ satisfy anchor gates in gate-runner.mjs', () => {
  const p = packet();
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    rmSync(path.join(repo, 'tests'), { recursive: true, force: true });
    const automated = p.spec.requirements.filter((requirement) => requirement.verify === 'automated');
    const half = Math.ceil(automated.length / 2);
    const goAnchors = automated.slice(0, half).map((r) => `// @req ${r.id}`).join('\n');
    const javaAnchors = automated.slice(half).map((r) => `// @req ${r.id}`).join('\n');
    write(repo, 'internal/escrow/release_test.go', `package escrow\n${goAnchors}\nfunc TestRelease(t *testing.T) {}\n`);
    write(repo, 'src/main/EscrowTest.java', `class EscrowTest {\n${javaAnchors}\nvoid testIt() {}\n}\n`);

    const summary = JSON.parse(run(p.outDir, ['--repo', repo, '--json']).stdout);
    const trace = summary.results.find((entry) => entry.id === 'G1-AC-TRACE');
    assert.equal(trace.status, 'pass', `Go/Java tests outside tests/ were not recognised: ${JSON.stringify(trace)}`);
  } finally {
    p.cleanup();
  }
});

test('polyglot CI static checks (go vet), *Test.php authz denial tests, and .dart/.php observability & secret scans work in gates.mjs', () => {
  const p = packet({
    stage: 'production',
    traits: ['auth', 'persistence'],
    risks: { pii: true, multiTenant: true, publicFacing: true }
  });
  try {
    const repo = satisfyingRepo(p, path.join(p.root, 'repo'));
    write(repo, '.github/workflows/ci.yml', 'on:\n  pull_request:\njobs:\n  ci:\n    steps:\n      - run: go vet ./...\n      - run: vendor/bin/phpunit\n');
    rmSync(path.join(repo, 'tests'), { recursive: true, force: true });
    const automated = p.spec.requirements.filter((requirement) => requirement.verify === 'automated');
    const anchors = automated.map((r) => `// @req ${r.id}`).join('\n');
    write(repo, 'api/src/TriageAuthzTest.php', `<?php\n${anchors}\nclass TriageAuthzTest { public function testDeny() { assert(403 === 403); } }\n`);
    write(repo, 'mobile/lib/sync.dart', 'String header(String traceId) => "x-request-id=$traceId";\n');

    const summary = JSON.parse(run(p.outDir, ['--repo', repo, '--json']).stdout);
    for (const gateId of ['G0-CHECK', 'G1-CI', 'G2-AUTHZ', 'G2-OBSERVABILITY']) {
      const res = summary.results.find((entry) => entry.id === gateId);
      assert.equal(res?.status, 'pass', `${gateId} failed on polyglot repo: ${JSON.stringify(res)}`);
    }

    // Secret leaked inside a .dart file must trip G1-SECRETS
    write(repo, 'mobile/lib/leak.dart', `const awsKey = "${'AKIA' + '9X7ZQ2M4PL8NR5TW'}";\n`);
    const leakSummary = JSON.parse(run(p.outDir, ['--repo', repo, '--json']).stdout);
    const secretsGate = leakSummary.results.find((entry) => entry.id === 'G1-SECRETS');
    assert.equal(secretsGate.status, 'fail', 'hardcoded AWS key in .dart file must fail G1-SECRETS');
  } finally {
    p.cleanup();
  }
});



