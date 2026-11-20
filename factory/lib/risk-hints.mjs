/**
 * Deterministic risk-hint and regime-hint scanner v2 (roadmap P1.1, F-01 / F-06).
 *
 * Reads `factory/risk-hints.json` and scans `profile.idea` sentence-by-sentence,
 * collecting EVERY matching cue grouped by `flag` (and by `regime`) with the
 * matched cue ID, exact phrase substring, and originating sentence.
 *
 * Purity contract:
 *   - Never mutates `profile.risks` or `profile.regulation`.
 *   - Respects explicit clause-level negation windows ("never stores personal data",
 *     "no credit cards", "without third-party APIs", "not public-facing") and
 *     explicit out-of-scope sentences without masking positive cues in sibling clauses.
 *   - Respects dated waivers in `profile.riskWaivers: [{ flag, reason, expires }]`;
 *     expired waivers surface explicitly so waived debt never outlives its expiry date.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';

const RISK_HINTS_PATH = path.join(ROOT, 'factory', 'risk-hints.json');

let cached = null;

export function loadRiskHints() {
  if (!cached) {
    const raw = JSON.parse(readFileSync(RISK_HINTS_PATH, 'utf8'));
    cached = {
      version: raw.version,
      negations: (raw.negationPrefixes ?? []).map((src) => new RegExp(src, 'i')),
      negationAnchored: (raw.negationPrefixes ?? []).map((src) => new RegExp(`${src}$`, 'i')),
      risks: (raw.risks ?? []).map((entry) => ({
        flag: entry.flag,
        why: entry.why,
        cues: (entry.cues ?? []).map((cue) => ({
          id: cue.id,
          source: cue.pattern,
          regex: new RegExp(cue.pattern, 'gi')
        }))
      })),
      regimes: (raw.regimes ?? []).map((entry) => {
        const cues = Array.isArray(entry.cues)
          ? entry.cues
          : [{ id: entry.regime, pattern: entry.pattern }];
        return {
          regime: entry.regime,
          why: entry.why,
          cues: cues.map((cue) => ({
            id: cue.id,
            source: cue.pattern,
            regex: new RegExp(cue.pattern, 'gi')
          }))
        };
      })
    };
  }
  return cached;
}

export function splitIdeaSentences(idea) {
  return String(idea ?? '')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Determine whether a match at `[matchIndex, matchIndex + matchLen)` is governed
 * by an explicit negation inside the same clause.
 */
function isNegated(sentence, matchIndex, matchLen, rules) {
  if (/^(?:out\s+of\s+scope|non[- ]goals?|excludes?|not\s+in\s+scope)\s*[:—-]/i.test(sentence)) {
    return true;
  }

  // Isolate preceding text back to the nearest clause boundary (`but`, `however`,
  // `while`, `whereas`, `except`, `;`, `—`). Commas inside a negated list
  // ("no PII, credit cards, or webhooks") remain in scope.
  const rawBefore = sentence.slice(Math.max(0, matchIndex - 96), matchIndex);
  const boundaryMatch = rawBefore.match(/(?:.*)(?:\b(?:but|however|although|though|while|whereas|yet|instead)\b|[;:—])\s*/i);
  const clauseBefore = boundaryMatch ? rawBefore.slice(boundaryMatch[0].length) : rawBefore;

  // Direct negation immediately preceding the phrase (allowing up to 2 short modifiers).
  if (rules.negationAnchored.some((re) => re.test(clauseBefore))) return true;
  const trimmedMod = clauseBefore.replace(/(?:\b(?:any|all|user|customer|client|patient|student|external|remote|stored|live|real|raw|direct|online|hosted|cloud|paid)\s+){1,3}$/i, '');
  if (trimmedMod !== clauseBefore && rules.negationAnchored.some((re) => re.test(trimmedMod))) return true;

  // Coordinated negation list: "never stores personal data or phone numbers",
  // "no PII, credit cards, or third-party APIs", "does not handle PHI or payouts".
  if (
    /\b(?:no|zero|without|never\s+\w+|does\s+not\s+\w+|do\s+not\s+\w+|free\s+(?:of|from)|excludes?|prohibits?)\b[^.!?]{0,65}(?:,\s*(?:or\s+|nor\s+)?|\s+(?:or|nor)\s+)$/i.test(
      clauseBefore
    )
  ) {
    return true;
  }

  // Post-match negation: "personal data is never stored", "payments are out of scope",
  // "webhooks are not supported", "third-party APIs are prohibited".
  const after = sentence.slice(matchIndex + matchLen, Math.min(sentence.length, matchIndex + matchLen + 55));
  if (
    /^\s+(?:is|are|remain|remains)\s+(?:never|not)\s+(?:stored|collected|handled|processed|accepted|charged|used|called|exposed|supported|allowed|enabled|retained|sent|included|in\s+scope)\b/i.test(
      after
    ) ||
    /^\s+(?:is|are)\s+(?:out\s+of\s+scope|excluded|disabled|prohibited|forbidden)\b/i.test(after)
  ) {
    return true;
  }

  // Explicit single-tenant / internal-only / read-only disavowals.
  const matchedText = sentence.slice(matchIndex, matchIndex + matchLen).toLowerCase();
  if (/multi[-\s]?tenant/.test(matchedText) && /\bsingle[-\s]?tenant\b/i.test(clauseBefore)) return true;

  return false;
}

function collectRuleMatches(sentences, cues, rules) {
  const matches = [];
  const seen = new Set();
  for (const sentence of sentences) {
    for (const cue of cues) {
      const re = new RegExp(cue.source, 'gi');
      let match;
      while ((match = re.exec(sentence)) !== null) {
        const phrase = match[0];
        if (isNegated(sentence, match.index, phrase.length, rules)) continue;
        const dedupKey = `${cue.id}::${sentence}::${match.index}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        matches.push({
          cue: cue.id,
          phrase,
          index: match.index,
          sentence
        });
      }
    }
  }
  return matches;
}

function isWaiverExpired(expires, referenceDate) {
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return true;
  if (!referenceDate) return false;
  return expires < referenceDate;
}

/**
 * Scan raw idea prose for EVERY positive risk flag and regulatory regime cue,
 * grouped by flag and regime, irrespective of declared profile fields.
 */
export function scanAllIdeaCues(idea, { rules = loadRiskHints() } = {}) {
  const sentences = splitIdeaSentences(idea);
  const risks = [];
  for (const rule of rules.risks) {
    const matches = collectRuleMatches(sentences, rule.cues, rules);
    if (matches.length === 0) continue;
    risks.push({
      flag: rule.flag,
      cue: matches[0].cue,
      phrase: matches[0].phrase,
      sentence: matches[0].sentence,
      cues: [...new Set(matches.map((m) => m.cue))],
      matches: matches.map(({ cue, phrase, sentence }) => ({ cue, phrase, sentence })),
      why: rule.why
    });
  }

  const regimes = [];
  for (const rule of rules.regimes) {
    const matches = collectRuleMatches(sentences, rule.cues, rules);
    if (matches.length === 0) continue;
    regimes.push({
      regime: rule.regime,
      cue: matches[0].cue,
      phrase: matches[0].phrase,
      sentence: matches[0].sentence,
      cues: [...new Set(matches.map((m) => m.cue))],
      matches: matches.map(({ cue, phrase, sentence }) => ({ cue, phrase, sentence })),
      why: rule.why
    });
  }

  return { risks, regimes };
}

/**
 * Deterministically scan a normalized profile for unflagged risk cues and
 * missing regulation overlays. Every match across the idea is preserved and
 * grouped under `hit.matches` (with `cue`, `phrase`, `sentence` at top level
 * referencing the primary match for backwards compatibility).
 */
export function scanRiskHints(profile, { rules = loadRiskHints(), referenceDate = null } = {}) {
  const raw = scanAllIdeaCues(profile?.idea, { rules });
  const risks = profile?.risks ?? {};
  const traits = new Set(Array.isArray(profile?.traits) ? profile.traits : []);
  const declaredRegimes = new Set(
    Array.isArray(profile?.regulation) ? profile.regulation.map((r) => String(r).toLowerCase()) : []
  );
  const waivers = Array.isArray(profile?.riskWaivers) ? profile.riskWaivers : [];
  const waiverByFlag = new Map(waivers.map((waiver) => [waiver.flag, waiver]));

  const unflaggedRisks = [];
  const waivedRisks = [];
  const expiredWaivers = [];

  for (const detected of raw.risks) {
    if (risks[detected.flag] === true) continue;
    const hit = {
      ...detected,
      traitPresent: detected.flag === 'payments' && traits.has('payments')
    };

    const waiver = waiverByFlag.get(detected.flag);
    if (waiver) {
      if (isWaiverExpired(waiver.expires, referenceDate)) {
        expiredWaivers.push({ ...hit, reason: waiver.reason, expires: waiver.expires });
        unflaggedRisks.push({ ...hit, expiredWaiver: waiver.expires });
      } else {
        waivedRisks.push({ ...hit, reason: waiver.reason, expires: waiver.expires });
      }
      continue;
    }
    unflaggedRisks.push(hit);
  }

  const suggestedRegimes = [];
  for (const detected of raw.regimes) {
    if (declaredRegimes.has(detected.regime)) continue;
    const regimeWaiver = waiverByFlag.get(`regulation:${detected.regime}`);
    if (regimeWaiver && !isWaiverExpired(regimeWaiver.expires, referenceDate)) continue;
    suggestedRegimes.push(detected);
  }

  return {
    unflaggedRisks,
    undeclaredFlags: unflaggedRisks,
    waivedRisks,
    expiredWaivers,
    suggestedRegimes,
    detectedFlags: raw.risks.map((r) => r.flag),
    detectedRegimes: raw.regimes.map((r) => r.regime)
  };
}

/** Format human-readable grouped findings for CLI / plan warnings. */
export function formatRiskHintWarnings(scan, profile) {
  const lines = [];
  for (const hit of scan.unflaggedRisks) {
    const suffix = hit.expiredWaiver ? ` (waiver expired ${hit.expiredWaiver})` : '';
    const allPhrases = [...new Set((hit.matches ?? [{ phrase: hit.phrase }]).map((m) => `"${m.phrase}"`))];
    const phraseSummary = allPhrases.slice(0, 4).join(', ') + (allPhrases.length > 4 ? ` (+${allPhrases.length - 4} more)` : '');
    const cueSummary = (hit.cues ?? [hit.cue]).join(', ');
    lines.push(
      `risk hint [${hit.flag}]: idea mentions ${phraseSummary} (cue: ${cueSummary}) in "${hit.sentence}" but risks.${hit.flag} is not true${suffix}. ` +
      `Set "risks.${hit.flag}": true or record a dated waiver in "riskWaivers".`
    );
  }
  if (scan.suggestedRegimes.length > 0) {
    const regulated = profile?.risks?.regulated === true;
    const declared = profile?.regulation ?? [];
    for (const suggestion of scan.suggestedRegimes) {
      const explicitCue = /\b(?:hipaa|coppa|ferpa|sox|sarbanes|dora|eu\s+ai\s+act|pci|cardholder|raw\s+card|gdpr|ccpa|cpra|california\s+(?:consumer|resident|privacy)|sec-gpc|soc\s*2|under\s+13|under\s+thirteen|kids?\s+aged?\s*(?:[3-9]|1[0-2])|parental\s+consent|parents?\s+approve|student\s+records?|k-12|eu\s+clinics?|therapy\s+appointments?)\b/i.test(
        (suggestion.matches ?? [suggestion]).map((m) => m.phrase).join(' ')
      );
      if ((regulated && declared.length === 0) || explicitCue) {
        lines.push(
          `regulation hint [${suggestion.regime}]: idea mentions "${suggestion.phrase}" in "${suggestion.sentence}" — consider adding "${suggestion.regime}" to profile.regulation (${suggestion.why})`
        );
      }
    }
  }
  return lines;
}
