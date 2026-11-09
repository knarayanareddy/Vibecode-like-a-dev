/**
 * Profile loading and validation.
 *
 * The profile is the only input. It is intentionally small: an idea, a kind, a
 * stage, traits and risks. Everything else is derived, and every derived choice
 * must be explainable in one line. If a field cannot change a decision, it does
 * not belong in the profile.
 */

import { readFileSync } from 'node:fs';

export const KINDS = [
  'web-app',
  'api',
  'cli',
  'library',
  'data-pipeline',
  'mobile',
  'agent',
  'automation'
];

export const STAGES = ['prototype', 'mvp', 'internal-tool', 'production'];
export const SCALES = ['small', 'medium', 'large'];

export const TRAITS = [
  'auth',
  'admin',
  'payments',
  'realtime',
  'search',
  'upload',
  'notifications',
  'webhooks',
  'offline',
  'ai',
  'i18n',
  'persistence',
  'background-jobs'
];

/**
 * A regulation is not a boolean. "Regulated" decides rigor; the regime decides
 * *which* obligations exist, and HIPAA, GDPR and PCI-DSS impose different ones.
 * Naming the regime is what lets the compiler add content instead of only weight.
 */
export const REGULATIONS = ['hipaa', 'gdpr', 'pci-dss', 'soc2'];

export const RISK_FLAGS = [
  'pii',
  'payments',
  'regulated',
  'multiTenant',
  'destructiveWrites',
  'publicFacing',
  'integrations'
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;
const PROFILE_KEYS = new Set(['name', 'idea', 'kind', 'stage', 'users', 'traits', 'risks', 'regulation', 'constraints', 'overlays', 'discoverability', 'traitWaivers', 'domain', 'rules', '$comment', '$adopted']);
const USER_KEYS = new Set(['scale']);
const CONSTRAINT_KEYS = new Set(['team', 'weeks', 'stack', 'mustUse']);
const DISCOVERABILITY_KEYS = new Set(['enabled']);
// The words the compiler would otherwise have to guess. Inference is a fallback,
// not an authority: a product owner who says "we call it a visit, our tenants are
// clinics and our privileged actor is the practice manager" should not have to
// argue with a noun picker.
const DOMAIN_KEYS = new Set(['entity', 'entityPlural', 'actors', 'tenant', 'endUser', 'privilegedActor']);
const NOUN_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

/**
 * Record policy-bearing shape faults before applying defaults. Normalization must
 * never turn a misspelled scalar/list into an innocent empty value: those fields
 * determine rigor, generated requirements, and gates.
 */
function inputShapeErrors(raw) {
  if (!plainObject(raw)) return ['profile: must be a JSON object'];
  const errors = [];
  if ('traits' in raw && !Array.isArray(raw.traits)) errors.push('traits: must be a list of known trait ids');
  if ('overlays' in raw && !Array.isArray(raw.overlays)) errors.push('overlays: must be a list of overlay ids');
  if ('regulation' in raw && !Array.isArray(raw.regulation)) errors.push('regulation: must be a list of regimes, e.g. ["hipaa"]');
  if ('risks' in raw && !plainObject(raw.risks)) errors.push('risks: must be an object of boolean risk flags');
  if ('users' in raw && !plainObject(raw.users)) errors.push('users: must be an object');
  if ('constraints' in raw && !plainObject(raw.constraints)) errors.push('constraints: must be an object');
  return errors;
}

/**
 * Suggest the closest known value for a rejected one.
 *
 * A new user's first profile is a guess at the vocabulary, so "unknown trait
 * uploads" with a list of thirteen values leaves them to spot the difference
 * themselves. Damerau-Levenshtein (with adjacent transposition, because typos are
 * usually a swap) is enough at this scale and needs no dependency.
 */
function editDistance(a, b) {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const grid = Array.from({ length: rows }, (_, i) => [i, ...Array(columns - 1).fill(0)]);
  for (let j = 0; j < columns; j += 1) grid[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + 1);
      }
    }
  }
  return grid[rows - 1][columns - 1];
}

/**
 * The closest allowed value, or null when nothing is close enough to be helpful.
 * A bad suggestion is worse than none: it sends the reader to the wrong word.
 */
export function closestMatch(value, allowed, { maxDistance = 2 } = {}) {
  const needle = String(value).toLowerCase();
  // A truncation of the right word ("prod" for "production") is the most common
  // guess, and it is many edits away from the full value at any length.
  const prefix = allowed.find((candidate) => String(candidate).toLowerCase().startsWith(needle) && needle.length >= 3);
  let best = null;
  for (const candidate of allowed) {
    const distance = editDistance(needle, String(candidate).toLowerCase());
    // Allow one extra edit on longer words; short ones must be near-exact.
    const limit = Math.min(maxDistance, Math.max(1, Math.floor(candidate.length / 3)));
    if (distance <= limit && (best === null || distance < best.distance)) best = { candidate, distance };
  }
  // Prefer the shortest candidate that starts with what was typed.
  if (prefix) return prefix;
  return best ? best.candidate : null;
}

/**
 * One line explaining a rejected value: the closest match, or, when the value is
 * legal somewhere else in the profile, that fact.
 *
 * "agent" is a valid *kind*, so telling a reader it is not a trait without saying
 * where it does belong sends them looking for a typo that does not exist.
 */
const SIBLING_VOCABULARIES = [
  { field: 'kind', values: () => KINDS },
  { field: 'stage', values: () => STAGES },
  { field: 'users.scale', values: () => SCALES },
  { field: 'risk flag', values: () => RISK_FLAGS }
];

function describeUnknown(value, field, allowed) {
  const text = String(value);
  const suggestion = closestMatch(text, allowed);
  if (suggestion) return `unknown ${field} "${text}" (did you mean "${suggestion}"? Known: ${allowed.join(', ')})`;
  const elsewhere = SIBLING_VOCABULARIES.find(
    (entry) => entry.field !== field && entry.values().some((candidate) => String(candidate).toLowerCase() === text.toLowerCase())
  );
  if (elsewhere) return `unknown ${field} "${text}" ("${text}" is a valid ${elsewhere.field}, not a ${field}; known ${field}s: ${allowed.join(', ')})`;
  return `unknown ${field} "${text}". Known: ${allowed.join(', ')}`;
}

function unknownKeys(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const hint = label === 'profile' && key === 'risk' ? '; did you mean "risks"?' : '';
      errors.push(`${label}.${key}: unknown field${hint}`);
    }
  }
}

export function normalizeProfile(raw) {
  const shapeErrors = inputShapeErrors(raw);
  // Keep a safe object for the remaining defaulting work even for a null/scalar
  // document. `loadProfile` returns the recorded shape error as a normal input
  // finding (CLI exit 2) rather than leaking a TypeError from a property read.
  raw = plainObject(raw) ? raw : {};
  const profile = {
    name: '',
    idea: '',
    kind: 'web-app',
    stage: 'prototype',
    users: { scale: 'small' },
    traits: [],
    risks: {},
    constraints: {},
    ...raw
  };

  profile.users = { scale: 'small', ...(plainObject(raw.users) ? raw.users : {}) };
  profile.constraints = {
    team: 1,
    weeks: 4,
    stack: 'undecided',
    mustUse: [],
    ...(plainObject(raw.constraints) ? raw.constraints : {})
  };
  profile.traits = Array.isArray(raw.traits) ? raw.traits : [];
  profile.overlays = Array.isArray(raw.overlays) ? raw.overlays : [];
  profile.regulation = Array.isArray(raw.regulation) ? raw.regulation.map((value) => String(value).toLowerCase()) : [];
  profile.traitWaivers = Array.isArray(raw.traitWaivers) ? raw.traitWaivers : [];
  profile.risks = { ...(plainObject(raw.risks) ? raw.risks : {}) };
  Object.defineProperty(profile, '__inputShapeErrors', { value: shapeErrors, enumerable: false });

  return profile;
}

export function validateProfile(profile) {
  const errors = [...(Array.isArray(profile?.__inputShapeErrors) ? profile.__inputShapeErrors : [])];
  if (!plainObject(profile)) return [...errors, 'profile: must be a JSON object'];

  // The profile controls rigor, requirements, and gates. Preserve no unknown
  // policy-bearing field as inert data: a typo such as `risk` must fail instead
  // of quietly compiling a lower-rigor packet.
  unknownKeys(profile, PROFILE_KEYS, 'profile', errors);
  unknownKeys(profile.users, USER_KEYS, 'users', errors);
  unknownKeys(profile.constraints, CONSTRAINT_KEYS, 'constraints', errors);
  if ('discoverability' in profile) {
    if (!profile.discoverability || typeof profile.discoverability !== 'object' || Array.isArray(profile.discoverability)) {
      errors.push('discoverability: must be an object with enabled: true or false');
    } else {
      unknownKeys(profile.discoverability, DISCOVERABILITY_KEYS, 'discoverability', errors);
      if (typeof profile.discoverability.enabled !== 'boolean') errors.push('discoverability.enabled: must be true or false; required when discoverability is set');
    }
  }

  // Adoption records inference provenance under these namespaced metadata fields.
  // They are deliberately not router inputs, but must retain basic safe shapes.
  if ('$comment' in profile && typeof profile.$comment !== 'string') errors.push('profile.$comment: must be a string');
  if ('$adopted' in profile && (!profile.$adopted || typeof profile.$adopted !== 'object' || Array.isArray(profile.$adopted))) errors.push('profile.$adopted: must be an object');

  if (!profile.name || !ID_PATTERN.test(profile.name)) {
    errors.push('name: required, lowercase kebab-case, 2-60 chars (e.g. "retro-board")');
  }

  if (!profile.idea || String(profile.idea).trim().length < 20) {
    errors.push('idea: required, at least 20 characters. One paragraph of intent is enough.');
  }

  if (String(profile.idea || '').length > 2000) {
    errors.push('idea: keep it under 2000 characters. The brief is expanded later, not dumped here.');
  }

  if (!KINDS.includes(profile.kind)) {
    errors.push(`kind: ${describeUnknown(profile.kind, 'kind', KINDS)}`);
  }

  if (!STAGES.includes(profile.stage)) {
    errors.push(`stage: ${describeUnknown(profile.stage, 'stage', STAGES)}`);
  }

  if (!SCALES.includes(profile.users.scale)) {
    errors.push(`users.scale: ${describeUnknown(profile.users.scale, 'scale', SCALES)}`);
  }

  for (const trait of profile.traits) {
    if (!TRAITS.includes(trait)) {
      errors.push(`traits: ${describeUnknown(trait, 'trait', TRAITS)}. Unknown traits are rejected so the router cannot silently ignore a decision.`);
    }
  }

  for (const [flag, value] of Object.entries(profile.risks)) {
    if (!RISK_FLAGS.includes(flag)) {
      errors.push(`risks.${flag}: unknown risk flag. Known: ${RISK_FLAGS.join(', ')}`);
    }
    if (typeof value !== 'boolean') {
      errors.push(`risks.${flag}: must be true or false`);
    }
  }

  if (!Array.isArray(profile.regulation)) {
    errors.push('regulation: must be a list of regimes, e.g. ["hipaa"]');
  } else {
    for (const regime of profile.regulation) {
      if (!REGULATIONS.includes(regime)) {
        errors.push(`regulation: unknown regime "${regime}". Known: ${REGULATIONS.join(', ')}. Name the regime so the compiler can add its obligations instead of only raising the tier.`);
      }
    }
    if (new Set(profile.regulation).size !== profile.regulation.length) {
      errors.push('regulation: a regime is listed twice; its obligations apply once');
    }
    // A boolean flag with no regime is the exact shape that produced a tier-3
    // health packet with no HIPAA requirement in it. Under --strict this is an
    // error; outside strict it is reported by `plan`.
    if (profile.risks?.regulated === true && profile.regulation.length === 0) {
      profile.__regulatedWithoutRegime = true;
    }
  }

  if ('domain' in profile) {
    if (!profile.domain || typeof profile.domain !== 'object' || Array.isArray(profile.domain)) {
      errors.push('domain: must be an object such as { entity, actors, tenant, privilegedActor }');
    } else {
      unknownKeys(profile.domain, DOMAIN_KEYS, 'domain', errors);
      for (const key of ['entity', 'entityPlural', 'tenant', 'endUser', 'privilegedActor']) {
        if (key in profile.domain && (typeof profile.domain[key] !== 'string' || !NOUN_PATTERN.test(profile.domain[key]))) {
          errors.push(`domain.${key}: must be a lowercase noun (kebab-case allowed), e.g. "visit"`);
        }
      }
      if ('actors' in profile.domain) {
        if (!Array.isArray(profile.domain.actors)) errors.push('domain.actors: must be a list of lowercase nouns');
        else profile.domain.actors.forEach((actor, position) => {
          if (typeof actor !== 'string' || !NOUN_PATTERN.test(actor)) errors.push(`domain.actors[${position}]: must be a lowercase noun`);
        });
      }
    }
  }

  // An author may pin an idea-level rule to the requirement that covers it. The
  // heuristic in the coverage detector is a classifier, and a classifier that cannot
  // be corrected is a classifier people route around.
  if ('rules' in profile) {
    if (!Array.isArray(profile.rules)) {
      errors.push('rules: must be a list of { text, covers: "REQ-008" } entries');
    } else {
      profile.rules.forEach((rule, position) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          errors.push(`rules[${position}]: must be an object with text and covers`);
          return;
        }
        const unknownRuleKeys = Object.keys(rule).filter((key) => !['text', 'covers', 'why'].includes(key));
        if (unknownRuleKeys.length > 0) errors.push(`rules[${position}].${unknownRuleKeys[0]}: unknown field`);
        if (typeof rule.text !== 'string' || rule.text.trim().length < 10) {
          errors.push(`rules[${position}].text: quote the idea sentence this pins (10+ characters)`);
        }
        if (typeof rule.covers !== 'string' || !/^REQ-\d{3,}$/.test(rule.covers)) {
          errors.push(`rules[${position}].covers: must be a requirement id such as "REQ-008"`);
        }
      });
    }
  }

  // A waiver is deliberate, dated debt. It must name a trait, a reason and an
  // expiry: an undated waiver is an undocumented gap that never gets closed.
  if (!Array.isArray(profile.traitWaivers)) {
    errors.push('traitWaivers: must be a list of { trait, reason, expires } entries');
  } else {
    profile.traitWaivers.forEach((waiver, position) => {
      if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
        errors.push(`traitWaivers[${position}]: must be an object with trait, reason and expires`);
        return;
      }
      if (!TRAITS.includes(waiver.trait)) errors.push(`traitWaivers[${position}].trait: unknown trait "${waiver.trait}"`);
      if (typeof waiver.reason !== 'string' || waiver.reason.trim().length < 10) {
        errors.push(`traitWaivers[${position}].reason: say why the trait is uncovered (10+ characters)`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(waiver.expires ?? '')) || Number.isNaN(Date.parse(waiver.expires))) {
        errors.push(`traitWaivers[${position}].expires: must be a YYYY-MM-DD date, so the waiver cannot live forever`);
      }
    });
  }

  if (!Array.isArray(profile.overlays)) {
    errors.push('overlays: must be a list of overlay ids, e.g. ["org-baseline", "health-data"]');
  } else {
    for (const id of profile.overlays) {
      if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(String(id))) {
        errors.push(`overlays: "${id}" is not a kebab-case overlay id`);
      }
    }
    if (new Set(profile.overlays).size !== profile.overlays.length) {
      errors.push('overlays: an overlay is listed twice; layers apply once');
    }
  }

  for (const key of ['team', 'weeks']) {
    const value = profile.constraints[key];
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`constraints.${key}: must be a positive number`);
    }
  }

  // Both fields are rendered into the packet. Validate their shape here rather
  // than letting a malformed optional value turn into an emitter stack trace.
  // Newlines would also let profile data become Markdown structure.
  if (typeof profile.constraints.stack !== 'string' || profile.constraints.stack.trim() === '') {
    errors.push('constraints.stack: must be a non-empty string');
  } else if (/[\r\n]/.test(profile.constraints.stack)) {
    errors.push('constraints.stack: must be one line');
  }

  if (!Array.isArray(profile.constraints.mustUse)) {
    errors.push('constraints.mustUse: must be a list of one-line strings');
  } else {
    profile.constraints.mustUse.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '' || /[\r\n]/.test(entry)) {
        errors.push(`constraints.mustUse[${index}]: must be a non-empty one-line string`);
      }
    });
  }

  return errors;
}

/**
 * Strings that look like an attempt to instruct the reader rather than describe
 * a product. Detected, not silently stripped: the author should see the finding,
 * and `--strict` should refuse to compile it.
 */
const INJECTION_PATTERNS = [
  [/\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding)\b/i, 'asks the reader to ignore previous instructions'],
  [/\b(?:disregard|forget)\s+(?:all\s+)?(?:your|the)\s+(?:previous\s+)?(?:instructions|rules|prompt)\b/i, 'asks the reader to discard its instructions'],
  [/^\s*#{1,6}\s*REQ-\d+/im, 'forges a requirement heading'],
  [/\bcurl\s+\S+\s*\|\s*(?:sh|bash|zsh)\b/i, 'pipes a download into a shell'],
  [/\bwget\s+\S+\s*\|\s*(?:sh|bash|zsh)\b/i, 'pipes a download into a shell'],
  [/```/, 'contains a fenced code block'],
  [/\b(?:exfiltrate|send\s+(?:the|all)\s+(?:secrets?|keys?|env(?:ironment)?)\b)/i, 'asks for secret material'],
  [/\byou\s+are\s+now\b/i, 'reassigns the reader\'s role']
];

export function injectionFindings(profile) {
  const findings = [];
  for (const [field, value] of Object.entries({ idea: profile?.idea, name: profile?.name, '$comment': profile?.$comment })) {
    if (typeof value !== 'string' || value === '') continue;
    for (const [pattern, reason] of INJECTION_PATTERNS) {
      if (pattern.test(value)) findings.push(`${field}: ${reason}. The idea is data the reader interprets, never a command it follows.`);
    }
    if (/https?:\/\//.test(value)) findings.push(`${field}: contains a URL. Requirements should name what to build, not where to fetch it.`);
  }
  return findings;
}

export function loadProfile(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read profile at ${filePath}: ${error.message}`);
  }

  const profile = normalizeProfile(raw);
  const errors = validateProfile(profile);
  return { profile, errors };
}
