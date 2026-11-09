/** Release identity is data, not an independently maintained collection of literals. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PACKAGE_VERSION } from '../lib/version.mjs';
import { FACTORY_VERSION } from '../lib/emit/derive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readPackage = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));

test('all distributable VLD surfaces advertise the root package release version', () => {
  const root = readPackage('package.json');
  assert.equal(PACKAGE_VERSION, root.version);
  assert.equal(FACTORY_VERSION, root.version);
  for (const relative of [
    'factory/studio/vscode/package.json',
    'factory/integrations/acp-v1/package.json',
    'factory/integrations/github-v1/package.json'
  ]) assert.equal(readPackage(relative).version, root.version, `${relative} drifted from the root release version`);

  const cli = execFileSync(process.execPath, [path.join(ROOT, 'factory/cli.mjs'), '--version'], { encoding: 'utf8' }).trim();
  assert.equal(cli, `vibecode-like-a-dev ${root.version}`);
});

test('the optional ACP bridge obtains client metadata from the shared version authority', () => {
  const source = readFileSync(path.join(ROOT, 'factory/integrations/acp-v1/index.mjs'), 'utf8');
  assert.match(source, /import \{ PACKAGE_VERSION \} from '\.\.\/\.\.\/lib\/version\.mjs';/);
  assert.match(source, /clientInfo: \{ name: 'VLD', version: PACKAGE_VERSION \}/);
  assert.equal(source.includes("version: '0.19.0'"), false);
});

/**
 * BUG-11: `engines` is advisory, so "Node 22 or newer" was a claim nobody tested —
 * Node 20 ran the whole suite. The CLI must refuse an older runtime itself, with a
 * message that names the requirement, and it must do so before it loads modules
 * that assume the newer one.
 */
test('the CLI refuses a runtime below the documented minimum', () => {
  const probe = `
    Object.defineProperty(process.versions, 'node', { value: '20.20.2', configurable: true });
    await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'factory', 'cli.mjs')).href)});
    console.error('guard did not fire');
    process.exit(0);
  `;
  let result;
  try {
    result = { code: 0, stderr: execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    result = { code: error.status ?? 1, stderr: String(error.stderr ?? '') };
  }
  assert.equal(result.code, 2, 'the guard must exit 2, not fall through to a syntax error');
  assert.match(result.stderr, /requires Node 22 or newer/);
  assert.match(result.stderr, /this is 20\.20\.2/);
});

test('the documented minimum matches the engine field and the guard', () => {
  const root = readPackage('package.json');
  assert.equal(root.engines.node, '>=22');
  const cli = readFileSync(path.join(ROOT, 'factory', 'cli.mjs'), 'utf8');
  // The guard's constant is the single authority the CI job and the docs quote.
  assert.match(cli, /export const MINIMUM_NODE_MAJOR = 22;/);
  // It must be declared before the CLI's own module imports: ESM hoists imports,
  // so a guard placed after them executes only once those modules have loaded.
  const guardAt = cli.indexOf('MINIMUM_NODE_MAJOR = 22');
  const firstLocalImportAt = cli.indexOf("from './lib/");
  assert.ok(guardAt !== -1, 'the guard constant is missing');
  assert.ok(
    guardAt < firstLocalImportAt,
    'the runtime guard must precede the import graph'
  );
});
