/**
 * The product's own primary journey, exercised through real processes.
 *
 * Every other test in this suite calls modules. This one runs the CLI the way a
 * user does, because "the modules work" and "the tool works" are different claims:
 * argument parsing, exit codes, stdout/stderr separation and file output are all
 * part of the contract, and none of them are covered by importing a function.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(drifted.stdout, /PASS/);

  // The same profile compiled into a fresh directory is byte-identical, so the
  // journey is repeatable. (Recompiling over an existing packet differs by design:
  // it records the progress it carried forward.)
  const second = path.join(workspace, 'specs-again');
  const recompiled = await cli(['compile', profilePath, '-o', second]);
  assert.equal(recompiled.code, 0, recompiled.stderr);
  assert.equal(
    readFileSync(path.join(second, 'spec.json'), 'utf8'),
    readFileSync(path.join(specs, 'spec.json'), 'utf8'),
    'the same profile produces the same manifest'
  );
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

