/**
 * The product's own primary journey, exercised through real processes.
 *
 * Every other test in this suite calls modules. This one runs the CLI the way a
 * user does, because "the modules work" and "the tool works" are different claims:
 * argument parsing, exit codes, stdout/stderr separation and file output are all
 * part of the contract, and none of them are covered by importing a function.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');

/** Run the CLI and return its exit code instead of throwing, which is the point. */
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: ROOT, ...options });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const PROFILE = {
  name: 'journey-check',
  idea: 'A small service whose only purpose is to be planned, compiled and verified by the tool under test.',
  kind: 'web-app',
  stage: 'mvp',
  traits: ['auth'],
  risks: { pii: true }
};

// @req REQ-002
test('primary journey: plan, compile, verify, then the shipped drift guard agrees', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-journey-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const profilePath = path.join(workspace, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(PROFILE, null, 2));

  const planned = await cli(['plan', profilePath]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /rigor/);
  assert.match(planned.stdout, /tier \d/);

  const specs = path.join(workspace, 'specs');
  const compiled = await cli(['compile', profilePath, '-o', specs]);
  assert.equal(compiled.code, 0, compiled.stderr);

  const manifest = JSON.parse(readFileSync(path.join(specs, 'spec.json'), 'utf8'));
  assert.ok(manifest.requirements.length > 0);
  assert.ok(manifest.primitives.length > 0);

  const verified = await cli(['verify', specs]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /PASS/);

  // The checker shipped inside the packet must reach the same verdict, run the way
  // a user would run it from their own repository.
  const drifted = await run(process.execPath, [path.join(specs, 'spec-check.mjs'), '--repo', workspace], {
    cwd: workspace
  });
  // A freshly compiled packet has no implemented requirements yet, so the shipped
  // checker reports NOT VERIFIED rather than PASS (BUG-9): the exit code is still
  // 0, but the verdict no longer reads as evidence it does not have.
  assert.match(drifted.stdout, /NOT VERIFIED/);
  assert.ok(!/PASS ·/.test(drifted.stdout), 'an unproven packet must not report PASS');

  // The same profile compiled to the same logical destination is byte-identical,
  // so the journey is repeatable. The destination is named explicitly: since
  // BUG-5 the packet embeds the directory it lives in, so two *different* paths
  // are supposed to differ in exactly that string and nowhere else.
  const second = path.join(workspace, 'specs-again');
  const recompiled = await cli(['compile', profilePath, '-o', second, '--packet-dir', specs]);
  assert.equal(recompiled.code, 0, recompiled.stderr);
  assert.equal(
    readFileSync(path.join(second, 'spec.json'), 'utf8'),
    readFileSync(path.join(specs, 'spec.json'), 'utf8'),
    'the same profile produces the same manifest'
  );

  // An override must not hide the real default: without it, the embedded path is
  // the actual output directory.
  // A destination outside the repository has no meaningful repo-relative name,
  // so the emitted label must be the absolute path rather than the default.
  const third = path.join(workspace, 'elsewhere', 'packet');
  const honored = await cli(['compile', profilePath, '-o', third]);
  assert.equal(honored.code, 0, honored.stderr);
  const thirdText = readFileSync(path.join(third, '07-agent-handoff.md'), 'utf8');
  const expectedLabel = third.split(path.sep).join('/');
  assert.ok(
    thirdText.includes(`Read ${expectedLabel}/AGENTS.md first`),
    `handoff does not name the real packet directory ${expectedLabel}`
  );
  assert.ok(!/(^|[^\w-])specs\//.test(thirdText), 'the default path leaked into a non-default output directory');
});

test('adopted TODO ideas are prominent in advisory mode and refused in strict plan and compile', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-adopted-todo-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const profile = path.join(workspace, 'profile.json');
  writeFileSync(profile, JSON.stringify({ ...PROFILE, idea: 'TODO replace with one paragraph. Adopted draft: web application.' }, null, 2));

  const advisory = await cli(['plan', profile]);
  assert.equal(advisory.code, 0, advisory.stderr);
  assert.match(advisory.stderr, /TODO draft/);

  const strictPlan = await cli(['plan', profile, '--strict']);
  assert.equal(strictPlan.code, 2);
  assert.match(strictPlan.stderr, /Remove TODO from profile\.idea/);

  const strictCompile = await cli(['compile', profile, '-o', path.join(workspace, 'spec'), '--strict']);
  assert.equal(strictCompile.code, 2);
  assert.equal(existsSync(path.join(workspace, 'spec')), false, 'strict refusal must not emit a packet');
});

// @req REQ-004
test('cli contract: data on stdout, diagnostics on stderr, non-zero exit on misuse', async () => {
  const declared = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const version = await cli(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), `vibecode-like-a-dev ${declared}`, 'reported version is the packaged version');

  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);

  const unknown = await cli(['not-a-command']);
  assert.equal(unknown.code, 2, 'usage errors exit 2');
  assert.equal(unknown.stdout.trim(), '', 'stdout stays clean so output can be piped');

  const missingProfile = await cli(['plan', '/nonexistent/profile.json']);
  assert.equal(missingProfile.code, 2);

  const unknownFlag = await cli(['plan', '/nonexistent/profile.json', '--strcit']);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /unknown option: --strcit/);

  const extraPositional = await cli(['init', 'one', 'two']);
  assert.equal(extraPositional.code, 2);
  assert.match(extraPositional.stderr, /Usage: vld init <dir>/);

  const equalsOption = await cli(['compile', '/missing.json', '--out=spec']);
  assert.equal(equalsOption.code, 2);
  assert.match(equalsOption.stderr, /unknown option: --out=spec/);

  const collision = await cli(['compile', '/missing.json', '-o', 'one', '--out', 'two']);
  assert.equal(collision.code, 2);
  assert.match(collision.stderr, /option supplied more than once: --out/);

  const misspelledRisk = path.join(os.tmpdir(), `vld-misspelled-risk-${process.pid}.json`);
  writeFileSync(misspelledRisk, JSON.stringify({ ...PROFILE, risk: { payments: true } }));
  try {
    const invalid = await cli(['plan', misspelledRisk]);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /profile\.risk: unknown field; did you mean "risks"\?/);
  } finally {
    rmSync(misspelledRisk, { force: true });
  }

  const longRunningJson = await cli(['runtime', 'serve', 'unused-mission.json', '--json']);
  assert.equal(longRunningJson.code, 2);
  assert.match(longRunningJson.stderr, /long-running local service; --json is not a one-shot response/);

  const invalidProfile = path.join(os.tmpdir(), `vld-invalid-${process.pid}.json`);
  writeFileSync(invalidProfile, JSON.stringify({ ...PROFILE, kind: 'spaceship' }));
  try {
    const invalid = await cli(['plan', invalidProfile]);
    assert.equal(invalid.code, 2);
    assert.equal(invalid.stdout.trim(), '', 'failures never pollute stdout');
    assert.match(invalid.stderr, /kind: must be one of|Profile is not valid/);
  } finally {
    rmSync(invalidProfile, { force: true });
  }

  // Optional constraints are still untrusted input. A non-list `mustUse` used to
  // reach the emitter and crash on `.join`; reject it during profile validation.
  const malformedConstraint = path.join(os.tmpdir(), `vld-malformed-constraint-${process.pid}.json`);
  writeFileSync(malformedConstraint, JSON.stringify({ ...PROFILE, constraints: { mustUse: 'postgres' } }));
  try {
    const invalid = await cli(['compile', malformedConstraint, '-o', path.join(os.tmpdir(), `vld-malformed-spec-${process.pid}`)]);
    assert.equal(invalid.code, 2, invalid.stderr);
    assert.equal(invalid.stdout.trim(), '', 'input errors never write a partial packet to stdout');
    assert.match(invalid.stderr, /constraints\.mustUse: must be a list/);
    assert.doesNotMatch(invalid.stderr, /^\s+at\s/m, 'a malformed optional field does not leak a stack trace');
  } finally {
    rmSync(malformedConstraint, { force: true });
    rmSync(path.join(os.tmpdir(), `vld-malformed-spec-${process.pid}`), { recursive: true, force: true });
  }

  // A target path that is a file, not a directory, is a mistake worth a sentence.
  const usable = path.join(os.tmpdir(), `vld-usable-${process.pid}.json`);
  writeFileSync(usable, JSON.stringify(PROFILE));
  const blocked = path.join(os.tmpdir(), `vld-blocked-${process.pid}`);
  writeFileSync(blocked, 'not a directory');
  try {
    const intoFile = await cli(['compile', usable, '-o', blocked, '--force']);
    assert.equal(intoFile.code, 2);
    assert.match(intoFile.stderr, /is not a directory/);
    assert.ok(!/^\s+at\s/m.test(intoFile.stderr), 'a user mistake does not print a stack trace');
  } finally {
    rmSync(blocked, { force: true });
    rmSync(usable, { force: true });
  }

  // A failing verification must exit 1, not 2: findings and misuse are different.
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-exit-'));
  try {
    writeFileSync(path.join(workspace, 'spec.json'), '{"schemaVersion":1,"requirements":[],"gates":[],"docs":[]}');
    const failed = await cli(['verify', workspace]);
    assert.equal(failed.code, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  // A broken overlay stack (missing parent `org-baseline`) exits 2 with a clean stderr diagnostic and no stack trace.
  const badOverlay = path.join(os.tmpdir(), `vld-bad-overlay-${process.pid}.json`);
  writeFileSync(badOverlay, JSON.stringify({ ...PROFILE, overlays: ['health-data'] }));
  try {
    const res = await cli(['plan', badOverlay]);
    assert.equal(res.code, 2);
    assert.equal(res.stdout.trim(), '');
    assert.match(res.stderr, /overlay stack is not valid[\s\S]*org-baseline/);
    assert.ok(!/^\s+at\s/m.test(res.stderr), 'missing parent overlay must not print a stack trace');
  } finally {
    rmSync(badOverlay, { force: true });
  }
});

test('compile and verify report identical core packet markdown line counts even with enforcement templates', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-linecount-'));
  try {
    const profilePath = path.join(workspace, 'profile.json');
    const specsDir = path.join(workspace, 'specs');
    writeFileSync(
      profilePath,
      JSON.stringify({
        name: 'trialbridge-reimburse',
        idea: 'A multi-tenant clinical trial stipend and travel reimbursement platform for pharmaceutical sponsors and enrolled participants.',
        kind: 'web-app',
        stage: 'production',
        users: { scale: 'medium' },
        traits: ['auth', 'admin', 'payments', 'persistence', 'webhooks', 'upload', 'ai', 'offline', 'background-jobs'],
        risks: { pii: true, payments: true, regulated: true, multiTenant: true, destructiveWrites: true, publicFacing: true, integrations: true },
        constraints: { team: 4, weeks: 12, stack: 'python' },
        overlays: ['two-person-review', 'health-data', 'org-baseline']
      })
    );

    const compiled = await cli(['compile', profilePath, '-o', specsDir]);
    assert.equal(compiled.code, 0, compiled.stderr);
    assert.doesNotMatch(compiled.stdout, /Over the tier ceiling/, 'enforcement templates must not push compile over the tier ceiling');
    const compileCount = Number(compiled.stdout.match(/markdown total\s+(\d+)\s+lines/)?.[1]);

    const verified = await cli(['verify', specsDir, '--json']);
    assert.equal(verified.code, 0, verified.stderr);
    const verifyReport = JSON.parse(verified.stdout);
    assert.equal(compileCount, verifyReport.stats.lines, 'compile and verify must agree on packet markdown line count');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('vld adopt supports --name and --idea flags on the CLI and rejects invalid --name cleanly with exit 2', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-adopt-flags-'));
  try {
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: '@grid/console', dependencies: { next: '15.0.0', react: '19.0.0' } }));
    const outPath = path.join(workspace, 'adopted-profile.json');
    const customIdea = 'A multi-tenant virtual power plant dispatch platform for commercial fleet operators and grid aggregators.';

    const ok = await cli(['adopt', '--name', 'gridpulse-dispatch', '--idea', customIdea, workspace, '-o', outPath]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout, /Replace the draft idea/i);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.name, 'gridpulse-dispatch');
    assert.equal(written.idea, customIdea);

    const bad = await cli(['adopt', workspace, '--name', 'BAD_UPPERCASE_NAME', '-o', path.join(workspace, 'bad.json')]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /invalid profile/i);
    assert.ok(!/^\s+at\s/m.test(bad.stderr), 'invalid --name must not print a stack trace');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('vld adopt accepts a Git repository URL, and spec-check/verify enforce [CLARIFY] and --require-assertions guards', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'vld-resilience-'));
  try {
    // 1. Remote Git URL adoption via file://
    const remoteSrc = path.join(workspace, 'remote-src');
    mkdirSync(remoteSrc, { recursive: true });
    writeFileSync(path.join(remoteSrc, 'package.json'), JSON.stringify({ name: '@acme/freight-hub', dependencies: { next: '15.0.0', react: '19.0.0' } }));
    writeFileSync(path.join(remoteSrc, 'index.ts'), 'export const ok = true;\n');
    execFileSync('git', ['init', '-q'], { cwd: remoteSrc });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteSrc });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteSrc });
    execFileSync('git', ['add', '.'], { cwd: remoteSrc });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: remoteSrc });

    const outProfile = path.join(workspace, 'profile.json');
    const adoptUrl = await cli([
      'adopt',
      `file://${remoteSrc}`,
      '--idea',
      'A freight customs clearance hub where licensed brokers clear consignments and audit temperature excursions.',
      '-o',
      outProfile
    ]);
    assert.equal(adoptUrl.code, 0, adoptUrl.stderr);
    const adopted = JSON.parse(readFileSync(outProfile, 'utf8'));
    assert.equal(adopted.name, 'freight-hub');

    // 2. Compile packet, plant a [CLARIFY] marker, and test authoring warning vs --strict failure
    const specsDir = path.join(workspace, 'specs');
    const compiled = await cli(['compile', outProfile, '-o', specsDir]);
    assert.equal(compiled.code, 0, compiled.stderr);

    const specJsonPath = path.join(specsDir, 'spec.json');
    const specJson = JSON.parse(readFileSync(specJsonPath, 'utf8'));
    const savedCriterion = specJson.requirements[0].acceptance[0].text;
    specJson.requirements[0].acceptance[0].text = `${savedCriterion} [CLARIFY: confirm port cut-off SLA]`;
    writeFileSync(specJsonPath, `${JSON.stringify(specJson, null, 2)}\n`);

    const looseVerify = await cli(['verify', specsDir, '--json']);
    assert.equal(looseVerify.code, 0, '[CLARIFY] is a warning during authoring');
    assert.match(looseVerify.stdout, /clarification marker/);

    const strictVerify = await cli(['verify', specsDir, '--strict', '--json']);
    assert.equal(strictVerify.code, 1, '[CLARIFY] must fail release verification under --strict');
    assert.match(strictVerify.stdout, /clarification marker/);

    // Restore clean spec.json and test hollow test detection (--require-assertions)
    specJson.requirements[0].acceptance[0].text = savedCriterion;
    writeFileSync(specJsonPath, `${JSON.stringify(specJson, null, 2)}\n`);

    const appRepo = path.join(workspace, 'app');
    mkdirSync(appRepo, { recursive: true });
    const anchors = specJson.requirements
      .filter((r) => r.verify === 'automated')
      .map((r) => `// @req ${r.id}`)
      .join('\n');
    writeFileSync(path.join(appRepo, 'journey_test.go'), `package app\n${anchors}\nfunc TestHollow(t *testing.T) {}\n`);

    const runSpecCheck = async (extraArgs) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [path.join(specsDir, 'spec-check.mjs'), '--repo', appRepo, ...extraArgs]);
        return { code: 0, stdout, stderr };
      } catch (err) {
        return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      }
    };

    const hollowCheck = await runSpecCheck(['--strict', '--require-assertions']);
    assert.equal(hollowCheck.code, 1, 'hollow Go test with no assertion must fail --require-assertions');
    assert.match(hollowCheck.stdout, /no visible assertion/);

    writeFileSync(
      path.join(appRepo, 'journey_test.go'),
      // BLK-2 rejects comparisons between two literals, so the "real" fixture must
      // assert on a value the test produced rather than on a constant.
      `package app\n${anchors}\nfunc TestReal(t *testing.T) { got := run(); if got != 0 { t.Fatalf("broken") } }\n`
    );
    const realCheck = await runSpecCheck(['--strict', '--require-assertions']);
    assert.equal(realCheck.code, 0, realCheck.stdout);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});


test('adopt returns a non-zero exit when the requested profile output is refused', async (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'vld-adopt-refused-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const output = path.join(project, 'profile.json');
  writeFileSync(output, '{"preserve":"this existing profile"}\n');
  const result = await cli(['adopt', project, '--idea', 'A reviewed profile must be written only when the target is available.', '-o', output]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stdout, /adopt ·/);
  assert.match(result.stderr, /profile not written: .*already exists/);
  assert.equal(readFileSync(output, 'utf8'), '{"preserve":"this existing profile"}\n');
});
