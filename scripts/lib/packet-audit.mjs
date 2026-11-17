/**
 * Shared judgement for a compiled packet.
 *
 * `verify` answers "is this packet internally consistent". This module answers a
 * different question: "would a reader of this product find it right?". The checks
 * are mechanical on purpose — a packet naming Vitest for a Go service, pointing at
 * a document it does not ship, or printing `undefined` is wrong in a way an exit
 * code will never notice.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isAnchorDiscoverable, resolveProfileStacks } from '../../factory/lib/stacks.mjs';
import { verifyPacket } from '../../factory/lib/verify.mjs';

export const STACK_PROBE = {
  typescript: { language: /TypeScript|Node\.js/, runner: /Vitest|npm (run )?test/, runnerWrong: /\bpytest\b|\bruff\b|\bmypy\b|\bgo test\b|\bcargo test\b|vendor\/bin\/phpunit/ },
  javascript: { language: /JavaScript|Node\.js/, runner: /node:test|Vitest|npm (run )?test/, runnerWrong: /\bpytest\b|\bruff\b|\bmypy\b|\bgo test\b|\bcargo test\b|vendor\/bin\/phpunit/ },
  python: { language: /Python 3/, runner: /pytest/, runnerWrong: /Vitest|ESLint|Zod|npm (run )?test|\bgo test\b|\bcargo test\b/ },
  go: { language: /\bGo\b|golang/, runner: /\bgo test\b/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|\bcargo test\b/ },
  rust: { language: /\bRust\b|Cargo/, runner: /\bcargo test\b/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|npm run lint|\bgo test\b/ },
  java: { language: /\bJava\b|OpenJDK/, runner: /JUnit|mvnw test/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|npm run lint|\bcargo test\b/ },
  kotlin: { language: /\bKotlin\b/, runner: /JUnit|Kotest|gradlew test/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|npm run lint|\bcargo test\b/ },
  ruby: { language: /\bRuby\b/, runner: /RSpec|bundle exec rspec/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|npm run lint|\bcargo test\b/ },
  php: { language: /\bPHP\b/, runner: /PHPUnit|vendor\/bin\/phpunit/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|npm run lint|\bcargo test\b/ },
  csharp: { language: /C#|\.NET/, runner: /xUnit|dotnet test/, runnerWrong: /Vitest|\bpytest\b|ESLint|npm (run )?test|npm run lint|\bcargo test\b/ }
};

const STOP = new Set([
  'a', 'an', 'and', 'the', 'that', 'this', 'with', 'from', 'into', 'must', 'never', 'each', 'when',
  'their', 'they', 'them', 'than', 'then', 'there', 'which', 'while', 'including', 'includes', 'data',
  'user', 'users', 'application', 'service', 'system', 'should', 'every', 'also', 'over', 'such',
  'records', 'record', 'stores', 'stored', 'before', 'after', 'where', 'what', 'have', 'been', 'will',
  'your', 'only', 'more', 'most', 'some', 'these', 'those', 'about', 'because', 'between'
]);

/** Words from the idea worth seeing in the specification. */
export function ideaKeywords(idea) {
  const seen = new Set();
  return String(idea)
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length >= 5 && !STOP.has(word))
    .filter((word) => (seen.has(word) ? false : (seen.add(word), true)))
    .slice(0, 40);
}

/** A heading followed by nothing before the next heading or the end of the file. */
export function emptySections(markdown) {
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

/** Run the checker that ships inside the packet, the way a user would. */
export function runShippedChecker(outDir) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(outDir, 'spec-check.mjs'), '--repo', outDir], {
      encoding: 'utf8'
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') };
  }
}

/**
 * Judge one compiled packet against the profile that produced it.
 * Returns metrics plus a list of findings; an empty list means nothing looked wrong.
 */
export function auditPacket(profile, outDir) {
  const report = verifyPacket(outDir);
  const docs = readdirSync(outDir).filter((file) => file.endsWith('.md'));
  const source = Object.fromEntries(docs.map((file) => [file, readFileSync(path.join(outDir, file), 'utf8')]));
  const spec = JSON.parse(readFileSync(path.join(outDir, 'spec.json'), 'utf8'));
  const all = Object.values(source).join('\n');

  const findings = [];
  const check = (id, ok, detail) => {
    if (!ok) findings.push({ id, detail });
    return ok;
  };

  check('verify', report.ok, report.errors.join(' | '));

  const empty = Object.entries(source).flatMap(([file, text]) => emptySections(text).map((title) => `${file}: "${title}"`));
  check('no-empty-sections', empty.length === 0, empty.join(' | '));

  // Values that mean a template was handed data it did not expect. This is the
  // cheapest possible test for "the generator crashed quietly".
  const leaks = ['undefined', 'NaN', '[object Object]', '{{', '}}'].filter((token) => all.includes(token));
  check('no-template-leaks', leaks.length === 0, `packet prints ${leaks.join(', ')}`);

  const resolvedStacks = resolveProfileStacks(profile);
  const stack = spec.stack ?? spec.project?.stack;
  if (resolvedStacks.isMultiService) {
    for (const svc of resolvedStacks.services) {
      check('stack-service-named', all.includes(svc.service), `service "${svc.service}" is not named in the packet`);
      const probe = svc.profile ? STACK_PROBE[svc.profile.id] : null;
      if (probe) {
        check('stack-test-runner', probe.runner.test(all), `no test runner for service "${svc.service}" (${svc.declared})`);
      }
    }
  } else if (resolvedStacks.recognised && resolvedStacks.primary) {
    const declared = resolvedStacks.declaredLabel;
    const probe = declared.toLowerCase() === 'undecided' ? null : STACK_PROBE[resolvedStacks.primary.id];
    if (probe) {
      check('stack-language', probe.language.test(all), `declared stack "${declared}" is not named in the packet`);
      check('stack-test-runner', probe.runner.test(all), `no test runner for "${declared}" in the packet`);
      const wrong = [...all.matchAll(new RegExp(probe.runnerWrong.source, 'g'))].map((match) => match[0]);
      check('stack-no-foreign-tooling', wrong.length === 0, `packet names foreign tooling for "${declared}": ${[...new Set(wrong)].join(', ')}`);
    }
    // Roadmap 1.7: every automated requirement's anchor path must be discoverable by
    // that ecosystem's default test runner glob (never a choose-runner placeholder).
    const undiscoverable = spec.requirements
      .filter((req) => req.verify === 'automated' && req.anchor)
      .filter((req) => !isAnchorDiscoverable(resolvedStacks.primary, req.anchor));
    check(
      'anchor-glob-discoverable',
      undiscoverable.length === 0,
      `anchors not matched by ${resolvedStacks.primary.id} default test glob: ${undiscoverable.map((r) => r.anchor).join(', ')}`
    );
  } else {
    const declared = resolvedStacks.declaredLabel;
    // An unknown stack must be admitted, not silently replaced with a default.
    check(
      'stack-unrecognised-is-labelled',
      /not one this packet knows|must be replaced/i.test(all),
      `declared stack "${declared}" is not recognised and the packet does not say so`
    );
    const borrowed = ['npm run lint', 'npm run typecheck'].filter((command) => all.includes(command));
    check(
      'stack-no-invented-commands',
      borrowed.length === 0,
      `packet gives ${borrowed.join(' / ')} for an unrecognised stack; it should ask for the real commands`
    );
  }

  const shipped = new Set(readdirSync(outDir));
  const referenced = Object.values(source).flatMap((text) => [...text.matchAll(/\b(0[0-7]-[a-z-]+\.md)\b/g)].map((match) => match[1]));
  const dangling = [...new Set(referenced)].filter((file) => !shipped.has(file));
  check('doc-references', dangling.length === 0, `packet points at documents it does not ship: ${dangling.join(', ')}`);

  const brief = source['01-product-brief.md'] ?? source['spec.md'] ?? '';
  const gaps = brief.includes('Obligations in the idea with no requirement yet')
    ? (brief.match(/Obligations in the idea[\s\S]*?(?=\n## |\n\*\*3\.)/)?.[0] ?? '').split('\n').filter((line) => line.startsWith('- ')).length
    : 0;

  // Text from the idea must never be able to forge structure in the documents.
  const ideaLines = String(profile.idea)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s/.test(line));
  const forged = ideaLines.filter((line) => Object.values(source).some((text) => text.split('\n').some((docLine) => docLine.trim() === line)));
  check('no-forged-headings', forged.length === 0, `idea text injected a heading into the packet: ${forged.join(' / ')}`);

  const noCriteria = spec.requirements.filter((requirement) => !requirement.acceptance || requirement.acceptance.length === 0);
  check('criteria', noCriteria.length === 0, `requirements without criteria: ${noCriteria.map((r) => r.id).join(', ')}`);

  const noAnchor = spec.requirements.filter((requirement) => requirement.verify === 'automated' && !requirement.anchor);
  check('anchor-hints', noAnchor.length === 0, `automated requirements without an anchor hint: ${noAnchor.map((r) => r.id).join(', ')}`);

  // Measure the specification, not the quote: the idea appears verbatim in the
  // packet, and scoring that text would reward quoting the input.
  const withoutQuotes = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('>')).join('\n');
  const specification = withoutQuotes(
    [
      ...spec.requirements.map(
        (requirement) => `${requirement.title} ${requirement.statement} ${(requirement.acceptance ?? []).map((ac) => ac.text).join(' ')}`
      ),
      source['02-domain-model.md'] ?? '',
      source['spec.md'] ?? ''
    ].join('\n')
  );
  const keywords = ideaKeywords(profile.idea);
  const present = keywords.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(specification));
  const coverage = keywords.length === 0 ? 1 : present.length / keywords.length;

  // Roadmap 1.3 (F-13): no duplicate glossary terms (case-insensitive) in 02-domain-model.md.
  const domainDocPath = path.join(outDir, '02-domain-model.md');
  try {
    const domainDoc = readFileSync(domainDocPath, 'utf8');
    const glossarySection = domainDoc.split(/^##\s+\d+\.\s+Ubiquitous language/m)[1]?.split(/^###\s+/m)[0] ?? '';
    const seenTerms = new Set();
    const dupes = [];
    for (const row of glossarySection.split('\n')) {
      const match = row.match(/^\|\s*\*\*([^*]+)\*\*\s*\|/);
      if (!match) continue;
      const key = match[1].trim().toLowerCase();
      if (seenTerms.has(key)) dupes.push(match[1].trim());
      seenTerms.add(key);
    }
    check('glossary-no-duplicate-terms', dupes.length === 0, `duplicate glossary term(s) in 02-domain-model.md: ${dupes.join(', ')}`);
  } catch {
    // single-file tier-0 packets do not emit 02-domain-model.md
  }

  const lines = readdirSync(outDir)
    .filter((file) => file.endsWith('.md'))
    .reduce((sum, file) => sum + readFileSync(path.join(outDir, file), 'utf8').split('\n').length, 0);

  return {
    id: spec.project?.name ?? spec.profile?.name ?? path.basename(outDir),
    kind: profile.kind,
    tier: spec.rigor?.tier,
    requirements: spec.requirements.length,
    criteria: spec.requirements.reduce((sum, requirement) => sum + (requirement.acceptance?.length ?? 0), 0),
    gates: spec.gates?.length ?? 0,
    practices: spec.primitives?.length ?? 0,
    lines,
    pending: report.warnings.filter((warning) => /no test anchor yet/.test(warning)).length,
    keywordCoverage: Number(coverage.toFixed(2)),
    missingKeywords: keywords.filter((word) => !present.includes(word)).slice(0, 8),
    gaps,
    stack: stack ?? null,
    findings,
    ok: findings.length === 0
  };
}
