#!/usr/bin/env node
/**
 * Stress test: run every profile in examples/ideas/ through the pipeline and
 * judge the packet on determinism, stack fidelity, expected obligations, and
 * shipped-checker health — not just the exit code.
 *
 * Usage: node scripts/stress-test.mjs [--json]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitPacket } from '../factory/lib/emit/index.mjs';
import { vocabularyFor } from '../factory/lib/emit/vocabulary.mjs';
import { buildIndex } from '../factory/lib/indexer.mjs';
import { buildPlan } from '../factory/lib/planner.mjs';
import { normalizeProfile } from '../factory/lib/profile.mjs';
import { resolveProfileStacks } from '../factory/lib/stacks.mjs';
import { auditPacket, runShippedChecker } from './lib/packet-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDEAS = path.join(ROOT, 'examples', 'ideas');
const EXPECTED_FILE = path.join(IDEAS, 'expected.json');
const BUILD = path.join(IDEAS, 'build');
const JSON_OUT = process.argv.includes('--json');

const index = buildIndex();
const expectedConfig = existsSync(EXPECTED_FILE)
  ? JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'))
  : { ideas: {}, knownGaps: [] };

const knownGapMap = new Map(
  (expectedConfig.knownGaps ?? []).map((entry) => [`${entry.idea}:${entry.check}`, entry])
);

function treeDigest(dir) {
  const entries = new Map();
  const walk = (current) => {
    for (const dirent of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        entries.set(rel, digest);
      }
    }
  };
  walk(dir);
  return entries;
}

function diffTrees(aDir, bDir) {
  const a = treeDigest(aDir);
  const b = treeDigest(bDir);
  const diffs = [];
  for (const [rel, hash] of a.entries()) {
    if (!b.has(rel)) diffs.push(`missing on second compile: ${rel}`);
    else if (b.get(rel) !== hash) diffs.push(`byte mismatch across compiles: ${rel}`);
  }
  for (const rel of b.keys()) {
    if (!a.has(rel)) diffs.push(`extra file on second compile: ${rel}`);
  }
  return diffs;
}

function checkExpected({ slug, profile, outDir, expectation }) {
  const findings = [];
  const knownGapsHit = [];
  const record = (check, detail) => {
    const gap = knownGapMap.get(`${slug}:${check}`);
    if (gap || expectation?.knownGap === true || (Array.isArray(expectation?.knownGaps) && expectation.knownGaps.includes(check))) {
      knownGapsHit.push({ check, detail, reason: gap?.reason ?? expectation?.knownGapReason ?? 'tracked known gap' });
    } else {
      findings.push({ id: `expected:${check}`, detail });
    }
  };

  const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
  const reqKeys = new Set((spec.requirements ?? []).map((r) => r.key));
  const gateIds = new Set((spec.gates ?? []).map((g) => g.id));
  const primIds = new Set((spec.primitives ?? []).map((p) => p.id));
  const countedIn = new Set(spec.anchorConvention?.countedIn ?? []);
  const customReqs = (spec.requirements ?? []).filter((r) => /^REQ-C\d{2,}$/.test(r.id));

  // Always verify stack runner countedIn globs appear in anchorConvention.countedIn.
  const stackInfo = resolveProfileStacks(profile);
  const requiredStackGlobs = Array.isArray(stackInfo.services) && stackInfo.services.length > 0
    ? stackInfo.services.flatMap((svc) => (svc.profile.countedIn ?? []).map((glob) => `${svc.service}/${glob}`))
    : (stackInfo.primary?.countedIn ?? []);
  for (const glob of requiredStackGlobs) {
    if (!countedIn.has(glob)) {
      record('stack-test-glob', `anchorConvention.countedIn missing stack glob "${glob}"`);
    }
  }

  if (!expectation) return { findings, knownGapsHit };

  if (typeof expectation.tier === 'number' && spec.rigor?.tier !== expectation.tier) {
    record('tier', `expected tier ${expectation.tier}, got ${spec.rigor?.tier}`);
  }
  if (expectation.packet && spec.rigor?.packet !== expectation.packet) {
    record('packet', `expected packet "${expectation.packet}", got "${spec.rigor?.packet}"`);
  }
  for (const key of expectation.requiredKeys ?? []) {
    if (!reqKeys.has(key)) record(`req:${key}`, `missing expected requirement key "${key}"`);
  }
  for (const gate of expectation.requiredGates ?? []) {
    if (!gateIds.has(gate)) record(`gate:${gate}`, `missing expected gate "${gate}"`);
  }
  for (const primitive of expectation.requiredPrimitives ?? []) {
    if (!primIds.has(primitive)) record(`primitive:${primitive}`, `missing expected primitive "${primitive}"`);
  }
  if (typeof expectation.expectCustomRequirements === 'number' && customReqs.length !== expectation.expectCustomRequirements) {
    record('custom-reqs', `expected ${expectation.expectCustomRequirements} REQ-Cxx requirement(s), got ${customReqs.length}`);
  }
  const expectGlobs = [
    ...(expectation.expectTestGlob ? [expectation.expectTestGlob] : []),
    ...(expectation.expectTestGlobs ?? [])
  ];
  for (const glob of expectGlobs) {
    if (!countedIn.has(glob)) record(`glob:${glob}`, `missing expected test glob "${glob}" in anchorConvention.countedIn`);
  }
  if (expectation.runnerCommand) {
    const entryDoc = existsSync(path.join(outDir, 'AGENTS.md'))
      ? readFileSync(path.join(outDir, 'AGENTS.md'), 'utf8')
      : readFileSync(path.join(outDir, 'SPEC.md'), 'utf8');
    const verifyDoc = existsSync(path.join(outDir, '05-verification.md'))
      ? readFileSync(path.join(outDir, '05-verification.md'), 'utf8')
      : '';
    if (!`${entryDoc}\n${verifyDoc}`.includes(expectation.runnerCommand)) {
      record('runner-command', `expected stack runner "${expectation.runnerCommand}" in packet docs`);
    }
  }
  if (Array.isArray(expectation.forbiddenPrimaryNouns) && expectation.forbiddenPrimaryNouns.length > 0) {
    const vocab = vocabularyFor(profile);
    if (expectation.forbiddenPrimaryNouns.includes(vocab.primary)) {
      record('primary-noun', `forbidden qualifier "${vocab.primary}" chosen as primary domain noun`);
    }
  }

  return { findings, knownGapsHit };
}

const files = readdirSync(IDEAS)
  .filter((file) => file.endsWith('.json') && file !== 'expected.json')
  .sort();
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

const results = [];
let totalKnownGaps = 0;
for (const file of files) {
  const slug = path.basename(file, '.json');
  const raw = JSON.parse(readFileSync(path.join(IDEAS, file), 'utf8'));
  const profile = normalizeProfile(raw);
  const outDir = path.join(BUILD, slug);
  const recheckDir = path.join(BUILD, '_recheck', slug);

  const plan1 = buildPlan(profile, { index });
  emitPacket(plan1, outDir, { force: true });

  // Double-compile byte-identity: second independent normalize -> plan -> emit into
  // the same logical packetDir must match every emitted file byte-for-byte.
  const packetDirLabel = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8')).project?.packetDir;
  const plan2 = buildPlan(normalizeProfile(raw), { index });
  emitPacket(plan2, recheckDir, { force: true, packetDir: packetDirLabel });
  const byteDiffs = diffTrees(outDir, recheckDir);

  const result = auditPacket(profile, outDir);
  if (byteDiffs.length > 0) {
    result.findings.push({ id: 'non-deterministic', detail: byteDiffs.slice(0, 5).join('; ') });
  }
  const checker = runShippedChecker(outDir);
  result.checkerCode = checker.code;
  if (checker.code !== 0) {
    result.findings.push({ id: 'shipped-checker', detail: checker.stdout.trim().split('\n').slice(-3).join(' ') });
  }
  const oracle = checkExpected({
    slug,
    profile,
    outDir,
    expectation: expectedConfig.ideas?.[slug]
  });
  result.findings.push(...oracle.findings);
  result.knownGaps = oracle.knownGapsHit;
  totalKnownGaps += oracle.knownGapsHit.length;
  result.byteIdentical = byteDiffs.length === 0;
  result.ok = result.findings.length === 0;
  result.id = slug;
  results.push(result);
}
rmSync(path.join(BUILD, '_recheck'), { recursive: true, force: true });

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const header = ['idea', 'kind', 'tier', 'req', 'crit', 'gates', 'lines', 'vocab', 'gaps', 'det', 'verdict'];
  const rows = results.map((result) => [
    result.id,
    result.kind,
    String(result.tier),
    String(result.requirements),
    String(result.criteria),
    String(result.gates),
    String(result.lines),
    `${Math.round(result.keywordCoverage * 100)}%`,
    String(result.gaps),
    result.byteIdentical ? 'yes' : 'NO',
    result.ok
      ? (result.knownGaps.length > 0 ? `pass (${result.knownGaps.length} knownGap)` : 'pass')
      : `${result.findings.length} finding(s)`
  ]);
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(row));

  const failing = results.filter((result) => !result.ok);
  if (failing.length > 0) {
    console.log('\nFindings');
    for (const result of failing) {
      console.log(`\n${result.id}`);
      for (const finding of result.findings) console.log(`  ✗ ${finding.id}: ${finding.detail}`);
    }
  }
  const coverage = results.map((result) => result.keywordCoverage);
  process.exitCode = failing.length > 0 ? 1 : 0;
  const gapSuffix = totalKnownGaps > 0 ? ` · ${totalKnownGaps} tracked knownGap(s)` : '';
  console.log(`\n${results.length} ideas · ${failing.length} with findings · ${results.filter((r) => r.byteIdentical).length}/${results.length} byte-identical · idea-vocabulary coverage ${Math.round(
    (coverage.reduce((a, b) => a + b, 0) / coverage.length) * 100
  )}% mean${gapSuffix}`);
}
