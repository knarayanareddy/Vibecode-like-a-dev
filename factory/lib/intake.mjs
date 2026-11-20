/**
 * Assisted intake pipeline: `vld intake` & `vld intake accept`
 * (ADR 0013, roadmap P1.4 & P1.5).
 *
 * Turns unstructured prose (string argument, `--file`, or stdin) into an
 * evidence-grounded `profile.draft.json`, an auditable `intake-report.json`,
 * and a hash-chained `.vld/evidence.jsonl` receipt — using an optional model
 * provider (`anthropic` | `openai` | `openai-compatible` | `command`) reconciled
 * against VLD's deterministic risk scanner, domain extractor, and rule linter,
 * or running 100% offline with zero API keys.
 *
 * Runtime extension module only: never imported by Core compiler modules.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { vocabularyFor } from './emit/vocabulary.mjs';
import { appendEvidence } from './evidence.mjs';
import { digest, extensionError } from './extension-utils.mjs';
const intakeError = (code, message) => extensionError(message, code);
import { createModelClient, DEFAULT_TOKEN_ENV } from './model-client.mjs';
import {
  defaultedProductionTierFields,
  getProfileProvenance,
  KINDS,
  normalizeProfile,
  REGULATIONS,
  RISK_FLAGS,
  SCALES,
  STAGES,
  TRAITS,
  validateProfile
} from './profile.mjs';
import { applyProfileAnswer, generateProfileQuestions, MAX_ELICITATION_QUESTIONS } from './questions.mjs';
import { scanAllIdeaCues, splitIdeaSentences } from './risk-hints.mjs';
import { lintRawRuleList } from './rule-lint.mjs';

export const DRAFT_SCHEMA_VERSION = 1;

const KIND_CUES = [
  ['cli', /\b(?:cli|command[- ]line|terminal\s+(?:tool|app|manager)|subcommand|stdin|stdout)\b/i],
  ['mobile', /\b(?:mobile\s+app|ios|android|react\s+native|swiftui|iphone|ipad)\b/i],
  ['library', /\b(?:library|sdk|npm\s+package|crate|pip\s+package|zero[- ]dependency\s+(?:ts|js|typescript|javascript)\s+library)\b/i],
  ['data-pipeline', /\b(?:data\s+pipeline|etl|streaming\s+pipeline|batch\s+(?:job|pipeline|processor)|ingestion\s+pipeline|kafka)\b/i],
  ['agent', /\b(?:autonomous\s+(?:ops\s+)?agent|ai\s+agent|coding\s+agent|tool[- ]calling\s+agent)\b/i],
  ['automation', /\b(?:cron\s+job|retention\s+worker|cleanup\s+controller|delivery\s+bot|triage\s+worker|webhook\s+worker|daemon)\b/i],
  ['web-app', /\b(?:saas|web\s+app|portal|dashboard|marketplace|storefront|club|chat|board|studio|workbench|console|booking\s+page|forum)\b/i],
  ['api', /\b(?:rest\s+api|graphql\s+api|http\s+api|api\s+service|gateway|microservice|webhook\s+proxy|backend\s+service)\b/i]
];

const TRAIT_CUES = [
  ['auth', /\b(?:login|sign[- ]?in|sign[- ]?up|auth(?:entication|orization)?|sso|saml|oidc|okta|oauth|mfa|accounts?|portal|multi[- ]?tenant|per[- ]clinic|per[- ]school|parents?\s+approve)\b/i],
  ['admin', /\b(?:admin(?:istrator)?s?|back[- ]?office|moderation|compliance\s+officer|practice\s+manager|role[- ]based|rbac|dual\s+approval)\b/i],
  ['payments', /\b(?:stripe|adyen|braintree|paypal|billing|payments?|payouts?|escrow|refunds?|pocket[- ]?money|credit\s+cards?|subscriptions?|ach|sepa|wire\s+transfers?|ledger)\b/i],
  ['realtime', /\b(?:real[- ]?time|live\s+(?:chat|updates|cursor|feed|board)|chat\s+with\s+friends|websocket|sse|multiplayer)\b/i],
  ['search', /\b(?:search(?:es|ing)?|full[- ]?text|filter\s+and\s+search|directory)\b/i],
  ['upload', /\b(?:uploads?|attachments?|file\s+uploads?|passport\s+scans?|license\s+scans?|resumes?)\b/i],
  ['notifications', /\b(?:sms\s+reminders?|email\s+(?:alerts?|reminders?|receipts?|notifications?)|twilio|sendgrid|postmark|push\s+notifications?|reminders?)\b/i],
  ['webhooks', /\b(?:webhooks?|callbacks?)\b/i],
  ['offline', /\b(?:offline|local[- ]first|air[- ]gapped|syncs?\s+when\s+online)\b/i],
  ['ai', /\b(?:llm|openai|anthropic|gpt-\d|claude|ai\s+(?:model|api|agent|scoring|triage|summarizer)|high[- ]risk\s+ai|embeddings?)\b/i],
  ['i18n', /\b(?:multi[- ]?language|multilingual|i18n|locali[sz]ation|translations?)\b/i],
  ['persistence', /\b(?:database|postgres|sqlite|mysql|stores?|storing|records?|appointments?|ledger|history|retention|vault|profiles?|clubs?|schedules?)\b/i],
  ['background-jobs', /\b(?:background\s+jobs?|queues?|workers?|scheduled|nightly|reminders?|async\s+retries|disbursements?)\b/i]
];

const STACK_CUES = [
  ['typescript', /\b(?:typescript|next\.?js|node\.?js|fastify|express|deno|bun)\b/i],
  ['python', /\b(?:python|fastapi|django|flask|pytest)\b/i],
  ['go', /\b(?:golang|\bgo\s+(?:1\.\d+|service|api|module))\b/i],
  ['rust', /\b(?:rust|cargo|tokio|axum)\b/i],
  ['java', /\b(?:java|spring\s+boot|maven|gradle)\b/i],
  ['kotlin', /\b(?:kotlin|ktor)\b/i],
  ['csharp', /\b(?:c#|csharp|\.net|asp\.net)\b/i],
  ['ruby', /\b(?:ruby|rails|rspec)\b/i],
  ['php', /\b(?:php|laravel|symfony)\b/i],
  ['javascript', /\bjavascript\b/i]
];

const RULE_SENTENCE_CUE = /\b(?:must|shall|never|cannot|can\s+never|only\s+if|require(?:s)?\s+(?:dual|manual|parental|two[- ]person|approval)|within\s+\d+|under\s+\d+|<\s*\d+|at\s+least\s+\d+|at\s+most\s+\d+|retain\s+[^.]{1,40}\s+for\s+\d+|delete\s+all\s+[^.]{1,40}\s+immediately|every\s+(?:api\s+)?call\s+(?:responds?|logs?))\b/i;

const INTAKE_JSON_SCHEMA = Object.freeze({
  title: 'vld_intake_proposal',
  type: 'object',
  properties: {
    name: { type: 'object', properties: { value: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'number' } } },
    kind: { type: 'object', properties: { value: { type: 'string', enum: KINDS }, evidence: { type: 'string' }, confidence: { type: 'number' }, question: { type: 'string' } } },
    stage: { type: 'object', properties: { value: { type: 'string', enum: STAGES }, evidence: { type: 'string' }, confidence: { type: 'number' }, question: { type: 'string' } } },
    scale: { type: 'object', properties: { value: { type: 'string', enum: SCALES }, evidence: { type: 'string' }, confidence: { type: 'number' }, question: { type: 'string' } } },
    stack: { type: 'object', properties: { value: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'number' }, question: { type: 'string' } } },
    traits: {
      type: 'array',
      items: { type: 'object', properties: { value: { type: 'string', enum: TRAITS }, evidence: { type: 'string' }, confidence: { type: 'number' } } }
    },
    risks: { type: 'object' },
    regulation: {
      type: 'array',
      items: { type: 'object', properties: { value: { type: 'string', enum: REGULATIONS }, evidence: { type: 'string' }, confidence: { type: 'number' } } }
    },
    rules: {
      type: 'array',
      items: { type: 'object', properties: { value: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'number' } } }
    }
  }
});

/**
 * Verify that `quote` appears as an exact substring (whitespace-normalised,
 * case-insensitive) of `sourceText`. Rejects fabricated/hallucinated citations.
 */
export function verifyVerbatimEvidence(sourceText, quote) {
  if (typeof quote !== 'string' || !quote.trim()) {
    return { valid: false, matched: null, reason: 'empty-evidence' };
  }
  const needle = quote.trim();
  const hay = String(sourceText ?? '');
  const directIdx = hay.indexOf(needle);
  if (directIdx !== -1) {
    return { valid: true, matched: hay.slice(directIdx, directIdx + needle.length), reason: null };
  }
  const lowerIdx = hay.toLowerCase().indexOf(needle.toLowerCase());
  if (lowerIdx !== -1) {
    return { valid: true, matched: hay.slice(lowerIdx, lowerIdx + needle.length), reason: null };
  }
  // Allow collapsed whitespace matching only (never paraphrasing or reordered words).
  const normHay = hay.replace(/\s+/g, ' ');
  const normNeedle = needle.replace(/\s+/g, ' ');
  const normIdx = normHay.toLowerCase().indexOf(normNeedle.toLowerCase());
  if (normIdx !== -1) {
    return { valid: true, matched: normHay.slice(normIdx, normIdx + normNeedle.length), reason: null };
  }
  return { valid: false, matched: null, reason: 'quote-not-in-input' };
}

function slugifyName(text, explicitName = null) {
  if (explicitName && /^[a-z0-9][a-z0-9-]{1,60}$/.test(explicitName)) return explicitName;
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !['the', 'and', 'for', 'with', 'that', 'from', 'build', 'app', 'tool', 'platform', 'system', 'using', 'via'].includes(w))
    .slice(0, 3);
  const base = (words.join('-') || 'vld-product').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base.length >= 2 ? base : 'vld-product';
}

function makeFieldProposal({ value, evidence = null, confidence = 0.5, source = 'deterministic', status = 'confirmed', question = null }) {
  return {
    value,
    evidence: evidence || null,
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2)),
    source,
    status, // 'confirmed' | 'inferred' | 'default' | 'needs-human'
    question: question || null
  };
}

/** Deterministic baseline extraction over raw prose (powers offline mode AND cross-check). */
function extractDeterministicProposals(inputText, explicitName = null) {
  const scanner = scanAllIdeaCues(inputText);
  const vocab = vocabularyFor(normalizeProfile({ name: 'intake-probe', idea: inputText, kind: 'web-app', stage: 'mvp' }));
  const inferredDomain =
    vocab.primary && !vocab.lowConfidence && vocab.source === 'idea' && /^[a-z][a-z0-9-]{1,40}$/.test(vocab.primary)
      ? {
          entity: vocab.primary,
          ...(vocab.secondary && /^[a-z][a-z0-9-]{1,40}$/.test(vocab.secondary) ? { actors: [vocab.secondary] } : {})
        }
      : null;
  const sentences = splitIdeaSentences(inputText);

  // Kind
  let kindField = makeFieldProposal({
    value: 'web-app',
    evidence: null,
    confidence: 0.45,
    source: 'default',
    status: 'default',
    question: 'What product kind best describes this system?'
  });
  for (const [kind, re] of KIND_CUES) {
    const m = re.exec(inputText);
    if (m) {
      kindField = makeFieldProposal({ value: kind, evidence: m[0], confidence: 0.86, source: 'deterministic', status: 'inferred' });
      break;
    }
  }

  // Stage
  let stageField;
  const stageMatch = inputText.match(/\b(prototype|mvp|internal[- ]tool|production)\b/i);
  if (stageMatch) {
    const val = stageMatch[1].toLowerCase().replace(/\s+/g, '-');
    stageField = makeFieldProposal({ value: val, evidence: stageMatch[0], confidence: 0.92, source: 'deterministic', status: 'inferred' });
  } else {
    const highRisk = scanner.risks.some((r) => r.flag === 'regulated' || r.flag === 'payments');
    stageField = makeFieldProposal({
      value: highRisk ? 'production' : 'mvp',
      evidence: null,
      confidence: 0.55,
      source: 'default',
      status: 'needs-human',
      question: 'What delivery stage are you targeting (prototype, mvp, internal-tool, or production)?'
    });
  }

  // Users scale
  let scaleField = makeFieldProposal({
    value: scanner.risks.some((r) => r.flag === 'multiTenant') ? 'medium' : 'small',
    evidence: scanner.risks.find((r) => r.flag === 'multiTenant')?.phrase ?? null,
    confidence: scanner.risks.some((r) => r.flag === 'multiTenant') ? 0.78 : 0.6,
    source: scanner.risks.some((r) => r.flag === 'multiTenant') ? 'deterministic' : 'default',
    status: scanner.risks.some((r) => r.flag === 'multiTenant') ? 'inferred' : 'inferred'
  });
  if (/\b(?:millions?\s+of\s+users|high[- ]traffic|nationwide|global\s+scale|100k\+?\s+users)\b/i.test(inputText)) {
    const m = inputText.match(/\b(?:millions?\s+of\s+users|high[- ]traffic|nationwide|global\s+scale|100k\+?\s+users)\b/i);
    scaleField = makeFieldProposal({ value: 'large', evidence: m[0], confidence: 0.9, source: 'deterministic', status: 'inferred' });
  }

  // Stack
  let stackField = makeFieldProposal({
    value: 'undecided',
    evidence: null,
    confidence: 0.4,
    source: 'default',
    status: 'default',
    question: 'Which primary implementation stack should the packet target?'
  });
  for (const [stack, re] of STACK_CUES) {
    const m = re.exec(inputText);
    if (m) {
      stackField = makeFieldProposal({ value: stack, evidence: m[0], confidence: 0.9, source: 'deterministic', status: 'inferred' });
      break;
    }
  }

  // Traits
  const traits = [];
  for (const [trait, re] of TRAIT_CUES) {
    const m = re.exec(inputText);
    if (!m) continue;
    // Respect simple local negation ("no auth", "without webhooks").
    const prefix = inputText.slice(Math.max(0, m.index - 24), m.index);
    if (/\b(?:no|without|zero|never\s+\w+)\s+$/i.test(prefix)) continue;
    traits.push(makeFieldProposal({ value: trait, evidence: m[0], confidence: 0.85, source: 'deterministic', status: 'inferred' }));
  }

  // Risks (all 7 flags)
  const riskByFlag = new Map(scanner.risks.map((r) => [r.flag, r]));
  const risks = {};
  for (const flag of RISK_FLAGS) {
    const hit = riskByFlag.get(flag);
    if (hit) {
      risks[flag] = makeFieldProposal({
        value: true,
        evidence: hit.phrase,
        confidence: 0.92,
        source: 'deterministic',
        status: 'needs-human',
        question: `Confirm risks.${flag}=true (matched "${hit.phrase}" in "${hit.sentence}") or record a dated waiver?`
      });
    } else {
      risks[flag] = makeFieldProposal({
        value: false,
        evidence: null,
        confidence: 0.8,
        source: 'deterministic',
        status: 'inferred',
        question: null
      });
    }
  }

  // Regulatory regimes
  const regulation = scanner.regimes.map((reg) =>
    makeFieldProposal({
      value: reg.regime,
      evidence: reg.phrase,
      confidence: 0.93,
      source: 'deterministic',
      status: 'needs-human',
      question: `Apply the "${reg.regime}" regulatory overlay (matched "${reg.phrase}")?`
    })
  );

  // Domain rules extracted from imperative/quantitative sentences
  const rules = [];
  for (const sentence of sentences) {
    if (sentence.length >= 12 && sentence.length <= 240 && RULE_SENTENCE_CUE.test(sentence)) {
      rules.push(
        makeFieldProposal({
          value: sentence.replace(/\s+/g, ' ').trim(),
          evidence: sentence,
          confidence: 0.84,
          source: 'deterministic',
          status: 'inferred'
        })
      );
    }
  }

  // Ensure idea meets profile minimum length (>= 20 chars) and single-paragraph safety.
  const ideaClean = String(inputText ?? '').replace(/\s+/g, ' ').trim();
  return {
    name: makeFieldProposal({
      value: slugifyName(inputText, explicitName),
      evidence: null,
      confidence: explicitName ? 1 : 0.75,
      source: explicitName ? 'user' : 'deterministic',
      status: 'inferred'
    }),
    idea: ideaClean,
    kind: kindField,
    stage: stageField,
    scale: scaleField,
    stack: stackField,
    traits,
    risks,
    regulation,
    rules,
    domain: inferredDomain,
    scanner
  };
}

/** Validate and reconcile optional LLM proposal against verbatim text + deterministic scanner. */
function reconcileModelProposal(inputText, baseline, modelJson) {
  const quoteAudit = { verified: 0, rejected: [] };
  const disagreements = [];
  if (!modelJson || typeof modelJson !== 'object') {
    return { merged: baseline, quoteAudit, disagreements };
  }

  const merged = structuredClone(baseline);

  function auditEntry(fieldLabel, entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.evidence) {
      const check = verifyVerbatimEvidence(inputText, entry.evidence);
      if (check.valid) {
        quoteAudit.verified += 1;
        return {
          value: entry.value,
          evidence: check.matched,
          confidence: Number(entry.confidence ?? 0.85),
          source: 'model',
          status: Number(entry.confidence ?? 0.85) >= 0.75 ? 'inferred' : 'needs-human',
          question: entry.question ?? null
        };
      }
      quoteAudit.rejected.push({
        field: fieldLabel,
        claimedEvidence: String(entry.evidence).slice(0, 160),
        reason: check.reason
      });
      return {
        value: entry.value,
        evidence: null,
        confidence: Math.min(0.35, Number(entry.confidence ?? 0.35)),
        source: 'model-unverified',
        status: 'needs-human',
        question: entry.question ?? `Model proposed ${fieldLabel}=${JSON.stringify(entry.value)} without a verbatim quote from your input. Confirm?`
      };
    }
    return {
      value: entry.value,
      evidence: null,
      confidence: Math.min(0.6, Number(entry.confidence ?? 0.5)),
      source: 'model',
      status: 'needs-human',
      question: entry.question ?? `Confirm ${fieldLabel}=${JSON.stringify(entry.value)}?`
    };
  }

  // Scalar fields: kind, stage, scale, stack, name.
  if (modelJson.name?.value && /^[a-z0-9][a-z0-9-]{1,60}$/.test(modelJson.name.value) && baseline.name.source !== 'user') {
    merged.name = makeFieldProposal({ value: modelJson.name.value, evidence: null, confidence: 0.85, source: 'model', status: 'inferred' });
  }
  for (const [key, allowed] of [['kind', KINDS], ['stage', STAGES], ['scale', SCALES]]) {
    const audited = auditEntry(key === 'scale' ? 'users.scale' : key, modelJson[key]);
    if (!audited || !allowed.includes(audited.value)) continue;
    if (baseline[key].source !== 'default' && baseline[key].value !== audited.value) {
      disagreements.push({
        field: key === 'scale' ? 'users.scale' : key,
        modelValue: audited.value,
        scannerValue: baseline[key].value,
        suggestedValue: audited.evidence ? audited.value : baseline[key].value,
        evidence: audited.evidence ?? baseline[key].evidence,
        options: allowed,
        reason: `Model proposed ${key}="${audited.value}" while deterministic cue matched "${baseline[key].value}"`,
        question: `Should ${key} be "${audited.value}" or "${baseline[key].value}"?`
      });
      merged[key] = { ...audited, status: 'needs-human' };
    } else if (audited.evidence || baseline[key].source === 'default') {
      merged[key] = makeFieldProposal(audited);
    }
  }

  if (modelJson.stack?.value && typeof modelJson.stack.value === 'string') {
    const audited = auditEntry('constraints.stack', modelJson.stack);
    if (audited && audited.evidence) {
      merged.stack = makeFieldProposal({ ...audited, value: audited.value.toLowerCase() });
    }
  }

  // Traits: union of verified model traits + deterministic traits.
  if (Array.isArray(modelJson.traits)) {
    const have = new Set(merged.traits.map((t) => t.value));
    for (const rawTrait of modelJson.traits) {
      const audited = auditEntry(`traits.${rawTrait?.value}`, rawTrait);
      if (!audited || !TRAITS.includes(audited.value) || have.has(audited.value)) continue;
      if (audited.evidence) {
        merged.traits.push(makeFieldProposal(audited));
        have.add(audited.value);
      }
    }
  }

  // Risks: NEVER allow a model `false` or omission to silence a deterministic scanner hit!
  const modelRisks = modelJson.risks && typeof modelJson.risks === 'object' ? modelJson.risks : {};
  for (const flag of RISK_FLAGS) {
    const field = `risks.${flag}`;
    const scannerTrue = baseline.risks[flag]?.value === true;
    const rawModelRisk = modelRisks[flag];
    const audited = rawModelRisk !== undefined ? auditEntry(field, rawModelRisk) : null;

    if (scannerTrue && (!audited || audited.value !== true)) {
      disagreements.push({
        field,
        modelValue: audited ? Boolean(audited.value) : false,
        scannerValue: true,
        suggestedValue: true,
        evidence: baseline.risks[flag].evidence,
        options: [true, false, 'waive'],
        reason: `Deterministic scanner matched "${baseline.risks[flag].evidence}" for ${field}, whereas model proposed ${audited ? Boolean(audited.value) : 'omitted'}`,
        question: `Enable ${field}=true (idea mentions "${baseline.risks[flag].evidence}") or waive with reason and expiry?`
      });
      merged.risks[flag] = {
        ...baseline.risks[flag],
        status: 'needs-human'
      };
    } else if (!scannerTrue && audited && audited.value === true) {
      disagreements.push({
        field,
        modelValue: true,
        scannerValue: false,
        suggestedValue: Boolean(audited.evidence),
        evidence: audited.evidence,
        options: [true, false, 'waive'],
        reason: audited.evidence
          ? `Model identified ${field}=true from "${audited.evidence}" (not flagged by lexical scanner)`
          : `Model proposed ${field}=true without a verbatim quote; human confirmation required`,
        question: audited.question ?? `Model flagged ${field}=true${audited.evidence ? ` citing "${audited.evidence}"` : ''}. Enable ${field}?`
      });
      merged.risks[flag] = makeFieldProposal({
        value: Boolean(audited.evidence),
        evidence: audited.evidence,
        confidence: audited.confidence,
        source: audited.source,
        status: 'needs-human',
        question: audited.question
      });
    } else if (scannerTrue && audited && audited.value === true && audited.evidence) {
      // Both model (with verbatim quote) AND scanner agree!
      merged.risks[flag] = makeFieldProposal({
        value: true,
        evidence: audited.evidence,
        confidence: Math.max(baseline.risks[flag].confidence, audited.confidence),
        source: 'model+scanner',
        status: 'inferred',
        question: null
      });
    }
  }

  // Regulation overlays: union + flag disagreements as needs-human.
  const scannerRegSet = new Set(baseline.regulation.map((r) => r.value));
  const modelRegs = Array.isArray(modelJson.regulation) ? modelJson.regulation : [];
  const auditedModelRegs = new Map();
  for (const entry of modelRegs) {
    if (!entry?.value || !REGULATIONS.includes(String(entry.value).toLowerCase())) continue;
    const reg = String(entry.value).toLowerCase();
    auditedModelRegs.set(reg, auditEntry(`regulation.${reg}`, { ...entry, value: reg }));
  }

  const missingFromModel = [...scannerRegSet].filter((r) => !auditedModelRegs.has(r));
  const extraFromModel = [...auditedModelRegs.entries()].filter(([r]) => !scannerRegSet.has(r));
  for (const [reg, audited] of extraFromModel) {
    merged.regulation.push(makeFieldProposal({ ...audited, status: 'needs-human' }));
  }
  if (missingFromModel.length > 0 || extraFromModel.length > 0) {
    const allSuggested = [...new Set([...merged.regulation.map((r) => r.value)])];
    disagreements.push({
      field: 'regulation',
      modelValue: [...auditedModelRegs.keys()],
      scannerValue: [...scannerRegSet],
      suggestedValue: allSuggested,
      evidence: merged.regulation[0]?.evidence ?? null,
      options: REGULATIONS,
      reason: `Scanner detected [${[...scannerRegSet].join(', ')}] while model proposed [${[...auditedModelRegs.keys()].join(', ')}]`,
      question: `Confirm applicable regulatory overlays (suggested: ${allSuggested.join(', ')}):`
    });
  } else {
    merged.regulation = merged.regulation.map((r) => ({
      ...r,
      source: auditedModelRegs.get(r.value)?.evidence ? 'model+scanner' : r.source,
      status: auditedModelRegs.get(r.value)?.evidence ? 'inferred' : r.status
    }));
  }

  // Rules: append verified model-extracted rules not already present.
  if (Array.isArray(modelJson.rules)) {
    const existing = new Set(merged.rules.map((r) => r.value.toLowerCase()));
    for (const rawRule of modelJson.rules) {
      if (typeof rawRule?.value !== 'string' || rawRule.value.trim().length < 10) continue;
      const audited = auditEntry('rules', rawRule);
      if (audited?.evidence && !existing.has(audited.value.trim().toLowerCase())) {
        merged.rules.push(makeFieldProposal({ ...audited, value: audited.value.trim() }));
        existing.add(audited.value.trim().toLowerCase());
      }
    }
  }

  return { merged, quoteAudit, disagreements };
}

/** Materialize a normalized candidate profile + provenance map from draft fields. */
export function draftToCandidateProfile(draft) {
  const f = draft.fields ?? {};
  const provenance = { ...(draft.provenance ?? {}) };
  const mapSource = (entry) => {
    if (!entry) return 'default';
    if (entry.source === 'user') return 'user';
    if (entry.source === 'waived') return 'waived';
    if (entry.source === 'default') return 'default';
    return 'inferred';
  };

  const risks = {};
  for (const flag of RISK_FLAGS) {
    const r = f.risks?.[flag];
    risks[flag] = Boolean(r?.value);
    if (!provenance[`risks.${flag}`]) provenance[`risks.${flag}`] = mapSource(r);
  }
  const regulation = (f.regulation ?? [])
    .filter((r) => r && r.value && r.status !== 'rejected')
    .map((r) => r.value);
  if (regulation.length > 0) risks.regulated = true;

  if (!provenance.kind) provenance.kind = mapSource(f.kind);
  if (!provenance.stage) provenance.stage = mapSource(f.stage);
  if (!provenance['users.scale']) provenance['users.scale'] = mapSource(f.scale);
  if (!provenance.traits) provenance.traits = (f.traits ?? []).length > 0 ? 'inferred' : 'default';
  if (!provenance.regulation) provenance.regulation = regulation.length > 0 ? 'inferred' : 'default';
  if (!provenance['constraints.stack']) provenance['constraints.stack'] = mapSource(f.stack);

  const profile = {
    name: f.name?.value || 'vld-product',
    idea: draft.idea,
    kind: f.kind?.value || 'web-app',
    stage: f.stage?.value || 'mvp',
    users: { scale: f.scale?.value || 'small' },
    traits: [...new Set((f.traits ?? []).map((t) => t.value).filter((t) => TRAITS.includes(t)))],
    risks,
    ...(regulation.length > 0 ? { regulation: [...new Set(regulation)] } : {}),
    constraints: {
      team: 1,
      weeks: 4,
      stack: f.stack?.value || 'undecided',
      mustUse: []
    },
    ...(f.domain ? { domain: f.domain } : {}),
    ...((f.rules ?? []).length > 0 ? { rules: f.rules.map((r) => r.value) } : {}),
    ...((draft.riskWaivers ?? []).length > 0 ? { riskWaivers: draft.riskWaivers } : {}),
    ...((draft.conflicts ?? []).length > 0 ? { conflicts: draft.conflicts } : {}),
    ...((draft.answeredQuestions ?? []).length > 0 ? { questions: draft.answeredQuestions } : {}),
    provenance
  };
  return profile;
}

/**
 * Execute `vld intake` over raw text, producing `profile.draft.json`,
 * `intake-report.json`, and an entry in `.vld/evidence.jsonl`.
 */
export async function runIntake({
  text,
  name = null,
  projectDir = '.',
  outFile = 'profile.draft.json',
  reportFile = 'intake-report.json',
  offline = false,
  provider = null,
  model = null,
  tokenEnv = undefined,
  baseUrl = null,
  command = null,
  cassetteDir = null,
  cassetteMode = null,
  modelClient = null,
  budget = {},
  recordEvidence = true,
  referenceDate = new Date().toISOString().slice(0, 10)
} = {}) {
  const cleaned = String(text ?? '').trim();
  if (cleaned.length < 20) {
    throw intakeError('INTAKE_INPUT_SHORT', 'intake text must be at least 20 characters describing what the product does');
  }

  const project = path.resolve(projectDir);
  const inputDigest = digest(cleaned);
  const baseline = extractDeterministicProposals(cleaned, name);

  // Determine whether an LLM provider is available and enabled.
  const activeProvider = provider || null;
  const resolvedEnvName = activeProvider ? (tokenEnv ?? DEFAULT_TOKEN_ENV[activeProvider]) : null;
  const hasKey = Boolean(
    modelClient ||
    activeProvider === 'command' ||
    activeProvider === 'openai-compatible' ||
    cassetteMode === 'replay' ||
    (resolvedEnvName && process.env[resolvedEnvName])
  );
  const useModel = !offline && Boolean(modelClient || (activeProvider && hasKey));

  let mode = 'offline-deterministic';
  let modelCallRecord = null;
  let modelRawJson = null;

  if (useModel) {
    const client = modelClient ?? createModelClient({
      provider: activeProvider,
      model: model || (activeProvider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-6'),
      tokenEnv,
      baseUrl,
      command,
      cassetteDir,
      cassetteMode,
      budget: { maxTokens: 2048, maxCostUsd: 0.5, ...budget }
    });
    const system = [
      'You are VLD Intake. Extract a structured product profile proposal from the user text.',
      'CRITICAL RULE: Every `evidence` field MUST be an exact, verbatim substring copied directly from the user text.',
      'Never paraphrase quotes. If a field is ambiguous, lower confidence below 0.7 and populate `question`.',
      `Allowed kinds: ${KINDS.join(', ')}. Allowed stages: ${STAGES.join(', ')}. Allowed scales: ${SCALES.join(', ')}.`,
      `Allowed traits: ${TRAITS.join(', ')}. Allowed risks: ${RISK_FLAGS.join(', ')}. Allowed regulations: ${REGULATIONS.join(', ')}.`
    ].join('\n');
    const completion = await client.complete({
      system,
      messages: [{ role: 'user', content: cleaned }],
      schema: INTAKE_JSON_SCHEMA,
      maxTokens: 2048,
      temperature: 0
    });
    mode = completion.cached ? 'model-cassette' : 'model-live';
    modelRawJson = completion.json;
    modelCallRecord = {
      provider: completion.provider,
      model: completion.model,
      cached: completion.cached,
      requestDigest: completion.requestDigest,
      responseDigest: completion.responseDigest,
      usage: completion.usage,
      durationMs: completion.durationMs
    };
  }

  const { merged, quoteAudit, disagreements } = reconcileModelProposal(cleaned, baseline, modelRawJson);

  // Collect structured questions (always <= 7, sorted by tier impact).
  const preliminaryDraft = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    status: 'draft',
    mode,
    inputDigest,
    idea: merged.idea,
    fields: {
      name: merged.name,
      kind: merged.kind,
      stage: merged.stage,
      scale: merged.scale,
      stack: merged.stack,
      traits: merged.traits,
      risks: merged.risks,
      regulation: merged.regulation,
      rules: merged.rules,
      domain: merged.domain
    },
    disagreements,
    riskWaivers: [],
    conflicts: [],
    answeredQuestions: [],
    provenance: {}
  };

  const candidateProfile = draftToCandidateProfile(preliminaryDraft);
  // Build targeted intake questions: scanner disagreements + needs-human risk/regime/stage confirmations + rule conflicts.
  const intakeDisagreements = [...disagreements];
  const seenClashFields = new Set(intakeDisagreements.map((d) => d.field));

  for (const flag of RISK_FLAGS) {
    const entry = merged.risks[flag];
    const field = `risks.${flag}`;
    if (entry?.status === 'needs-human' && !seenClashFields.has(field)) {
      seenClashFields.add(field);
      intakeDisagreements.push({
        field,
        suggestedValue: entry.value,
        evidence: entry.evidence,
        options: [true, false, 'waive'],
        reason: entry.evidence ? `Detected "${entry.evidence}" for ${field}` : `Confirm ${field}`,
        question: entry.question ?? `Confirm ${field}=${entry.value} or record a dated waiver?`
      });
    }
  }
  if (merged.regulation.some((r) => r.status === 'needs-human') && !seenClashFields.has('regulation')) {
    const suggested = merged.regulation.map((r) => r.value);
    seenClashFields.add('regulation');
    intakeDisagreements.push({
      field: 'regulation',
      suggestedValue: suggested,
      evidence: merged.regulation[0]?.evidence ?? null,
      options: REGULATIONS,
      reason: `Detected regulatory regime cues: ${merged.regulation.map((r) => `"${r.evidence}" -> ${r.value}`).join(', ')}`,
      question: `Confirm applicable regulatory regime overlays (suggested: ${suggested.join(', ')}):`
    });
  }
  if (merged.stage.status === 'needs-human' && !seenClashFields.has('stage')) {
    seenClashFields.add('stage');
    intakeDisagreements.push({
      field: 'stage',
      suggestedValue: merged.stage.value,
      evidence: merged.stage.evidence,
      options: STAGES,
      reason: 'Delivery stage was not explicitly stated in input text',
      question: merged.stage.question ?? `Confirm target delivery stage (suggested: ${merged.stage.value}):`
    });
  }

  const elicitation = generateProfileQuestions(candidateProfile, {
    maxQuestions: MAX_ELICITATION_QUESTIONS,
    referenceDate,
    disagreements: intakeDisagreements
  });
  const ruleLint = lintRawRuleList(candidateProfile.rules ?? [], { profile: candidateProfile });

  const draft = {
    ...preliminaryDraft,
    provenance: candidateProfile.provenance,
    questions: elicitation.questions,
    ruleLint: {
      ok: ruleLint.ok,
      contradictions: ruleLint.contradictions,
      infeasible: ruleLint.infeasible,
      duplicates: ruleLint.duplicates
    },
    candidateProfile
  };

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    mode,
    offlineFallback: !useModel,
    inputDigest,
    draftFile: outFile,
    model: modelCallRecord,
    quoteAudit,
    scannerSummary: {
      detectedFlags: baseline.scanner.risks.map((r) => ({ flag: r.flag, cues: r.cues, matchCount: r.matches.length })),
      detectedRegimes: baseline.scanner.regimes.map((r) => ({ regime: r.regime, phrase: r.phrase }))
    },
    disagreements,
    ruleLint: {
      ok: ruleLint.ok,
      blockingCount: ruleLint.blockingCount,
      warningCount: ruleLint.warningCount
    },
    pendingQuestionCount: elicitation.questions.length,
    questions: elicitation.questions.map((q) => ({ id: q.id, field: q.field, status: q.status, suggestedValue: q.suggestedValue }))
  };

  const draftAbs = path.resolve(project, outFile);
  const reportAbs = path.resolve(project, reportFile);
  mkdirSync(path.dirname(draftAbs), { recursive: true });
  mkdirSync(path.dirname(reportAbs), { recursive: true });
  writeFileSync(draftAbs, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  writeFileSync(reportAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  let evidenceEntry = null;
  if (recordEvidence) {
    evidenceEntry = appendEvidence({
      projectDir: project,
      kind: 'intake',
      actor: useModel ? `agent:intake:${modelCallRecord.provider}:${modelCallRecord.model}` : 'operator:vld-intake-offline',
      subject: path.basename(draftAbs),
      payload: {
        mode,
        inputDigest,
        draftDigest: digest(draft),
        requestDigest: modelCallRecord?.requestDigest ?? null,
        responseDigest: modelCallRecord?.responseDigest ?? null,
        provider: modelCallRecord?.provider ?? null,
        model: modelCallRecord?.model ?? null,
        usage: modelCallRecord?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        verifiedQuotes: quoteAudit.verified,
        rejectedQuotes: quoteAudit.rejected.length,
        disagreementCount: disagreements.length,
        pendingQuestions: elicitation.questions.length
      }
    });
  }

  return {
    ok: true,
    mode,
    draftFile: draftAbs,
    reportFile: reportAbs,
    draft,
    report,
    questions: elicitation.questions,
    evidenceEntry
  };
}

/**
 * Promote `profile.draft.json` to a strict-ready `profile.json` (`vld intake accept`).
 *
 * Refuses promotion if any `needs-human` question or rule contradiction remains
 * unresolved, unless resolved via `answers`, `waivers`, or `acceptSuggested: true`
 * (an explicit user confirmation action that stamps answered items as `provenance: 'user'`).
 */
export function acceptIntakeDraft({
  projectDir = '.',
  draftFile = 'profile.draft.json',
  outFile = 'profile.json',
  answers = [], // [{ questionId?, field?, value }]
  waivers = [], // [{ flag, reason, expires }]
  acceptSuggested = false,
  force = false,
  actor = 'operator:vld-intake-accept',
  timestamp = new Date().toISOString(),
  referenceDate = timestamp.slice(0, 10),
  recordEvidence = true
} = {}) {
  const project = path.resolve(projectDir);
  const draftAbs = path.resolve(project, draftFile);
  if (!existsSync(draftAbs)) {
    throw intakeError('INTAKE_DRAFT_MISSING', `draft file not found: ${draftAbs}`);
  }
  const outAbs = path.resolve(project, outFile);
  if (existsSync(outAbs) && !force) {
    throw intakeError('MANAGED_FILE_EXISTS', `${outAbs} already exists; pass --force to overwrite`);
  }

  const draft = JSON.parse(readFileSync(draftAbs, 'utf8'));
  let profile = draft.candidateProfile ? structuredClone(draft.candidateProfile) : draftToCandidateProfile(draft);
  const pendingDraftQuestions = Array.isArray(draft.questions) ? draft.questions : [];

  // Apply explicit waivers first.
  for (const w of waivers) {
    const field = w.flag.startsWith('regulation:') ? w.flag : `risks.${w.flag}`;
    profile = applyProfileAnswer(profile, {
      field,
      waive: { reason: w.reason, expires: w.expires },
      actor,
      timestamp,
      referenceDate
    }).profile;
  }

  // Apply explicit answers.
  for (const ans of answers) {
    const matched = pendingDraftQuestions.find((q) => (ans.questionId && q.id === ans.questionId) || (ans.field && q.field === ans.field));
    profile = applyProfileAnswer(profile, {
      questionId: ans.questionId ?? matched?.id ?? null,
      field: ans.field ?? matched?.field ?? null,
      value: ans.value,
      waive: ans.waive ?? null,
      actor,
      timestamp,
      referenceDate
    }).profile;
  }

  // Track which draft questions were answered.
  const answeredFields = new Set((profile.questions ?? []).map((q) => q.field));
  const unresolvedNeedsHuman = pendingDraftQuestions.filter(
    (q) => q.status === 'needs-human' && !answeredFields.has(q.field)
  );

  if (acceptSuggested) {
    for (const q of pendingDraftQuestions) {
      if (answeredFields.has(q.field)) continue;
      if (q.field.startsWith('conflicts.')) continue; // Never auto-pick conflict winners!
      if (q.suggestedValue === undefined || q.suggestedValue === null) continue;
      profile = applyProfileAnswer(profile, {
        questionId: q.id,
        field: q.field,
        value: q.suggestedValue,
        actor,
        timestamp,
        referenceDate
      }).profile;
      answeredFields.add(q.field);
    }
  } else if (unresolvedNeedsHuman.length > 0) {
    throw intakeError('INTAKE_UNRESOLVED_QUESTIONS',
      `cannot accept draft with ${unresolvedNeedsHuman.length} unresolved question(s): ` +
      unresolvedNeedsHuman.map((q) => `${q.field} ("${q.prompt}")`).join('; ') +
      '. Answer with --answer field=value, waive with --waive flag:reason:YYYY-MM-DD, or confirm suggestions with --accept-suggested.'
    );
  }

  // Ensure production tier-driving fields are all explicitly stamped when confirmed.
  if (profile.stage === 'production') {
    const stillDefault = defaultedProductionTierFields(profile);
    if (stillDefault.length > 0 && acceptSuggested) {
      for (const field of stillDefault) {
        if (field === 'stage') {
          profile.provenance.stage = 'user';
        } else if (field === 'users.scale') {
          profile.provenance['users.scale'] = 'user';
        } else if (field === 'regulation' && Array.isArray(profile.regulation) && profile.regulation.length > 0) {
          profile.provenance.regulation = 'user';
        } else if (field.startsWith('risks.')) {
          const flag = field.slice('risks.'.length);
          profile.risks[flag] = Boolean(profile.risks[flag]);
          profile.provenance[field] = 'user';
        }
      }
    } else if (stillDefault.length > 0) {
      throw intakeError('INTAKE_DEFAULTED_PRODUCTION_FIELDS',
        `production profile still has defaulted tier-driving field(s): ${stillDefault.join(', ')}. Answer them explicitly before accepting.`
      );
    }
  }

  // Validate against strict profile schema + rule-lint.
  const normalized = normalizeProfile(profile);
  const schemaErrors = validateProfile(normalized);
  if (schemaErrors.length > 0) {
    throw intakeError('INTAKE_PROFILE_INVALID', `accepted profile failed validation: ${schemaErrors.join('; ')}`);
  }
  const ruleLint = lintRawRuleList(normalized.rules ?? [], { profile: normalized, conflicts: normalized.conflicts ?? [] });
  if (!ruleLint.ok) {
    throw intakeError('INTAKE_RULE_CONFLICT',
      `accepted profile has ${ruleLint.blockingCount} unresolved rule conflict(s): ` +
      [...ruleLint.contradictions, ...ruleLint.infeasible].map((c) => c.reason).join('; ')
    );
  }

  mkdirSync(path.dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');

  if (recordEvidence) {
    appendEvidence({
      projectDir: project,
      kind: 'intake-accepted',
      actor,
      subject: path.basename(outAbs),
      payload: {
        draftFile: path.basename(draftAbs),
        profileDigest: digest(profile),
        answeredCount: (profile.questions ?? []).length,
        provenance: getProfileProvenance(profile)
      }
    });
  }

  return {
    ok: true,
    profileFile: outAbs,
    profile,
    provenance: getProfileProvenance(profile),
    answeredCount: (profile.questions ?? []).length
  };
}
