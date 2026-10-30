/**
 * A Model Context Protocol server over stdio, with no dependencies.
 *
 * Why this exists: handing an agent 34 markdown files wastes its context on the
 * 30 it does not need. MCP lets it ask for what is relevant, and forces the
 * selection to come from the same policy the CLI uses, so an agent cannot invent
 * its own tier logic.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout. The protocol is
 * deliberately implemented inline rather than pulled from an SDK: this project
 * has no dependencies, and the surface is small enough to read.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, buildIndex, loadIndex } from './indexer.mjs';
import { buildPlan, loadCatalog, loadPolicy, loadRouting } from './planner.mjs';
import { normalizeProfile, validateProfile } from './profile.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'vibecode-like-a-dev', version: '0.1.0' };

const PRIMITIVE_ROOT = path.join(ROOT, 'primitives');

function index() {
  try {
    return loadIndex();
  } catch {
    return buildIndex();
  }
}

function primitiveById(id) {
  return index().primitives.find((primitive) => primitive.id === id) ?? null;
}

const BODY_CACHE = new Map();

function readPrimitiveBody(id) {
  if (BODY_CACHE.has(id)) return BODY_CACHE.get(id);
  const primitive = primitiveById(id);
  if (!primitive) return null;
  let body = null;
  try {
    const raw = readFileSync(path.join(ROOT, primitive.path), 'utf8');
    // Strip frontmatter: the caller already has the metadata from search.
    body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  } catch {
    body = null;
  }
  BODY_CACHE.set(id, body);
  return body;
}

const SEARCH_STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'done', 'during', 'each', 'either', 'even', 'every',
  'first', 'for', 'from', 'get', 'gets', 'got', 'had', 'has', 'have', 'having', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'keep', 'keeps', 'let', 'lets', 'like', 'made', 'make', 'makes', 'making', 'may',
  'might', 'more', 'most', 'much', 'must', 'my', 'need', 'needs', 'new', 'no', 'nor', 'not', 'now', 'of', 'off',
  'on', 'once', 'one', 'only', 'onto', 'or', 'other', 'our', 'out', 'over', 'own', 'put', 'run', 'runs', 'running',
  'same', 'see', 'set', 'sets', 'shall', 'should', 'so', 'some', 'still', 'such', 'take', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'turn', 'two',
  'under', 'until', 'up', 'use', 'used', 'uses', 'using', 'very', 'via', 'want', 'wants', 'was', 'way', 'we',
  'were', 'what', 'when', 'whenever', 'where', 'whether', 'which', 'while', 'who', 'why', 'will', 'with',
  'within', 'without', 'would', 'write', 'writes', 'writing', 'you', 'your',
  // Generic software nouns that appear in nearly every prompt and carry no routing signal on their own.
  'add', 'app', 'application', 'build', 'change', 'changes', 'code', 'codebase', 'create', 'customer', 'customers',
  'day', 'developer', 'developers', 'engineer', 'engineers', 'file', 'files', 'fix', 'function', 'helper',
  'implement', 'line', 'lines', 'method', 'number', 'numbers', 'page', 'people', 'practice', 'practices', 'product',
  'project', 'repo', 'repository', 'service', 'services', 'software', 'string', 'strings', 'system', 'team', 'update',
  'user', 'users', 'work', 'worker', 'workers'
]);

const KEEP_S = new Set([
  'asvs', 'access', 'address', 'alias', 'analysis', 'basis', 'bus', 'canvas', 'chaos', 'class', 'cors', 'css',
  'focus', 'gas', 'glass', 'harness', 'headless', 'ingress', 'less', 'loss', 'mass', 'nexus', 'pass', 'postgres',
  'process', 'progress', 'redis', 'rss', 'sass', 'serverless', 'status', 'stress', 'success', 'tls', 'xss'
]);

/**
 * Light, deterministic stemmer for routing tokens.
 * Both the raw token and its stem are indexed so acronyms (`asvs`, `rbac`, `wcag`)
 * match verbatim while inflections (`webhooks`/`webhook`, `retries`/`retry`,
 * `migrations`/`migration`) collapse cleanly.
 */
export function stemToken(word) {
  if (word.length <= 3 || KEEP_S.has(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes|sses)$/.test(w) && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length >= 4) {
    w = w.slice(0, -1);
  }
  if (w.endsWith('ing') && w.length >= 6) {
    const base = w.slice(0, -3);
    if (/(.)\1$/.test(base) && !/[lsz]$/.test(base)) return base.slice(0, -1);
    if (/(at|iz|is|ur|rc|rg|nc|ng|lv|rv|tl|dl|gl|pl|bl|fl|cl|kl)$/.test(base)) return `${base}e`;
    return base;
  }
  if (w.endsWith('ed') && w.length >= 6) {
    const base = w.slice(0, -2);
    if (/(.)\1$/.test(base) && !/[lsz]$/.test(base)) return base.slice(0, -1);
    if (/(at|iz|is|ur|rc|rg|nc|lv|rv|tl|dl|gl|pl|bl|fl|cl|kl)$/.test(base)) return `${base}e`;
    return base;
  }
  return w;
}

export function tokenizeQuery(text, { dropStop = true } = {}) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/@req\b/g, ' reqanchor ')
    .replace(/[^a-z0-9]+/g, ' ');
  const tokens = [];
  for (const part of normalized.split(/\s+/)) {
    if (!part || part.length < 2) continue;
    if (dropStop && SEARCH_STOP.has(part)) continue;
    tokens.push(part);
  }
  return tokens;
}

function tokenBag(text, opts) {
  const tokens = tokenizeQuery(text, opts);
  const stems = tokens.map(stemToken);
  return { tokens, stems, set: new Set([...tokens, ...stems]) };
}

/**
 * Check whether every content stem in `phraseStems` appears in `queryStems` in order
 * within a compact span (`phraseStems.length + 2` tokens), so "alter a live orders table"
 * matches trigger "alter table" while unrelated words at opposite ends of a paragraph do not.
 */
function matchesPhrase(phraseStems, queryStems) {
  if (phraseStems.length === 0) return false;
  if (phraseStems.length === 1) return queryStems.includes(phraseStems[0]);
  const maxSpan = phraseStems.length + 3;
  for (let start = 0; start < queryStems.length; start += 1) {
    if (queryStems[start] !== phraseStems[0]) continue;
    let cursor = start;
    let ok = true;
    for (let k = 1; k < phraseStems.length; k += 1) {
      const limit = Math.min(queryStems.length, start + maxSpan);
      let found = -1;
      for (let pos = cursor + 1; pos < limit; pos += 1) {
        if (queryStems[pos] === phraseStems[k]) {
          found = pos;
          break;
        }
      }
      if (found === -1) {
        ok = false;
        break;
      }
      cursor = found;
    }
    if (ok) return true;
  }
  return false;
}

const MIN_ACTIVATE_SCORE = 9.5;
const ACTIVATE_RATIO = 0.52;
const MAX_ACTIVATED = 3;

/**
 * Rank primitives against a natural-language prompt or keyword query using their
 * progressive-disclosure metadata (`title`, `summary`, `triggers`, `tags`, `id`).
 *
 * Exported so `eval-routing.mjs` can measure the exact router MCP exposes and run
 * metadata-ablation checks (e.g. blanking `summary` or `triggers` to verify CI fails).
 */
export function rankPrimitives(
  primitives,
  query,
  { maxTier = 3, module = null, activate = false, limit = 10, includeBodyFallback = true } = {}
) {
  const q = tokenBag(query, { dropStop: true });
  const qRaw = tokenBag(query, { dropStop: false });
  if (q.stems.length === 0 && qRaw.stems.length === 0) return [];

  // Inverse document frequency across the full catalog so specialist terms (`gdpr`,
  // `idor`, `stryker`, `wcag`, `openapi`) outweigh shared words (`test`, `model`, `data`).
  const docFreq = new Map();
  const prepared = primitives.map((primitive) => {
    const slugText = String(primitive.id ?? '').split('.').slice(1).join(' ');
    const title = tokenBag(primitive.title ?? '', { dropStop: true });
    const summary = tokenBag(primitive.summary ?? '', { dropStop: true });
    const tags = tokenBag([...(primitive.tags ?? []), slugText].join(' '), { dropStop: true });
    const triggerBags = (primitive.triggers ?? []).map((trigger) => {
      const content = tokenBag(trigger, { dropStop: true });
      return content.stems.length > 0 ? content : tokenBag(trigger, { dropStop: false });
    });
    const allMeta = new Set([...title.set, ...summary.set, ...tags.set]);
    for (const tb of triggerBags) for (const t of tb.set) allMeta.add(t);
    for (const term of allMeta) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    return { primitive, title, summary, tags, triggerBags };
  });

  const totalDocs = Math.max(1, primitives.length);
  const idf = (term) => 1 + Math.log((totalDocs + 1) / ((docFreq.get(term) ?? 0) + 1));
  const uniqueQueryStems = [...new Set(q.stems)];

  const eligible = prepared
    .filter(({ primitive }) => primitive.tier_min <= maxTier)
    .filter(({ primitive }) => !module || primitive.module === module);

  const scored = eligible.map(({ primitive, title, summary, tags, triggerBags }) => {
    let metaScore = 0;

    // 1. Trigger matches: phrase triggers are explicit routing rules written by the author.
    for (const tb of triggerBags) {
      const uniqueTriggerStems = [...new Set(tb.stems)];
      if (uniqueTriggerStems.length >= 2) {
        if (matchesPhrase(uniqueTriggerStems, q.stems) || matchesPhrase(uniqueTriggerStems, qRaw.stems)) {
          const rarity = uniqueTriggerStems.reduce((sum, s) => sum + idf(s), 0) / uniqueTriggerStems.length;
          metaScore += 6.5 + 2.2 * uniqueTriggerStems.length * rarity;
        }
      } else if (uniqueTriggerStems.length === 1) {
        const stem = uniqueTriggerStems[0];
        if (q.set.has(stem)) metaScore += 3.8 * idf(stem);
      }
    }

    // 2. Title, summary (description), and tag/slug matches weighted by catalog rarity.
    for (const stem of uniqueQueryStems) {
      const weight = idf(stem);
      if (title.set.has(stem)) metaScore += 2.8 * weight;
      if (summary.set.has(stem)) metaScore += 2.4 * weight;
      if (tags.set.has(stem)) metaScore += 1.4 * weight;
    }

    let score = metaScore;
    if (score === 0 && !activate && includeBodyFallback) {
      const body = (readPrimitiveBody(primitive.id) ?? '').toLowerCase();
      let bodyHits = 0;
      for (const tok of new Set(q.tokens)) {
        if (tok.length >= 4 && new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) {
          bodyHits += 1;
        }
      }
      score = bodyHits * 0.5;
    }

    return { primitive, score: Number(score.toFixed(2)), metaScore: Number(metaScore.toFixed(2)) };
  });

  const nonZero = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.primitive.tier_min - b.primitive.tier_min || a.primitive.id.localeCompare(b.primitive.id));

  const topMeta = nonZero[0]?.metaScore ?? 0;
  let activatedCount = 0;
  const annotated = nonZero.map((entry) => {
    const canActivate =
      activatedCount < MAX_ACTIVATED &&
      entry.metaScore >= MIN_ACTIVATE_SCORE &&
      entry.metaScore >= topMeta * ACTIVATE_RATIO;
    if (canActivate) activatedCount += 1;
    return { ...entry, activated: canActivate };
  });

  const filtered = activate ? annotated.filter((entry) => entry.activated) : annotated;
  return filtered.slice(0, Math.min(limit ?? 10, 50));
}

// ------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'compute_rigor',
    description:
      'Compute the rigor tier for a project profile without compiling a packet. Use this first: the tier decides which practices are even eligible. Returns the score, the signals that produced it, the practice and line ceilings, and any stage cap.',
    inputSchema: {
      type: 'object',
      required: ['idea', 'kind', 'stage'],
      properties: {
        idea: { type: 'string', description: 'One paragraph: who it is for, what it does, what they do today instead.' },
        kind: { type: 'string', enum: ['web-app', 'api', 'cli', 'library', 'data-pipeline', 'mobile', 'agent', 'automation'] },
        stage: { type: 'string', enum: ['prototype', 'mvp', 'internal-tool', 'production'] },
        name: { type: 'string', description: 'kebab-case project name (optional here)' },
        scale: { type: 'string', enum: ['small', 'medium', 'large'] },
        traits: { type: 'array', items: { type: 'string' }, description: 'e.g. auth, payments, realtime, webhooks, ai, persistence' },
        risks: {
          type: 'object',
          description: 'Boolean flags: pii, payments, regulated, multiTenant, destructiveWrites, publicFacing, integrations',
          additionalProperties: { type: 'boolean' }
        }
      }
    }
  },
  {
    name: 'select_primitives',
    description:
      'Select the engineering practices that apply to a project, with the predicate and reason for each, plus what was deferred or skipped and why. This is the same selection the compiler uses, so an agent cannot invent its own tier logic.',
    inputSchema: {
      type: 'object',
      required: ['idea', 'kind', 'stage'],
      properties: {
        idea: { type: 'string' },
        kind: { type: 'string', enum: ['web-app', 'api', 'cli', 'library', 'data-pipeline', 'mobile', 'agent', 'automation'] },
        stage: { type: 'string', enum: ['prototype', 'mvp', 'internal-tool', 'production'] },
        name: { type: 'string' },
        scale: { type: 'string', enum: ['small', 'medium', 'large'] },
        traits: { type: 'array', items: { type: 'string' } },
        risks: { type: 'object', additionalProperties: { type: 'boolean' } }
      }
    }
  },
  {
    name: 'search_primitives',
    description:
      'Find practices by keyword or natural-language prompt across title, summary, triggers and tags. Pass activate: true when routing a task prompt to only the high-confidence practices that should be opened (0..3), suppressing low-score neighbours.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        module: { type: 'string', description: 'Optional module filter: product, domain, architecture, data, testing, security, reliability, delivery, frontend, agent' },
        maxTier: { type: 'integer', minimum: 0, maximum: 3, description: 'Only return practices allowed at or below this tier' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        activate: {
          type: 'boolean',
          description: 'When true, return only calibrated high-confidence practices (0..3) rather than every weak keyword match'
        }
      }
    }
  },
  {
    name: 'get_primitive',
    description: 'Read one practice in full: the failure mode, the practice, the checklist, anti-patterns and its cost. Call this only after search_primitives or select_primitives has narrowed the set.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Primitive id, e.g. testing.mutation-testing' } }
    }
  },
  {
    name: 'get_requirements',
    description:
      'Return the requirement templates that apply to a profile, with acceptance criteria and failure paths. Use these as the source of behaviour for a specification rather than inventing requirements.',
    inputSchema: {
      type: 'object',
      required: ['idea', 'kind', 'stage'],
      properties: {
        idea: { type: 'string' },
        kind: { type: 'string', enum: ['web-app', 'api', 'cli', 'library', 'data-pipeline', 'mobile', 'agent', 'automation'] },
        stage: { type: 'string', enum: ['prototype', 'mvp', 'internal-tool', 'production'] },
        name: { type: 'string' },
        scale: { type: 'string', enum: ['small', 'medium', 'large'] },
        traits: { type: 'array', items: { type: 'string' } },
        risks: { type: 'object', additionalProperties: { type: 'boolean' } }
      }
    }
  },
  {
    name: 'get_gates',
    description: 'Return the definition-of-done gates for a tier (cumulative across lower tiers) and the line budget for the packet.',
    inputSchema: {
      type: 'object',
      required: ['tier'],
      properties: { tier: { type: 'integer', minimum: 0, maximum: 3 } }
    }
  },
  {
    name: 'plan_project',
    description:
      'Run the full planner and return a compact plan: tier, selected practices with reasons, requirements, gates and stats. This is what `vld plan` prints, in JSON. Use it to check intent before writing anything.',
    inputSchema: {
      type: 'object',
      required: ['idea', 'kind', 'stage'],
      properties: {
        idea: { type: 'string' },
        kind: { type: 'string', enum: ['web-app', 'api', 'cli', 'library', 'data-pipeline', 'mobile', 'agent', 'automation'] },
        stage: { type: 'string', enum: ['prototype', 'mvp', 'internal-tool', 'production'] },
        name: { type: 'string' },
        scale: { type: 'string', enum: ['small', 'medium', 'large'] },
        traits: { type: 'array', items: { type: 'string' } },
        risks: { type: 'object', additionalProperties: { type: 'boolean' } }
      }
    }
  },
  {
    name: 'get_anchor_convention',
    description: 'Return how requirements are bound to tests (the @req convention) and the drift-check commands. Use before writing any test in a project that has a packet.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function profileFrom(args) {
  return normalizeProfile({
    name: args.name ?? 'mcp-project',
    idea: args.idea,
    kind: args.kind,
    stage: args.stage,
    users: { scale: args.scale ?? 'small' },
    traits: args.traits ?? [],
    risks: args.risks ?? {}
  });
}

function planFor(args) {
  const profile = profileFrom(args);
  const errors = validateProfile(profile);
  if (errors.length > 0) return { error: errors };
  return { plan: buildPlan(profile, { index: index() }) };
}

function requirePlan(args) {
  const { plan, error } = planFor(args);
  if (error) throw new Error(`invalid profile: ${error.join('; ')}`);
  return plan;
}

const HANDLERS = {
  compute_rigor(args) {
    const plan = requirePlan(args);
    const policy = loadPolicy();
    const ceiling = policy.budgets.maxLinesByTier[String(plan.rigor.tier)];
    return {
      tier: plan.rigor.tier,
      label: plan.rigor.label,
      score: plan.rigor.score,
      signals: plan.rigor.signals,
      capped: plan.rigor.capped,
      cappedReason: plan.rigor.cappedReason,
      limits: { practices: plan.rigor.maxPrimitives, markdownLines: ceiling, packet: plan.packet },
      note: 'Practices with tier_min above this value are not eligible, even if they look relevant.'
    };
  },

  select_primitives(args) {
    const plan = requirePlan(args);
    return {
      tier: plan.rigor.tier,
      selected: plan.primitives.map((primitive) => ({
        id: primitive.id,
        title: primitive.title,
        cost: primitive.cost,
        why: primitive.why,
        when: primitive.when,
        enforces: primitive.enforces,
        gates: primitive.gates ?? [],
        // The template, not a filled sentence: filling needs a profile, and this call
        // is about *which* practices apply. The packet is where it reads like the product.
        obligation: primitive.obligation ?? '',
        path: primitive.path
      })),
      deferred: plan.deferred,
      skipped: plan.skipped,
      note: 'Skipped and deferred entries are deliberate. Do not re-add a practice by inventing a reason; raise the tier or the cap instead.'
    };
  },

  search_primitives(args) {
    const maxTier = Number.isInteger(args.maxTier) ? args.maxTier : 3;
    const limit = Math.min(args.limit ?? 10, 50);
    const activate = args.activate === true;
    const ranked = rankPrimitives(index().primitives, args.query, {
      maxTier,
      module: args.module ?? null,
      activate,
      limit
    });

    return {
      query: args.query,
      matches: ranked.map(({ primitive, score, activated }) => ({
        id: primitive.id,
        title: primitive.title,
        summary: primitive.summary,
        module: primitive.module,
        tier_min: primitive.tier_min,
        cost: primitive.cost,
        score,
        activated
      })),
      hint:
        ranked.length === 0
          ? activate
            ? 'No practice crossed the activation threshold for this prompt.'
            : 'No match. Try a broader term, or browse by module with search_primitives({query: "testing", module: "testing"}).'
          : 'Call get_primitive on the id you need.'
    };
  },

  get_primitive(args) {
    const primitive = primitiveById(args.id);
    if (!primitive) throw new Error(`unknown primitive "${args.id}". Use search_primitives to find one.`);
    const body = readPrimitiveBody(args.id);
    return {
      id: primitive.id,
      title: primitive.title,
      module: primitive.module,
      summary: primitive.summary,
      tier_min: primitive.tier_min,
      cost: primitive.cost,
      priority: primitive.priority,
      enforces: primitive.enforces,
      gates: primitive.gates ?? [],
      advisory: primitive.advisory === true,
      advisory_reason: primitive.advisory_reason || '',
      obligation: primitive.obligation ?? '',
      path: primitive.path,
      body
    };
  },

  get_requirements(args) {
    const plan = requirePlan(args);
    return {
      tier: plan.rigor.tier,
      requirements: plan.requirements.map((requirement) => ({
        id: requirement.id,
        key: requirement.key,
        title: requirement.title,
        area: requirement.render,
        statement: requirement.statement,
        failurePath: requirement.failurePath,
        acceptance: requirement.acceptance,
        verify: requirement.verify,
        anchor: requirement.verify === 'automated' ? `tests/${requirement.render}/${requirement.key.replace(/\./g, '-')}.test.ts` : null,
        status: 'todo'
      })),
      note: 'Copy these ids and criteria into the packet. Do not renumber them: anchors cite them.'
    };
  },

  get_gates(args) {
    const policy = loadPolicy();
    const tier = Math.max(0, Math.min(3, Number(args.tier ?? 0)));
    const gates = [];
    for (let current = 0; current <= tier; current += 1) {
      for (const gate of policy.gates[String(current)] ?? []) gates.push({ ...gate, tier: current });
    }
    return {
      tier,
      gates,
      markdownLines: policy.budgets.maxLinesByTier[String(tier)],
      note: `Tier ${tier} obligations are cumulative: gates introduced at lower tiers still apply.`
    };
  },

  plan_project(args) {
    const plan = requirePlan(args);
    return {
      profile: plan.profile,
      rigor: plan.rigor,
      packet: plan.packet,
      docs: plan.docs,
      primitives: plan.primitives.map((primitive) => ({ id: primitive.id, title: primitive.title, why: primitive.why })),
      requirements: plan.requirements.map((requirement) => ({
        id: requirement.id,
        title: requirement.title,
        area: requirement.render,
        verify: requirement.verify
      })),
      gates: plan.gates,
      stats: plan.stats,
      deferred: plan.deferred,
      next: plan.packet === 'single-file' ? 'Write one spec.md with these requirements, targeted at the tier-0 gate list.' : 'Write the eight documents, then ship spec-check.mjs from the packet.'
    };
  },

  get_anchor_convention() {
    return {
      marker: '@req',
      syntax: '@req REQ-xxx in TypeScript/JS/Go/Java, or # @req REQ-xxx in Python/Ruby/Shell: one marker per anchor line',
      countedIn: 'test files only: tests/, test/, __tests__/, spec/, *.test.*, *.spec.*, test_*.py, *_test.go',
      ratchet: 'requirements start as "todo" (pending notice); marking one "done" without an anchor in a test is an error',
      checks: [
        'node specs/spec-check.mjs --repo .           # pending is a notice',
        'node specs/spec-check.mjs --repo . --strict  # release CI: pending fails'
      ],
      examples: ['// @req REQ-004  // @req-ignore: documentation example', "test('erasing a subject removes every owned row (AC-01)', ...)"]
    };
  }
};

// -------------------------------------------------------------- JSON-RPC

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

export function handleMessage(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'This server selects engineering practices for building software well. Call compute_rigor first, then select_primitives, then get_primitive only for the practices you will actually apply. Never invent a requirement: use get_requirements. Bind tests to requirements with @req anchors.'
    });
  }

  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const handler = HANDLERS[name];
    if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      const value = handler(params?.arguments ?? {});
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        isError: false
      });
    } catch (error) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      });
    }
  }

  if (id === undefined) return null; // unknown notification: ignore, per spec
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function serve({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = '';

  const send = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };

  input.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      try {
        send(handleMessage(JSON.parse(line)));
      } catch (error) {
        send(rpcError(null, -32700, `Parse error: ${error.message}`));
      }
    }
  });

  input.on('end', () => process.exit(0));
  return { send };
}

export { TOOLS };
