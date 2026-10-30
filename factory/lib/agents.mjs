/**
 * Agent adapters are generated handoffs, not hidden model calls.
 *
 * They install a small, versioned VLD skill/command set for supported agent
 * environments. The skills point agents back at VLD's deterministic plan and
 * workflow state; they may draft artifacts but may not alter policy or claim a
 * gate passed without the command's evidence.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './indexer.mjs';
import { moduleStatus } from './modules.mjs';
import {
  ID_PATTERN,
  SEMVER_PATTERN,
  digest,
  ensureProjectDir,
  extensionError,
  readJson,
  vldDir,
  writeJsonAtomic
} from './extension-utils.mjs';

export const ADAPTERS_DIR = path.join(ROOT, 'factory', 'adapters');

function adapterPath(id) {
  return path.join(ADAPTERS_DIR, `${id}.json`);
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !value.includes('\0');
}

export function validateAdapter(adapter, expectedId = adapter?.id) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return [`${expectedId ?? 'adapter'}: adapter is not an object`];
  if (adapter.schemaVersion !== 1) errors.push('schemaVersion: must be 1');
  if (!adapter.id || !ID_PATTERN.test(adapter.id)) errors.push('id: required, lowercase kebab-case');
  else if (expectedId && adapter.id !== expectedId) errors.push(`id: "${adapter.id}" does not match file name "${expectedId}"`);
  if (!SEMVER_PATTERN.test(String(adapter.version ?? ''))) errors.push('version: required semantic version');
  if (typeof adapter.title !== 'string' || adapter.title.trim().length < 3 || /[\r\n]/.test(adapter.title)) errors.push('title: required one-line string');
  if (!safeRelative(adapter.target)) errors.push('target: must be a safe relative directory');
  if (!['skill', 'command'].includes(adapter.format)) errors.push('format: must be skill or command');
  if (!Array.isArray(adapter.files) || adapter.files.length === 0 || adapter.files.some((file) => !safeRelative(file))) errors.push('files: must be a non-empty list of safe relative paths');
  if (Array.isArray(adapter.files) && new Set(adapter.files).size !== adapter.files.length) errors.push('files: paths must not repeat');
  return errors;
}

export function listAdapters() {
  const adapters = [];
  const errors = [];
  for (const entry of readdirSync(ADAPTERS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    try {
      const adapter = readJson(adapterPath(id));
      errors.push(...validateAdapter(adapter, id).map((problem) => `${entry.name}: ${problem}`));
      adapters.push({ ...adapter, digest: digest(adapter), source: `factory/adapters/${entry.name}` });
    } catch (error) {
      errors.push(`${entry.name}: invalid JSON (${error.message})`);
    }
  }
  return { adapters, errors };
}

export function getAdapter(id) {
  const catalogue = listAdapters();
  if (catalogue.errors.length > 0) throw extensionError(`builtin adapters are invalid:\n${catalogue.errors.map((error) => `- ${error}`).join('\n')}`, 'INVALID_ADAPTER_CATALOGUE');
  const adapter = catalogue.adapters.find((entry) => entry.id === id);
  if (!adapter) throw extensionError(`unknown agent adapter "${id}". Known: ${catalogue.adapters.map((entry) => entry.id).join(', ')}`, 'UNKNOWN_AGENT_ADAPTER');
  return adapter;
}

function installedStatePath(project, id) {
  return path.join(vldDir(project), 'agents', `${id}.json`);
}

function enabledModuleNames(project) {
  const status = moduleStatus(project);
  if (status.errors.length > 0) throw extensionError(status.errors.join('\n'), 'INVALID_MODULE_STATE');
  if (status.drift.length > 0) {
    throw extensionError(`module lock drift:\n${status.drift.map((entry) => `- ${entry.id}: ${entry.reason}`).join('\n')}\nRe-enable the module after reviewing it before installing an agent handoff.`, 'MODULE_LOCK_DRIFT');
  }
  return status.modules.map((module) => module.id);
}

function frontmatter(title, description) {
  return `---\ndescription: "${description}"\n---\n\n# ${title}\n`;
}

function discoveryBody({ modules, format }) {
  const lead = format === 'command'
    ? frontmatter('VLD discovery', 'Use VLD policy and workflow state to draft a bounded product brief.')
    : '# VLD discovery\n';
  return `${lead}
You are working in a VLD-governed repository. Treat the compiled policy as an authority, not as background reading.

## Non-negotiable rules

1. Run \`vld module verify --project .\` before trusting enabled modules.
2. Read the profile and run \`vld plan profile.json\` before drafting product content.
3. Do not edit generated \`specs/\` prose by hand. Change the profile, overlay or approved change source, then recompile.
4. Do not change requirement IDs, tier, risk flags, gates or completion status to make work look easier.
5. A claim of verification needs command output or an explicit human decision; a narrative is not evidence.

## Task

Draft only the product artifacts requested by the active workflow. Preserve uncertainty as an assumption or a question. Link each meaningful assertion to a VLD requirement key or to an explicitly labelled discovery assumption.

## Enabled modules

${modules.length ? modules.map((id) => `- \`${id}\``).join('\n') : '- None. Install a bundle or module before requesting module-specific work.'}

## Handoff

When finished, state: artifact paths, requirements affected, assumptions introduced, evidence still missing, and the workflow step awaiting human approval. Do not mark the workflow complete yourself.
`;
}

function deliveryBody({ modules, format }) {
  const lead = format === 'command'
    ? frontmatter('VLD feature delivery', 'Implement or review against a VLD packet without bypassing requirement evidence.')
    : '# VLD feature delivery\n';
  return `${lead}
You are implementing or reviewing a VLD-governed change. The packet is a contract between intent, code and release evidence.

## Before code

1. Run \`vld module verify --project .\` and \`vld workflow status feature-delivery --project .\`.
2. Read \`specs/AGENTS.md\`, \`specs/spec.json\`, the active change proposal, and the relevant requirement IDs.
3. For automated requirements, put \`@req REQ-###\` only in a real test that proves the stated behaviour.
4. Keep implementation, migration, rollback and probe work linked to the active change; do not bury scope changes in code.

## Completion evidence

- Run the product's actual test commands.
- Run the generated strict drift check and gates when the workflow reaches verification.
- Report failed or skipped evidence plainly; do not convert it into a green status.
- Keep generated packets reproducible: alter the source profile/overlay/change and recompile.

## Enabled modules

${modules.length ? modules.map((id) => `- \`${id}\``).join('\n') : '- None. Install a bundle or module before requesting module-specific work.'}

## Handoff

Return changed files, requirement IDs, executed commands and their outcomes, residual risks, and the next workflow step. A human records approvals; an agent never self-approves a release.
`;
}

function renderedFiles(adapter, modules) {
  const bodies = adapter.format === 'command'
    ? [
        ['vld-discovery.md', discoveryBody({ modules, format: adapter.format })],
        ['vld-feature-delivery.md', deliveryBody({ modules, format: adapter.format })]
      ]
    : [
        ['vld-discovery/SKILL.md', discoveryBody({ modules, format: adapter.format })],
        ['vld-feature-delivery/SKILL.md', deliveryBody({ modules, format: adapter.format })]
      ];
  const expected = new Map();
  for (const [file, content] of bodies) expected.set(file, content);
  for (const file of adapter.files) {
    if (!expected.has(file)) throw extensionError(`adapter "${adapter.id}" declares unsupported generated file "${file}"`, 'INVALID_ADAPTER_CATALOGUE');
  }
  return new Map(adapter.files.map((file) => [file, expected.get(file)]));
}

export function agentStatus(projectDir = '.', id = null) {
  const project = ensureProjectDir(projectDir);
  const catalogue = listAdapters();
  const moduleLock = moduleStatus(project);
  const errors = [...catalogue.errors, ...moduleLock.errors];
  const currentModules = moduleLock.modules.map((module) => module.id);
  const choices = id ? catalogue.adapters.filter((adapter) => adapter.id === id) : catalogue.adapters;
  if (id && choices.length === 0) errors.push(`unknown agent adapter "${id}"`);
  const adapters = choices.map((adapter) => {
    const stateFile = installedStatePath(project, adapter.id);
    if (!existsSync(stateFile)) return { id: adapter.id, installed: false, stateFile, files: [], drift: [] };
    try {
      const state = readJson(stateFile);
      const drift = [];
      if (state.schemaVersion !== 1 || state.adapter !== adapter.id) drift.push('invalid installed adapter state');
      if (state.version !== adapter.version || state.adapterDigest !== adapter.digest) drift.push('adapter definition differs from the installed lock');
      if (moduleLock.drift.length > 0) drift.push('module lock drift must be resolved before this handoff is trusted');
      else if (digest(state.modules ?? []) !== digest(currentModules)) drift.push('enabled module set changed; reinstall this handoff to refresh its guidance');
      for (const entry of state.files ?? []) {
        if (!entry || !safeRelative(entry.path) || !/^[a-f0-9]{64}$/.test(String(entry.digest ?? ''))) {
          drift.push('invalid managed file entry in adapter state');
          continue;
        }
        const file = path.resolve(project, entry.path);
        if (!file.startsWith(`${project}${path.sep}`)) {
          drift.push(`${entry.path}: escapes the project directory`);
          continue;
        }
        if (!existsSync(file)) drift.push(`${entry.path}: missing`);
        else if (digest(readFileSync(file, 'utf8')) !== entry.digest) drift.push(`${entry.path}: modified outside vld`);
      }
      return { id: adapter.id, installed: true, stateFile, files: state.files ?? [], drift };
    } catch (error) {
      return { id: adapter.id, installed: true, stateFile, files: [], drift: [`invalid installed adapter state (${error.message})`] };
    }
  });
  return { project, adapters, errors, ok: errors.length === 0 && adapters.every((adapter) => adapter.drift.length === 0) };
}

/** Install or refresh one generated agent handoff. Existing unmanaged files are protected. */
export function installAgent({ id, projectDir = '.', force = false }) {
  const project = ensureProjectDir(projectDir);
  const adapter = getAdapter(id);
  const modules = enabledModuleNames(project);
  const files = renderedFiles(adapter, modules);
  const target = path.join(project, adapter.target);
  const planned = [...files.entries()].map(([relative, content]) => ({
    relative,
    path: path.join(target, relative),
    content,
    digest: digest(content)
  }));

  for (const entry of planned) {
    if (existsSync(entry.path) && readFileSync(entry.path, 'utf8') !== entry.content && !force) {
      throw extensionError(`${path.relative(project, entry.path)} already exists with different content; refusing to overwrite. Review it or pass --force.`, 'AGENT_FILE_EXISTS');
    }
  }

  const written = [];
  for (const entry of planned) {
    mkdirSync(path.dirname(entry.path), { recursive: true });
    const existed = existsSync(entry.path);
    const prior = existed ? readFileSync(entry.path, 'utf8') : null;
    if (prior !== entry.content) writeFileSync(entry.path, entry.content, 'utf8');
    written.push({ path: path.relative(project, entry.path).split(path.sep).join('/'), digest: entry.digest, changed: prior !== entry.content });
  }

  const state = {
    schemaVersion: 1,
    adapter: adapter.id,
    version: adapter.version,
    adapterDigest: adapter.digest,
    modules,
    files: written.map(({ path: relative, digest: fileDigest }) => ({ path: relative, digest: fileDigest }))
  };
  const stateFile = installedStatePath(project, adapter.id);
  writeJsonAtomic(stateFile, state);
  return { project, adapter, stateFile, modules, files: written, changed: written.some((entry) => entry.changed) };
}
