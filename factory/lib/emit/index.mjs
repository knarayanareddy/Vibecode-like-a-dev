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

  const written = [];
  let totalLines = 0;
  for (const [name, content] of files) {
    const filePath = path.join(target, name);
    writeFileSync(filePath, content, 'utf8');
    const lines = content.split('\n').length;
    totalLines += lines;
    written.push({ name, lines });
  }

  return { outDir: target, written, totalLines, derived };
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
