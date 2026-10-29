/**
 * Packet verification.
 *
 * This is the difference between a spec and a wish. It checks the packet is
 * internally complete, that every gate required by the tier is present, that
 * quoted primitives still exist, that the packet respects its own size budget,
 * and — given a repository — that automated requirements are actually anchored
 * to tests that exist.
 *
 * Exit semantics are ratcheted on purpose: an unfinished requirement is a
 * warning, a finished requirement without proof is an error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadIndex } from './indexer.mjs';
import { loadPolicy } from './planner.mjs';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.turbo'
]);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs|sh|feature|exs)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\//;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb)$/;
const ANCHOR_LINE = /@req\s+(REQ-\d{3})/;
const SUPPRESSED = /@req-ignore/i;

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function walk(dir, root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (full === root) continue;
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, root, out);
    else if (SOURCE_FILE.test(entry)) out.push(full);
  }
  return out;
}

export function scanAnchors(repoDir, { exclude = [] } = {}) {
  const anchors = new Map();
  const stray = [];
  let scanned = 0;
  let suppressed = 0;
  const exclusionPatterns = exclude.map(globToRegExp);

  for (const file of walk(repoDir, repoDir)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!source.includes('@req')) continue;
    scanned += 1;

    const relative = rel(repoDir, file);
    if (exclusionPatterns.some((pattern) => pattern.test(relative))) continue;

    const isTest = TEST_FILE.test(relative) || TEST_NAME.test(relative);
    for (const line of source.split('\n')) {
      const match = line.match(ANCHOR_LINE);
      if (!match) continue;
      // A line that suppresses the marker is not an anchor: fixtures and examples
      // quote @req deliberately, and pretending otherwise creates false failures.
      if (SUPPRESSED.test(line)) {
        suppressed += 1;
        continue;
      }
      const id = match[1];
      if (!anchors.has(id)) anchors.set(id, []);
      anchors.get(id).push({ id, file: relative, isTest });
    }
  }

  return { anchors, stray, scanned, suppressed };
}

export function verifyPacket(packetDir, { repo = null, strict = false, policy = loadPolicy() } = {}) {
  const errors = [];
  const warnings = [];
  const passes = [];
  const info = [];

  const manifestPath = path.join(packetDir, 'spec.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`${packetDir} has no spec.json`], warnings, passes, info, stats: null };
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`spec.json is not valid JSON: ${error.message}`], warnings, passes, info, stats: null };
  }

  if (spec.schemaVersion !== 1) errors.push(`spec.json schemaVersion is ${spec.schemaVersion}; expected 1`);

  const packetType = spec.rigor?.packet ?? 'full';
  const required = policy.requiredDocs[packetType] ?? policy.requiredDocs.full;

  // 1. documents
  for (const doc of required) {
    if (!existsSync(path.join(packetDir, doc))) errors.push(`missing required document: ${doc}`);
  }
  for (const doc of spec.docs ?? []) {
    if (!existsSync(path.join(packetDir, doc))) errors.push(`spec.json lists "${doc}" but it is not in the packet`);
  }
  if (errors.length === 0) passes.push(`all ${required.length} required documents present (${packetType} packet)`);

  // 2. size budget — the anti-ceremony rule, enforced per tier
  const markdown = readdirSync(packetDir).filter((file) => file.endsWith('.md') || file === 'spec.md');
  let lines = 0;
  for (const file of new Set(markdown)) {
    lines += readFileSync(path.join(packetDir, file), 'utf8').split('\n').length;
  }
  const tierForBudget = spec.rigor?.tier ?? 0;
  const budget = policy.budgets.maxLinesByTier[String(tierForBudget)] ?? policy.budgets.maxLinesByTier['3'];
  info.push(`packet size: ${lines} lines (tier ${tierForBudget} ceiling ${budget})`);
  if (lines > budget) {
    errors.push(
      `packet is ${lines} lines, over the ${budget}-line budget. Demote primitives by priority instead of trimming their content, or raise the budget in factory/policy.json with a reason.`
    );
  } else {
    passes.push(`packet fits its ${budget}-line budget (${lines} lines)`);
  }

  // 3. rigor and gates
  const tier = spec.rigor?.tier;
  if (![0, 1, 2, 3].includes(tier)) errors.push(`rigor.tier must be 0-3 (got ${tier})`);

  const expectedGates = [];
  for (let t = 0; t <= (Number.isInteger(tier) ? tier : 0); t += 1) {
    expectedGates.push(...(policy.gates[String(t)] ?? []));
  }
  const gateIds = new Set((spec.gates ?? []).map((gate) => gate.id));
  for (const gate of expectedGates) {
    if (!gateIds.has(gate.id)) errors.push(`gate ${gate.id} is required at tier ${tier} but missing from spec.json`);
  }
  if (expectedGates.length > 0 && expectedGates.every((gate) => gateIds.has(gate.id))) {
    passes.push(`all ${expectedGates.length} gates for tiers 0-${tier} present`);
  }

  // 4. requirements
  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  if (requirements.length === 0) errors.push('spec.json has no requirements');

  const known = new Set(requirements.map((requirement) => requirement.id));
  let criteria = 0;
  for (const requirement of requirements) {
    if (!/^REQ-\d{3}$/.test(requirement.id ?? '')) errors.push(`invalid requirement id "${requirement.id}"`);
    if (!requirement.statement || String(requirement.statement).length < 40) {
      errors.push(`${requirement.id}: statement missing or too thin`);
    }
    if (!Array.isArray(requirement.acceptance) || requirement.acceptance.length === 0) {
      errors.push(`${requirement.id}: no acceptance criteria`);
    } else {
      criteria += requirement.acceptance.length;
    }
    if (!['automated', 'manual', 'gate'].includes(requirement.verify)) {
      errors.push(`${requirement.id}: verify must be automated, manual or gate`);
    }
    if (requirement.verify === 'automated' && !requirement.anchor) {
      errors.push(`${requirement.id}: automated requirement needs an anchor path`);
    }
  }

  // 5. primitive references still resolve
  let index = null;
  try {
    index = loadIndex();
  } catch {
    warnings.push('primitives/index.json is missing; run `npm run index` to check quoted primitives');
  }

  if (index) {
    const byId = new Map(index.primitives.map((primitive) => [primitive.id, primitive]));
    for (const primitive of spec.primitives ?? []) {
      const actual = byId.get(primitive.id);
      if (!actual) {
        errors.push(`primitive "${primitive.id}" no longer exists in primitives/index.json`);
        continue;
      }
      if (actual.tier_min > tier) {
        errors.push(`primitive "${primitive.id}" requires tier ${actual.tier_min} but this packet is tier ${tier}`);
      }
      if (primitive.path && primitive.path !== actual.path) {
        warnings.push(`primitive "${primitive.id}" path moved: spec says ${primitive.path}, index says ${actual.path}`);
      }
    }
    if ((spec.primitives ?? []).length > 0) {
      passes.push(`${spec.primitives.length} quoted primitives resolve in the index`);
    }
  }

  // 6. anchors, when a repository is supplied
  let anchorStats = null;
  if (repo) {
    const { anchors, scanned, suppressed } = scanAnchors(repo, { exclude: spec.anchors?.exclude ?? [] });
    anchorStats = { scanned, anchored: anchors.size, suppressed };
    if (suppressed > 0) info.push(`${suppressed} anchor(s) ignored by @req-ignore or anchors.exclude`);

    for (const [id, hits] of anchors) {
      if (!known.has(id)) {
        errors.push(`${hits[0].file} cites unknown requirement ${id}`);
      }
    }

    let pending = 0;
    let proven = 0;
    for (const requirement of requirements) {
      if (requirement.verify !== 'automated') continue;
      const hits = anchors.get(requirement.id) ?? [];
      const inTests = hits.filter((hit) => hit.isTest);
      const status = String(requirement.status ?? 'todo').toLowerCase();

      if (inTests.length > 0) {
        proven += 1;
        continue;
      }
      if (hits.length > 0) {
        errors.push(`${requirement.id} is anchored only outside a test file (${hits.map((hit) => hit.file).join(', ')})`);
        continue;
      }
      if (status === 'done') {
        errors.push(`${requirement.id} is marked done but no test carries an @req anchor for it`);
      } else {
        pending += 1;
        const message = `${requirement.id} ${requirement.title}: no test anchor yet`;
        if (strict) errors.push(message);
        else warnings.push(message);
      }
    }

    info.push(`anchors: ${proven} proven, ${pending} pending, ${scanned} files scanned in ${repo}`);
    if (proven > 0) passes.push(`${proven} automated requirement(s) proven by test anchors`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    passes,
    info,
    stats: {
      packetType,
      tier,
      requirements: requirements.length,
      criteria,
      gates: gateIds.size,
      primitives: (spec.primitives ?? []).length,
      lines,
      ...anchorStats
    }
  };
}
