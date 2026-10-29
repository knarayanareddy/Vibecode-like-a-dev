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

/**
 * Metadata matches are worth more than body matches: a term in the title or
 * triggers means the practice is about it, a term in the body may be a caveat.
 */
function searchScore(primitive, terms) {
  const meta = [primitive.id, primitive.title, primitive.summary, ...(primitive.tags ?? []), ...(primitive.triggers ?? [])]
    .join(' ')
    .toLowerCase();
  const body = (readPrimitiveBody(primitive.id) ?? '').toLowerCase();
  return terms.reduce((total, term) => total + (meta.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
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
      'Find practices by keyword across id, title, summary, tags and triggers. Use when you know the problem (e.g. "webhook duplicates", "accessibility") but not which practice covers it.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        module: { type: 'string', description: 'Optional module filter: product, domain, architecture, data, testing, security, reliability, delivery, frontend, agent' },
        maxTier: { type: 'integer', minimum: 0, maximum: 3, description: 'Only return practices allowed at or below this tier' },
        limit: { type: 'integer', minimum: 1, maximum: 50 }
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
        path: primitive.path
      })),
      deferred: plan.deferred,
      skipped: plan.skipped,
      note: 'Skipped and deferred entries are deliberate. Do not re-add a practice by inventing a reason; raise the tier or the cap instead.'
    };
  },

  search_primitives(args) {
    const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const maxTier = Number.isInteger(args.maxTier) ? args.maxTier : 3;
    const limit = Math.min(args.limit ?? 10, 50);

    const scored = index()
      .primitives.filter((primitive) => primitive.tier_min <= maxTier)
      .filter((primitive) => !args.module || primitive.module === args.module)
      .map((primitive) => ({ primitive, score: searchScore(primitive, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.primitive.tier_min - b.primitive.tier_min);

    return {
      query: args.query,
      matches: scored.slice(0, limit).map(({ primitive }) => ({
        id: primitive.id,
        title: primitive.title,
        summary: primitive.summary,
        module: primitive.module,
        tier_min: primitive.tier_min,
        cost: primitive.cost
      })),
      hint: scored.length === 0 ? 'No match. Try a broader term, or browse by module with search_primitives({query: "testing", module: "testing"}).' : 'Call get_primitive on the id you need.'
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
