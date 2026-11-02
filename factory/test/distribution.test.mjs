/** Package contents are a public documentation and provenance contract. */
import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
function packedFiles() {
  // npm is a .cmd shim on Windows; execFile cannot launch command scripts there.
  // The command is fixed (not user input), so the platform shell is deliberate.
  const result = process.platform === 'win32'
    ? execSync('npm pack --json --dry-run', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', ['pack', '--json', '--dry-run'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return new Set(JSON.parse(result)[0].files.map((entry) => entry.path));
}

function localMarkdownTargets(markdown) {
  return [...markdown.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:)/i.test(target) && !target.startsWith('/'));
}

test('package metadata identifies the canonical repository and support surface', () => {
  assert.deepEqual(manifest.repository, { type: 'git', url: 'git+https://github.com/knarayanareddy/Vibecode-like-a-dev.git' });
  assert.equal(manifest.bugs.url, 'https://github.com/knarayanareddy/Vibecode-like-a-dev/issues');
  assert.equal(manifest.homepage, 'https://github.com/knarayanareddy/Vibecode-like-a-dev#readme');
});

test('packed install contains the README local-link targets and contributor guidance', () => {
  const packed = packedFiles();
  for (const required of ['docs/AUTHORING.md', 'prompts/bootstrap.md', 'examples/retro-board/spec/spec.json', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) assert.ok(packed.has(required), `${required} must ship`);
  for (const target of localMarkdownTargets(readFileSync(path.join(ROOT, 'README.md'), 'utf8'))) {
    const directoryLink = target.endsWith('/');
    assert.ok(directoryLink ? [...packed].some((file) => file.startsWith(target)) : packed.has(target), `README target ${target} must ship in the npm tarball`);
  }
  assert.ok(![...packed].some((file) => file.includes('/node_modules/') || file.startsWith('examples/ideas/build/')), 'nested installs and generated stress packets are not package assets');
});


test('Git ignores only ephemeral VLD state, not reviewable locks and workflow definitions', () => {
  const ignored = ['.vld/runtime/mission/events.jsonl', '.vld/agents/codex.json', '.vld/workspaces.json', '.vld/catalogs/team/packages.json', '.vld/stores/team/templates.md'];
  for (const file of ignored) {
    assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT }).status, 0, `${file} is local state`);
  }
  const durable = ['.vld/modules.json', '.vld/catalog.json', '.vld/catalog-root.json', '.vld/stores.json', '.vld/workflows/release.json'];
  for (const file of durable) {
    assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT }).status, 1, `${file} remains reviewable`);
  }
  assert.match(readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /What to commit from `\.vld\/`/);
});
