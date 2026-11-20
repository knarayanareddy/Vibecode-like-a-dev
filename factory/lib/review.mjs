/**
 * Structured independent review protocol (ADR 0012, roadmap 3.1).
 *
 * Enforces `primitives/agent/review-protocol` in code:
 *   1. Session separation: prepares an isolated review packet with ONLY the
 *      governing `spec.json` requirements, the unified Git diff, and a static
 *      diff-risk scan — never the author's reasoning or chat transcript.
 *   2. Six mandatory categories (`scope`, `coverage`, `failurePaths`,
 *      `assertionStrength`, `boundaries`, `reversibility`), each explicitly
 *      `"none"` or a list of requirement-cited findings (`{ requirement, file,
 *      line, severity, summary, fix }`).
 *   3. Automated diff-risk signals: weakened/deleted assertions, skipped tests,
 *      new package dependencies, and new environment variable reads.
 *   4. Risk-tier escalation: tier >= 2 or money/regulated/destructiveWrites
 *      packets require explicit human sign-off alongside automated review.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvidence } from './evidence.mjs';
import { digest, ensureProjectDir, extensionError, ID_PATTERN, stableJson } from './extension-utils.mjs';

const canonicalJson = (value) => `${stableJson(value)}\n`;

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_CATEGORIES = Object.freeze([
  'scope',
  'coverage',
  'failurePaths',
  'assertionStrength',
  'boundaries',
  'reversibility'
]);
export const FINDING_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const REVIEW_VERDICTS = Object.freeze(['approved', 'changes-requested', 'escalated-to-human']);

const REQ_ID = /^REQ-(?:C\d{2,}|\d{3,})$/;
const ASSERT_RE = /\b(?:assert(?:\.|_eq!|_ne!|\s|\()|expect\s*\(|Assert\.|assertEquals|assertThat|t\.(?:Fatal|Error)|should\b|\$this->assert)/;
const SKIP_RE = /(?:\b(?:test|it|describe)\.(?:skip|only|todo)\b|#\[ignore\]|\bt\.Skip\s*\(|@pytest\.mark\.skip|\bxit\s*\(|\bxdescribe\s*\()/;
const ENV_RE = /(?:process\.env\.[A-Z0-9_]+|os\.(?:environ(?:\.\w+)?|getenv)\s*[\[(]|os\.Getenv\s*\(|std::env::var\s*\(|System\.getenv\s*\(|ENV\[['"][A-Z0-9_]+)/g;
const TAUTOLOGY_RE = /\bassert(?:\.\w+)?\(\s*(?:true|True|1)\s*\)|\bexpect\(\s*(?:true|True|1)\s*\)|\bassert(?:\.\w+)?\(\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*\)|\bassert\s+(?:True|1)\b/;
const STRICT_ASSERT_RE = /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(|\bexpect\([^)]*\)\.(?:toBe|toEqual|toStrictEqual)\b|\bassert_(?:eq|equal)\s*\(/;
const LOOSE_ASSERT_RE = /\bassert(?:\.ok)?\(\s*[^,;)]*\)|\bexpect\([^)]*\)\.(?:toBeTruthy|toBeDefined)\b/;
const MANIFEST_FILES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json']);
const TEST_PATH_RE = /(?:^|\/)(?:tests?|spec|__tests__)\/|\.(?:test|spec)\.[^/]+$|_test\.(?:go|py|rs)$|Test\.(?:java|kt|php)$|Tests\.cs$/;

function gitDiff(project, baseRef, headRef) {
  const range = headRef ? `${baseRef}..${headRef}` : baseRef;
  return execFileSync('git', ['-C', project, 'diff', '--unified=3', range], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * Deterministically inspect a unified Git diff for test weakening, test skips,
 * dropped `@req` anchors, new dependencies, and newly introduced env vars.
 */
export function scanDiffRisks(diffText) {
  const files = [];
  const testWeakening = [];
  const skippedTests = [];
  const droppedAnchors = [];
  const manifestChanges = [];
  const newEnvVars = new Set();

  let addedTautologies = 0;
  let removedStrict = 0;
  let addedStrict = 0;
  let addedLoose = 0;
  let currentFile = null;
  let addedAssertions = 0;
  let removedAssertions = 0;
  let removedReqs = new Set();
  let addedReqs = new Set();

  const flushFile = () => {
    if (!currentFile) return;
    files.push(currentFile);
    const weakenedByReplacement = addedTautologies > 0 || (removedStrict > 0 && addedLoose > 0 && addedStrict === 0);
    if (TEST_PATH_RE.test(currentFile) && (removedAssertions > addedAssertions || weakenedByReplacement)) {
      testWeakening.push({
        file: currentFile,
        removedAssertions,
        addedAssertions,
        detail: `${currentFile} removed ${removedAssertions} assertion(s) and added ${addedAssertions}`
      });
    }
    for (const req of removedReqs) {
      if (!addedReqs.has(req)) {
        droppedAnchors.push({ file: currentFile, requirement: req });
      }
    }
    if (MANIFEST_FILES.has(path.posix.basename(currentFile)) || currentFile.endsWith('.csproj')) {
      manifestChanges.push(currentFile);
    }
  };

  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      flushFile();
      currentFile = header[1];
      addedAssertions = 0;
      removedAssertions = 0;
      addedTautologies = 0;
      removedStrict = 0;
      addedStrict = 0;
      addedLoose = 0;
      removedReqs = new Set();
      addedReqs = new Set();
      continue;
    }
    if (!currentFile || line.startsWith('--- ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      const content = line.slice(1);
      if (ASSERT_RE.test(content)) addedAssertions += 1;
      if (TAUTOLOGY_RE.test(content)) addedTautologies += 1;
      if (STRICT_ASSERT_RE.test(content)) addedStrict += 1;
      else if (LOOSE_ASSERT_RE.test(content)) addedLoose += 1;
      if (SKIP_RE.test(content)) skippedTests.push({ file: currentFile, snippet: content.trim().slice(0, 120) });
      for (const m of content.matchAll(/@req\s+(REQ-(?:C\d{2,}|\d{3,}))\b/g)) addedReqs.add(m[1]);
      for (const m of content.matchAll(ENV_RE)) newEnvVars.add(m[0].slice(0, 80));
    } else if (line.startsWith('-')) {
      const content = line.slice(1);
      if (ASSERT_RE.test(content)) removedAssertions += 1;
      if (STRICT_ASSERT_RE.test(content)) removedStrict += 1;
      for (const m of content.matchAll(/@req\s+(REQ-(?:C\d{2,}|\d{3,}))\b/g)) removedReqs.add(m[1]);
    }
  }
  flushFile();

  return {
    changedFiles: files,
    testWeakening,
    skippedTests,
    droppedAnchors,
    manifestChanges,
    newEnvVars: [...newEnvVars].sort()
  };
}

/** Determine whether a packet requires mandatory human escalation on review. */
export function requiresHumanReview(spec, { escalationTier = 2 } = {}) {
  const tier = Number(spec?.rigor?.tier ?? 0);
  const risks = spec?.project?.risks ?? {};
  const reasons = [];
  if (tier >= escalationTier) reasons.push(`rigor tier ${tier} >= ${escalationTier}`);
  if (risks.money) reasons.push('risks.money');
  if (risks.regulated) reasons.push('risks.regulated');
  if (risks.destructiveWrites) reasons.push('risks.destructiveWrites');
  return { required: reasons.length > 0, reasons };
}

/**
 * Prepare a session-isolated review packet containing ONLY spec obligations,
 * the unified diff, and static diff-risk probes (zero author chat context).
 */
export function prepareReviewPacket({
  projectDir = '.',
  packetDir = 'specs',
  baseRef = 'HEAD~1',
  headRef = 'HEAD',
  authorId = 'unknown-author',
  requirementIds = null,
  diffText = null
} = {}) {
  const project = ensureProjectDir(projectDir);
  const specFile = path.resolve(project, packetDir, 'spec.json');
  if (!existsSync(specFile)) throw extensionError(`spec.json not found: ${specFile}`, 'PACKET_NOT_FOUND');
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const packetDigest = digest(readFileSync(specFile, 'utf8'));
  const rawDiff = diffText !== null ? String(diffText) : gitDiff(project, baseRef, headRef);
  const diffDigest = digest(rawDiff);
  const risks = scanDiffRisks(rawDiff);
  const escalation = requiresHumanReview(spec);
  const filterSet = Array.isArray(requirementIds) && requirementIds.length > 0 ? new Set(requirementIds) : null;
  const governing = (spec.requirements ?? [])
    .filter((r) => !filterSet || filterSet.has(r.id))
    .map((r) => ({
      id: r.id,
      key: r.key,
      area: r.area,
      title: r.title,
      statement: r.statement,
      failurePath: r.failurePath ?? null,
      acceptance: r.acceptance ?? [],
      verify: r.verify
    }));

  const bundleBody = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    contextIsolated: true,
    authorTranscriptIncluded: false,
    authorId,
    baseRef,
    headRef,
    packetDigest,
    diffDigest,
    humanEscalation: escalation,
    diffRisks: risks,
    categoriesRequired: [...REVIEW_CATEGORIES],
    requirements: governing
  };
  return { ...bundleBody, reviewPacketDigest: digest(bundleBody), diff: rawDiff.slice(0, 65_536) };
}

/**
 * Validate an independent review report against `agent.review-protocol` rules.
 */
export function validateReviewReport(report, {
  knownRequirements = null,
  authorId = null,
  requireHumanEscalation = false,
  diffRisks = null
} = {}) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['review report must be an object'] };
  }
  if (report.schemaVersion !== REVIEW_SCHEMA_VERSION) {
    errors.push(`review report schemaVersion must be ${REVIEW_SCHEMA_VERSION}`);
  }
  if (!ID_PATTERN.test(String(report.reviewerId ?? ''))) {
    errors.push('reviewerId must be a valid lowercase kebab-case identifier');
  }
  if (!['agent', 'human'].includes(report.reviewerKind)) {
    errors.push('reviewerKind must be "agent" or "human"');
  }
  const effectiveAuthor = authorId ?? report.authorId ?? null;
  if (effectiveAuthor && report.reviewerId === effectiveAuthor) {
    errors.push(`self-review forbidden: reviewerId "${report.reviewerId}" matches authorId "${effectiveAuthor}"`);
  }
  if (report.sessionIsolated !== true) {
    errors.push('sessionIsolated must be true (reviewer must not share author session memory)');
  }
  if (!REVIEW_VERDICTS.includes(report.verdict)) {
    errors.push(`verdict must be one of: ${REVIEW_VERDICTS.join(', ')}`);
  }

  const known = Array.isArray(knownRequirements) ? new Set(knownRequirements) : null;
  let blockingFindings = 0;

  if (!report.categories || typeof report.categories !== 'object' || Array.isArray(report.categories)) {
    errors.push('categories must be an object listing all six mandatory review categories');
  } else {
    for (const category of REVIEW_CATEGORIES) {
      if (!(category in report.categories)) {
        errors.push(`categories.${category} is required (write "none" explicitly when clean)`);
        continue;
      }
      const value = report.categories[category];
      if (value === 'none') continue;
      if (!Array.isArray(value) || value.length === 0) {
        errors.push(`categories.${category} must be "none" or a non-empty list of spec-cited findings`);
        continue;
      }
      value.forEach((finding, idx) => {
        const prefix = `categories.${category}[${idx}]`;
        if (!finding || typeof finding !== 'object') {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!REQ_ID.test(String(finding.requirement ?? ''))) {
          errors.push(`${prefix}.requirement must cite a REQ-### or REQ-C## identifier`);
        } else if (known && !known.has(finding.requirement)) {
          errors.push(`${prefix}.requirement cites unknown requirement "${finding.requirement}"`);
        }
        if (typeof finding.file !== 'string' || !finding.file.trim()) {
          errors.push(`${prefix}.file is required`);
        }
        if (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
          errors.push(`${prefix}.line must be a positive integer when provided`);
        }
        if (!FINDING_SEVERITIES.includes(finding.severity)) {
          errors.push(`${prefix}.severity must be one of: ${FINDING_SEVERITIES.join(', ')}`);
        } else if (finding.severity === 'high' || finding.severity === 'critical') {
          blockingFindings += 1;
        }
        if (typeof finding.fix !== 'string' || finding.fix.trim().length < 5) {
          errors.push(`${prefix}.fix must state the smallest concrete remediation`);
        }
      });
    }
  }

  if (report.verdict === 'approved' && blockingFindings > 0) {
    errors.push(`cannot approve review with ${blockingFindings} high/critical finding(s)`);
  }

  if (diffRisks) {
    const unaddressedWeakening = (diffRisks.testWeakening?.length ?? 0) + (diffRisks.skippedTests?.length ?? 0) + (diffRisks.droppedAnchors?.length ?? 0);
    if (report.verdict === 'approved' && unaddressedWeakening > 0 && report.testWeakeningJustified !== true) {
      errors.push('cannot approve a diff that weakens, skips or drops test anchors without explicit justification');
    }
  }

  if (requireHumanEscalation && report.verdict === 'approved' && report.reviewerKind === 'agent') {
    const human = report.humanSignoff;
    if (!human || !ID_PATTERN.test(String(human.reviewerId ?? '')) || human.reviewerId === effectiveAuthor || human.reviewerId === report.reviewerId || typeof human.reason !== 'string' || human.reason.trim().length < 8) {
      errors.push('high-rigor packet requires independent humanSignoff ({ reviewerId, reason }) or verdict "escalated-to-human"');
    }
  }

  return { ok: errors.length === 0, errors, blockingFindings };
}

/** Validate, persist and append a review decision into the hash-chained evidence ledger. */
export function recordReviewDecision({
  projectDir = '.',
  packetDir = 'specs',
  report,
  diffRisks = null,
  outFile = null
} = {}) {
  const project = ensureProjectDir(projectDir);
  const specFile = path.resolve(project, packetDir, 'spec.json');
  if (!existsSync(specFile)) throw extensionError(`spec.json not found: ${specFile}`, 'PACKET_NOT_FOUND');
  const spec = JSON.parse(readFileSync(specFile, 'utf8'));
  const knownRequirements = (spec.requirements ?? []).map((r) => r.id);
  const escalation = requiresHumanReview(spec);
  const checked = validateReviewReport(report, {
    knownRequirements,
    authorId: report.authorId ?? null,
    requireHumanEscalation: escalation.required,
    diffRisks
  });
  if (!checked.ok) {
    throw extensionError(`review report rejected:\n${checked.errors.map((e) => `- ${e}`).join('\n')}`, 'INVALID_REVIEW_REPORT');
  }

  const stamped = {
    ...report,
    recordedAt: new Date().toISOString(),
    packetDigest: digest(readFileSync(specFile, 'utf8')),
    humanEscalationRequired: escalation.required
  };
  const persisted = { ...stamped, reviewDigest: digest(stamped) };
  const relOut = outFile ?? path.join('.vld', 'reviews', `review-${persisted.reviewDigest.slice(0, 16)}.json`);
  const absOut = path.resolve(project, relOut);
  if (absOut.startsWith('..') || !absOut.startsWith(project)) {
    throw extensionError('review output escapes project directory', 'INVALID_REVIEW_PATH');
  }
  mkdirSync(path.dirname(absOut), { recursive: true });
  writeFileSync(absOut, canonicalJson(persisted), 'utf8');

  const evidence = appendEvidence({
    projectDir: project,
    kind: 'review',
    actor: `${report.reviewerKind}:${report.reviewerId}`,
    subject: report.packageId ?? spec.project?.name ?? 'packet',
    payload: {
      verdict: report.verdict,
      reviewerKind: report.reviewerKind,
      reviewerId: report.reviewerId,
      humanSignoffId: report.humanSignoff?.reviewerId ?? null,
      packetDigest: persisted.packetDigest,
      reviewDigest: persisted.reviewDigest,
      blockingFindings: checked.blockingFindings,
      provenance: {
        modelId: report.reviewerModelId ?? null,
        promptHash: null,
        transcriptDigest: null,
        usage: report.usage ?? null
      }
    }
  });

  return {
    ok: true,
    file: absOut,
    review: persisted,
    evidenceHash: evidence.headHash
  };
}

/* -------------------------------------------------------------------------
 * P3.5 additions: reviewer/model identity, seeded-defect measurement.
 * ---------------------------------------------------------------------- */

/**
 * Normalize a `provider:model` identity ("openai:gpt-x"). Returns `null` when
 * the value is not a plausible model id.
 */
export function normalizeModelId(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 160) return null;
  const match = raw.match(/^([a-z0-9][a-z0-9._-]{0,60}):([a-z0-9][a-z0-9._/-]{0,100})$/i);
  if (!match) return null;
  return `${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
}

/** Extract the normalized model id from an agent policy (`VLD_MODEL_SPEC`). */
export function modelIdFromPolicy(policy) {
  return normalizeModelId(policy?.env?.VLD_MODEL_SPEC ?? policy?.environment?.VLD_MODEL_SPEC ?? '');
}

/** Count high/critical findings across the six report categories. */
export function blockingReportFindings(categories) {
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) return 0;
  let count = 0;
  for (const category of REVIEW_CATEGORIES) {
    const value = categories[category];
    if (!Array.isArray(value)) continue;
    for (const finding of value) {
      if (finding?.severity === 'high' || finding?.severity === 'critical') count += 1;
    }
  }
  return count;
}

/**
 * Seeded-defect diffs for measuring diff-risk sensitivity. Every seed embeds a
 * `@req` anchor so requirement citation is exercised alongside detection.
 */
export const SEEDED_DEFECTS = Object.freeze([
  {
    kind: 'weakened-assertion',
    diff: [
      '+++ b/tests/invoice.test.ts',
      ' test(\'marks an overdue invoice\', () => {',
      '-  assert.equal(list.filter((i) => i.overdue).length, 1);',
      '+  assert.ok(list.list()[0].overdue);',
      ' });'
    ].join('\n')
  },
  {
    kind: 'weakened-assertion',
    diff: [
      '+++ b/tests/total.test.ts',
      '-  assert.equal(computeTotal(cart), 4250);',
      '+  assert.ok(true);'
    ].join('\n')
  },
  {
    kind: 'deleted-test',
    diff: [
      '+++ b/tests/refund.test.ts',
      '-  // @req REQ-402', // @req-ignore (template example emitted into generated user tests)
      '-  test(\'refuses refunds above the cap\', () => {',
      '-    assert.equal(refund(order, 10_000), REFUSED);',
      '-    assert.equal(audit.entries().length, 1);',
      '-  });',
      '-  test(\'rolls back a failed refund\', () => {',
      '-    assert.equal(rollback(refundJob), ROLLED_BACK);',
      '-  });'
    ].join('\n')
  },
  {
    kind: 'skipped-test',
    diff: [
      '+++ b/tests/signature.test.ts',
      '+  // TODO re-enable after the migration',
      "+  test.skip('verifies signatures', () => {",
      '   assert.equal(verifySig(payload, sig), true);',
      '  });'
    ].join('\n')
  },
  {
    kind: 'skipped-test',
    diff: [
      '+++ b/tests/test_e2e.py',
      '+  @pytest.mark.skip(reason="flaky under load")',
      '  def test_checkout_happy_path():',
      '      assert checkout(cart) == "ok"'
    ].join('\n')
  },
  {
    kind: 'deleted-test',
    diff: [
      '+++ b/tests/audit.test.ts',
      '-  test(\'writes an audit entry on deny\', () => {',
      '-    assert.equal(audit.entries().length, 1);',
      '-    assert.equal(audit.entries()[0].action, "deny");',
      '-  });'
    ].join('\n')
  },
  {
    kind: 'new-dependency',
    diff: [
      '+++ b/package.json',
      '+    "node-serialize": "0.0.4",',
      '+    "left-pad": "1.3.0"'
    ].join('\n')
  },
  {
    kind: 'new-dependency',
    diff: [
      '+++ b/requirements.txt',
      '+pickle-mixin==1.0'
    ].join('\n')
  },
  {
    kind: 'new-env-read',
    diff: [
      '+++ b/src/billing/charge.ts',
      '+  const masterKey = process.env.PAYMENTS_MASTER_KEY;'
    ].join('\n')
  },
  {
    kind: 'new-env-read',
    diff: [
      '+++ b/src/debug.py',
      '+  debug = os.environ.get("ADMIN_DEBUG")'
    ].join('\n')
  }
]);

const SEED_CATCH_GROUPS = Object.freeze({
  'weakened-assertion': (r) => r.testWeakening.length > 0,
  'deleted-test': (r) => r.testWeakening.length > 0,
  'skipped-test': (r) => r.skippedTests.length > 0,
  'new-dependency': (r) => r.manifestChanges.length > 0,
  'new-env-read': (r) => r.newEnvVars.length > 0
});

/**
 * Measure diff-risk scanner sensitivity over the seeded-defect corpus.
 * Acceptance (roadmap P3.5): seeded defects caught >= 80%.
 */
export function measureDiffRiskSensitivity(defects = SEEDED_DEFECTS) {
  const results = defects.map((defect) => {
    const risks = scanDiffRisks(defect.diff);
    const caught = (SEED_CATCH_GROUPS[defect.kind] ?? (() => false))(risks);
    return { kind: defect.kind, caught };
  });
  const caught = results.filter((r) => r.caught).length;
  return {
    total: results.length,
    caught,
    ratio: results.length ? caught / results.length : 1,
    results
  };
}
