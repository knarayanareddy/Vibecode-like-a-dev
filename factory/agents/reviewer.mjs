/**
 * P3.5 reviewer agent: an independent second reader that turns a review packet
 * into an ADR-0012 six-category review report with requirement-cited findings.
 *
 * Two modes:
 *   - rules (`provider = 'rules'`, reviewer model `rules:diff-risk-v1`): a
 *     deterministic diff-risk reviewer that converts the packet's static scan
 *     (weakened assertions, deleted tests, skipped tests, dropped @req anchors,
 *     new dependencies, new environment reads) into category findings.
 *   - model (`provider = 'openai' | 'anthropic'`): one `complete` call through
 *     the model broker returns candidate findings as JSON; every finding is
 *     schema-checked and invalid ones are dropped to `warnings`, never trusted.
 *
 * The verdict is always computed from the findings and the packet's escalation
 * flags — never negotiated with the model. The agent shares NO session memory
 * with the implementer: it only sees the prepared packet.
 */

import { createModelClient } from '../lib/model-client.mjs';
import {
  blockingReportFindings,
  measureDiffRiskSensitivity,
  normalizeModelId,
  REVIEW_CATEGORIES,
  REVIEW_SCHEMA_VERSION,
  validateReviewReport
} from '../lib/review.mjs';

export const RULES_REVIEWER_MODEL_ID = 'rules:diff-risk-v1';
export const REVIEWER_TRANSCRIPT_NAME = 'reviewer-transcript.json';

const REQ_TOKEN = /@req\s+(REQ-(?:C\d{2,}|\d{3,}))\b/g;
const FINDING_KEYS = new Set(['requirement', 'file', 'line', 'severity', 'summary', 'fix']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const REQ_ID = /^REQ-(?:C\d{2,}|\d{3,})$/;

function cleanCategories() {
  return Object.fromEntries(REVIEW_CATEGORIES.map((category) => [category, 'none']));
}

function withFinding(categories, category, finding) {
  const current = categories[category];
  categories[category] = current === 'none' ? [finding] : [...current, finding];
}

/** Map each diff file to the `@req` tokens appearing in its unified-diff section. */
function requirementTokensByFile(diff) {
  const byFile = new Map();
  let current = null;
  for (const line of String(diff ?? '').split(/\r?\n/)) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      current = header[1];
      if (!byFile.has(current)) byFile.set(current, new Set());
      continue;
    }
    if (!current) continue;
    for (const match of line.matchAll(REQ_TOKEN)) byFile.get(current).add(match[1]);
  }
  return byFile;
}

function requirementFor(file, { byFile, packet }) {
  const local = byFile.get(file);
  if (local && local.size > 0) return [...local][0];
  for (const tokens of byFile.values()) {
    if (tokens.size > 0) return [...tokens][0];
  }
  return packet?.requirements?.[0]?.id ?? null;
}

/**
 * Convert the packet's static diff-risk signals into six-category findings.
 * Every finding cites a requirement (dropped anchors cite the dropped id
 * directly; others cite an `@req` token found in the same diff section).
 */
export function riskSignalsToFindings(diffRisks, { diff = '', packet = null } = {}) {
  const byFile = requirementTokensByFile(diff);
  const categories = cleanCategories();
  const warnings = [];
  const cite = (file) => {
    const requirement = requirementFor(file, { byFile, packet });
    if (!requirement) warnings.push(`no requirement citation available for ${file}; finding skipped`);
    return requirement;
  };

  for (const entry of diffRisks?.testWeakening ?? []) {
    const requirement = cite(entry.file);
    if (!requirement) continue;
    withFinding(categories, 'assertionStrength', {
      requirement,
      file: entry.file,
      severity: 'high',
      summary: `Test assertions weakened: ${entry.detail}`,
      fix: 'Restore the removed strict assertions, or mark the weakening as explicitly justified in the review report.'
    });
  }
  for (const entry of diffRisks?.skippedTests ?? []) {
    const requirement = cite(entry.file);
    if (!requirement) continue;
    withFinding(categories, 'coverage', {
      requirement,
      file: entry.file,
      severity: 'high',
      summary: `Test execution skipped: ${String(entry.snippet ?? '').slice(0, 120)}`,
      fix: 'Re-enable the skipped test so the requirement stays proven by executed assertions.'
    });
  }
  for (const entry of diffRisks?.droppedAnchors ?? []) {
    withFinding(categories, 'coverage', {
      requirement: entry.requirement,
      file: entry.file,
      severity: 'high',
      summary: `@req ${entry.requirement} anchor removed without replacement`,
      fix: `Restore the @req ${entry.requirement} anchor on the test that proves it.`
    });
  }
  for (const file of diffRisks?.manifestChanges ?? []) {
    const requirement = cite(file);
    if (!requirement) continue;
    withFinding(categories, 'boundaries', {
      requirement,
      file,
      severity: 'medium',
      summary: `Dependency manifest ${file} changed`,
      fix: 'Confirm the dependency change is required and pinned; remove it otherwise.'
    });
  }
  for (const token of diffRisks?.newEnvVars ?? []) {
    const file = [...byFile.keys()].find((name) => String(diff).includes(token)) ?? [...byFile.keys()][0] ?? 'unknown';
    const requirement = cite(file);
    if (!requirement) continue;
    withFinding(categories, 'boundaries', {
      requirement,
      file,
      severity: 'medium',
      summary: `New environment read introduced: ${String(token).slice(0, 80)}`,
      fix: 'Confirm the environment read is allow-listed and documented; remove it otherwise.'
    });
  }
  return { categories, warnings };
}

/** Compute the verdict from the findings and escalation flags (never negotiated). */
export function verdictFor(categories, { humanEscalationRequired = false } = {}) {
  if (blockingReportFindings(categories) > 0) return 'changes-requested';
  if (humanEscalationRequired) return 'escalated-to-human';
  return 'approved';
}

function assembleReport({ reviewerId, categories, verdict, testWeakeningJustified = false }) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    reviewerId,
    reviewerKind: 'agent',
    sessionIsolated: true,
    verdict,
    categories,
    ...(testWeakeningJustified ? { testWeakeningJustified: true } : {})
  };
}

/** Prompt for model-backed review: the packet speaks; the author does not. */
export function buildReviewerPrompt(packet) {
  const requirementLines = (packet.requirements ?? [])
    .map((r) => `${r.id}: ${r.title}`)
    .join('\n')
    .slice(0, 4000);
  const categoryList = REVIEW_CATEGORIES.join(', ');
  return [
    'You are an independent code reviewer. You have never seen the author or their session.',
    'Review ONLY the requirements, diff and static risk signals in this packet.',
    '',
    `Required categories (all six, each "none" or a list of findings): ${categoryList}.`,
    'Each finding: { "requirement": "REQ-###", "file": "path", "line": optional integer, "severity": "low|medium|high|critical", "summary": "one line", "fix": "smallest concrete remediation" }.',
    'Every finding must cite a requirement from the packet. High or critical severity blocks delivery.',
    'Return strict JSON: { "categories": { ...six keys... }, "testWeakeningJustified": optional boolean }.',
    '',
    'Governing requirements:',
    requirementLines,
    '',
    'Static risk signals (JSON):',
    JSON.stringify(packet.diffRisks ?? {}).slice(0, 6000),
    '',
    'Unified diff:',
    String(packet.diff ?? '').slice(0, 24000)
  ].join('\n');
}

function parseFencedJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model reply did not contain a JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

function filterModelFindings(categories, warnings) {
  const cleaned = cleanCategories();
  for (const category of REVIEW_CATEGORIES) {
    const value = categories?.[category];
    if (value === undefined || value === 'none') continue;
    if (!Array.isArray(value)) {
      warnings.push(`model categories.${category} was not a list; treated as "none"`);
      continue;
    }
    for (const finding of value) {
      const ok = finding
        && typeof finding === 'object'
        && !Array.isArray(finding)
        && REQ_ID.test(String(finding.requirement ?? ''))
        && typeof finding.file === 'string' && finding.file.trim().length > 0 && finding.file.length <= 300
        && (finding.line === undefined || (Number.isSafeInteger(finding.line) && finding.line >= 1))
        && SEVERITIES.has(finding.severity)
        && (finding.summary === undefined || (typeof finding.summary === 'string' && finding.summary.length <= 400))
        && typeof finding.fix === 'string' && finding.fix.trim().length >= 5 && finding.fix.length <= 1000
        && Object.keys(finding).every((key) => FINDING_KEYS.has(key));
      if (!ok) {
        warnings.push(`model finding dropped: ${JSON.stringify(finding ?? null).slice(0, 160)}`);
        continue;
      }
      withFinding(cleaned, category, {
        requirement: finding.requirement,
        file: finding.file,
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        severity: finding.severity,
        ...(finding.summary !== undefined ? { summary: finding.summary } : {}),
        fix: finding.fix
      });
    }
  }
  return cleaned;
}

/**
 * Run the reviewer agent over a prepared review packet. Returns the validated
 * six-category report plus mode, reviewer model identity and usage.
 */
export async function runReviewerAgent({
  packet,
  provider = 'rules',
  model = null,
  env = process.env,
  transport = undefined,
  cassetteDir = null,
  cassetteMode = 'off',
  reviewerId = 'diff-risk-reviewer',
  maxTokens = 2048
} = {}) {
  const mode = provider === 'rules' || provider === null || provider === undefined ? 'rules' : 'model';
  const escalationRequired = Boolean(packet?.humanEscalation?.required);
  const rulesFindings = riskSignalsToFindings(packet?.diffRisks ?? {}, { diff: packet?.diff ?? '', packet });

  if (mode === 'rules') {
    const categories = rulesFindings.categories;
    const report = assembleReport({ reviewerId, categories, verdict: verdictFor(categories, { humanEscalationRequired: escalationRequired }) });
    const checked = validateReviewReport(report, {
      knownRequirements: (packet?.requirements ?? []).map((r) => r.id),
      requireHumanEscalation: escalationRequired,
      diffRisks: packet?.diffRisks ?? null
    });
    if (!checked.ok) throw new Error(`rules reviewer produced an invalid report: ${checked.errors.join('; ')}`);
    return {
      mode,
      reviewerModelId: RULES_REVIEWER_MODEL_ID,
      report,
      categories,
      verdict: report.verdict,
      blocking: checked.blockingFindings,
      usage: { totalTokens: 0, costUsd: 0 },
      warnings: [...rulesFindings.warnings, ...measureNote()],
      reportCheck: checked
    };
  }

  const reviewerModel = normalizeModelId(`${provider}:${model}`);
  if (!reviewerModel) throw new Error('model reviewer needs a provider and model (provider:model)');
  const client = createModelClient({
    provider,
    model,
    baseUrl: env?.VLD_MODEL_BASE_URL,
    cassetteDir,
    cassetteMode,
    env,
    ...(transport ? { transport } : {})
  });
  const completed = await client.complete({
    messages: [{ role: 'user', content: buildReviewerPrompt(packet) }],
    maxTokens
  });
  const warnings = [];
  let modelCategories = null;
  let justified = false;
  try {
    const parsed = parseFencedJson(completed.text);
    modelCategories = parsed?.categories ?? null;
    justified = parsed?.testWeakeningJustified === true;
  } catch (error) {
    warnings.push(`model reply could not be parsed (${error.message}); falling back to diff-risk rules`);
  }
  const categories = modelCategories ? filterModelFindings(modelCategories, warnings) : rulesFindings.categories;
  if (!modelCategories) warnings.push(...rulesFindings.warnings);
  const report = assembleReport({
    reviewerId,
    categories,
    verdict: verdictFor(categories, { humanEscalationRequired: escalationRequired }),
    testWeakeningJustified: justified
  });
  const checked = validateReviewReport(report, {
    knownRequirements: (packet?.requirements ?? []).map((r) => r.id),
    requireHumanEscalation: escalationRequired,
    diffRisks: packet?.diffRisks ?? null
  });
  if (!checked.ok) {
    warnings.push(`model findings rejected (${checked.errors[0]}); falling back to diff-risk rules`);
    const fallback = assembleReport({ reviewerId, categories: rulesFindings.categories, verdict: verdictFor(rulesFindings.categories, { humanEscalationRequired: escalationRequired }) });
    const fallbackCheck = validateReviewReport(fallback, {
      knownRequirements: (packet?.requirements ?? []).map((r) => r.id),
      requireHumanEscalation: escalationRequired,
      diffRisks: packet?.diffRisks ?? null
    });
    return {
      mode,
      reviewerModelId: reviewerModel,
      report: fallback,
      categories: rulesFindings.categories,
      verdict: fallback.verdict,
      blocking: fallbackCheck.blockingFindings,
      usage: completed.usage ?? { totalTokens: 0, costUsd: 0 },
      warnings: [...warnings, ...rulesFindings.warnings],
      reportCheck: fallbackCheck
    };
  }
  return {
    mode,
    reviewerModelId: reviewerModel,
    report,
    categories,
    verdict: report.verdict,
    blocking: checked.blockingFindings,
    usage: completed.usage ?? { totalTokens: 0, costUsd: 0 },
    warnings,
    reportCheck: checked
  };
}

function measureNote() {
  try {
    const measured = measureDiffRiskSensitivity();
    return measured.ratio >= 0.8 ? [] : [`diff-risk sensitivity ${measured.caught}/${measured.total} is below the 0.8 floor`];
  } catch {
    return [];
  }
}
