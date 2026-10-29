import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive } from './derive.mjs';
import {
  agentsMd,
  agentHandoff,
  architecture,
  constitution,
  contracts,
  deliveryPlan,
  domainModel,
  manifest,
  productBrief,
  singleFileSpec,
  verification
} from './docs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, '..', '..', 'templates');

/** Canonical order. Also the read order documented in the constitution. */
const FULL_PACKET = [
  ['00-constitution.md', constitution],
  ['01-product-brief.md', productBrief],
  ['02-domain-model.md', domainModel],
  ['03-architecture.md', architecture],
  ['04-contracts.md', contracts],
  ['05-verification.md', verification],
  ['06-delivery-plan.md', deliveryPlan],
  ['07-agent-handoff.md', agentHandoff]
];

export function renderPacket(plan) {
  const d = derive(plan);
  const files = new Map();

  if (plan.packet === 'single-file') {
    files.set('spec.md', singleFileSpec(plan, d));
  } else {
    for (const [name, build] of FULL_PACKET) {
      files.set(name, build(plan, d));
    }
  }

  files.set('spec.json', manifest(plan, d));
  files.set('AGENTS.md', agentsMd(plan, d));

  const checker = path.join(TEMPLATES, 'spec-check.mjs');
  if (existsSync(checker)) {
    files.set('spec-check.mjs', readFileSync(checker, 'utf8'));
  }

  return { files, derived: d };
}

/**
 * Progress persistence.
 *
 * A packet is regenerated whenever policy or the profile changes. Wiping the
 * record of what has been implemented would make the tool unusable on a project
 * older than one release: every recompile would claim nothing was ever done.
 * So `status` and the anchor of a proven requirement survive a recompile,
 * matched by requirement key. Everything else is regenerated, because everything
 * else is the product of policy.
 */
function carryForwardProgress(target, files) {
  const specPath = path.join(target, 'spec.json');
  if (!existsSync(specPath)) return { carried: 0, removed: [] };

  let previous;
  try {
    previous = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch {
    return { carried: 0, removed: [] };
  }

  const byKey = new Map((previous.requirements ?? []).map((requirement) => [requirement.key, requirement]));
  const next = JSON.parse(files.get('spec.json'));
  const carried = [];

  for (const requirement of next.requirements) {
    const old = byKey.get(requirement.key);
    if (!old) continue;
    if (old.status === 'done' || old.status === 'blocked') {
      requirement.status = old.status;
      if (old.anchor) requirement.anchor = old.anchor;
      carried.push({ id: requirement.id, key: requirement.key, status: old.status });
    }
  }

  const removed = [...byKey.keys()].filter((key) => !next.requirements.some((requirement) => requirement.key === key));

  // History records a recompile that actually changed something. A recompile with
  // nothing to carry is not an event, and writing an empty record into the packet
  // would make an unchanged recompile differ from a fresh compile — which breaks
  // the "same profile, same packet" guarantee that the sync check depends on.
  if (carried.length > 0 || removed.length > 0) {
    next.history = { carriedForward: carried.length, dropped: removed };
  } else {
    delete next.history;
  }

  files.set('spec.json', `${JSON.stringify(next, null, 2)}\n`);
  return { carried: carried.length, carriedDetail: carried, removed };
}

export function emitPacket(plan, outDir, { force = false } = {}) {
  const { files, derived } = renderPacket(plan);
  const target = path.resolve(outDir);

  if (existsSync(target) && !force) {
    const contents = readdirSyncSafe(target);
    if (contents.length > 0) {
      const error = new Error(
        `Refusing to overwrite ${target}: it already contains ${contents.length} file(s) (${contents.slice(0, 3).join(', ')}). Pass --force to regenerate.`
      );
      error.code = 'OUTPUT_NOT_EMPTY';
      throw error;
    }
  }

  mkdirSync(target, { recursive: true });
  const progress = carryForwardProgress(target, files);

  const written = [];
  let totalLines = 0;
  for (const [name, content] of files) {
    const filePath = path.join(target, name);
    writeFileSync(filePath, content, 'utf8');
    const lines = content.split('\n').length;
    totalLines += lines;
    written.push({ name, lines });
  }

  return { outDir: target, written, totalLines, derived, progress };
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
