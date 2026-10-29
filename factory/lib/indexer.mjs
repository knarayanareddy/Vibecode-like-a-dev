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
      relPath: path.relative(ROOT, file).split(path.sep).join('/')
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
