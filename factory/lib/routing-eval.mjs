/**
 * Routing evaluation for the MCP and skill-metadata layer.
 *
 * When an agent decides which engineering practices to open before touching code,
 * it sees only metadata: `id`, `title`, `summary` and `triggers`. Two failure modes
 * dominate that step in the literature and in this repository:
 *
 *   1. Missed specialists (low recall): practitioner wording ("IDOR", "surviving
 *      mutant", "prompt injection") fails to activate the practice that teaches it.
 *   2. Broad absorbers (low precision): a generic word in one practice's triggers
 *      or summary fires on unrelated prompts and crowds out specialists.
 *
 * Four drivers share one scorer and one threshold contract:
 *   - `mcp`       deterministic metadata router exposed by `search_primitives({ activate: true })`
 *   - `openai`    live model-in-the-loop via OpenAI-compatible `/chat/completions`
 *   - `anthropic` live model-in-the-loop via Anthropic `/v1/messages`
 *   - `cmd`       any external CLI or model wrapper reading `{ prompt, catalog }` on stdin
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, buildIndex } from './indexer.mjs';
import { handleMessage, rankPrimitives } from './mcp.mjs';

export const DEFAULT_CASES_PATH = path.join(ROOT, 'factory', 'evals', 'routing-cases.json');

export const DEFAULT_THRESHOLDS = {
  minMicroRecall: 0.7,
  minMicroPrecision: 0.9,
  maxFalsePositivesPerPractice: 2,
  maxZeroRecallPractices: 0
};

export function loadRoutingSuite(filePath = DEFAULT_CASES_PATH) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return {
    version: raw.version ?? 1,
    description: raw.description ?? '',
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
    cases: raw.cases ?? []
  };
}

/** The exact metadata surface an MCP client or skill router sees before opening `SKILL.md`. */
export function metadataCatalog(primitives) {
  return primitives.map((primitive) => ({
    id: primitive.id,
    title: primitive.title,
    module: primitive.module,
    tier_min: primitive.tier_min,
    summary: primitive.summary,
    triggers: primitive.triggers ?? []
  }));
}

export function buildModelRoutingPrompt(prompt, catalog) {
  const entries = catalog
    .map(
      (entry) =>
        `- ${entry.id} | ${entry.title}: ${entry.summary}${entry.triggers.length ? ` (triggers: ${entry.triggers.join(', ')})` : ''}`
    )
    .join('\n');

  return [
    'You are routing a developer request to the engineering practices that directly govern it.',
    'Select 0, 1, or at most 3 practice IDs from the catalog below.',
    'Rules:',
    '- Return {"selected": []} if the request is a routine code helper, formatting tweak or typo where no architectural or process practice is needed.',
    '- Prefer the single most specific practice unless the request explicitly spans two distinct concerns.',
    '- Respond with JSON only: {"selected": ["module.practice-name"]}',
    '',
    'Catalog:',
    entries,
    '',
    `Request: ${prompt}`
  ].join('\n');
}

/** Extract `{"selected": [...]}` even when a model wraps its answer in a code fence. */
export function parseModelSelection(rawText, validIds) {
  const text = String(rawText ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  const braceStart = candidate.indexOf('{');
  const braceEnd = candidate.lastIndexOf('}');
  const slice = braceStart !== -1 && braceEnd > braceStart ? candidate.slice(braceStart, braceEnd + 1) : candidate;
  const parsed = JSON.parse(slice);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.selected) ? parsed.selected : [];
  const seen = new Set();
  const selected = [];
  const unknown = [];
  for (const id of list) {
    const clean = String(id).trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    if (validIds.has(clean)) selected.push(clean);
    else unknown.push(clean);
  }
  return { selected, unknown };
}

function createMcpSelector(primitives, { viaProtocol = false } = {}) {
  return async (prompt) => {
    if (viaProtocol) {
      const response = handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_primitives', arguments: { query: prompt, activate: true } }
      });
      const payload = JSON.parse(response.result.content[0].text);
      return { selected: payload.matches.map((match) => match.id), unknown: [] };
    }
    const ranked = rankPrimitives(primitives, prompt, { activate: true, includeBodyFallback: false });
    return { selected: ranked.map((entry) => entry.primitive.id), unknown: [] };
  };
}

function createCmdSelector(command, catalog, validIds) {
  if (!command) throw new Error('cmd driver requires a shell command (--cmd "<command>")');
  return async (prompt) => {
    const input = JSON.stringify({ prompt, catalog, systemPrompt: buildModelRoutingPrompt(prompt, catalog) });
    const stdout = execSync(command, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000
    });
    return parseModelSelection(stdout, validIds);
  };
}

function createOpenAiSelector({ model = process.env.EVAL_MODEL || 'gpt-4o-mini', baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey = process.env.OPENAI_API_KEY } = {}, catalog, validIds) {
  if (!apiKey) throw new Error('openai driver requires OPENAI_API_KEY in the environment');
  return async (prompt) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: buildModelRoutingPrompt(prompt, catalog) }]
      })
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '{"selected":[]}';
    return {
      ...parseModelSelection(content, validIds),
      tokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0)
    };
  };
}

function createAnthropicSelector({ model = process.env.EVAL_MODEL || 'claude-3-5-haiku-latest', baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', apiKey = process.env.ANTHROPIC_API_KEY } = {}, catalog, validIds) {
  if (!apiKey) throw new Error('anthropic driver requires ANTHROPIC_API_KEY in the environment');
  return async (prompt) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: 'user', content: buildModelRoutingPrompt(prompt, catalog) }]
      })
    });
    if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const content = data.content?.map((part) => part.text ?? '').join('\n') ?? '{"selected":[]}';
    return {
      ...parseModelSelection(content, validIds),
      tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
    };
  };
}

export async function evaluateRouting({
  primitives = buildIndex().primitives,
  cases = null,
  thresholds = null,
  driver = 'mcp',
  model = undefined,
  cmd = null,
  viaProtocol = false,
  includeAblation = driver === 'mcp'
} = {}) {
  const loaded = cases ? { cases, thresholds: { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) } } : loadRoutingSuite();
  const activeThresholds = thresholds ? { ...loaded.thresholds, ...thresholds } : loaded.thresholds;
  const catalog = metadataCatalog(primitives);
  const validIds = new Set(primitives.map((primitive) => primitive.id));

  let select;
  if (driver === 'mcp') select = createMcpSelector(primitives, { viaProtocol });
  else if (driver === 'cmd') select = createCmdSelector(cmd, catalog, validIds);
  else if (driver === 'openai') select = createOpenAiSelector({ model }, catalog, validIds);
  else if (driver === 'anthropic') select = createAnthropicSelector({ model }, catalog, validIds);
  else throw new Error(`unknown routing driver "${driver}" (expected mcp, openai, anthropic, or cmd)`);

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let totalTokens = 0;
  let negativeClean = 0;
  let negativeTotal = 0;

  const perPractice = new Map(
    primitives.map((primitive) => [primitive.id, { id: primitive.id, expected: 0, tp: 0, fp: 0, fn: 0 }])
  );
  const caseResults = [];

  for (const testCase of loaded.cases) {
    const outcome = await select(testCase.prompt);
    const got = new Set(outcome.selected);
    const exp = new Set(testCase.expected ?? []);
    totalTokens += outcome.tokens ?? 0;

    let caseTp = 0;
    let caseFp = 0;
    let caseFn = 0;

    for (const id of got) {
      if (exp.has(id)) {
        tp += 1;
        caseTp += 1;
        if (perPractice.has(id)) perPractice.get(id).tp += 1;
      } else {
        fp += 1;
        caseFp += 1;
        if (perPractice.has(id)) perPractice.get(id).fp += 1;
      }
    }
    // Unknown IDs hallucinated by a model count as false positives too.
    fp += outcome.unknown.length;
    caseFp += outcome.unknown.length;

    for (const id of exp) {
      if (perPractice.has(id)) perPractice.get(id).expected += 1;
      if (!got.has(id)) {
        fn += 1;
        caseFn += 1;
        if (perPractice.has(id)) perPractice.get(id).fn += 1;
      }
    }

    if (exp.size === 0) {
      negativeTotal += 1;
      if (got.size === 0 && outcome.unknown.length === 0) negativeClean += 1;
    }

    caseResults.push({
      id: testCase.id,
      kind: testCase.kind ?? 'single',
      expected: [...exp],
      selected: [...got],
      unknown: outcome.unknown,
      exact: caseFp === 0 && caseFn === 0,
      tp: caseTp,
      fp: caseFp,
      fn: caseFn
    });
  }

  const microPrecision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const microRecall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = microPrecision + microRecall === 0 ? 0 : (2 * microPrecision * microRecall) / (microPrecision + microRecall);

  const practiceStats = [...perPractice.values()].map((entry) => ({
    ...entry,
    recall: entry.expected === 0 ? null : Number((entry.tp / entry.expected).toFixed(3))
  }));

  const zeroRecallPractices = practiceStats
    .filter((entry) => entry.expected > 0 && entry.tp === 0)
    .map((entry) => entry.id);

  const absorbers = practiceStats
    .filter((entry) => entry.fp > activeThresholds.maxFalsePositivesPerPractice)
    .sort((a, b) => b.fp - a.fp)
    .map((entry) => ({ id: entry.id, fp: entry.fp }));

  let ablation = null;
  if (includeAblation) {
    const stripped = primitives.map((primitive) => ({ ...primitive, summary: '', triggers: [], tags: [] }));
    const bare = await evaluateRouting({
      primitives: stripped,
      cases: loaded.cases,
      thresholds: activeThresholds,
      driver: 'mcp',
      viaProtocol: false,
      includeAblation: false
    });
    ablation = {
      titleOnlyPrecision: bare.microPrecision,
      titleOnlyRecall: bare.microRecall,
      precisionLift: Number((microPrecision - bare.microPrecision).toFixed(3)),
      recallLift: Number((microRecall - bare.microRecall).toFixed(3))
    };
  }

  const findings = [];
  if (microRecall < activeThresholds.minMicroRecall) {
    findings.push({
      id: 'recall-below-threshold',
      detail: `micro-recall ${(microRecall * 100).toFixed(1)}% is below ${(activeThresholds.minMicroRecall * 100).toFixed(0)}%`
    });
  }
  if (microPrecision < activeThresholds.minMicroPrecision) {
    findings.push({
      id: 'precision-below-threshold',
      detail: `micro-precision ${(microPrecision * 100).toFixed(1)}% is below ${(activeThresholds.minMicroPrecision * 100).toFixed(0)}%`
    });
  }
  if (zeroRecallPractices.length > activeThresholds.maxZeroRecallPractices) {
    findings.push({
      id: 'practice-never-activated',
      detail: `0% recall on labelled prompts for: ${zeroRecallPractices.join(', ')}`
    });
  }
  if (absorbers.length > 0) {
    findings.push({
      id: 'absorber-practice',
      detail: `false-positive absorber(s) (> ${activeThresholds.maxFalsePositivesPerPractice} FP): ${absorbers.map((a) => `${a.id} (${a.fp})`).join(', ')}`
    });
  }

  return {
    ok: findings.length === 0,
    driver,
    liveModel: driver !== 'mcp',
    model: model ?? null,
    casesRun: loaded.cases.length,
    primitivesCount: primitives.length,
    thresholds: activeThresholds,
    counts: { tp, fp, fn, negativeClean, negativeTotal, totalTokens },
    microPrecision: Number(microPrecision.toFixed(3)),
    microRecall: Number(microRecall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    exactMatchRate: Number((caseResults.filter((c) => c.exact).length / Math.max(1, caseResults.length)).toFixed(3)),
    zeroRecallPractices,
    absorbers,
    ablation,
    practices: practiceStats,
    cases: caseResults,
    findings
  };
}
