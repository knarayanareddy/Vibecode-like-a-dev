/**
 * Bounded verification-failure diagnosis and autonomous repair loop
 * (ADR 0011, roadmap 2.5).
 *
 * Parses `spec-check`, gate-runner and sandboxed test failures into typed,
 * secret-redacted diagnostic findings keyed by requirement (`REQ-xxx` /
 * `REQ-Cxx`) and gate (`G0-*`..`G3-*`), builds a minimal targeted repair brief,
 * and drives bounded verify -> repair -> re-verify iterations with automatic
 * stall and non-retryable safety exits.
 */

import { redactAgentOutput } from './agent-adapters.mjs';
import { digest, extensionError } from './extension-utils.mjs';

export const FAILURE_KINDS = Object.freeze([
  'missing-anchor',
  'hollow-test',
  'unknown-anchor',
  'gate-failure',
  'test-failure',
  'packet-error',
  'resource-claim-violation',
  'sandbox-violation',
  'timeout'
]);

const NON_RETRYABLE_KINDS = new Set(['sandbox-violation']);
const REQ_RE = /\bREQ-(?:C\d{2,}|\d{3,})\b/g;
const GATE_RE = /\bG[0-3]-[A-Z0-9-]+\b/g;

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Classify a composite verification result (`{ ok, drift, gates, tests, resourceClaims, sandboxOutcome }`)
 * into structured, secret-redacted failure items and a deterministic `failureDigest`.
 */
export function classifyVerificationFailures(verification = {}) {
  const failures = [];
  const add = (kind, target, detail) => {
    failures.push({
      kind,
      target: target ?? 'workspace',
      retryable: !NON_RETRYABLE_KINDS.has(kind),
      detail: redactAgentOutput(detail).slice(0, 320)
    });
  };

  if (verification.sandboxOutcome === 'violation') {
    add('sandbox-violation', 'sandbox', verification.sandboxDetail ?? 'sandbox security boundary rejected the run');
  } else if (verification.sandboxOutcome === 'timed-out') {
    add('timeout', 'sandbox', verification.sandboxDetail ?? 'execution exceeded the declared duration limit');
  }

  if (Array.isArray(verification.resourceClaimViolations)) {
    for (const rel of verification.resourceClaimViolations) {
      add('resource-claim-violation', rel, `modified file "${rel}" lies outside package resourceClaims`);
    }
  }

  // Drift-guard (`spec-check` / `verifyPacket`) structured findings or stdout lines
  const driftLines = [
    ...(verification.drift?.errors ?? []),
    ...(verification.drift?.pending ?? []),
    ...String(verification.drift?.stdout ?? '').split(/\r?\n/).filter((line) => /^\s*[✗!·]/.test(line))
  ];
  for (const raw of driftLines) {
    const line = String(raw).trim();
    if (!line) continue;
    const reqs = line.match(REQ_RE) ?? [];
    const target = reqs[0] ?? 'packet';
    if (/cites unknown requirement/i.test(line)) {
      add('unknown-anchor', target, line);
    } else if (/no assertion|hollow|assert nothing|without an assertion|does not import/i.test(line)) {
      add('hollow-test', target, line);
    } else if (/no test anchor|not anchored|missing.*anchor|unanchored|pending|not marked done|no @req/i.test(line) || (reqs.length > 0 && /no test|missing/i.test(line))) {
      add('missing-anchor', target, line);
    } else if (/✗/.test(line) || (verification.drift?.errors ?? []).includes(raw)) {
      add(reqs.length > 0 ? 'missing-anchor' : 'packet-error', target, line);
    }
  }

  // Gate-runner structured findings or stdout lines
  const gateLines = [
    ...(verification.gates?.failures ?? []),
    ...String(verification.gates?.stdout ?? '').split(/\r?\n/).filter((line) => /^\s*[✗!]/.test(line))
  ];
  for (const raw of gateLines) {
    const line = String(raw).trim();
    if (!line) continue;
    const gates = line.match(GATE_RE) ?? [];
    add('gate-failure', gates[0] ?? 'gates', line);
  }

  // Sandboxed unit/integration test runner failures
  if (verification.tests && verification.tests.ok === false) {
    if (verification.tests.outcome === 'timed-out') {
      add('timeout', 'tests', 'test suite exceeded declared sandbox timeout');
    } else {
      const output = `${verification.tests.stdout ?? ''}\n${verification.tests.stderr ?? ''}`;
      const failingLines = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^(?:not ok\b|FAIL\b|FAILED\b|✗|AssertionError|Error:)/.test(l))
        .slice(0, 8);
      if (failingLines.length === 0) {
        add('test-failure', 'tests', `test command exited with code ${verification.tests.exitCode ?? 1}`);
      } else {
        for (const line of failingLines) {
          const reqs = line.match(REQ_RE) ?? [];
          add('test-failure', reqs[0] ?? 'tests', line);
        }
      }
    }
  }

  // Deduplicate identical (kind, target, detail) tuples while preserving deterministic order.
  const deduped = [];
  const seen = new Set();
  for (const item of failures) {
    const key = `${item.kind}|${item.target}|${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  const failingRequirements = uniqueSorted(
    deduped.flatMap((f) => `${f.target} ${f.detail}`.match(REQ_RE) ?? [])
  );
  const failingGates = uniqueSorted(
    deduped.flatMap((f) => `${f.target} ${f.detail}`.match(GATE_RE) ?? [])
  );
  const retryable = deduped.length > 0 && deduped.every((f) => f.retryable);
  const failureDigest = digest(deduped.map((f) => ({ kind: f.kind, target: f.target, detail: f.detail })));

  return {
    ok: deduped.length === 0,
    retryable,
    failureDigest,
    failingRequirements,
    failingGates,
    failures: deduped
  };
}

const MAX_BRIEF_SECTION_CHARS = 2000;

function briefSection(text) {
  const value = String(text ?? '').trim();
  if (value.length <= MAX_BRIEF_SECTION_CHARS) return value;
  return `${value.slice(0, MAX_BRIEF_SECTION_CHARS)}\n… (truncated)`;
}

function extractFailingTestNames(diagnosis) {
  const names = [];
  for (const failure of diagnosis?.failures ?? []) {
    if (failure.kind !== 'test-failure') continue;
    const tap = /\bnot ok \d+ - (.+?)\s*$/.exec(failure.detail);
    const node = /^✖\s+(.+?)\s*$/.exec(failure.detail);
    if (tap) names.push(tap[1]);
    else if (node) names.push(node[1]);
    else names.push(failure.detail);
  }
  return [...new Set(names)];
}

/**
 * Render a concise, deterministic repair brief scoped strictly to the failing
 * requirements, gates and test assertions (no raw secrets or host paths).
 * Roadmap P3.4: the brief names the failing tests, carries the spec-check
 * findings and gate output, and shows what the previous attempt changed.
 */
export function buildRepairPrompt({ packageId, attempt, maxAttempts, diagnosis, requirements = [], verification = null, previousAttemptDiff = null }) {
  const reqMap = new Map(requirements.map((r) => [r.id, r]));
  const failingTests = extractFailingTestNames(diagnosis);
  const specKinds = new Set(['missing-anchor', 'hollow-test', 'unknown-anchor', 'packet-error']);
  const specFindings = diagnosis.failures.filter((failure) => specKinds.has(failure.kind));
  const gateFindings = diagnosis.failures.filter((failure) => failure.kind === 'gate-failure');
  const gateOutputLines = String(verification?.gates?.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-30)
    .join('\n');
  const lines = [
    `# Repair Brief · ${packageId} · attempt ${attempt}/${maxAttempts}`,
    '',
    `Failure signature: ${diagnosis.failureDigest.slice(0, 16)} (${diagnosis.failures.length} finding(s))`,
    '',
    '## Failing tests',
    failingTests.length > 0
      ? failingTests.slice(0, 16).map((name) => `- ${name}`).join('\n')
      : '- (test output names no specific failing test)',
    '',
    '## Spec-check findings',
    specFindings.length > 0
      ? specFindings.slice(0, 16).map((item) => `- [${item.kind}] ${item.target}: ${briefSection(item.detail)}`).join('\n')
      : '- (spec-check reports no drift findings)',
    '',
    '## Gate output',
    gateFindings.length > 0
      ? gateFindings.slice(0, 16).map((item) => `- [${item.kind}] ${item.target}: ${briefSection(item.detail)}`).join('\n')
      : '- (no failing gates)',
    ...(gateOutputLines ? ['', briefSection(redactAgentOutput(gateOutputLines))] : []),
    '',
    '## Changes since the previous attempt',
    previousAttemptDiff ? briefSection(redactAgentOutput(previousAttemptDiff)) : '- (no previous attempt)',
    '',
    '## Findings to resolve'
  ];
  for (const item of diagnosis.failures.slice(0, 16)) {
    lines.push(`- [${item.kind}] ${item.target}: ${item.detail}`);
  }
  const relevantReqs = diagnosis.failingRequirements
    .map((id) => reqMap.get(id))
    .filter(Boolean);
  if (relevantReqs.length > 0) {
    lines.push('', '## Governing requirements');
    for (const req of relevantReqs) {
      lines.push(`- ${req.id} (${req.title}): ${req.statement}`);
      if (req.failurePath) lines.push(`  Failure path: ${req.failurePath}`);
    }
  }
  lines.push(
    '',
    '## Constraints',
    '- Modify only files inside the work package resourceClaims.',
    '- Anchor automated requirements in real tests that import product code and execute assertions.',
    '- Do not weaken, delete or skip existing tests or specification files.'
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Drive a bounded verify -> diagnose -> repair -> re-verify state machine.
 *
 * Halts immediately when:
 *   - verification passes (`outcome: "converged"` or `"passed-initial"`),
 *   - a non-retryable failure occurs (`outcome: "halted-non-retryable"`),
 *   - two consecutive attempts emit the exact same `failureDigest`
 *     (`outcome: "stuck"`, escalated for human review),
 *   - accumulated agent-run usage passes the package cost ceiling
 *     (`outcome: "cost-ceiling"`, escalated),
 *   - `budgetMs` is exhausted (`outcome: "budget-exhausted"`), or
 *   - `maxRepairs` repairs have run without convergence (`outcome: "exhausted"`).
 */
export async function runRepairLoop({
  packageId,
  requirements = [],
  maxRepairs = 2,
  budgetMs = 5 * 60 * 1_000,
  budget = null,
  initialUsage = null,
  verify,
  repair
} = {}) {
  if (typeof verify !== 'function') throw extensionError('repair loop requires a verify callback', 'INVALID_REPAIR_CONFIG');
  if (typeof repair !== 'function') throw extensionError('repair loop requires a repair callback', 'INVALID_REPAIR_CONFIG');
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) {
    throw extensionError('maxRepairs must be an integer from 0 to 5', 'INVALID_REPAIR_CONFIG');
  }

  const startedMs = Date.now();
  const ledger = [];
  // Package cost ceiling (roadmap P3.4): agent-run receipts (initial run plus
  // every repair attempt) accumulate against the package budget.
  const spent = {
    tokens: Number(initialUsage?.totalTokens) || 0,
    costUsd: Number(initialUsage?.costUsd) || 0
  };
  const overCeiling = () =>
    (budget?.maxTokens !== undefined && spent.tokens > budget.maxTokens) ||
    (budget?.maxCostUsd !== undefined && spent.costUsd > budget.maxCostUsd);

  let currentVerification = await verify({ attempt: 0 });
  let currentDiagnosis = currentVerification.ok
    ? { ok: true, retryable: false, failureDigest: digest([]), failingRequirements: [], failingGates: [], failures: [] }
    : classifyVerificationFailures(currentVerification);

  ledger.push({
    attempt: 0,
    phase: 'initial-verify',
    passed: Boolean(currentVerification.ok && currentDiagnosis.ok),
    failureDigest: currentDiagnosis.failureDigest,
    failureCount: currentDiagnosis.failures.length,
    failingRequirements: currentDiagnosis.failingRequirements,
    failingGates: currentDiagnosis.failingGates,
    failures: currentDiagnosis.failures
  });

  if (currentVerification.ok && currentDiagnosis.ok) {
    return {
      ok: true,
      outcome: 'passed-initial',
      repairsUsed: 0,
      maxRepairs,
      durationMs: Math.max(0, Date.now() - startedMs),
      ledger,
      ledgerDigest: digest(ledger),
      finalVerification: currentVerification
    };
  }

  let previousDigest = currentDiagnosis.failureDigest;
  let previousAttemptDelta = null;

  for (let repairIndex = 1; repairIndex <= maxRepairs; repairIndex += 1) {
    if (!currentDiagnosis.retryable) {
      return {
        ok: false,
        outcome: 'halted-non-retryable',
        repairsUsed: repairIndex - 1,
        maxRepairs,
        durationMs: Math.max(0, Date.now() - startedMs),
        ledger,
        ledgerDigest: digest(ledger),
        usage: { totalTokens: spent.tokens, costUsd: spent.costUsd },
        finalVerification: currentVerification
      };
    }
    if (Date.now() - startedMs >= budgetMs) {
      return {
        ok: false,
        outcome: 'budget-exhausted',
        repairsUsed: repairIndex - 1,
        maxRepairs,
        durationMs: Math.max(0, Date.now() - startedMs),
        ledger,
        ledgerDigest: digest(ledger),
        usage: { totalTokens: spent.tokens, costUsd: spent.costUsd },
        finalVerification: currentVerification
      };
    }
    if (overCeiling()) {
      return {
        ok: false,
        outcome: 'cost-ceiling',
        escalated: true,
        repairsUsed: repairIndex - 1,
        maxRepairs,
        durationMs: Math.max(0, Date.now() - startedMs),
        ledger,
        ledgerDigest: digest(ledger),
        usage: { totalTokens: spent.tokens, costUsd: spent.costUsd },
        finalVerification: currentVerification
      };
    }

    const prompt = buildRepairPrompt({
      packageId,
      attempt: repairIndex,
      maxAttempts: maxRepairs,
      diagnosis: currentDiagnosis,
      requirements,
      verification: currentVerification,
      previousAttemptDiff: previousAttemptDelta
    });
    const promptDigest = digest(prompt);
    const repairResult = await repair({
      attempt: repairIndex,
      prompt,
      promptDigest,
      diagnosis: currentDiagnosis
    });
    spent.tokens += Number(repairResult?.usage?.totalTokens) || 0;
    spent.costUsd += Number(repairResult?.usage?.costUsd) || 0;
    previousAttemptDelta = repairResult?.diffSinceLastAttempt ?? null;

    currentVerification = await verify({ attempt: repairIndex });
    currentDiagnosis = currentVerification.ok
      ? { ok: true, retryable: false, failureDigest: digest([]), failingRequirements: [], failingGates: [], failures: [] }
      : classifyVerificationFailures(currentVerification);

    ledger.push({
      attempt: repairIndex,
      phase: 'repair-and-verify',
      promptDigest,
      sandboxReceiptDigest: repairResult?.sandboxReceipt?.receiptDigest ?? repairResult?.receiptDigest ?? null,
      passed: Boolean(currentVerification.ok && currentDiagnosis.ok),
      failureDigest: currentDiagnosis.failureDigest,
      failureCount: currentDiagnosis.failures.length,
      failingRequirements: currentDiagnosis.failingRequirements,
      failingGates: currentDiagnosis.failingGates,
      failures: currentDiagnosis.failures
    });

    if (currentVerification.ok && currentDiagnosis.ok) {
      return {
        ok: true,
        outcome: 'converged',
        repairsUsed: repairIndex,
        maxRepairs,
        durationMs: Math.max(0, Date.now() - startedMs),
        ledger,
        ledgerDigest: digest(ledger),
        usage: { totalTokens: spent.tokens, costUsd: spent.costUsd },
        finalVerification: currentVerification
      };
    }

    if (currentDiagnosis.failureDigest === previousDigest) {
      return {
        ok: false,
        outcome: 'stuck',
        escalated: true,
        repairsUsed: repairIndex,
        maxRepairs,
        durationMs: Math.max(0, Date.now() - startedMs),
        ledger,
        ledgerDigest: digest(ledger),
        usage: { totalTokens: spent.tokens, costUsd: spent.costUsd },
        finalVerification: currentVerification
      };
    }
    previousDigest = currentDiagnosis.failureDigest;
  }

  return {
    ok: false,
    outcome: 'exhausted',
    repairsUsed: maxRepairs,
    maxRepairs,
    durationMs: Math.max(0, Date.now() - startedMs),
    ledger,
    ledgerDigest: digest(ledger),
    usage: { totalTokens: spent.tokens, costUsd: spent.costUsd },
    finalVerification: currentVerification
  };
}
