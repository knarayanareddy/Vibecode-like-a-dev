#!/usr/bin/env node
/** Generate the discoverable CLI reference from the CLI's sole USAGE authority. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ROOT, 'docs', 'CLI.md');
const usage = execFileSync(process.execPath, [path.join(ROOT, 'factory', 'cli.mjs'), '--help'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const content = `# CLI reference\n\n> Generated from the \`USAGE\` constant in \`factory/cli.mjs\`. Do not edit command prose here; run \`node scripts/generate-cli-doc.mjs\` after changing the CLI.\n\n\`\`\`text\n${usage}\n\`\`\`\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
    console.error('✗ docs/CLI.md is stale; run: node scripts/generate-cli-doc.mjs');
    process.exitCode = 1;
  } else console.log('✓ docs/CLI.md matches CLI usage');
} else {
  writeFileSync(target, content, 'utf8');
  console.log('✓ wrote docs/CLI.md from CLI usage');
}
