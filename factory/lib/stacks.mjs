/**
 * Data-driven stack profiles (factory/stacks/<id>.json).
 *
 * Pure deterministic loader used by the compiler, adoption and verification.
 * Supports single-stack declarations ("rust", "Python 3.12") and per-service
 * maps ({ backend: "python", frontend: "typescript" }).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STACKS_DIR = path.resolve(HERE, '..', 'stacks');

export const STACK_RESOLUTION_ORDER = Object.freeze([
  'python',
  'rust',
  'go',
  'kotlin',
  'csharp',
  'javascript',
  'java',
  'ruby',
  'php',
  'typescript'
]);

let cachedStacks = null;

export function loadStacks() {
  if (cachedStacks) return cachedStacks;
  const files = readdirSync(STACKS_DIR).filter((file) => file.endsWith('.json')).sort();
  const byId = new Map();
  for (const file of files) {
    const profile = JSON.parse(readFileSync(path.join(STACKS_DIR, file), 'utf8'));
    byId.set(profile.id, Object.freeze(profile));
  }
  cachedStacks = byId;
  return cachedStacks;
}

export function getStackProfile(id) {
  return loadStacks().get(String(id ?? '').toLowerCase()) ?? null;
}

function tokenMatches(declared, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(declared);
}

/**
 * Resolve one stack string (e.g. "Rust 1.82", "Java 21, Spring Boot 3", "undecided")
 * to a stack profile object, or null when unrecognised.
 */
export function resolveStackString(raw) {
  const declared = String(raw ?? 'undecided').trim().toLowerCase();
  const stacks = loadStacks();
  if (declared === '' || declared === 'undecided') return stacks.get('typescript') ?? null;
  if (stacks.has(declared)) return stacks.get(declared);

  for (const id of STACK_RESOLUTION_ORDER) {
    const entry = stacks.get(id);
    if (!entry) continue;
    if ((entry.match ?? []).some((token) => token !== 'undecided' && tokenMatches(declared, token))) {
      return entry;
    }
  }
  return null;
}

export function isStackMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalise a profile's `constraints.stack` (string or per-service map) into
 * primary stack profile + optional ordered service list.
 */
export function resolveProfileStacks(profile) {
  const raw = profile?.constraints?.stack ?? 'undecided';
  if (isStackMap(raw)) {
    const entries = Object.entries(raw).map(([service, declared]) => {
      const resolved = resolveStackString(declared);
      return {
        service,
        declared: String(declared),
        profile: resolved,
        recognised: Boolean(resolved)
      };
    });
    const preferred =
      entries.find((entry) => /^(?:backend|api|server|core|service|app)$/i.test(entry.service) && entry.profile) ??
      entries.find((entry) => entry.profile) ??
      entries[0] ??
      null;
    const frontend =
      entries.find((entry) => /^(?:frontend|web|ui|client|dashboard)$/i.test(entry.service) && entry.profile) ??
      null;
    return {
      isMultiService: true,
      declaredLabel: entries.map((entry) => `${entry.service}: ${entry.declared}`).join(', '),
      primary: preferred?.profile ?? null,
      primaryService: preferred?.service ?? null,
      frontend: frontend?.profile ?? null,
      frontendService: frontend?.service ?? null,
      services: entries,
      recognised: entries.length > 0 && entries.every((entry) => entry.recognised)
    };
  }

  const declared = String(raw || 'undecided');
  const resolved = resolveStackString(declared);
  return {
    isMultiService: false,
    declaredLabel: declared,
    primary: resolved,
    primaryService: null,
    frontend: null,
    frontendService: null,
    services: [],
    recognised: Boolean(resolved)
  };
}

function toKebab(slug) {
  return String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'requirement';
}

function toSnake(slug) {
  return toKebab(slug).replace(/-/g, '_');
}

function toPascal(slug) {
  return toKebab(slug)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('') || 'Requirement';
}

/** Format an idiomatic anchor test file path for a stack profile and requirement slug. */
export function formatAnchorPath(stackProfile, rawSlug, { servicePrefix = null } = {}) {
  const kebab = toKebab(rawSlug);
  if (!stackProfile) {
    const base = `tests/choose-runner/${kebab}.test`;
    return servicePrefix ? `${servicePrefix}/${base}` : base;
  }
  const snake = toSnake(rawSlug);
  const pascal = toPascal(rawSlug);
  const rendered = stackProfile.anchorPattern
    .replaceAll('{slug}', kebab)
    .replaceAll('{snake}', snake)
    .replaceAll('{Pascal}', pascal);
  return servicePrefix ? `${servicePrefix}/${rendered}` : rendered;
}

/** Return ordered [lint, typecheck, test] commands for a resolved stack profile. */
export function stackCommandList(stackProfile) {
  if (!stackProfile?.commands) return null;
  return [stackProfile.commands.lint, stackProfile.commands.typecheck, stackProfile.commands.test].filter(Boolean);
}

/** Generate an idiomatic anchor example snippet for a stack profile. */
export function renderAnchorExample(stackProfile, { reqId = 'REQ-002', title = 'requirement holds', bodyHint = null } = {}) {
  if (!stackProfile) return null;
  const id = stackProfile.id;
  const snake = toSnake(title).slice(0, 40) || 'requirement_holds';
  const pascal = toPascal(title).slice(0, 40) || 'RequirementHolds';
  const safeTitle = String(title).replace(/'/g, "\\'");
  const comment = `${stackProfile.anchorComment} @req ${reqId}`;
  const note = bodyHint ? `${stackProfile.anchorComment} ${bodyHint}` : null;

  switch (id) {
    case 'python':
      return [comment, `def test_${snake}():`, ...(note ? [`    ${note}`] : []), '    result = execute_under_test()', '    assert result is not None'].join('\n');
    case 'go':
      return [comment, `func Test${pascal}(t *testing.T) {`, ...(note ? [`\t${note}`] : []), '\tif err := executeUnderTest(); err != nil {', '\t\tt.Fatalf("unexpected error: %v", err)', '\t}', '}'].join('\n');
    case 'rust':
      return [comment, '#[test]', `fn ${snake}() {`, ...(note ? [`    ${note}`] : []), '    let result = execute_under_test();', '    assert!(result.is_ok());', '}'].join('\n');
    case 'java':
      return [comment, '@Test', `void ${snake}() {`, ...(note ? [`    ${note}`] : []), '    var result = subject.execute();', '    assertNotNull(result);', '}'].join('\n');
    case 'kotlin':
      return [comment, '@Test', `fun \`${reqId} ${safeTitle}\`() {`, ...(note ? [`    ${note}`] : []), '    val result = subject.execute()', '    assertNotNull(result)', '}'].join('\n');
    case 'ruby':
      return [comment, `it '${reqId} ${safeTitle}' do`, ...(note ? [`  ${note}`] : []), '  expect(subject.call).to be_truthy', 'end'].join('\n');
    case 'php':
      return [comment, `public function test${pascal}(): void`, '{', ...(note ? [`    ${note}`] : []), '    $this->assertNotNull($this->subject->execute());', '}'].join('\n');
    case 'csharp':
      return [comment, '[Fact]', `public void ${pascal}()`, '{', ...(note ? [`    ${note}`] : []), '    Assert.NotNull(_subject.Execute());', '}'].join('\n');
    default:
      return [comment, `test('${reqId} ${safeTitle}', async () => {`, ...(note ? [`  ${note}`] : []), '  const result = await executeUnderTest();', '  expect(result).toBeDefined();', '});'].join('\n');
  }
}

/** Test a relative path against a simple glob (`*`, `**`, `**\/`). */
export function matchesGlob(relativePath, glob) {
  const normalized = String(relativePath).replaceAll('\\', '/');
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `^${escaped
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?')
      .replace(/\u0001/g, '.*')}$`
  );
  return regex.test(normalized);
}

/** Check whether an anchor path is matched by at least one of its stack's default runner globs. */
export function isAnchorDiscoverable(stackProfile, anchorPath, { servicePrefix = null } = {}) {
  if (!stackProfile) return false;
  let target = String(anchorPath).replaceAll('\\', '/');
  if (servicePrefix && target.startsWith(`${servicePrefix}/`)) {
    target = target.slice(servicePrefix.length + 1);
  }
  return (stackProfile.defaultTestGlobs ?? []).some((glob) => matchesGlob(target, glob));
}
