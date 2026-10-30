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

export function normalizeProfile(raw) {
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

  profile.users = { scale: 'small', ...(raw.users || {}) };
  profile.constraints = {
    team: 1,
    weeks: 4,
    stack: 'undecided',
    mustUse: [],
    ...(raw.constraints || {})
  };
  profile.traits = Array.isArray(raw.traits) ? raw.traits : [];
  profile.overlays = Array.isArray(raw.overlays) ? raw.overlays : [];
  profile.risks = { ...(raw.risks || {}) };

  return profile;
}

export function validateProfile(profile) {
  const errors = [];

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
    errors.push(`kind: must be one of ${KINDS.join(', ')} (got "${profile.kind}")`);
  }

  if (!STAGES.includes(profile.stage)) {
    errors.push(`stage: must be one of ${STAGES.join(', ')} (got "${profile.stage}")`);
  }

  if (!SCALES.includes(profile.users.scale)) {
    errors.push(`users.scale: must be one of ${SCALES.join(', ')} (got "${profile.users.scale}")`);
  }

  for (const trait of profile.traits) {
    if (!TRAITS.includes(trait)) {
      errors.push(
        `traits: unknown trait "${trait}". Known: ${TRAITS.join(', ')}. Unknown traits are rejected so the router cannot silently ignore a decision.`
      );
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
