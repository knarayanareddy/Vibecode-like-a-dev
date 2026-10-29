#!/usr/bin/env node
/**
 * Stress test: run every profile in examples/ideas/ through the pipeline and
 * judge the packet, not just the exit code.
 *
 * `verify` answers "is this packet internally consistent". It cannot answer "is
 * this packet right for this product". These checks are an attempt at the second
 * question, and they are deliberately mechanical: a packet that names Vitest for
 * a Python service, or leaves a section heading with nothing under it, is wrong
 * in a way a reader would catch and an exit code would not.
 *
 * Usage: node scripts/stress-test.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitPacket } from '../factory/lib/emit/index.mjs';
import { buildIndex } from '../factory/lib/indexer.mjs';
import { buildPlan } from '../factory/lib/planner.mjs';
import { normalizeProfile } from '../factory/lib/profile.mjs';
import { verifyPacket } from '../factory/lib/verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDEAS = path.join(ROOT, 'examples', 'ideas');
const BUILD = path.join(IDEAS, 'build');
const JSON_OUT = process.argv.includes('--json');

const index = buildIndex();

const STACK_PROBE = {
  typescript: { language: /TypeScript|Node\.js/, runner: /Vitest|npm (run )?test/, runnerWrong: /pytest|ruff|mypy|go test/ },
  python: { language: /Python 3/, runner: /pytest/, runnerWrong: /Vitest|ESLint|Zod|npm (run )?test/ },
  go: { language: /\bGo\b|golang/, runner: /go test/, runnerWrong: /Vitest|pytest|ESLint|npm (run )?test/ }
};

/** Words from the idea worth seeing in the packet, longest first. */
function ideaKeywords(idea) {
  const stop = new Set([
    'a', 'an', 'and', 'the', 'that', 'this', 'with', 'from', 'into', 'must', 'never', 'each', 'when',
    'their', 'they', 'them', 'than', 'then', 'there', 'which', 'while', 'including', 'includes', 'data',
    'user', 'users', 'application', 'service', 'system', 'should', 'every', 'also', 'over', 'such',
    'records', 'record', 'stores', 'stored', 'before', 'after', 'where', 'what', 'have', 'been', 'will',
    'your', 'only', 'more', 'most', 'some', 'than', 'these', 'those', 'about', 'because', 'between'
  ]);
  const seen = new Set();
  return idea
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length >= 5 && !stop.has(word))
    .filter((word) => (seen.has(word) ? false : (seen.add(word), true)))
    .slice(0, 40);
}

/** A heading followed by no prose before the next heading or the end of file. */
function emptySections(markdown) {
  const lines = markdown.split('\n');
  const empty = [];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].match(/^(#{2,4})\s+(.*)$/);
    if (!heading) continue;
    const level = heading[1].length;
    let hasContent = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].match(/^(#{1,6})\s+/);
      // A deeper heading is content: a section made of subsections is not empty.
      if (next && next[1].length <= level) break;
      if (lines[j].trim() !== '') {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) empty.push(heading[2].trim());
  }
  return empty;
}

function checkPacket(profile, outDir) {
  const report = verifyPacket(outDir);
  const docs = readdirSync(outDir).filter((file) => file.endsWith('.md'));
  const source = Object.fromEntries(docs.map((file) => [file, readFileSync(path.join(outDir, file), 'utf8')]));
  const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
  const all = Object.values(source).join('\n');

  const declared = String(profile.constraints.stack || 'undecided').toLowerCase();
  const probe = STACK_PROBE[declared];

  const findings = [];
  const check = (id, ok, detail) => {
    if (!ok) findings.push({ id, detail });
    return ok;
  };

  check('verify', report.ok, report.errors.join(' | '));

  const empty = Object.entries(source).flatMap(([file, text]) => emptySections(text).map((title) => `${file}: "${title}"`));
  check('no-empty-sections', empty.length === 0, empty.join(' | '));

  if (probe) {
    check('stack-language', probe.language.test(all), `declared stack "${declared}" is not named in the packet`);
    check('stack-test-runner', probe.runner.test(all), `no test runner for "${declared}" in the packet`);
    const wrong = [...all.matchAll(new RegExp(probe.runnerWrong.source, 'g'))].map((match) => match[0]);
    check('stack-no-foreign-tooling', wrong.length === 0, `packet names foreign tooling for "${declared}": ${[...new Set(wrong)].join(', ')}`);
  }

  const shipped = new Set(readdirSync(outDir));
  const referenced = Object.values(source).flatMap((text) => [...text.matchAll(/\b(0[0-7]-[a-z-]+\.md)\b/g)].map((match) => match[1]));
  const dangling = [...new Set(referenced)].filter((file) => !shipped.has(file));
  check('doc-references', dangling.length === 0, `packet points at documents it does not ship: ${dangling.join(', ')}`);

  const gaps = (source['01-product-brief.md'] ?? source['spec.md'] ?? '').includes('Obligations in the idea with no requirement yet')
    ? ((source['01-product-brief.md'] ?? source['spec.md']).match(/Obligations in the idea[\s\S]*?(?=\n## |\n\*\*3\.)/)?.[0] ?? '').split('\n').filter((line) => line.startsWith('- ')).length
    : 0;

  const noCriteria = spec.requirements.filter((requirement) => !requirement.acceptance || requirement.acceptance.length === 0);
  check('criteria', noCriteria.length === 0, `requirements without criteria: ${noCriteria.map((r) => r.id).join(', ')}`);

  const noAnchor = spec.requirements.filter((requirement) => requirement.verify === 'automated' && !requirement.anchor);
  check('anchor-hints', noAnchor.length === 0, `automated requirements without an anchor hint: ${noAnchor.map((r) => r.id).join(', ')}`);

  // Measure the specification, not the quote: the idea is reproduced verbatim in
  // the brief, so including that text would always score 100%.
  // Strip block quotes: the idea is reproduced verbatim in the packet, and scoring
  // that text would reward quoting the input rather than acting on it.
  const withoutQuotes = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('>')).join('\n');
  const specification = withoutQuotes(
    [
      ...spec.requirements.map((requirement) => `${requirement.title} ${requirement.statement} ${(requirement.acceptance ?? []).map((ac) => ac.text).join(' ')}`),
      source['02-domain-model.md'] ?? '',
      source['spec.md'] ?? ''
    ].join('\n')
  );
  const keywords = ideaKeywords(profile.idea);
  const present = keywords.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(specification));
  const coverage = keywords.length === 0 ? 1 : present.length / keywords.length;

  return {
    id: spec.profile?.name ?? path.basename(outDir),
    tier: spec.tier ?? spec.rigor?.tier,
    requirements: spec.requirements.length,
    criteria: spec.requirements.reduce((sum, requirement) => sum + (requirement.acceptance?.length ?? 0), 0),
    gates: spec.gates?.length ?? 0,
    practices: spec.primitives?.length ?? 0,
    lines: spec.stats?.packetLines ?? spec.packetLines ?? null,
    pending: report.warnings.filter((warning) => /no test anchor yet/.test(warning)).length,
    keywordCoverage: Number(coverage.toFixed(2)),
    missingKeywords: keywords.filter((word) => !present.includes(word)).slice(0, 8),
    gaps,
    findings,
    ok: findings.length === 0
  };
}

const files = readdirSync(IDEAS).filter((file) => file.endsWith('.json')).sort();
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

const results = [];
for (const file of files) {
  const slug = path.basename(file, '.json');
  const profile = normalizeProfile(JSON.parse(readFileSync(path.join(IDEAS, file), 'utf8')));
  const outDir = path.join(BUILD, slug);
  const plan = buildPlan(profile, { index });
  emitPacket(plan, outDir, { force: true });
  const result = checkPacket(profile, outDir);

  let checker = { code: 0, stdout: '' };
  try {
    checker = {
      code: 0,
      stdout: execFileSync(process.execPath, [path.join(outDir, 'spec-check.mjs'), '--repo', outDir], { encoding: 'utf8' })
    };
  } catch (error) {
    checker = { code: error.status ?? 1, stdout: String(error.stdout ?? '') };
  }
  result.checkerCode = checker.code;
  if (checker.code !== 0) result.findings.push({ id: 'shipped-checker', detail: checker.stdout.trim().split('\n').slice(-3).join(' ') });
  result.ok = result.findings.length === 0;

  // Match the verifier's own accounting: every markdown file in the packet.
  result.lines = readdirSync(outDir)
    .filter((file) => file.endsWith('.md'))
    .reduce((sum, file) => sum + readFileSync(path.join(outDir, file), 'utf8').split('\n').length, 0);

  results.push(result);
}

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const header = ['idea', 'kind', 'tier', 'req', 'crit', 'gates', 'lines', 'vocab', 'gaps', 'verdict'];
  const rows = results.map((result) => {
    const profile = JSON.parse(readFileSync(path.join(IDEAS, `${result.id}.json`), 'utf8'));
    return [
      result.id,
      profile.kind,
      String(result.tier),
      String(result.requirements),
      String(result.criteria),
      String(result.gates),
      String(result.lines),
      `${Math.round(result.keywordCoverage * 100)}%`,
      String(result.gaps),
      result.ok ? 'pass' : `${result.findings.length} finding(s)`
    ];
  });
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
  console.log(`\n${results.length} ideas · ${failing.length} with findings · idea-vocabulary coverage ${Math.round(
    (coverage.reduce((a, b) => a + b, 0) / coverage.length) * 100
  )}% mean`);
}
