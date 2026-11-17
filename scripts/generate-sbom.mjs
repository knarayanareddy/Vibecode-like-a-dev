#!/usr/bin/env node
/**
 * Deterministic, zero-dependency CycloneDX 1.5 JSON SBOM generator for the
 * published `vibecode-like-a-dev` package (roadmap 4.4).
 *
 * Usage:
 *   node scripts/generate-sbom.mjs [-o sbom.cdx.json]
 *   node scripts/generate-sbom.mjs --check [-o sbom.cdx.json]
 */

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const outIdx = argv.indexOf('-o');
const outFile = path.resolve(ROOT, outIdx !== -1 && argv[outIdx + 1] ? argv[outIdx + 1] : 'sbom.cdx.json');

function sha256File(absPath) {
  const buf = readFileSync(absPath);
  // Normalize CRLF -> LF on UTF-8 text files so Windows core.autocrlf checkouts
  // produce the exact same digest as POSIX checkouts and published tarballs.
  if (!buf.includes(0)) {
    return createHash('sha256').update(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  }
  return createHash('sha256').update(buf).digest('hex');
}

export function buildSbom() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const runtimeDeps = Object.entries(pkg.dependencies ?? {});
  if (runtimeDeps.length > 0) {
    throw new Error(`zero-dependency invariant violated: found ${runtimeDeps.length} runtime dependency/dependencies`);
  }

  // npm is a .cmd shim on Windows; fixed command string mirrors distribution.test.mjs.
  const rawPack = process.platform === 'win32'
    ? execSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const packInfo = JSON.parse(rawPack)[0];
  const outRel = path.relative(ROOT, outFile).split(path.sep).join('/');
  const packedFiles = (packInfo.files ?? [])
    .map((f) => f.path)
    .filter((rel) => rel !== outRel && existsSync(path.join(ROOT, rel)))
    .sort();

  const fileHashes = packedFiles.map((rel) => ({
    path: rel,
    sha256: sha256File(path.join(ROOT, rel))
  }));
  const treeDigest = createHash('sha256')
    .update(fileHashes.map((f) => `${f.sha256}  ${f.path}`).join('\n'))
    .digest('hex');

  const rootBomRef = `pkg:npm/${pkg.name}@${pkg.version}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      tools: [
        {
          vendor: pkg.name,
          name: 'generate-sbom.mjs',
          version: pkg.version
        }
      ],
      component: {
        type: 'application',
        'bom-ref': rootBomRef,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        purl: rootBomRef,
        licenses: [{ license: { id: pkg.license ?? 'MIT' } }],
        hashes: [{ alg: 'SHA-256', content: treeDigest }],
        properties: [
          { name: 'vld:runtimeDependencies', value: '0' },
          { name: 'vld:nodeEngine', value: String(pkg.engines?.node ?? '>=22.0.0') },
          { name: 'vld:shippedFileCount', value: String(fileHashes.length) }
        ]
      }
    },
    components: [],
    dependencies: [
      {
        ref: rootBomRef,
        dependsOn: []
      }
    ]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sbom = buildSbom();
  const serialized = `${JSON.stringify(sbom, null, 2)}\n`;
  if (checkOnly) {
    if (!existsSync(outFile)) {
      console.error(`✗ SBOM missing: ${path.relative(ROOT, outFile)} (run node scripts/generate-sbom.mjs)`);
      process.exit(1);
    }
    const current = readFileSync(outFile, 'utf8');
    if (current !== serialized) {
      console.error(`✗ SBOM out of date: ${path.relative(ROOT, outFile)} (run node scripts/generate-sbom.mjs)`);
      process.exit(1);
    }
    console.log(`✓ SBOM verified (${path.relative(ROOT, outFile)} · 0 runtime deps · ${sbom.metadata.component.version})`);
  } else {
    writeFileSync(outFile, serialized, 'utf8');
    console.log(`✓ wrote ${path.relative(ROOT, outFile)} (CycloneDX 1.5 · 0 runtime deps · v${sbom.metadata.component.version})`);
  }
}
