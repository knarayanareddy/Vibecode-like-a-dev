/**
 * Custom business-rule compilation (roadmap 1.4, F-04).
 *
 * Authors may declare product-specific obligations in `profile.rules` in three forms:
 *   1. String shorthand:
 *        "Refunds over $500 require dual approval before disbursement."
 *      Compiled into a first-class requirement (`REQ-C01`, key `custom.<slug>`,
 *      origin `profile`) with a valid EARS statement, failure path and testable
 *      acceptance criteria.
 *   2. Structured custom requirement object (no `covers`):
 *        { slug?, title?, text, statement?, failurePath?, acceptance?, area?, verify?, why? }
 *      Compiled into a first-class `REQ-Cxx` requirement keyed by `custom.<slug>`.
 *   3. Coverage pin / criterion extension (has `covers`):
 *        { text, covers: "REQ-008" | "payments.correctness", appendCriterion?: true, acceptance?: [...] }
 *      Pins the rule to the named requirement and, when `appendCriterion` or
 *      `acceptance` is supplied, appends Given/When/Then criteria onto that
 *      requirement so the rule is enforced inside the packet.
 *
 * IDs use the `REQ-C01` namespace, separate from catalog `REQ-001` IDs, and stay
 * stable by `custom.<slug>` across recompiles and rule reordering.
 */

import { earsError } from './ears.mjs';

const AREA_KEYWORDS = [
  ['security', /\b(?:auth|permission|role|tenant|clinic|school|encrypt|secret|token|consent|approv|access|deny|forbid|isolat|redact|audit)\b/i],
  ['data', /\b(?:database|record|store|storage|retain|retention|delet|eras|purge|backup|migrat|ledger|balance|reconcil|immutable|append-only|period)\b/i],
  ['api', /\b(?:endpoint|request|response|webhook|payload|header|idempoten|rate[- ]limit|timeout|status code|schema|contract)\b/i],
  ['frontend', /\b(?:screen|page|button|form|modal|keyboard|focus|contrast|aria|display|banner|ui)\b/i],
  ['ai', /\b(?:model|prompt|agent|tool call|allowlist|hallucin|inference|kill[- ]switch|token budget)\b/i],
  ['reliability', /\b(?:retry|retries|queue|dead[- ]letter|alert|incident|sla|slo|failover|latency|schedule|nightly|within \d+)\b/i]
];

const SLUG_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'while', 'where',
  'must', 'shall', 'never', 'always', 'only', 'every', 'each', 'cannot', 'have', 'been',
  'application', 'system', 'service', 'product', 'before', 'after', 'than', 'over', 'under'
]);

export function ruleSlug(input) {
  if (input && typeof input === 'object' && typeof input.slug === 'string' && input.slug.trim()) {
    return input.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }
  const source = typeof input === 'string' ? input : String(input?.title ?? input?.text ?? '');
  const tokens = source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 3 && !SLUG_STOP.has(tok));
  const picked = (tokens.length > 0 ? tokens : source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)).slice(0, 5);
  return (picked.join('-') || 'rule').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export function inferRuleArea(text, explicitArea = null) {
  if (explicitArea && ['core', 'data', 'security', 'frontend', 'api', 'reliability', 'ai'].includes(explicitArea)) {
    return explicitArea;
  }
  for (const [area, re] of AREA_KEYWORDS) {
    if (re.test(text)) return area;
  }
  return 'core';
}

function cleanSentence(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

function makeTitle(rule, text) {
  if (rule && typeof rule === 'object' && typeof rule.title === 'string' && rule.title.trim()) {
    return rule.title.trim();
  }
  const clean = cleanSentence(text);
  if (clean.length <= 72) return clean.charAt(0).toUpperCase() + clean.slice(1);
  const clipped = clean.slice(0, 69).replace(/\s+\S*$/, '');
  return `${clipped.charAt(0).toUpperCase()}${clipped.slice(1)}`;
}

/**
 * Convert free-form business-rule prose into a guaranteed-valid EARS `shall`
 * statement without losing the rule's exact thresholds or prohibitions.
 */
export function toEarsStatement(text, explicitStatement = null) {
  if (explicitStatement && typeof explicitStatement === 'string' && !earsError(explicitStatement.trim())) {
    return explicitStatement.trim();
  }
  const raw = cleanSentence(text);
  // Already valid EARS?
  if (!earsError(`${raw}.`)) return `${raw}.`;

  // Rewrite common modal patterns cleanly into "the application shall ...".
  const conditional = raw.match(/^(when|if|while|where)\s+([^,]+),\s*(.+)$/i);
  if (conditional) {
    const [, keyword, trigger, rest] = conditional;
    const normalizedRest = rest
      .replace(/\bmust not\b/i, 'shall not')
      .replace(/\bcannot\b|\bcan never\b/i, 'shall never')
      .replace(/\bmust\b/i, 'shall');
    const candidate = /\bshall\b/i.test(normalizedRest)
      ? `${keyword.charAt(0).toUpperCase()}${keyword.slice(1).toLowerCase()} ${trigger}, ${normalizedRest}.`
      : `${keyword.charAt(0).toUpperCase()}${keyword.slice(1).toLowerCase()} ${trigger}, the application shall enforce that ${rest}.`;
    if (!earsError(candidate)) return candidate;
  }

  const replaced = raw
    .replace(/\bmust not\b/i, 'shall not')
    .replace(/\bmay not\b/i, 'shall not')
    .replace(/\bcannot\b|\bcan never\b/i, 'shall never')
    .replace(/\bmust\b/i, 'shall');
  if (/\bshall\b/i.test(replaced)) {
    const asIs = `${replaced.charAt(0).toUpperCase()}${replaced.slice(1)}.`;
    if (!earsError(asIs)) return asIs;
    const withArticle = `The ${replaced.charAt(0).toLowerCase()}${replaced.slice(1)}.`;
    if (!earsError(withArticle)) return withArticle;
  }

  const lowered = (raw.charAt(0).toLowerCase() + raw.slice(1)).replace(/\bshall\b/gi, 'must');
  return `When evaluating domain rules, the application shall enforce that ${lowered}.`;
}

export function defaultCriterionForRule(text) {
  const clean = cleanSentence(text);
  const lowered = clean.charAt(0).toLowerCase() + clean.slice(1);
  if (/\b(?:must not|shall not|never|cannot|forbid|prohibit|reject|refuse|deny|block)\b/i.test(clean)) {
    return `Given an input or action that violates "${clean}", when the operation is attempted, then the application rejects it with a typed error and performs no state change.`;
  }
  return `Given an operation governed by the rule that ${lowered}, when executed on both compliant and violating inputs, then compliant inputs succeed and violating inputs are rejected.`;
}

function allocateCustomIds(entries, previousIds = {}) {
  const used = new Set();
  const assigned = new Map();

  // First preserve any prior REQ-Cxx assigned to the same custom.<slug> key.
  for (const entry of entries) {
    const prev = previousIds[entry.key];
    if (typeof prev === 'string' && /^REQ-C\d{2,}$/.test(prev) && !used.has(prev)) {
      assigned.set(entry.key, prev);
      used.add(prev);
    }
  }

  // Allocate remaining entries in deterministic slug order so reordering rules
  // inside profile.rules does not churn custom requirement IDs.
  let counter = 1;
  for (const id of Object.values(previousIds)) {
    const match = String(id).match(/^REQ-C(\d{2,})$/);
    if (match) counter = Math.max(counter, Number(match[1]) + 1);
  }
  const sortedRemaining = entries
    .filter((entry) => !assigned.has(entry.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const entry of sortedRemaining) {
    let candidate = `REQ-C${String(counter).padStart(2, '0')}`;
    while (used.has(candidate)) {
      counter += 1;
      candidate = `REQ-C${String(counter).padStart(2, '0')}`;
    }
    assigned.set(entry.key, candidate);
    used.add(candidate);
    counter += 1;
  }
  return assigned;
}

/**
 * Compile `profile.rules` against the catalog/overlay requirements selected for a plan.
 */
export function compileProfileRules(profile, baseRequirements, previousIds = {}) {
  const rawRules = Array.isArray(profile?.rules) ? profile.rules : [];
  if (rawRules.length === 0) {
    return { requirements: baseRequirements, customRequirements: [], pins: [] };
  }

  const requirements = baseRequirements.map((req) => ({
    ...req,
    acceptance: Array.isArray(req.acceptance) ? [...req.acceptance] : []
  }));
  const pins = [];
  const pendingCustom = [];
  const seenKeys = new Set(requirements.map((req) => req.key));

  for (const entry of rawRules) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (!text) continue;
      let slug = ruleSlug(text);
      let key = `custom.${slug}`;
      let suffix = 2;
      while (seenKeys.has(key)) {
        key = `custom.${slug}-${suffix}`;
        suffix += 1;
      }
      seenKeys.add(key);
      pendingCustom.push({ key, slug, raw: { text }, text });
      continue;
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const text = String(entry.text ?? entry.statement ?? '').trim();
    if (!text) continue;

    if (entry.covers) {
      const target = requirements.find((req) => req.id === entry.covers || req.key === entry.covers);
      const extraCriteria = Array.isArray(entry.acceptance) && entry.acceptance.length > 0
        ? entry.acceptance.map((c) => String(c).trim()).filter(Boolean)
        : entry.appendCriterion
          ? [defaultCriterionForRule(text)]
          : [];
      if (target && extraCriteria.length > 0) {
        for (const criterionText of extraCriteria) {
          if (target.acceptance.some((existing) => existing.text === criterionText)) continue;
          const nextNum = target.acceptance.length + 1;
          target.acceptance.push({
            id: `AC-${String(nextNum).padStart(2, '0')}`,
            text: criterionText
          });
        }
      }
      pins.push({ text, covers: target ? target.id : entry.covers, why: entry.why ?? 'pinned by the author in profile.rules' });
      continue;
    }

    let slug = ruleSlug(entry);
    let key = entry.key && /^custom\.[a-z0-9-]+$/.test(entry.key) ? entry.key : `custom.${slug}`;
    let suffix = 2;
    while (seenKeys.has(key)) {
      key = `custom.${slug}-${suffix}`;
      suffix += 1;
    }
    seenKeys.add(key);
    pendingCustom.push({ key, slug, raw: entry, text });
  }

  const idMap = allocateCustomIds(pendingCustom, previousIds);
  const customRequirements = pendingCustom.map(({ key, raw, text }) => {
    const id = idMap.get(key);
    const area = inferRuleArea(text, raw.area ?? null);
    const statement = toEarsStatement(text, raw.statement ?? null);
    const failurePath =
      typeof raw.failurePath === 'string' && raw.failurePath.trim().length >= 10
        ? raw.failurePath.trim()
        : 'If a request or state transition violates this rule, the application rejects it with a typed domain error and leaves persisted state unchanged.';
    const rawAcceptance =
      Array.isArray(raw.acceptance) && raw.acceptance.length > 0
        ? raw.acceptance.map((c) => (typeof c === 'string' ? c.trim() : String(c?.text ?? '').trim())).filter(Boolean)
        : [defaultCriterionForRule(text)];
    const acceptance = rawAcceptance.map((criterion, idx) => ({
      id: `AC-${String(idx + 1).padStart(2, '0')}`,
      text: criterion
    }));
    const req = {
      id,
      key,
      render: area,
      area,
      title: makeTitle(raw, text),
      statement,
      definition: cleanSentence(text) + '.',
      failurePath,
      acceptance,
      verify: raw.verify && ['automated', 'manual', 'gate'].includes(raw.verify) ? raw.verify : 'automated',
      origin: 'profile',
      traits: [],
      why: raw.why ? String(raw.why).trim() : 'declared in profile.rules',
      sourceRule: text
    };
    pins.push({ text, covers: id, why: 'compiled from profile.rules' });
    return req;
  });

  // Order custom requirements by their assigned REQ-Cxx ID so spec.json stays crisp.
  customRequirements.sort((a, b) => a.id.localeCompare(b.id));
  return {
    requirements: [...requirements, ...customRequirements],
    customRequirements,
    pins
  };
}
