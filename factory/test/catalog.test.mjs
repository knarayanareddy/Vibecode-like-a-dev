/** M7 signed inert catalog: cryptographic trust, pins and copy-only provenance. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addCatalog, catalogStatus, copyCatalogPayload, previewCatalogRefresh, refreshCatalog, trustCatalogRoot } from '../lib/catalog.mjs';
import { digest, stableJson } from '../lib/extension-utils.mjs';

const FUTURE = '2034-06-01T00:00:00.000Z';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'factory', 'cli.mjs');
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function signed(value, privateKey, keyId = 'test-publisher') {
  const unsigned = { ...value }; delete unsigned.signatures;
  return { ...unsigned, signatures: [{ keyId, signature: sign(null, Buffer.from(stableJson(unsigned)), privateKey).toString('base64') }] };
}
function key() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function rootFixture(directory, signingKey, { version = 1, previousRootDigest = null, signWith = null } = {}) {
  const root = {
    schemaVersion: 1, type: 'vld-catalog-root', version, expiresAt: '2035-01-01T00:00:00.000Z', threshold: 1,
    keys: [{ id: 'test-publisher', algorithm: 'ed25519', publicKey: signingKey.publicKey, roles: ['root', 'index', 'package'] }],
    ...(previousRootDigest ? { previousRootDigest } : {})
  };
  const value = signWith ? signed(root, signWith.privateKey) : root;
  const file = path.join(directory, `root-v${version}.json`); writeJson(file, value); return { root: value, file };
}
function makeCatalog(directory, signingKey, { catalogId = 'team-catalog', coreCompatibility = '^0.19.0', payloadType = 'guidance', payload = '# Signed guidance\n\nKeep this inert and review the provenance.\n', tamperIndex = false } = {}) {
  const source = path.join(directory, 'catalog-source'); const packageDir = path.join(source, 'packages', 'review-content'); mkdirSync(packageDir, { recursive: true });
  const payloadPath = payloadType === 'guidance' ? 'guidance.md' : `${payloadType}.json`; const payloadId = payloadType === 'guidance' ? 'review-guidance' : 'review-workflow';
  const payloadFile = path.join(packageDir, payloadPath); writeFileSync(payloadFile, payload);
  const payloadEntry = { id: payloadId, type: payloadType, path: payloadPath, digest: digest(payload), bytes: Buffer.byteLength(payload) };
  const manifest = signed({
    schemaVersion: 1, type: 'vld-catalog-package', name: 'review-content', version: '1.0.0', license: 'MIT', coreCompatibility,
    payloads: [payloadEntry], publisher: { id: 'test-publisher' }, releaseTimestamp: '2030-01-01T00:00:00.000Z', revoked: false, capabilities: ['content-only']
  }, signingKey.privateKey);
  const manifestFile = path.join(packageDir, 'catalog-package.json'); writeJson(manifestFile, manifest); const manifestDigest = digest(readFileSync(manifestFile, 'utf8'));
  const index = signed({
    schemaVersion: 1, type: 'vld-catalog-index', catalogId, version: 1, expiresAt: '2035-01-01T00:00:00.000Z', rootVersion: 1,
    packages: [{ name: 'review-content', version: '1.0.0', path: 'packages/review-content', manifestDigest, revoked: false }]
  }, signingKey.privateKey);
  if (tamperIndex) index.packages[0].version = '9.9.9';
  // Deliberately persist a different object-key order than the signer used.
  // Verification must rely on stable canonical serialization, never file order.
  writeJson(path.join(source, 'catalog-index.json'), { signatures: index.signatures, packages: index.packages, rootVersion: index.rootVersion, expiresAt: index.expiresAt, version: index.version, catalogId: index.catalogId, type: index.type, schemaVersion: index.schemaVersion });
  git(source, ['init']); git(source, ['add', '.']); git(source, ['-c', 'user.name=VLD Catalog Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'signed catalog']);
  return source;
}
function reviseCatalog(source, signingKey, payload) {
  const packageDir = path.join(source, 'packages', 'review-content'); const payloadFile = path.join(packageDir, 'guidance.md'); writeFileSync(payloadFile, payload);
  const existingManifest = JSON.parse(readFileSync(path.join(packageDir, 'catalog-package.json'), 'utf8')); const { signatures: ignoredManifestSignatures, ...unsignedManifest } = existingManifest;
  unsignedManifest.payloads = [{ id: 'review-guidance', type: 'guidance', path: 'guidance.md', digest: digest(payload), bytes: Buffer.byteLength(payload) }];
  const manifest = signed(unsignedManifest, signingKey.privateKey); const manifestFile = path.join(packageDir, 'catalog-package.json'); writeJson(manifestFile, manifest);
  const existingIndex = JSON.parse(readFileSync(path.join(source, 'catalog-index.json'), 'utf8')); const { signatures: ignoredIndexSignatures, ...unsignedIndex } = existingIndex;
  unsignedIndex.version += 1; unsignedIndex.packages = [{ ...unsignedIndex.packages[0], manifestDigest: digest(readFileSync(manifestFile, 'utf8')) }]; writeJson(path.join(source, 'catalog-index.json'), signed(unsignedIndex, signingKey.privateKey));
  git(source, ['add', '.']); git(source, ['-c', 'user.name=VLD Catalog Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'signed catalog refresh']);
}

test('M7 trusts an explicit root, verifies a signed content-only Git catalog offline, pins identity and copies with provenance', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-catalog-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const signer = key(); const trust = rootFixture(root, signer); const source = makeCatalog(root, signer); const project = path.join(root, 'consumer'); mkdirSync(project);
  const trusted = trustCatalogRoot({ projectDir: project, rootFile: trust.file, now: FUTURE });
  assert.equal(trusted.changed, true); assert.equal(trusted.root.keyIds[0], 'test-publisher');
  const added = addCatalog({ projectDir: project, id: 'team-catalog', repository: `file://${source}`, now: FUTURE });
  assert.match(added.catalog.commit, /^[a-f0-9]{40}$/); assert.equal(added.catalog.packages[0].capabilities[0], 'content-only');
  const status = catalogStatus(project, null, { now: FUTURE }); assert.equal(status.ok, true); assert.equal(status.catalogs[0].packages[0].publisher.id, 'test-publisher');
  const copied = copyCatalogPayload({ projectDir: project, catalogId: 'team-catalog', packageName: 'review-content', payloadId: 'review-guidance', out: 'docs/catalog/review-guidance.md', now: FUTURE });
  assert.match(readFileSync(copied.output, 'utf8'), /Signed guidance/); assert.equal(copied.provenance.publisher, 'test-publisher');
  const provenance = JSON.parse(readFileSync(path.join(project, '.vld', 'catalog-copies.json'), 'utf8')); assert.equal(provenance.copies[0].payloadDigest, copied.payload.digest);
  assert.throws(() => copyCatalogPayload({ projectDir: project, catalogId: 'team-catalog', packageName: 'review-content', payloadId: 'review-guidance', out: 'docs/catalog/unsafe.js', now: FUTURE }), (error) => error.code === 'INVALID_CATALOG_OUTPUT');
  assert.equal(existsSync(path.join(project, '.vld', 'catalogs', 'team-catalog', 'packages', 'review-content', 'guidance.md')), true);
});

test('M7 preview/update preserves the existing exact-commit acknowledgement flow for a valid new signed index', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-catalog-refresh-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const signer = key(); const trust = rootFixture(root, signer); const source = makeCatalog(root, signer); const project = path.join(root, 'consumer'); mkdirSync(project);
  trustCatalogRoot({ projectDir: project, rootFile: trust.file, now: FUTURE }); const initial = addCatalog({ projectDir: project, id: 'team-catalog', repository: `file://${source}`, now: FUTURE }); const before = readFileSync(path.join(project, '.vld', 'catalog.json'), 'utf8');
  reviseCatalog(source, signer, '# Updated signed guidance\n\nReview exact catalog commits.\n');
  const preview = previewCatalogRefresh({ projectDir: project, id: 'team-catalog', now: FUTURE });
  assert.equal(preview.changes.changed, true); assert.notEqual(preview.next.commit, initial.catalog.commit); assert.equal(readFileSync(path.join(project, '.vld', 'catalog.json'), 'utf8'), before);
  assert.throws(() => refreshCatalog({ projectDir: project, id: 'team-catalog', now: FUTURE }), (error) => error.code === 'CATALOG_ACKNOWLEDGEMENT_REQUIRED');
  assert.throws(() => refreshCatalog({ projectDir: project, id: 'team-catalog', acknowledge: initial.catalog.commit, now: FUTURE }), (error) => error.code === 'CATALOG_ACKNOWLEDGEMENT_MISMATCH');
  const refreshed = refreshCatalog({ projectDir: project, id: 'team-catalog', acknowledge: preview.next.commit, now: FUTURE });
  assert.equal(refreshed.catalog.commit, preview.next.commit); assert.equal(refreshed.catalog.acknowledgedCommit, preview.next.commit);
});

test('M7 rejects altered signed metadata, incompatible packages and digest drift without replacing locks', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-catalog-invalid-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const signer = key(); const trust = rootFixture(root, signer); const source = makeCatalog(root, signer); const project = path.join(root, 'consumer'); mkdirSync(project);
  trustCatalogRoot({ projectDir: project, rootFile: trust.file, now: FUTURE }); const initial = addCatalog({ projectDir: project, id: 'team-catalog', repository: `file://${source}`, now: FUTURE });
  const before = readFileSync(path.join(project, '.vld', 'catalog.json'), 'utf8');
  const indexFile = path.join(source, 'catalog-index.json'); const index = JSON.parse(readFileSync(indexFile, 'utf8')); index.packages[0].manifestDigest = '0'.repeat(64); writeJson(indexFile, index); git(source, ['add', '.']); git(source, ['-c', 'user.name=VLD Catalog Test', '-c', 'user.email=vld@example.test', 'commit', '-m', 'tampered index']);
  assert.throws(() => previewCatalogRefresh({ projectDir: project, id: 'team-catalog', now: FUTURE }), (error) => error.code === 'CATALOG_SIGNATURE_INVALID');
  assert.equal(readFileSync(path.join(project, '.vld', 'catalog.json'), 'utf8'), before, 'rejected preview leaves lock untouched');
  writeFileSync(path.join(project, '.vld', 'catalogs', 'team-catalog', 'packages', 'review-content', 'guidance.md'), 'drift');
  assert.equal(catalogStatus(project, null, { now: FUTURE }).ok, false, 'offline verification detects cache payload drift');
  const incompatible = makeCatalog(path.join(root, 'incompatible'), signer, { catalogId: 'other-catalog', coreCompatibility: '^0.15.0' });
  assert.throws(() => addCatalog({ projectDir: project, id: 'other-catalog', repository: `file://${incompatible}`, now: FUTURE }), (error) => error.code === 'CATALOG_CORE_INCOMPATIBLE');
  const unsafeWorkflow = JSON.stringify({ schemaVersion: 1, id: 'unsafe-workflow', version: '1.0.0', title: 'Unsafe workflow', summary: 'A deliberately unsafe workflow fixture for catalog validation.', requiresModules: [], steps: [{ id: 'run-anything', type: 'command', description: 'Try to invoke an arbitrary shell-like executable from catalog content.', dependsOn: [], run: ['sh', '-c', 'echo unsafe'] }] });
  const unsafe = makeCatalog(path.join(root, 'unsafe'), signer, { catalogId: 'unsafe-catalog', payloadType: 'workflow', payload: unsafeWorkflow });
  assert.throws(() => addCatalog({ projectDir: project, id: 'unsafe-catalog', repository: `file://${unsafe}`, now: FUTURE }), (error) => error.code === 'CATALOG_PAYLOAD_SCHEMA_INVALID');
  assert.equal(initial.catalog.id, 'team-catalog');
});

test('M7 public CLI trusts and pins a signed catalog without exposing a private key', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-catalog-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const signer = key(); const trust = rootFixture(root, signer); const source = makeCatalog(root, signer); const project = path.join(root, 'consumer'); mkdirSync(project);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'catalog', ...args, '--project', project, '--json'], { encoding: 'utf8' });
  const trusted = run('trust', trust.file); assert.equal(trusted.status, 0, trusted.stderr); assert.equal(JSON.parse(trusted.stdout).root.version, 1);
  const added = run('add', 'team-catalog', `file://${source}`); assert.equal(added.status, 0, added.stderr); assert.equal(JSON.parse(added.stdout).catalog.packages.length, 1);
  const status = run('status'); assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).ok, true);
  assert.equal(trusted.stdout.includes('PRIVATE KEY'), false);
});

test('M7 root rotation requires exact acknowledgement and old-root threshold signatures; no private key is persisted', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-catalog-root-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldKey = key(); const initial = rootFixture(root, oldKey); const project = path.join(root, 'consumer'); mkdirSync(project);
  const trusted = trustCatalogRoot({ projectDir: project, rootFile: initial.file, now: FUTURE });
  const nextKey = key(); const rotated = rootFixture(root, nextKey, { version: 2, previousRootDigest: trusted.root.digest, signWith: oldKey });
  const nextDigest = digest(rotated.root);
  assert.throws(() => trustCatalogRoot({ projectDir: project, rootFile: rotated.file, now: FUTURE }), (error) => error.code === 'CATALOG_ROOT_ACKNOWLEDGEMENT_REQUIRED');
  const result = trustCatalogRoot({ projectDir: project, rootFile: rotated.file, acknowledge: nextDigest, now: FUTURE });
  assert.equal(result.root.version, 2);
  assert.equal(readFileSync(path.join(project, '.vld', 'catalog-root.json'), 'utf8').includes('PRIVATE KEY'), false);
});
