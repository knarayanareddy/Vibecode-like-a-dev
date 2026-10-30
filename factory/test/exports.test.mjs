import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportPacket } from '../lib/exports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKET = path.join(ROOT, 'examples', 'retro-board', 'spec');

test('Spec Kit and Kiro exports are deterministic bounded views of a verified VLD packet', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-exports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specKit = path.join(root, 'spec-kit');
  const kiro = path.join(root, 'kiro');
  const secondSpecKit = path.join(root, 'spec-kit-again');

  const specResult = exportPacket({ format: 'spec-kit', packetDir: PACKET, outDir: specKit });
  const kiroResult = exportPacket({ format: 'kiro', packetDir: PACKET, outDir: kiro });
  exportPacket({ format: 'spec-kit', packetDir: PACKET, outDir: secondSpecKit });

  assert.deepEqual(specResult.files, ['.specify/memory/constitution.md', 'README.md', 'specs/vld-packet/plan.md', 'specs/vld-packet/spec.md', 'specs/vld-packet/tasks.md', 'vld-export.json']);
  assert.deepEqual(kiroResult.files, ['.kiro/specs/vld-packet/design.md', '.kiro/specs/vld-packet/requirements.md', '.kiro/specs/vld-packet/tasks.md', '.kiro/steering/vld-packet.md', 'README.md', 'vld-export.json']);
  const spec = readFileSync(path.join(specKit, 'specs', 'vld-packet', 'spec.md'), 'utf8');
  assert.match(spec, /REQ-001/);
  assert.match(spec, /Derived view only/);
  assert.match(spec, /spec\.after\.json/);
  assert.match(readFileSync(path.join(kiro, '.kiro', 'specs', 'vld-packet', 'requirements.md'), 'utf8'), /REQ-001/);
  assert.equal(readFileSync(path.join(specKit, 'vld-export.json'), 'utf8'), readFileSync(path.join(secondSpecKit, 'vld-export.json'), 'utf8'));
  assert.equal(readFileSync(path.join(specKit, 'specs', 'vld-packet', 'plan.md'), 'utf8'), readFileSync(path.join(secondSpecKit, 'specs', 'vld-packet', 'plan.md'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(path.join(specKit, 'vld-export.json'), 'utf8')).source.project, 'retro-board');
});

test('exports reject malformed packets and preserve unrelated files on explicit overwrite', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vld-exports-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => exportPacket({ format: 'spec-kit', packetDir: path.join(root, 'missing'), outDir: path.join(root, 'out') }), /does not exist/);
  assert.throws(() => exportPacket({ format: 'unknown', packetDir: PACKET, outDir: path.join(root, 'out') }), /unknown export format/);

  const unowned = path.join(root, 'unowned');
  // A non-empty directory without VLD's own manifest is never a force-overwrite target.
  mkdirSync(unowned);
  writeFileSync(path.join(unowned, 'human.md'), 'human-owned');
  assert.throws(() => exportPacket({ format: 'kiro', packetDir: PACKET, outDir: unowned, force: true }), /not a prior/);
  assert.throws(() => exportPacket({ format: 'kiro', packetDir: PACKET, outDir: path.join(PACKET, 'kiro-view') }), /outside the authoritative packet/);

  const out = path.join(root, 'existing');
  exportPacket({ format: 'kiro', packetDir: PACKET, outDir: out });
  writeFileSync(path.join(out, 'keep.txt'), 'human-owned');
  assert.throws(() => exportPacket({ format: 'kiro', packetDir: PACKET, outDir: out }), /not empty/);
  exportPacket({ format: 'kiro', packetDir: PACKET, outDir: out, force: true });
  assert.equal(readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'human-owned');
  assert.ok(existsSync(path.join(out, '.kiro', 'steering', 'vld-packet.md')));
});
