/**
 * Structured question elicitation & provenance recording (roadmap P1.5).
 *
 * Generates at most 7 high-impact, tier-ordered questions for a `profile.json`
 * or `profile.draft.json`, supports dependent follow-up questions (e.g. answering
 * `risks.regulated = true` unlocks `regulation`), and stamps user answers with
 * ISO timestamps and `provenance[field] = 'user' | 'waived'`.
 *
 * Pure module: shared across CLI, `vld intake`, MCP (`get_questions` / `answer`),
 * and Studio (`GET /api/questions`, `POST /api/answer`).
 */

import {
  defaultedProductionTierFields,
  getProfileProvenance,
  KINDS,
  normalizeProfile,
  REGULATIONS,
  RISK_FLAGS,
  SCALES,
  STAGES
} from './profile.mjs';
import { scanRiskHints } from './risk-hints.mjs';
import { lintRawRuleList } from './rule-lint.mjs';

export const MAX_ELICITATION_QUESTIONS = 7;

/** Tier-impact rank (higher = larger rigor impact, asked first). */
const RISK_IMPACT_ORDER = Object.freeze({
  regulated: 100,
  payments: 95,
  pii: 85,
  multiTenant: 82,
  destructiveWrites: 80,
  publicFacing: 65,
  integrations: 60
});

const RISK_PROMPTS = Object.freeze({
  regulated: 'Does this product operate under a statutory or industry regulation (healthcare, children under 13, student records, privacy law, financial controls, or high-risk AI)?',
  payments: 'Does this product charge, hold, disburse, refund, or reconcile money or payment cards?',
  pii: 'Does this product collect, store, or transmit personal identifiers (names, emails, phone numbers, addresses, health/student records, or government IDs)?',
  multiTenant: 'Does this product isolate data across multiple customer organisations, clinics, schools, or workspaces?',
  destructiveWrites: 'Can this product permanently delete data, modify live infrastructure, push/merge code, or execute shell commands?',
  publicFacing: 'Is any surface reachable over the public internet by anonymous, consumer, or self-serve users?',
  integrations: 'Does this product call external third-party APIs or receive/send webhooks?'
});

function setNestedField(target, fieldPath, value) {
  const parts = fieldPath.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function getNestedField(target, fieldPath) {
  return fieldPath.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), target);
}

/** Build the dependent `regulation` question populated with scanner suggestions. */
function buildRegulationQuestion(suggestedRegimes = [], current = [], provenance = 'default', conditional = false) {
  const suggested = suggestedRegimes.map((s) => (typeof s === 'string' ? s : s.regime));
  const phrases = suggestedRegimes
    .map((s) => (typeof s === 'object' && s.phrase ? `"${s.phrase}" -> ${s.regime}` : null))
    .filter(Boolean);
  return {
    id: 'q-regulation',
    field: 'regulation',
    prompt: suggested.length > 0
      ? `Which regulatory regime overlays apply? Detected cues suggest: ${suggested.join(', ')}.`
      : 'Which regulatory regime overlays apply (e.g. hipaa, gdpr, ccpa, coppa, pci-dss, ferpa, soc2, sox, dora, eu-ai-act)?',
    tierImpact: 98,
    reason: phrases.length > 0
      ? `Regulatory cues found in idea (${phrases.join('; ')})`
      : 'risks.regulated is true and requires at least one named regime overlay',
    evidence: suggestedRegimes[0]?.sentence ?? null,
    currentValue: current,
    suggestedValue: suggested,
    provenance,
    options: REGULATIONS,
    allowMultiple: true,
    dependsOn: conditional ? { field: 'risks.regulated', equals: true } : null,
    status: 'pending'
  };
}

/**
 * Generate a prioritized list of at most `MAX_ELICITATION_QUESTIONS` (7)
 * structured questions for a normalized or raw `profile.json`.
 */
export function generateProfileQuestions(rawProfile, {
  maxQuestions = MAX_ELICITATION_QUESTIONS,
  referenceDate = null,
  disagreements = []
} = {}) {
  const profile = normalizeProfile(rawProfile);
  const prov = getProfileProvenance(rawProfile);
  const scan = scanRiskHints(profile, { referenceDate });
  const ruleLint = lintRawRuleList(profile.rules ?? [], { profile, conflicts: profile.conflicts ?? [] });
  const answeredList = Array.isArray(rawProfile?.questions) ? rawProfile.questions.filter((q) => q.status === 'answered') : [];
  const answeredFields = new Set(answeredList.map((q) => q.field));

  const candidates = [];
  const seenFields = new Set();

  // 1. Scanner vs model disagreements (`needs-human`) always surface first.
  for (const clash of disagreements) {
    if (seenFields.has(clash.field) || answeredFields.has(clash.field)) continue;
    seenFields.add(clash.field);
    candidates.push({
      id: `q-${clash.field.replace(/\./g, '-')}`,
      field: clash.field,
      prompt: clash.question ?? `Confirm ${clash.field}: ${clash.reason}`,
      tierImpact: 105,
      reason: clash.reason,
      evidence: clash.evidence ?? null,
      currentValue: getNestedField(profile, clash.field),
      suggestedValue: clash.suggestedValue,
      provenance: prov[clash.field] ?? 'inferred',
      options: Array.isArray(clash.options) ? clash.options : [true, false, 'waive'],
      dependsOn: null,
      dependentQuestions: [],
      status: 'needs-human'
    });
  }

  // 2. Unflagged risk hints detected by the deterministic scanner.
  const sortedHits = [...scan.unflaggedRisks].sort(
    (a, b) => (RISK_IMPACT_ORDER[b.flag] ?? 50) - (RISK_IMPACT_ORDER[a.flag] ?? 50)
  );
  for (const hit of sortedHits) {
    const field = `risks.${hit.flag}`;
    if (seenFields.has(field)) continue;
    // If user explicitly set `risks.<flag>: false` without waiver, still ask whether to enable or waive.
    seenFields.add(field);
    const allPhrases = [...new Set((hit.matches ?? [{ phrase: hit.phrase }]).map((m) => `"${m.phrase}"`))].join(', ');
    const dependentQuestions = [];
    if (hit.flag === 'regulated' && (profile.regulation ?? []).length === 0) {
      dependentQuestions.push(buildRegulationQuestion(scan.suggestedRegimes, profile.regulation ?? [], prov.regulation ?? 'default', true));
      seenFields.add('regulation');
    }
    candidates.push({
      id: `q-risks-${hit.flag}`,
      field,
      prompt: RISK_PROMPTS[hit.flag] ?? `Should ${field} be enabled?`,
      tierImpact: RISK_IMPACT_ORDER[hit.flag] ?? 50,
      reason: `Idea mentions ${allPhrases}${hit.expiredWaiver ? ` (waiver expired ${hit.expiredWaiver})` : ''}`,
      evidence: hit.sentence ?? null,
      currentValue: profile.risks?.[hit.flag] ?? false,
      suggestedValue: true,
      provenance: prov[field] ?? 'default',
      options: [true, false, 'waive'],
      dependsOn: null,
      dependentQuestions,
      status: 'needs-human'
    });
  }

  // 3. Regulation overlay question when `risks.regulated === true` (or explicit regime cues missing from `profile.regulation`).
  if (!seenFields.has('regulation')) {
    const missingExplicitRegimes = scan.suggestedRegimes.filter((r) => !(profile.regulation ?? []).includes(r.regime));
    if (
      (profile.risks?.regulated === true && (profile.regulation ?? []).length === 0) ||
      (missingExplicitRegimes.length > 0 && !answeredFields.has('regulation'))
    ) {
      seenFields.add('regulation');
      candidates.push({
        ...buildRegulationQuestion(missingExplicitRegimes, profile.regulation ?? [], prov.regulation ?? 'default', false),
        suggestedValue: [...new Set([...(profile.regulation ?? []), ...missingExplicitRegimes.map((r) => r.regime)])],
        dependentQuestions: [],
        status: 'needs-human'
      });
    }
  }

  // 4. Unresolved cross-rule contradictions (`REQ-C01 ⟂ REQ-C02`).
  for (const conflict of ruleLint.contradictions) {
    const qId = `q-conflict-${conflict.rules.join('-').toLowerCase()}`;
    candidates.push({
      id: qId,
      field: `conflicts.${conflict.rules.join(':')}`,
      prompt: `Rules ${conflict.label} contradict each other. Which rule takes precedence and why?`,
      tierImpact: 92,
      reason: conflict.reason,
      evidence: null,
      currentValue: null,
      suggestedValue: conflict.rules[1],
      provenance: 'default',
      options: conflict.rules,
      dependsOn: null,
      dependentQuestions: [],
      status: 'needs-human'
    });
  }

  // 5. Production defaulted tier-driving fields (roadmap P1.5).
  const defaulted = defaultedProductionTierFields(rawProfile).filter((f) => !seenFields.has(f));
  const defaultedRiskFlags = defaulted.filter((f) => f.startsWith('risks.')).map((f) => f.slice('risks.'.length));
  for (const scalarField of defaulted.filter((f) => !f.startsWith('risks.'))) {
    seenFields.add(scalarField);
    candidates.push({
      id: `q-${scalarField.replace(/\./g, '-')}`,
      field: scalarField,
      prompt: scalarField === 'users.scale'
        ? 'What user scale is targeted at production launch (small, medium, or large)?'
        : scalarField === 'stage'
          ? 'What delivery stage applies to this product?'
          : `Confirm production value for ${scalarField}:`,
      tierImpact: 75,
      reason: `Production profile cannot leave tier-driving field "${scalarField}" at an unconfirmed default`,
      evidence: null,
      currentValue: getNestedField(profile, scalarField),
      suggestedValue: getNestedField(profile, scalarField),
      provenance: 'default',
      options: scalarField === 'users.scale' ? SCALES : scalarField === 'stage' ? STAGES : REGULATIONS,
      dependsOn: null,
      dependentQuestions: [],
      status: 'pending'
    });
  }

  // Fit remaining defaulted production risk booleans within the <= 7 cap: ask
  // individually when budget permits, or coalesce remaining safe-false booleans
  // into a single explicit confirmation question so 1 click confirms them all.
  if (defaultedRiskFlags.length > 0) {
    const remainingSlots = Math.max(1, maxQuestions - candidates.length);
    if (defaultedRiskFlags.length <= remainingSlots) {
      for (const flag of defaultedRiskFlags) {
        const field = `risks.${flag}`;
        seenFields.add(field);
        candidates.push({
          id: `q-risks-${flag}`,
          field,
          prompt: RISK_PROMPTS[flag],
          tierImpact: (RISK_IMPACT_ORDER[flag] ?? 50) - 20,
          reason: `Production profile leaves "${field}" at default; confirm true or false explicitly`,
          evidence: null,
          currentValue: false,
          suggestedValue: false,
          provenance: 'default',
          options: [true, false],
          dependsOn: null,
          dependentQuestions: flag === 'regulated'
            ? [buildRegulationQuestion(scan.suggestedRegimes, profile.regulation ?? [], prov.regulation ?? 'default', true)]
            : [],
          status: 'pending'
        });
      }
    } else {
      candidates.push({
        id: 'q-risks-remaining',
        field: 'risks',
        coveredFlags: defaultedRiskFlags,
        prompt: `Do any of these remaining risk flags apply (${defaultedRiskFlags.join(', ')}), or confirm "none" to set them explicitly false?`,
        tierImpact: 55,
        reason: `Production profile requires explicit confirmation of defaulted risk flags: ${defaultedRiskFlags.join(', ')}`,
        evidence: null,
        currentValue: Object.fromEntries(defaultedRiskFlags.map((f) => [f, false])),
        suggestedValue: Object.fromEntries(defaultedRiskFlags.map((f) => [f, false])),
        provenance: 'default',
        options: ['none', ...defaultedRiskFlags],
        allowMultiple: true,
        dependsOn: null,
        dependentQuestions: [],
        status: 'pending'
      });
    }
  }

  // 6. Stage / kind / stack when still defaulted on non-production drafts and slots remain.
  if (!seenFields.has('stage') && (prov.stage ?? 'default') === 'default' && candidates.length < maxQuestions) {
    seenFields.add('stage');
    candidates.push({
      id: 'q-stage',
      field: 'stage',
      prompt: 'What delivery stage are you targeting (prototype, mvp, internal-tool, or production)?',
      tierImpact: 72,
      reason: 'Stage drives rigor tier, gate depth, and packet size',
      evidence: null,
      currentValue: profile.stage,
      suggestedValue: profile.risks?.regulated || profile.risks?.payments ? 'production' : 'mvp',
      provenance: 'default',
      options: STAGES,
      dependsOn: null,
      dependentQuestions: [],
      status: 'pending'
    });
  }
  if (!seenFields.has('kind') && (prov.kind ?? 'default') === 'default' && candidates.length < maxQuestions) {
    seenFields.add('kind');
    candidates.push({
      id: 'q-kind',
      field: 'kind',
      prompt: 'What product kind best describes this system?',
      tierImpact: 50,
      reason: 'Product kind selects surface-specific requirements (UI, API, CLI, pipeline, agent)',
      evidence: null,
      currentValue: profile.kind,
      suggestedValue: profile.kind,
      provenance: 'default',
      options: KINDS,
      dependsOn: null,
      dependentQuestions: [],
      status: 'pending'
    });
  }
  if (!seenFields.has('constraints.stack') && (prov['constraints.stack'] ?? 'default') === 'default' && candidates.length < maxQuestions) {
    seenFields.add('constraints.stack');
    candidates.push({
      id: 'q-constraints-stack',
      field: 'constraints.stack',
      prompt: 'Which primary implementation stack should the specification target (e.g. typescript, python, go, rust)?',
      tierImpact: 35,
      reason: 'Stack tailors test/gate commands and idiomatic verification examples',
      evidence: null,
      currentValue: profile.constraints?.stack ?? 'undecided',
      suggestedValue: 'typescript',
      provenance: 'default',
      options: ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php', 'undecided'],
      dependsOn: null,
      dependentQuestions: [],
      status: 'pending'
    });
  }

  candidates.sort((a, b) => b.tierImpact - a.tierImpact || a.id.localeCompare(b.id));
  const bounded = candidates.slice(0, Math.min(maxQuestions, MAX_ELICITATION_QUESTIONS));

  return {
    questions: bounded,
    answered: answeredList,
    totalPending: bounded.length,
    cap: Math.min(maxQuestions, MAX_ELICITATION_QUESTIONS),
    provenance: prov
  };
}

/**
 * Record a timestamped user answer (or waiver) onto a profile object, updating
 * the target field, `profile.provenance`, and `profile.questions`, then
 * recomputing remaining pending questions (surfacing any dependent follow-ups).
 */
export function applyProfileAnswer(rawProfile, {
  questionId = null,
  field = null,
  value = undefined,
  waive = null, // { reason, expires }
  actor = 'user',
  timestamp = new Date().toISOString(),
  referenceDate = null
} = {}) {
  const next = structuredClone(rawProfile ?? {});
  if (!next.provenance || typeof next.provenance !== 'object' || Array.isArray(next.provenance)) {
    next.provenance = {};
  }
  if (!Array.isArray(next.questions)) next.questions = [];
  if (!Array.isArray(next.riskWaivers)) next.riskWaivers = [];
  if (!next.risks || typeof next.risks !== 'object' || Array.isArray(next.risks)) next.risks = {};

  let targetField = field;
  let matchedQuestion = null;
  if (!targetField && questionId) {
    const current = generateProfileQuestions(next, { referenceDate });
    matchedQuestion = current.questions.find((q) => q.id === questionId) ?? null;
    if (!matchedQuestion) {
      throw new Error(`unknown question id "${questionId}"`);
    }
    targetField = matchedQuestion.field;
  }
  if (!targetField) {
    throw new Error('applyProfileAnswer requires `field` or `questionId`');
  }

  const resolvedId = questionId ?? `q-${targetField.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

  if (waive && typeof waive === 'object') {
    const flagName = targetField.startsWith('risks.') ? targetField.slice('risks.'.length) : targetField;
    if (!RISK_FLAGS.includes(flagName) && !flagName.startsWith('regulation:')) {
      throw new Error(`cannot waive non-risk field "${targetField}"`);
    }
    next.riskWaivers = next.riskWaivers.filter((w) => w.flag !== flagName);
    next.riskWaivers.push({
      flag: flagName,
      reason: String(waive.reason ?? '').trim(),
      expires: String(waive.expires ?? '').trim()
    });
    if (RISK_FLAGS.includes(flagName)) {
      next.risks[flagName] = false;
      next.provenance[`risks.${flagName}`] = 'waived';
    } else {
      next.provenance.regulation = 'waived';
    }
  } else if (targetField === 'risks') {
    // Batched confirmation of remaining risk booleans.
    if (value === 'none' || (Array.isArray(value) && (value.length === 0 || (value.length === 1 && value[0] === 'none')))) {
      const flags = matchedQuestion?.coveredFlags ?? RISK_FLAGS.filter((f) => !(f in next.risks));
      for (const flag of flags) {
        next.risks[flag] = false;
        next.provenance[`risks.${flag}`] = 'user';
      }
    } else if (Array.isArray(value)) {
      const enabled = new Set(value.filter((v) => v !== 'none'));
      const flags = matchedQuestion?.coveredFlags ?? RISK_FLAGS;
      for (const flag of flags) {
        next.risks[flag] = enabled.has(flag);
        next.provenance[`risks.${flag}`] = 'user';
      }
    } else if (value && typeof value === 'object') {
      for (const [flag, boolVal] of Object.entries(value)) {
        if (RISK_FLAGS.includes(flag)) {
          next.risks[flag] = Boolean(boolVal);
          next.provenance[`risks.${flag}`] = 'user';
        }
      }
    }
  } else if (targetField.startsWith('conflicts.')) {
    const pair = targetField.slice('conflicts.'.length).split(':');
    if (!Array.isArray(next.conflicts)) next.conflicts = [];
    const winner = typeof value === 'object' && value !== null ? value.winner : String(value);
    const reason = typeof value === 'object' && value !== null && value.reason
      ? String(value.reason)
      : `Operator selected ${winner} to take precedence over ${pair.find((r) => r !== winner) ?? pair[0]}.`;
    next.conflicts = next.conflicts.filter((c) => !(Array.isArray(c.rules) && c.rules.includes(pair[0]) && c.rules.includes(pair[1])));
    next.conflicts.push({ rules: pair, winner, reason });
    next.provenance[targetField] = 'user';
  } else if (targetField === 'regulation') {
    const arr = Array.isArray(value)
      ? value
      : String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    next.regulation = [...new Set(arr)];
    next.provenance.regulation = 'user';
    if (next.regulation.length > 0) {
      next.risks.regulated = true;
      if (!next.provenance['risks.regulated'] || next.provenance['risks.regulated'] === 'default') {
        next.provenance['risks.regulated'] = 'user';
      }
    }
  } else if (targetField === 'traits') {
    const arr = Array.isArray(value)
      ? value
      : String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    next.traits = [...new Set(arr)];
    next.provenance.traits = 'user';
  } else if (targetField.startsWith('risks.')) {
    const boolVal = typeof value === 'boolean' ? value : /^(?:true|yes|y|1)$/i.test(String(value).trim());
    setNestedField(next, targetField, boolVal);
    next.provenance[targetField] = 'user';
  } else if (targetField === 'constraints.team' || targetField === 'constraints.weeks') {
    setNestedField(next, targetField, Number(value));
    next.provenance[targetField] = 'user';
  } else {
    setNestedField(next, targetField, value);
    next.provenance[targetField] = 'user';
  }

  // Record timestamped audit record in profile.questions.
  next.questions = next.questions.filter((q) => q.id !== resolvedId && q.field !== targetField);
  next.questions.push({
    id: resolvedId,
    field: targetField,
    status: 'answered',
    answer: waive ? { waived: true, reason: waive.reason, expires: waive.expires } : value,
    actor,
    answeredAt: timestamp
  });

  // Recompute remaining questions (including newly triggered dependent questions).
  const followUp = generateProfileQuestions(next, { referenceDate });
  return {
    profile: next,
    remainingQuestions: followUp.questions,
    provenance: followUp.provenance
  };
}
