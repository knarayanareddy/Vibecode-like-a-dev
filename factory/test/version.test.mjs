/** Release identity is data, not an independently maintained collection of literals. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
