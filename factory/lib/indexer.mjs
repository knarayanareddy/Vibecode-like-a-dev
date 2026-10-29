import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstHeading, parseFrontmatter } from './frontmatter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const PRIMITIVES_DIR = path.join(ROOT, 'primitives');
export const INDEX_PATH = path.join(PRIMITIVES_DIR, 'index.json');

const REQUIRED_FIELDS = ['id', 'module', 'summary', 'tier_min', 'cost', 'priority'];
const ALLOWED_COST = new Set(['low', 'medium', 'high']);
const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

// Every practice carries the two sections that make a skill stick under pressure —
// the excuses a competent person makes while skipping it, and the signals that they
// already did. A SECTION-level floor (three of each) rather than a word count: one
// red flag is an anecdote, three is a pattern an agent can match against a diff.
const SECTIONS = {
  'Red flags': { kind: 'bullets', min: 3 },
  'Anti-rationalization': { kind: 'table', min: 3 },
  'In this product': { kind: 'obligation', min: 1 }
};

/** Pull `## Heading` blocks out of a SKILL.md body, in order. */
function sectionsOf(body) {
  const found = new Map();
  const lines = body.split('\n');
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      found.set(current, []);
      continue;
    }
    if (current) found.get(current).push(line);
  }
  return found;
}

/** Count the rows a section contributes: bullets, or body rows of a markdown table. */
function countEntries(kind, lines) {
  if (kind === 'bullets') return lines.filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
  if (kind === 'table') {
    return lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('|') && !/^\|[\s|:-]+\|$/.test(trimmed) && !/^\|\s*Excuse\b/i.test(trimmed);
    }).length;
  }
  return lines.join('\n').trim() === '' ? 0 : 1;
}

// A practice without a consequence is advice. `gates` bind a practice to the policy
// checks it makes real; `advisory` is the honest escape hatch, and it costs a reason.
const PRODUCT_SLOT = /\{(primary|aPrimary|primaryPlural|secondary|aSecondary|secondaryPlural|project|db)\}/;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name === 'SKILL.md') found.push(full);
  }
  return found.sort();
}

export function loadPrimitives() {
  const files = walk(PRIMITIVES_DIR);

  return files.map((file) => {
    const raw = readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const relativeDir = path.relative(PRIMITIVES_DIR, path.dirname(file));
    const module = relativeDir.split(path.sep)[0];

    return {
      data,
      body,
      file,
      module,
      dir: relativeDir,
      relPath: path.relative(ROOT, file).split(path.sep).join('/'),
      // The raw frontmatter block, so validation can catch syntax the parser drops.
      frontmatterLines: (() => {
        const lines = raw.split(/\r?\n/);
        if (lines[0].trim() !== '---') return [];
        const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
        return close === -1 ? [] : lines.slice(1, close);
      })()
    };
  });
}

export function validatePrimitives(entries) {
  const errors = [];
  const seen = new Map();

  for (const entry of entries) {
    const where = entry.relPath;

    for (const field of REQUIRED_FIELDS) {
      if (entry.data[field] === undefined || entry.data[field] === '') {
        errors.push(`${where}: missing required field "${field}"`);
      }
    }

    const { id, tier_min: tierMin, cost, priority } = entry.data;

    if (id && !ID_PATTERN.test(id)) {
      errors.push(`${where}: id "${id}" must look like "module.primitive-name"`);
    }

    if (id && seen.has(id)) {
      errors.push(`${where}: duplicate id "${id}" (also in ${seen.get(id)})`);
    } else if (id) {
      seen.set(id, where);
    }

    if (id && !String(id).startsWith(`${entry.module}.`)) {
      errors.push(`${where}: id "${id}" must be namespaced under "${entry.module}."`);
    }

    if (tierMin !== undefined && ![0, 1, 2, 3].includes(tierMin)) {
      errors.push(`${where}: tier_min must be 0, 1, 2 or 3 (got ${tierMin})`);
    }

    if (cost !== undefined && !ALLOWED_COST.has(cost)) {
      errors.push(`${where}: cost must be one of ${[...ALLOWED_COST].join(', ')} (got ${cost})`);
    }

    if (priority !== undefined && !(Number.isInteger(priority) && priority >= 1 && priority <= 9)) {
      errors.push(`${where}: priority must be an integer 1-9 (got ${priority})`);
    }

    if (!firstHeading(entry.body)) {
      errors.push(`${where}: body must start with a level-1 heading`);
    }

    const sections = sectionsOf(entry.body);
    for (const [name, rule] of Object.entries(SECTIONS)) {
      const lines = sections.get(name);
      if (!lines) {
        errors.push(`${where}: missing section "## ${name}"`);
        continue;
      }
      const count = countEntries(rule.kind, lines);
      if (count < rule.min) {
        errors.push(`${where}: "## ${name}" needs at least ${rule.min} ${rule.kind === 'table' ? 'rows' : 'entries'} (found ${count})`);
      }
    }

    // The obligation is what the packet says about this practice in *this* product,
    // so a sentence with no slot is a sentence that cannot adapt.
    const obligation = entry.data.obligation;
    if (!obligation || String(obligation).trim() === '') {
      errors.push(`${where}: missing required field "obligation"`);
    } else if (!PRODUCT_SLOT.test(String(obligation))) {
      errors.push(`${where}: obligation must name the product through a slot like {primary} or {project}`);
    }

    const gates = entry.data.gates;
    if (gates !== undefined && !Array.isArray(gates)) {
      errors.push(`${where}: gates must be an inline list, e.g. [G1-SECRETS]`);
    }
    for (const gate of Array.isArray(gates) ? gates : []) {
      if (typeof gate !== 'string' || gate.trim() === '') {
        errors.push(`${where}: gates must be gate ids, not objects`);
      }
    }

    // A nested block parses to an empty scalar and disappears without a word, which is
    // how a declared gate lived in this library while the compiler never saw it.
    for (const line of entry.frontmatterLines ?? []) {
      if (/^\s+\S/.test(line)) {
        errors.push(`${where}: nested YAML is not supported — "${line.trim()}" would be silently ignored`);
      }
    }

    if (entry.data.advisory !== undefined) {
      if (entry.data.advisory !== true) {
        errors.push(`${where}: advisory is only valid as \`true\``);
      } else if (!entry.data.advisory_reason || String(entry.data.advisory_reason).trim().length < 30) {
        errors.push(`${where}: advisory practices must state advisory_reason (why no gate can check them)`);
      }
    }

    if (/{{[A-Z_]+}}/.test(entry.body) === false && entry.body.length < 400) {
      errors.push(`${where}: body looks too thin to be useful (< 400 chars)`);
    }
  }

  return errors;
}

export function buildIndex() {
  const entries = loadPrimitives();
  const errors = validatePrimitives(entries);

  const primitives = entries
    .map(({ data, dir, relPath }) => ({
      id: data.id,
      module: data.module,
      title: data.title || '',
      summary: data.summary,
      tier_min: data.tier_min,
      cost: data.cost,
      priority: data.priority,
      enforces: data.enforces || [],
      gates: data.gates || [],
      // A practice may be worth having and still be unenforceable by a machine. Say so
      // explicitly, with a reason, instead of leaving `enforces` empty and hoping.
      advisory: data.advisory === true,
      advisory_reason: data.advisory_reason || '',
      obligation: data.obligation || '',
      artifacts: data.artifacts || [],
      tags: data.tags || [],
      triggers: data.triggers || [],
      path: relPath,
      dir
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    meta: {
      purpose: 'Machine-readable catalog for agent traversal. Read this before opening any SKILL.md.',
      generatedFrom: 'primitives/**/SKILL.md',
      count: primitives.length,
      note: 'Do not edit by hand. Run `vld index` after changing a primitive.'
    },
    primitives
  };
}

export function serializeIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function writeIndex({ check = false } = {}) {
  const entries = loadPrimitives();
  const errors = validatePrimitives(entries);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const next = serializeIndex(buildIndex());
  const current = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf8') : '';

  if (check) {
    if (current !== next) {
      return { ok: false, errors: ['primitives/index.json is stale. Run: npm run index'] };
    }
    return { ok: true, errors: [], count: entries.length, changed: false };
  }

  if (current !== next) {
    writeFileSync(INDEX_PATH, next, 'utf8');
    return { ok: true, errors: [], count: entries.length, changed: true };
  }

  return { ok: true, errors: [], count: entries.length, changed: false };
}

export function loadIndex() {
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}
