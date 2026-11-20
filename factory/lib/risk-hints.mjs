/**
 * Deterministic risk-hint and regime-hint scanner (roadmap 1.1, F-01 / F-06).
 *
 * Reads `factory/risk-hints.json` and scans `profile.idea` sentence-by-sentence
 * for domain cues whose corresponding `profile.risks.<flag>` boolean is omitted
 * or false, or whose regulatory regime is missing from `profile.regulation`.
 *
 * Purity contract:
 *   - Never mutates `profile.risks` or `profile.regulation`.
 *   - Respects explicit negation windows ("never stores personal data", "no credit cards").
 *   - Respects dated waivers in `profile.riskWaivers: [{ flag, reason, expires }]`;
 *     expired waivers are reported separately so debt cannot outlive its date.
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
      negations: (raw.negationPrefixes ?? []).map((src) => new RegExp(`${src}$`, 'i')),
      risks: (raw.risks ?? []).map((entry) => ({
        flag: entry.flag,
        why: entry.why,
        cues: (entry.cues ?? []).map((cue) => ({
          id: cue.id,
          regex: new RegExp(cue.pattern, 'i')
        }))
      })),
      regimes: (raw.regimes ?? []).map((entry) => ({
        regime: entry.regime,
        why: entry.why,
        regex: new RegExp(entry.pattern, 'i')
      }))
    };
  }
  return cached;
}

function splitSentences(idea) {
  return String(idea ?? '')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isNegated(sentence, matchIndex, negations) {
  const before = sentence.slice(Math.max(0, matchIndex - 70), matchIndex);
  if (negations.some((re) => re.test(before))) return true;
  // Also skip explicit non-goal sentences ("Out of scope: ...", "Never produces ...").
  if (/^(?:out of scope|non-goals?|excludes?|not in scope)\b/i.test(sentence)) return true;
  return false;
}

function isWaiverExpired(expires, referenceDate) {
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return true;
  if (!referenceDate) return false;
  return expires < referenceDate;
}

/**
 * Deterministically scan a normalized profile for unflagged risk cues and
 * suggested regulation overlays.
 *
 * Note on determinism: `referenceDate` defaults to `null` during pure plan
 * generation so `buildPlan` remains byte-identical across calendar days; CLI
 * strict/explain callers may pass today's `YYYY-MM-DD` to flag expired waivers.
 */
export function scanRiskHints(profile, { rules = loadRiskHints(), referenceDate = null } = {}) {
  const sentences = splitSentences(profile?.idea);
  const risks = profile?.risks ?? {};
  const traits = new Set(Array.isArray(profile?.traits) ? profile.traits : []);
  const declaredRegimes = new Set(Array.isArray(profile?.regulation) ? profile.regulation.map((r) => String(r).toLowerCase()) : []);
  const waivers = Array.isArray(profile?.riskWaivers) ? profile.riskWaivers : [];
  const waiverByFlag = new Map(waivers.map((waiver) => [waiver.flag, waiver]));

  const unflaggedRisks = [];
  const waivedRisks = [];
  const expiredWaivers = [];

  for (const rule of rules.risks) {
    if (risks[rule.flag] === true) continue;
    // Trait parity: `traits: ["payments"]` already triggers full payment rigor
    // via policy.json's dedicated signal, only flag when the risk boolean is false
    // so the author makes it explicit or waives it.
    let hit = null;
    for (const sentence of sentences) {
      for (const cue of rule.cues) {
        const match = cue.regex.exec(sentence);
        if (!match) continue;
        if (isNegated(sentence, match.index, rules.negations)) continue;
        hit = {
          flag: rule.flag,
          cue: cue.id,
          phrase: match[0],
          sentence,
          why: rule.why,
          traitPresent: rule.flag === 'payments' && traits.has('payments')
        };
        break;
      }
      if (hit) break;
    }
    if (!hit) continue;

    const waiver = waiverByFlag.get(rule.flag);
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
  for (const rule of rules.regimes) {
    if (declaredRegimes.has(rule.regime)) continue;
    for (const sentence of sentences) {
      const match = rule.regex.exec(sentence);
      if (!match) continue;
      if (isNegated(sentence, match.index, rules.negations)) continue;
      suggestedRegimes.push({
        regime: rule.regime,
        phrase: match[0],
        sentence,
        why: rule.why
      });
      break;
    }
  }

  return {
    unflaggedRisks,
    waivedRisks,
    expiredWaivers,
    suggestedRegimes
  };
}

/** Format human-readable one-line findings for CLI / plan warnings. */
export function formatRiskHintWarnings(scan, profile) {
  const lines = [];
  for (const hit of scan.unflaggedRisks) {
    const suffix = hit.expiredWaiver
      ? ` (waiver expired ${hit.expiredWaiver})`
      : '';
    lines.push(
      `risk hint: idea mentions "${hit.phrase}" but risks.${hit.flag} is not true${suffix}. ` +
      `Set "risks.${hit.flag}": true or record a dated waiver in "riskWaivers".`
    );
  }
  if (scan.suggestedRegimes.length > 0) {
    const regulated = profile?.risks?.regulated === true;
    const declared = profile?.regulation ?? [];
    // Always suggest regimes when regulated has none, or when a specific named
    // regime (COPPA, FERPA, HIPAA, SOX, DORA, EU AI Act) appears explicitly.
    for (const suggestion of scan.suggestedRegimes) {
      const explicitCue = /\b(?:hipaa|coppa|ferpa|sox|sarbanes|dora|eu ai act|pci|gdpr|soc\s*2|under 13|under thirteen|student records?|k-12)\b/i.test(suggestion.phrase);
      if ((regulated && declared.length === 0) || explicitCue) {
        lines.push(
          `regulation hint: idea mentions "${suggestion.phrase}" — consider adding "${suggestion.regime}" to profile.regulation (${suggestion.why})`
        );
      }
    }
  }
  return lines;
}
